use super::*;

#[tokio::test]
async fn pending_registration_is_not_confirmed_until_cancelled() {
    let mut registry = Registry::start().unwrap();
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
    let job = Job::create().unwrap();
    assert_eq!(job.active().unwrap(), 0);
    job.terminate().unwrap();
    assert_eq!(job.active().unwrap(), 0);
}
