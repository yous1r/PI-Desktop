use super::*;
use crate::{db::Database, sessions};
use serde_json::json;

fn request() -> Value {
    json!({"version":1,"requestId":uuid::Uuid::new_v4().to_string(),
        "sourceEpoch":uuid::Uuid::new_v4().to_string(),"profileId":"a".repeat(64),
        "generation":uuid::Uuid::new_v4().to_string()})
}

#[test]
fn inspection_request_is_bounded_strict_and_canonical() {
    let valid = request();
    assert!(Request::parse(valid.clone()).is_ok());
    for (key, value) in [
        ("extra", json!(0)),
        ("version", json!(2)),
        ("sourceEpoch", json!("00000000-0000-0000-0000-000000000000")),
        ("profileId", json!("A".repeat(64))),
        ("generation", json!(12)),
        ("requestId", json!("x".repeat(model::MAX_RECORD_BYTES))),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value;
        assert!(Request::parse(invalid).is_err(), "{key}");
    }
}

#[test]
fn durable_inspection_preserves_pending_approvals_and_reports_original_obligations() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    assert_eq!(Durable::read(&db).unwrap(), Durable::default());
    db.conn().execute_batch(&format!(
        "INSERT INTO turns(id,session_id,status,started_at,ended_at) VALUES('t1','{}','unknown',1,2);
         INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,position,created_at)
           VALUES('q1','{}','local','hash','pending','ask',1,1);
         INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,plan_json,status,created_at,updated_at,expires_at,execution_state)
           VALUES('p1','{}','t1','c1','{{}}','pending',1,1,1,'queued');
         INSERT INTO scheduled_tasks(id,title,prompt,created_at,updated_at) VALUES('s1','scheduled','prompt',1,1);
         INSERT INTO task_runs(id,task_id,status,started_at,ended_at) VALUES('r1','s1','unknown',1,2);
         INSERT INTO mode_snapshots(hash,json,created_at) VALUES('snapshot','{{}}','now');
         INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,state,active_turn_id,active_origin,pending_gate,artifact_paths,created_at,updated_at)
           VALUES('m1','{}','mode','snapshot','input','stage','paused','t1','user',0,'{{}}',1,1);
         INSERT INTO worktrees(id,session_id,path,common_dir,branch,owner_branch,status,setup_status,created_at,updated_at)
           VALUES('w1','{}','fixture','fixture-git','branch','main','active','running',1,1);",
        session.id, session.id, session.id, session.id, session.id,
    )).unwrap();
    let before = db.conn().total_changes();
    db.conn().execute_batch("PRAGMA query_only=ON").unwrap();
    assert_eq!(
        Durable::read(&db).unwrap(),
        Durable {
            turns: true,
            queued_turns: true,
            plans: true,
            approvals: true,
            scheduled_runs: true,
            mode_claims: true,
            mode_waits: true,
            worktrees: true,
        }
    );
    assert_eq!(db.conn().total_changes(), before);
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT status FROM plan_approvals WHERE request_id='p1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "pending"
    );
    db.conn()
        .execute_batch(
            "PRAGMA query_only=OFF;
        UPDATE turns SET status='completed'; DELETE FROM turn_queue;
        UPDATE plan_approvals SET status='expired',execution_state='completed';
        UPDATE task_runs SET status='completed';
        UPDATE mode_runs SET active_turn_id=NULL,active_origin=NULL,pending_gate=NULL;
        UPDATE worktrees SET setup_status='ok';",
        )
        .unwrap();
    assert_eq!(Durable::read(&db).unwrap(), Durable::default());
    db.conn()
        .execute_batch("UPDATE mode_runs SET state='running'")
        .unwrap();
    assert!(Durable::read(&db).unwrap().mode_waits);
}

#[test]
fn missing_durable_source_is_an_error_not_an_idle_report() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    db.conn().execute_batch("DROP TABLE turn_queue").unwrap();
    assert!(Durable::read(&db).is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn running_owner_inspection_binds_native_generation_and_journal_without_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = AppState::open(directory.path()).unwrap();
    let mut registry = crate::execution_fence::Registry::start(directory.path()).unwrap();
    registry.bind_journal(directory.path()).unwrap();
    let ticket = registry.prepare().unwrap();
    let epoch = registry.epoch().to_string();
    let profile = crate::owner_control::profile_id(directory.path()).unwrap();
    let mut command = request();
    command["sourceEpoch"] = json!(epoch);
    command["profileId"] = json!(profile);
    command["generation"] = json!(ticket.generation);
    state.execution_fence = Some(registry);
    let activity = state.handoff_activity.clone();
    let running = activity.begin(super::super::activity::Kind::Background);
    let state = Arc::new(Mutex::new(state));
    let report = handle(state.clone(), command.clone()).await.unwrap();
    assert_eq!(report["requestId"], command["requestId"]);
    assert_eq!(report["activity"]["backgroundTasks"], 1);
    assert_eq!(report["nativeCoverage"], "execution_generation_only");
    assert_eq!(report["native"]["state"], "pending");
    assert_eq!(report["native"]["confirmed"], false);
    assert!(serde_json::to_vec(&report).unwrap().len() < model::MAX_RECORD_BYTES);
    assert!(!report.to_string().contains(&ticket.capability));
    for key in ["sourceEpoch", "generation", "profileId"] {
        let mut stale = command.clone();
        stale[key] = if key == "profileId" {
            json!("b".repeat(64))
        } else {
            json!(uuid::Uuid::new_v4().to_string())
        };
        assert!(handle(state.clone(), stale).await.is_err());
    }
    {
        let guard = state.lock().await;
        assert!(handle(state.clone(), command.clone()).await.is_err());
        guard
            .db
            .conn()
            .execute(
                "UPDATE execution_owners SET retired=1 WHERE epoch=?1",
                [&epoch],
            )
            .unwrap();
    }
    assert!(handle(state.clone(), command).await.is_err());
    running.finish(true);
    let lease = state
        .lock()
        .await
        .execution_fence
        .as_ref()
        .unwrap()
        .lease(&ticket.generation)
        .unwrap();
    assert!(lease.stop(2000).await.unwrap().confirmed);
}

#[tokio::test]
async fn absent_native_owner_never_becomes_zero_inventory() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(Mutex::new(AppState::open(directory.path()).unwrap()));
    assert!(handle(state, request()).await.is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn mismatched_journal_root_cannot_describe_the_original_native_generation() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = AppState::open(directory.path()).unwrap();
    let mut registry = crate::execution_fence::Registry::start(directory.path()).unwrap();
    registry.bind_journal(directory.path()).unwrap();
    let ticket = registry.prepare().unwrap();
    let mut command = request();
    command["sourceEpoch"] = json!(registry.epoch());
    command["profileId"] = json!(crate::owner_control::profile_id(directory.path()).unwrap());
    command["generation"] = json!(ticket.generation);
    state.db.conn().execute(
        "UPDATE execution_generations SET record_json=json_set(record_json,'$.root',
         json((SELECT json_extract(record_json,'$.host') FROM execution_owners WHERE epoch=?1))) WHERE id=?2",
        rusqlite::params![registry.epoch(), ticket.generation],
    ).unwrap();
    let lease = registry.lease(&ticket.generation).unwrap();
    state.execution_fence = Some(registry);
    let result = handle(Arc::new(Mutex::new(state)), command).await;
    assert!(lease.stop(2000).await.unwrap().confirmed);
    assert!(
        result.is_err(),
        "a journal root absent from the original lease must refuse inspection"
    );
}

#[tokio::test]
async fn runtime_inspection_follows_actual_permission_tool_and_sync_owners() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = AppState::open(directory.path()).unwrap();
    let clean = serde_json::to_value(Runtime::read(&state)).unwrap();
    assert!(clean
        .as_object()
        .unwrap()
        .values()
        .all(|value| value == false));
    let permit = state
        .tool_budget
        .acquire("fixture-session", "Read")
        .await
        .unwrap();
    state.register_pending_permission("request", "fixture-session", "tool");
    let (remote, _remote_reply) = tokio::sync::oneshot::channel();
    let (plugin, _plugin_reply) = tokio::sync::oneshot::channel();
    state.remote_execs.insert("remote".into(), remote);
    state.plugin_execs.insert("plugin".into(), plugin);
    state
        .config_sync_in_progress
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let busy = Runtime::read(&state);
    assert!(
        busy.tools
            && busy.permissions
            && busy.remote_executions
            && busy.plugin_executions
            && busy.config_sync
    );
    assert!(!busy.background_processes);
    drop(permit);
    state.clear_pending_permission("request");
    state.remote_execs.clear();
    state.plugin_execs.clear();
    state
        .config_sync_in_progress
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(serde_json::to_value(Runtime::read(&state)).unwrap(), clean);
}
