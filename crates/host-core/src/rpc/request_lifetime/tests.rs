use super::*;
use crate::owner_handoff::activity::{Kind, Snapshot};
use crate::state::AppState;
use crate::{sessions, transcripts};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

fn checkpoint() -> transcripts::InflightRecord {
    serde_json::from_value(json!({
        "schema": 1, "sessionId": "s1", "turnId": "t1",
        "savedAt": "2026-09-04T00:00:00.000Z",
        "message": { "id": "m1", "role": "assistant", "blocks": [{"type":"text", "text":"partial"}],
            "createdAt": "2026-09-04T00:00:00.000Z" }
    }))
    .unwrap()
}

#[tokio::test]
async fn request_errors_keep_their_wire_shape_without_inventing_work() {
    let activity = Activity::default();
    let (handled, committed) = execute(&activity, Some(1000), async {
        Err(super::super::rpc_err(-32602, "bad input", "INVALID_PARAMS"))
    })
    .await;
    assert_eq!(handled.unwrap_err().code, -32602);
    committed.unwrap();
    assert_eq!(activity.snapshot(), Snapshot::default());
}

#[tokio::test]
async fn timeout_keeps_uncertainty_after_the_original_blocking_work_finishes() {
    let activity = Activity::default();
    let (started, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (done, finished) = oneshot::channel();
    let obligation = activity.begin(Kind::Request);
    let (handled, committed) = execute(&activity, Some(0), async {
        tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let _ = wait.recv_timeout(Duration::from_secs(5));
            let _ = done.send(());
        })
        .await
        .unwrap();
        Ok(json!(null))
    })
    .await;
    obligation.finish(true);
    assert_eq!(
        handled.unwrap_err().data.unwrap()["errorCode"],
        "HOST_RPC_TIMEOUT"
    );
    committed.unwrap();
    tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    assert!(activity.snapshot().uncertain);
    assert_eq!(activity.snapshot().requests, 0);
    release.send(()).unwrap();
    finished.await.unwrap();
    let (handled, committed) = execute(&activity, None, async { Ok(json!("later success")) }).await;
    assert_eq!(handled.unwrap(), json!("later success"));
    committed.unwrap();
    assert!(activity.snapshot().uncertain);
}

#[tokio::test]
async fn failed_checkpoint_commit_remains_uncertain_after_a_successful_retry() {
    let root = tempfile::tempdir().unwrap();
    let path = transcripts::inflight_path(root.path(), "s1").unwrap();
    let temporary = path.with_extension("json.tmp");
    std::fs::create_dir_all(&temporary).unwrap();
    let activity = Activity::default();
    let (handled, committed) = execute(&activity, None, async {
        transcripts::write_inflight(root.path(), "s1", &checkpoint()).unwrap();
        Ok(json!("accepted"))
    })
    .await;
    assert_eq!(handled.unwrap(), json!("accepted"));
    assert!(committed.is_err());
    assert_eq!(activity.snapshot().writes, 0);
    assert!(activity.snapshot().uncertain);
    std::fs::remove_dir(&temporary).unwrap();
    let (_, committed) = execute(&activity, None, async {
        transcripts::write_inflight(root.path(), "s1", &checkpoint()).unwrap();
        Ok(json!(null))
    })
    .await;
    committed.unwrap();
    assert_eq!(
        transcripts::read_inflight(root.path(), "s1")
            .unwrap()
            .unwrap()
            .message
            .id,
        "m1"
    );
    assert!(activity.snapshot().uncertain);
}

#[test]
fn aborting_the_checkpoint_waiter_cannot_release_the_queued_writer() {
    // One occupied blocking lane gives an explicit synchronization point before
    // the original checkpoint can run. No elapsed-time assumption is needed.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let root = tempfile::tempdir().unwrap();
        let activity = Activity::default();
        let (entered, ready) = oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(5));
        });
        ready.await.unwrap();
        let pending = activity.begin(Kind::Request);
        let owner = activity.clone();
        let directory = root.path().to_path_buf();
        let request = tokio::spawn(async move {
            let result = execute(&owner, None, async {
                transcripts::write_inflight(&directory, "s1", &checkpoint()).unwrap();
                Ok(json!(null))
            })
            .await;
            pending.finish(true);
            result
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while activity.snapshot().writes != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(
            activity.snapshot(),
            Snapshot {
                requests: 0,
                background_tasks: 0,
                writes: 1,
                uncertain: true
            }
        );
        release.send(()).unwrap();
        blocker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while activity.snapshot().writes != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            transcripts::read_inflight(root.path(), "s1")
                .unwrap()
                .unwrap()
                .message
                .id,
            "m1"
        );
        assert!(activity.snapshot().uncertain);
    });
}

#[tokio::test]
async fn checkpoint_rpc_user_path_commits_and_recovers_the_original_reply() {
    let root = tempfile::tempdir().unwrap();
    let mut app = AppState::open(root.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(&app.db, None, None, None, None, None).unwrap();
    let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let activity = app.handoff_activity.clone();
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    let calls = [
        (
            "session.saveInflightMessage",
            json!({"sessionId":session.id,"turnId":turn,
            "message":{"id":"m1","role":"assistant","content":"partial reply",
                "createdAt":"2026-09-04T00:00:00.000Z","status":"streaming"}}),
        ),
        (
            "session.endTurn",
            json!({"turnId":turn,"status":"aborted","errorCode":"TURN_ABORTED",
            "createNotification":false,"recoverInflight":true}),
        ),
        ("session.get", json!({"id":session.id})),
    ];
    let mut results = Vec::new();
    for (method, params) in calls {
        let request = activity.begin(Kind::Request);
        let (handled, committed) = execute(
            &activity,
            None,
            super::super::handle_request(state.clone(), method, params, tx.clone()),
        )
        .await;
        committed.unwrap();
        results.push(handled.unwrap());
        request.finish(true);
        assert_eq!(activity.snapshot(), Snapshot::default());
    }
    assert_eq!(results[0], json!({"ok":true,"saved":true}));
    assert_eq!(results[1]["recovered"]["content"], "partial reply");
    assert_eq!(results[2]["session"]["messages"][0]["status"], "aborted");
}

#[tokio::test]
async fn an_admitted_request_can_enqueue_and_commit_its_checkpoint_after_closure() {
    use crate::owner_handoff::activity::Ingress;
    let root = tempfile::tempdir().unwrap();
    let activity = Activity::default();
    let request = activity.admit(Ingress::Request).unwrap();
    let (started, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let original = activity.clone();
    let directory = root.path().to_path_buf();
    let task = tokio::spawn(async move {
        let result = execute(&original, None, async {
            started.send(()).unwrap();
            wait.await.unwrap();
            transcripts::write_inflight(&directory, "s1", &checkpoint()).unwrap();
            Ok(json!("persisted"))
        })
        .await;
        request.finish(true);
        result
    });
    ready.await.unwrap();
    let held = activity.hold().unwrap();
    assert!(activity.admit(Ingress::Request).is_err());
    release.send(()).unwrap();
    let (handled, committed) = task.await.unwrap();
    assert_eq!(handled.unwrap(), json!("persisted"));
    committed.unwrap();
    assert_eq!(
        transcripts::read_inflight(root.path(), "s1")
            .unwrap()
            .unwrap()
            .message
            .id,
        "m1"
    );
    assert_eq!(activity.snapshot(), Snapshot::default());
    held.reopen().unwrap();
}
