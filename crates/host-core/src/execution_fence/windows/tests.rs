use super::*;

#[test]
fn adopt_reuses_the_captured_owner_without_a_new_random_epoch() {
    let directory = tempfile::tempdir().unwrap();
    drop(crate::db::Database::open_in_dir(directory.path()).unwrap());
    let identity = Identity::current().unwrap();
    let coordinator = Arc::new(Coordinator::capture(&identity).unwrap());
    let owner = Owner {
        version: VERSION,
        epoch: uuid::Uuid::new_v4().to_string(),
        profile: crate::owner_handoff::model::digest(b"adopt fixture profile"),
        host: record(std::process::id(), &identity),
        coordinator: record(coordinator.pid, &coordinator.identity),
    };
    let mut journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
    journal.register_owner(&owner).unwrap();
    let registry = Registry::adopt(
        directory.path(),
        identity.clone(),
        Arc::clone(&coordinator),
        owner.clone(),
    )
    .unwrap();
    assert_eq!(registry.epoch(), owner.epoch);
    assert_eq!(registry.owner(), &owner);
    // The exact active row is reused; no second owner was registered.
    let (epoch, profile, transfer) = registry.read_source(None).unwrap();
    assert_eq!(epoch, owner.epoch);
    assert_eq!(profile, owner.profile);
    assert!(transfer.is_none());
    assert_eq!(
        registry
            .journal
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .active_owners()
            .unwrap(),
        vec![owner.clone()]
    );
    // Normal start still mints its own owner epoch.
    assert_ne!(
        Registry::start(directory.path()).unwrap().epoch(),
        owner.epoch
    );

    let wrong = Owner {
        host: record(std::process::id() + 1, &identity),
        ..owner
    };
    assert!(Registry::adopt(directory.path(), identity, coordinator, wrong,).is_err());
}

#[tokio::test]
async fn pending_registration_is_not_confirmed_until_cancelled() {
    let directory = tempfile::tempdir().unwrap();
    drop(crate::db::Database::open_in_dir(directory.path()).unwrap());
    let mut registry = Registry::start(directory.path()).unwrap();
    assert!(registry.prepare().is_err());
    registry.bind_journal(directory.path()).unwrap();
    let ticket = registry.prepare().unwrap();
    let lease = registry.lease(&ticket.generation).unwrap();
    let pending = lease.status().unwrap();
    assert_eq!(pending.state, "pending");
    assert_eq!(pending.active_processes, 0);
    assert!(!pending.confirmed);
    assert!(registry.prepare().is_err());
    // Cancellation cannot finish until this single-thread runtime yields.
    assert!(!lease.stop(0).await.unwrap().confirmed);
    assert!(lease.stop(2000).await.unwrap().confirmed);
    let next = registry.prepare().unwrap();
    assert!(registry.lease(&ticket.generation).is_err());
    assert!(
        registry
            .lease(&next.generation)
            .unwrap()
            .stop(2000)
            .await
            .unwrap()
            .confirmed
    );
}

#[test]
fn ticket_is_strict_and_preserves_native_creation_time() {
    let value = serde_json::json!({
        "version": 1, "generation": "12345678-1234-4234-8234-123456789abc",
        "address": "test", "capability": "22345678-1234-4234-8234-123456789abc",
        "ownerPid": 1234, "ownerCreatedAt": "134000000000000001"
    });
    let ticket: Ticket = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(ticket.owner_created_at, "134000000000000001");
    let mut extra = value.clone();
    extra["pid"] = serde_json::json!(99);
    assert!(serde_json::from_value::<Ticket>(extra).is_err());
    let mut lossy = value;
    lossy["ownerCreatedAt"] = serde_json::json!(134000000000000001u64);
    assert!(serde_json::from_value::<Ticket>(lossy).is_err());
}

#[test]
fn native_job_and_coordinator_have_explicit_live_identity() {
    let identity = Identity::current().unwrap();
    let coordinator = Coordinator::capture(&identity).unwrap();
    assert!(!native::exited(coordinator.handle.as_raw_handle()).unwrap());
    assert!(coordinator.identity.created_at < identity.created_at);
    let name = format!("Global\\pi-execution-test-{}", uuid::Uuid::new_v4());
    let job = Job::create(&name, &identity.sid).unwrap();
    assert!(Job::create(&name, &identity.sid).is_err());
    assert_eq!(Job::recorded_active(&name).unwrap(), Some(0));
    assert_eq!(job.active().unwrap(), 0);
    job.terminate().unwrap();
    assert_eq!(job.active().unwrap(), 0);
    drop(job);
    assert_eq!(Job::recorded_active(&name).unwrap(), None);
}

#[test]
fn source_query_refuses_journal_contention_without_waiting() {
    let directory = tempfile::tempdir().unwrap();
    drop(crate::db::Database::open_in_dir(directory.path()).unwrap());
    let mut registry = Registry::start(directory.path()).unwrap();
    registry.bind_journal(directory.path()).unwrap();
    let journal = registry.journal.as_ref().unwrap().lock().unwrap();
    assert!(registry.read_source(None).is_err());
    drop(journal);
    let (epoch, profile, record) = registry.read_source(None).unwrap();
    assert_eq!(epoch, registry.owner.epoch);
    assert_eq!(profile, registry.owner.profile);
    assert!(record.is_none());
    assert!(registry
        .read_source(Some((
            &uuid::Uuid::new_v4().to_string(),
            &profile,
            &uuid::Uuid::new_v4().to_string()
        )))
        .is_err());
}
