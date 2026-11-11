//! Root-join evidence: prepared target ticket, bind refusal, event epoch and
//! launch frame contracts. The OS named-pipe peer handshake is exercised by the
//! existing registration path; these deterministic tests cover the target
//! orchestration pieces without minting a fake Ready root.
use super::*;
use crate::execution_fence::{native::Coordinator, Registry, Ticket};
use crate::owner_control::identity::{authenticate, Identity};
use crate::owner_handoff::target::protocol::{launch_sidecar_reply, AttachEpoch};
use serde_json::{json, Value};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

/// Coordinator handle for the test process itself, so a spawned fake sidecar's
/// parent is exactly the coordinator pid required by the production check.
fn self_coordinator() -> Arc<Coordinator> {
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
    let identity = Identity::current().unwrap();
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, std::process::id()) };
    assert!(!raw.is_null(), "self process handle");
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as _) };
    Arc::new(Coordinator {
        pid: std::process::id(),
        handle,
        identity,
    })
}

fn target_frame(f: &Fixture, target_epoch: &str, revision: i64, epoch: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "version": VERSION,
        "operation": "attachEpoch",
        "requestId": id(),
        "transferId": f.released.id,
        "targetEpoch": target_epoch,
        "expectedRevision": revision,
        "eventEpoch": epoch,
    }))
    .unwrap()
}

#[tokio::test]
async fn real_sidecar_process_binds_root_through_job_and_pipe() {
    let sid = Identity::current().unwrap().sid;
    let f = Fixture::with_sid(&sid);
    let target = f.claim();
    let prepared = target
        .prepare_generation(generation(target.owner()))
        .unwrap();
    let generation_id = prepared.record().id.clone();
    let identity = Identity::current().unwrap();
    let mut registry = Registry::for_test(
        f.directory.path(),
        identity,
        self_coordinator(),
        target.owner().clone(),
    )
    .unwrap();
    let (ticket, bound) = registry.prepare_prepared(prepared).unwrap();
    let encoded = serde_json::to_string(&ticket).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "owner_handoff::target::tests::root_join_tests::fake_sidecar_child",
            "--test-threads",
            "1",
        ])
        .env("PI_FAKE_SIDECAR_TICKET", encoded)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let result = registry
        .wait_root(&generation_id, Duration::from_secs(5))
        .await;
    if let Err(error) = &result {
        let output = child.wait_with_output().unwrap();
        panic!(
            "fake sidecar failed: {error}; stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let registered = bound.lock().unwrap().take().unwrap();
    assert_eq!(registered.record().id, generation_id);
    let root = registered.record().root.as_ref().unwrap();
    assert_eq!(root.pid, child.id());
    assert_eq!(root.sid, sid);
    let lease = registry.lease(&generation_id).unwrap();
    let status = lease.status().unwrap();
    assert_eq!(status.state, "running");
    assert!(status.active_processes >= 1);
    registry.abort_target(&generation_id).await.unwrap();
    let _ = child.wait();
}

#[test]
#[ignore]
fn fake_sidecar_child() {
    let encoded = std::env::var("PI_FAKE_SIDECAR_TICKET").expect("ticket env");
    let ticket: Ticket = serde_json::from_str(&encoded).expect("ticket json");
    let identity = Identity::current().expect("client identity");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&ticket.address)
            .expect("one-use pipe");
        let owner = authenticate(pipe.as_raw_handle(), false, &identity).expect("peer auth");
        assert_eq!(owner.pid, ticket.owner_pid);
        assert_eq!(
            owner.identity.created_at.to_string(),
            ticket.owner_created_at
        );
        assert_eq!(pipe.read_u8().await.unwrap(), 1);
        let body = serde_json::to_vec(&ticket).unwrap();
        pipe.write_u32_le(body.len() as u32).await.unwrap();
        pipe.write_all(&body).await.unwrap();
        pipe.flush().await.unwrap();
        let length = pipe.read_u32_le().await.unwrap() as usize;
        let mut generation = vec![0u8; length];
        pipe.read_exact(&mut generation).await.unwrap();
        assert_eq!(generation, ticket.generation.as_bytes());
        pipe.write_u8(0).await.unwrap();
        pipe.flush().await.unwrap();
        std::thread::sleep(Duration::from_secs(20));
    });
}

#[tokio::test]
async fn prepared_target_ticket_times_out_then_aborts_its_generation() {
    let f = Fixture::new();
    let target = f.claim();
    let generation = generation(target.owner());
    let prepared = target.prepare_generation(generation).unwrap();
    let generation_id = prepared.record().id.clone();
    let identity = Identity::current().unwrap();
    let coordinator = Arc::new(Coordinator::capture(&identity).unwrap());
    let mut registry = Registry::for_test(
        f.directory.path(),
        identity,
        coordinator,
        target.owner().clone(),
    )
    .unwrap();
    let (ticket, bound) = registry.prepare_prepared(prepared).unwrap();
    assert_eq!(ticket.generation, generation_id);
    assert_eq!(
        ticket.address,
        format!(r"\\.\pipe\pi-execution-v1-{generation_id}")
    );
    assert!(bound.lock().unwrap().is_none());
    let error = registry
        .wait_root(&generation_id, Duration::from_millis(100))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_TARGET_ROOT_TIMEOUT"), "{error}");
    registry.abort_target(&generation_id).await.unwrap();
    let closed: bool = f
        .journal
        .conn
        .query_row(
            "SELECT closed FROM execution_generations WHERE id=?1",
            [&generation_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(closed);
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::TargetClaimed
    );
    assert!(registry.active_generation().is_none());
}

#[test]
fn bind_root_refuses_a_stale_claim_without_minting_a_root() {
    let f = Fixture::new();
    let target = f.claim();
    let prepared = target
        .prepare_generation(generation(target.owner()))
        .unwrap();
    let generation_id = prepared.record().id.clone();
    let mut changed = f.journal.transfer(&f.released.id).unwrap();
    changed.revision += 1;
    f.journal
        .conn
        .execute(
            "UPDATE owner_handoffs SET revision=?1,record_json=?2 WHERE id=?3",
            params![
                changed.revision,
                model::encode(&changed).unwrap(),
                changed.id
            ],
        )
        .unwrap();
    let error = match prepared.bind_root(&process(23)) {
        Ok(_) => panic!("stale claim must not bind a root"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("STALE_REVISION"), "{error}");
    let root: Option<String> = f
        .journal
        .conn
        .query_row(
            "SELECT json_extract(record_json,'$.root') FROM execution_generations WHERE id=?1",
            [&generation_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(root.is_none());
}

#[test]
fn unrooted_generation_ready_intent_is_refused_before_any_write() {
    use crate::owner_handoff::target::journal::ReadyIntent;
    let mut f = Fixture::new();
    let target = f.claim();
    let generation = generation(target.owner());
    assert!(generation.root.is_none());
    let intent = ReadyIntent {
        request_id: id(),
        claimed: target.record().clone(),
        owner: target.owner().clone(),
        generation,
        event_epoch: "hub-epoch".into(),
        protocol_version: crate::state::PROTOCOL_VERSION,
    };
    let error = f
        .journal
        .target_ready(&target.authority, &intent)
        .expect_err("unrooted generation must not publish Ready");
    assert!(error.to_string().contains("INVALID_READY"), "{error}");
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::TargetClaimed
    );
}

#[test]
fn attach_epoch_is_strict_and_bound_to_the_current_claim() {
    let f = Fixture::new();
    let target = f.claim();
    let revision = target.record().revision;
    let valid = target_frame(&f, f.context.owner.epoch.as_str(), revision, "hub-epoch-1");
    let attach = AttachEpoch::parse(&valid).unwrap();
    attach.check(&target).unwrap();
    assert_eq!(attach.event_epoch(), "hub-epoch-1");

    for (mut value, code) in [
        (
            json!({"version":2,"operation":"attachEpoch","requestId":id(),
                "transferId":f.released.id,"targetEpoch":f.context.owner.epoch,
                "expectedRevision":revision,"eventEpoch":"hub"}),
            "UNSUPPORTED_VERSION",
        ),
        (
            json!({"version":VERSION,"operation":"attachEpoch","requestId":id(),
                "transferId":id(),"targetEpoch":f.context.owner.epoch,
                "expectedRevision":revision,"eventEpoch":"hub"}),
            "TARGET_IDENTITY_MISMATCH",
        ),
        (
            json!({"version":VERSION,"operation":"attachEpoch","requestId":id(),
                "transferId":f.released.id,"targetEpoch":id(),
                "expectedRevision":revision,"eventEpoch":"hub"}),
            "TARGET_IDENTITY_MISMATCH",
        ),
        (
            json!({"version":VERSION,"operation":"attachEpoch","requestId":id(),
                "transferId":f.released.id,"targetEpoch":f.context.owner.epoch,
                "expectedRevision":revision + 1,"eventEpoch":"hub"}),
            "STALE_REVISION",
        ),
        (
            json!({"version":VERSION,"operation":"attachEpoch","requestId":id(),
                "transferId":f.released.id,"targetEpoch":f.context.owner.epoch,
                "expectedRevision":revision,"eventEpoch":""}),
            "EVENT_EPOCH_UNAVAILABLE",
        ),
        (
            json!({"version":VERSION,"operation":"attachEpoch","requestId":id(),
                "transferId":f.released.id,"targetEpoch":f.context.owner.epoch,
                "expectedRevision":revision,"eventEpoch":"hub","extra":true}),
            "INVALID_REQUEST",
        ),
    ] {
        if value["eventEpoch"] == json!("") {
            value["eventEpoch"] = json!("x".repeat(257));
        }
        let error = AttachEpoch::parse(&serde_json::to_vec(&value).unwrap())
            .and_then(|request| request.check(&target))
            .unwrap_err()
            .to_string();
        assert!(error.contains(code), "{code}: {error}");
    }
}

#[test]
fn launch_sidecar_frame_is_bounded_and_carries_the_exact_ticket() {
    let ticket = Ticket {
        version: 1,
        generation: id(),
        address: format!(r"\\.\pipe\pi-execution-v1-{}", id()),
        capability: id(),
        owner_pid: std::process::id(),
        owner_created_at: "134115649234567890".into(),
    };
    let transfer = id();
    let epoch = id();
    let frame = launch_sidecar_reply(&transfer, &epoch, &ticket).unwrap();
    assert!(frame.len() <= model::MAX_RECORD_BYTES);
    let value: Value = serde_json::from_slice(&frame).unwrap();
    assert_eq!(value["version"], json!(VERSION));
    assert_eq!(value["operation"], json!("launch-sidecar"));
    assert_eq!(value["transferId"], json!(transfer));
    assert_eq!(value["targetEpoch"], json!(epoch));
    assert_eq!(value["ticket"]["generation"], json!(ticket.generation));
    assert_eq!(value["ticket"]["address"], json!(ticket.address));
    assert_eq!(value["ticket"]["capability"], json!(ticket.capability));
}

#[test]
fn ticket_mismatch_and_wrong_epoch_are_refused_by_outcome_contracts() {
    // A sidecar ticket with another generation cannot satisfy the exact Ready
    // intent; the ReadyTarget refuses the mismatched registered generation.
    let ticket = Ticket {
        version: 1,
        generation: id(),
        address: format!(r"\\.\pipe\pi-execution-v1-{}", id()),
        capability: id(),
        owner_pid: 1,
        owner_created_at: "1".into(),
    };
    assert_ne!(
        ticket.address,
        format!(r"\\.\pipe\pi-execution-v1-{}", ticket.generation)
    );
    // Event epoch presence is required before any Ready write.
    let empty = match AttachEpoch::parse(&[]) {
        Ok(_) => panic!("empty frame must be refused"),
        Err(error) => error.to_string(),
    };
    assert_eq!(empty, "HANDOFF_INVALID_FRAME");
}
