//! Focused native binding tests. Every case uses an isolated temporary journal
//! and real native objects; no process is spawned, adopted, killed or replayed,
//! and no Desktop profile, provider or default data directory is touched.
use super::super::Progress;
use super::*;
use crate::execution_fence::native::Job;
use crate::owner_control::identity::{Identity, Peer};
use crate::owner_handoff::model::VERSION;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows_sys::Win32::System::Threading::CreateEventW;

/// A waitable handle stands in for the recorded launcher handle: an already
/// signalled manual-reset event reports observed exit, an unsignalled one
/// reports a live process. The identity beside it is always this test process,
/// so the retained record stays a real, validated process identity.
fn waitable(signalled: bool) -> OwnedHandle {
    let raw = unsafe { CreateEventW(std::ptr::null(), 1, i32::from(signalled), std::ptr::null()) };
    assert!(!raw.is_null(), "test waitable unavailable");
    unsafe { OwnedHandle::from_raw_handle(raw) }
}
fn registry() -> (tempfile::TempDir, Registry) {
    let directory = tempfile::tempdir().unwrap();
    drop(crate::db::Database::open_in_dir(directory.path()).unwrap());
    let mut registry = Registry::start(directory.path()).unwrap();
    registry.bind_journal(directory.path()).unwrap();
    (directory, registry)
}
/// Registers one original generation exactly as the fence does, then installs
/// the lease a running registration would hold.
fn running(registry: &mut Registry, signalled: bool) -> String {
    let identity = Identity::current().unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let job_name =
        Generation::job_name(&registry.owner.profile, &registry.owner.epoch, &generation);
    let root = record(std::process::id(), &identity);
    let registration = Generation {
        version: VERSION,
        id: generation.clone(),
        owner_epoch: registry.owner.epoch.clone(),
        profile: registry.owner.profile.clone(),
        job_name: job_name.clone(),
        root: None,
    };
    {
        let mut journal = registry.journal.as_ref().unwrap().lock().unwrap();
        journal.register_generation(&registration).unwrap();
        journal.bind_root(&generation, &root).unwrap();
    }
    registry.current = Some(Arc::new(Lease {
        generation: generation.clone(),
        job: Arc::new(Job::create(&job_name, &identity.sid).unwrap()),
        progress: Arc::new(Mutex::new(Progress {
            state: "running",
            root: Some(Peer {
                pid: std::process::id(),
                identity,
                handle: waitable(signalled),
            }),
        })),
        task: tokio::spawn(async {}),
    }));
    generation
}
fn failed<T>(result: Result<T>) -> String {
    result.err().expect("expected a refusal").to_string()
}

#[tokio::test]
async fn capture_requires_running_bound_generation_and_original_journal() {
    let directory = tempfile::tempdir().unwrap();
    drop(crate::db::Database::open_in_dir(directory.path()).unwrap());
    let mut registry = Registry::start(directory.path()).unwrap();
    // No generation is running yet, with or without a bound journal.
    assert_eq!(failed(registry.capture_source()), "EXECUTION_FENCE_STALE");
    registry.bind_journal(directory.path()).unwrap();
    assert_eq!(failed(registry.capture_source()), "EXECUTION_FENCE_STALE");
    let generation = running(&mut registry, true);
    let binding = registry.capture_source().unwrap();
    assert_eq!(binding.generation(), generation);
    assert_eq!(binding.owner(), &registry.owner);
    assert!(Arc::ptr_eq(
        &binding.journal(),
        registry.journal.as_ref().unwrap()
    ));
    assert!(Arc::ptr_eq(&binding.coordinator, &registry.coordinator));
    registry.matches_source(&binding).unwrap();
    binding.check_authority().unwrap();
    // Only a running registration is a source; a stopping one is refused.
    binding.lease.progress.lock().unwrap().state = "stopping";
    assert_eq!(failed(registry.capture_source()), "EXECUTION_FENCE_STALE");
    binding.lease.progress.lock().unwrap().state = "running";
    registry.capture_source().unwrap();
    // The exact original journal must still be bound to this registry.
    let journal = registry.journal.take();
    assert_eq!(
        failed(registry.capture_source()),
        "HANDOFF_OWNER_NOT_REGISTERED"
    );
    registry.journal = journal;
    // The durable original record must still be open.
    binding
        .journal()
        .lock()
        .unwrap()
        .close_generation(&generation)
        .unwrap();
    assert_eq!(failed(registry.capture_source()), "HANDOFF_OWNER_CHANGED");
}

#[tokio::test]
async fn replacement_generation_owner_and_journal_are_never_adopted() {
    let (_directory, mut registry) = registry();
    let first = running(&mut registry, true);
    let binding = registry.capture_source().unwrap();
    binding.stop(2000).await.unwrap();
    binding
        .journal()
        .lock()
        .unwrap()
        .close_generation(&first)
        .unwrap();
    let second = running(&mut registry, true);
    assert_ne!(first, second);
    // The registry now leases a replacement generation for the same owner.
    assert_eq!(
        failed(registry.matches_source(&binding)),
        "HANDOFF_OWNER_CHANGED"
    );
    // The captured binding keeps authority for its own generation only.
    assert_eq!(binding.generation(), first);
    binding.check_authority().unwrap();
    let replacement = registry.capture_source().unwrap();
    assert_eq!(replacement.generation(), second);
    assert!(!Arc::ptr_eq(&replacement.lease, &binding.lease));
    registry.matches_source(&replacement).unwrap();
    // A registry with its own owner, coordinator and journal adopts nothing.
    let other_directory = tempfile::tempdir().unwrap();
    drop(crate::db::Database::open_in_dir(other_directory.path()).unwrap());
    let mut other = Registry::start(other_directory.path()).unwrap();
    other.bind_journal(other_directory.path()).unwrap();
    assert_eq!(failed(other.capture_source()), "EXECUTION_FENCE_STALE");
    assert_eq!(
        failed(other.matches_source(&binding)),
        "HANDOFF_OWNER_CHANGED"
    );
}

#[tokio::test]
async fn authority_accepts_original_closure_and_refuses_retirement() {
    let (_directory, mut registry) = registry();
    let generation = running(&mut registry, true);
    let binding = registry.capture_source().unwrap();
    // Journal contention is refused, never waited on.
    let journal = binding.journal();
    let held = journal.lock().unwrap();
    assert_eq!(
        failed(binding.check_authority()),
        "HANDOFF_JOURNAL_UNAVAILABLE"
    );
    drop(held);
    binding.check_authority().unwrap();
    // The caller's closure keeps the original generation authoritative.
    binding
        .journal()
        .lock()
        .unwrap()
        .close_generation(&generation)
        .unwrap();
    binding.check_authority().unwrap();
    registry.matches_source(&binding).unwrap();
    // Retirement withdraws authority for the same retained handles.
    binding
        .journal()
        .lock()
        .unwrap()
        .retire_owner(&registry.owner.epoch)
        .unwrap();
    assert_eq!(failed(binding.check_authority()), "HANDOFF_OWNER_CHANGED");
    assert_eq!(
        failed(registry.matches_source(&binding)),
        "HANDOFF_OWNER_CHANGED"
    );
}

#[tokio::test]
async fn stop_confirms_only_observed_original_root_exit() {
    let (_directory, mut registry) = registry();
    // A termination request against a live recorded root is never exit proof.
    running(&mut registry, false);
    let live = registry.capture_source().unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        failed(live.stop(0).await),
        "EXECUTION_FENCE_STOP_UNCONFIRMED"
    );
    assert!(!live.lease.status().unwrap().confirmed);
    // An observed original exit, an empty owned job and a settled task confirm.
    let (_exited_directory, mut exited_registry) = self::registry();
    let generation = running(&mut exited_registry, true);
    let exited = exited_registry.capture_source().unwrap();
    tokio::task::yield_now().await;
    exited.stop(2000).await.unwrap();
    // Stop never closes the durable generation itself.
    exited
        .journal()
        .lock()
        .unwrap()
        .inspect_generation(exited.owner(), &generation, Some(&exited.root))
        .unwrap();
    // The stopped original generation keeps authority; the replaced lease does
    // not become the registry's source.
    exited.check_authority().unwrap();
    exited_registry.matches_source(&exited).unwrap();
    live.check_authority().unwrap();
    assert_eq!(
        failed(exited_registry.matches_source(&live)),
        "HANDOFF_OWNER_CHANGED"
    );
}

#[tokio::test]
async fn stop_refuses_confirmation_without_the_retained_root() {
    let (_directory, mut registry) = registry();
    running(&mut registry, true);
    let binding = registry.capture_source().unwrap();
    {
        let mut progress = binding.lease.progress.lock().unwrap();
        // The lease alone treats a missing root as closed; the binding must not.
        progress.root = None;
        progress.state = "closed";
    }
    tokio::task::yield_now().await;
    assert!(binding.lease.status().unwrap().confirmed);
    assert_eq!(
        failed(binding.stop(0).await),
        "EXECUTION_FENCE_ROOT_UNCONFIRMED"
    );
}
