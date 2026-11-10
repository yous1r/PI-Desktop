//! Only original-owner handoff control can enter while business ingress is
//! closed. Every call still occupies the ordinary RPC semaphore and deadline.
use super::{rpc_err, JsonRpcError};
use crate::owner_handoff::activity::{Activity, Ingress, Kind, Obligation};

pub(super) fn admit(activity: &Activity, method: &str) -> Result<Option<Obligation>, JsonRpcError> {
    match method {
        // This bounded read alone excludes its own request from the inventory.
        crate::owner_handoff::inspection::METHOD => Ok(None),
        crate::owner_handoff::query::IDENTITY
        | crate::owner_handoff::query::TRANSFER
        | crate::owner_handoff::exchange_protocol::COMPLETE
        | "executionFence.status"
        | "executionFence.stop" => Ok(Some(activity.begin(Kind::Request))),
        _ => activity
            .admit(Ingress::Request)
            .map(Some)
            .map_err(|_| rpc_err(-32000, "host admission is closed", "HANDOFF_BUSY")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner_handoff::activity::Snapshot;

    #[test]
    fn closed_admission_has_exact_control_exceptions_and_preserves_counts() {
        let activity = Activity::default();
        let held = activity.hold().unwrap();
        for method in [
            "ownerHandoff.identity",
            "ownerHandoff.readTransfer",
            "ownerHandoff.completeQuiescence",
            "executionFence.status",
            "executionFence.stop",
        ] {
            let request = admit(&activity, method).unwrap().unwrap();
            assert_eq!(activity.snapshot().requests, 1);
            request.finish(true);
        }
        assert!(admit(&activity, "ownerHandoff.inspect").unwrap().is_none());
        for method in [
            "handshake",
            "session.create",
            "session.saveInflightMessage",
            "session.endTurn",
            "configSync.syncNow",
            "tools.execute",
            "executionFence.prepare",
            "executionFence.other",
            "ownerHandoff.other",
            "ownerHandoff.inspect.extra",
        ] {
            let error = admit(&activity, method).err().unwrap();
            assert_eq!(error.code, -32000);
            assert_eq!(error.message, "host admission is closed");
            assert_eq!(error.data.unwrap()["errorCode"], "HANDOFF_BUSY");
        }
        assert_eq!(activity.snapshot(), Snapshot::default());
        held.reopen().unwrap();
        admit(&activity, "session.create")
            .unwrap()
            .unwrap()
            .finish(true);
    }

    #[tokio::test]
    async fn admitted_session_creation_settles_while_later_requests_are_refused() {
        use crate::{sessions, state::AppState};
        use std::sync::Arc;
        use tokio::sync::{mpsc, Mutex};
        let root = tempfile::tempdir().unwrap();
        let mut app = AppState::open(root.path()).unwrap();
        app.handshook = true;
        let activity = app.handoff_activity.clone();
        let state = Arc::new(Mutex::new(app));
        let admitted = admit(&activity, "session.create").unwrap().unwrap();
        let held = activity.hold().unwrap();
        let (handled, committed) = super::super::request_lifetime::execute(
            &activity,
            Some(2000),
            super::super::handle_request(
                state.clone(),
                "session.create",
                serde_json::json!({}),
                mpsc::unbounded_channel().0,
            ),
        )
        .await;
        committed.unwrap();
        handled.unwrap();
        admitted.finish(true);
        assert!(admit(&activity, "session.create").is_err());
        assert_eq!(
            sessions::list_sessions(&state.lock().await.db)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(activity.snapshot(), Snapshot::default());
        held.reopen().unwrap();
    }
}
