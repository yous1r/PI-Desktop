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
            workers: 0,
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

/// Collaboration delivery requires Agent mode on both sides, so the fixture
/// parent is an ordinary Agent session like the real sender.
fn collaboration_parent(db: &Database) -> String {
    sessions::create_session(db, None, Some("agent".into()), None, None, None)
        .unwrap()
        .id
}

/// Real public entry points: `spawn` creates the session, the link and the
/// queued task; later states come from the same settlement helpers production
/// uses, so the fixture never invents a Worker row.
fn spawn_worker(db: &Database, parent: &str, key: &str) -> (String, String) {
    let spawned = crate::session_collaboration::handle(
        db,
        "session.collaboration.spawn",
        &json!({"sourceSessionId":parent,"pluginId":"pi.session-orchestrator",
            "content":"Review the change","idempotencyKey":key,"title":key}),
    )
    .unwrap();
    (
        spawned["sessionId"].as_str().unwrap().to_owned(),
        spawned["message"]["id"].as_str().unwrap().to_owned(),
    )
}

fn message_status(db: &Database, id: &str) -> String {
    db.conn()
        .query_row(
            "SELECT status FROM session_collaboration_messages WHERE id=?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn durable_workers_count_a_queued_spawn_before_desktop_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let parent = collaboration_parent(&db);
    assert_eq!(Durable::read(&db).unwrap().workers, 0);
    let (worker, task) = spawn_worker(&db, &parent, "queued-worker");
    assert_eq!(message_status(&db, &task), "queued");
    let before = db.conn().total_changes();
    db.conn().execute_batch("PRAGMA query_only=ON").unwrap();
    let queued = Durable::read(&db).unwrap();
    db.conn().execute_batch("PRAGMA query_only=OFF").unwrap();
    assert_eq!(
        queued.workers, 1,
        "a Worker whose task is still queued in Rust is already work"
    );
    assert!(
        !queued.turns && !queued.queued_turns,
        "Agent Host has neither a turn nor a queued turn for this Worker"
    );
    assert_eq!(db.conn().total_changes(), before, "the count is read-only");
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT created_by_session_id FROM session_collaboration_links WHERE session_id=?1",
                rusqlite::params![worker],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        parent,
        "the link is the Worker identity"
    );
}

#[test]
fn durable_workers_count_a_running_turn_after_its_queued_task_settles() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let parent = collaboration_parent(&db);
    let (worker, task) = spawn_worker(&db, &parent, "running-worker");
    crate::session_collaboration::handle(
        &db,
        "session.collaboration.cancel",
        &json!({"sessionId":worker,"pluginId":"pi.session-orchestrator","sourceSessionId":parent}),
    )
    .unwrap();
    assert_eq!(message_status(&db, &task), "cancelled");
    assert_eq!(
        Durable::read(&db).unwrap().workers,
        0,
        "a cancelled queued task leaves no active Worker"
    );
    let turn = sessions::begin_turn(&db, &worker, None, None).unwrap();
    assert_eq!(
        Durable::read(&db).unwrap().workers,
        1,
        "a running turn keeps the linked Worker active"
    );
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    assert_eq!(Durable::read(&db).unwrap().workers, 0);
}

#[test]
fn durable_workers_count_one_worker_once_while_its_task_runs() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let parent = collaboration_parent(&db);
    let (worker, task) = spawn_worker(&db, &parent, "claimed-worker");
    let turn = crate::session_collaboration::begin_turn(&db, &worker, &task, None, None).unwrap();
    assert_eq!(message_status(&db, &task), "running");
    assert_eq!(
        Durable::read(&db).unwrap().workers,
        1,
        "one link is one Worker, not one per matching obligation"
    );
    sessions::end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    assert_eq!(
        Durable::read(&db).unwrap().workers,
        1,
        "the delivery is still running until it settles"
    );
    crate::session_collaboration::settle_turn(&db, &turn).unwrap();
    assert_eq!(message_status(&db, &task), "cancelled");
    assert_eq!(Durable::read(&db).unwrap().workers, 0);
}

#[test]
fn durable_workers_count_distinct_linked_sessions_across_creators() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let parent = collaboration_parent(&db);
    let other = collaboration_parent(&db);
    let (first, _) = spawn_worker(&db, &parent, "first-worker");
    let (second, _) = spawn_worker(&db, &parent, "second-worker");
    let (third, _) = spawn_worker(&db, &other, "third-worker");
    assert!(first != second && second != third && first != third);
    assert_eq!(Durable::read(&db).unwrap().workers, 3);
    let (links, distinct): (i64, i64) = db
        .conn()
        .query_row(
            "SELECT COUNT(*),COUNT(DISTINCT session_id) FROM session_collaboration_links",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(links, distinct, "one link per Worker session");
    // The spawn limit and the obligation count must classify the same rows.
    let limited: i64 = db
        .conn()
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM session_collaboration_links l
                 WHERE l.plugin_id=?1 AND ({})",
                crate::session_collaboration::ACTIVE_WORKER_CONDITION
            ),
            rusqlite::params!["pi.session-orchestrator"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(limited, 3);
    let per_creator: i64 = db
        .conn()
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM session_collaboration_links l
                 WHERE l.created_by_session_id=?1 AND ({})",
                crate::session_collaboration::ACTIVE_WORKER_CONDITION
            ),
            rusqlite::params![parent],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(per_creator, 2, "the per-parent limit counts the same links");
}

#[test]
fn durable_workers_exclude_settled_cancelled_and_interrupted_deliveries() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let parent = collaboration_parent(&db);
    let (cancelled_worker, _) = spawn_worker(&db, &parent, "cancelled-worker");
    crate::session_collaboration::handle(
        &db,
        "session.collaboration.cancel",
        &json!({"sessionId":cancelled_worker}),
    )
    .unwrap();
    assert_eq!(Durable::read(&db).unwrap().workers, 0);
    let (settled_worker, settled_task) = spawn_worker(&db, &parent, "settled-worker");
    let settled =
        crate::session_collaboration::begin_turn(&db, &settled_worker, &settled_task, None, None)
            .unwrap();
    sessions::end_turn(&db, &settled, "completed", None, None, false).unwrap();
    crate::session_collaboration::settle_turn(&db, &settled).unwrap();
    assert_eq!(Durable::read(&db).unwrap().workers, 0);
    let (interrupted_worker, interrupted_task) = spawn_worker(&db, &parent, "interrupted-worker");
    let interrupted = crate::session_collaboration::begin_turn(
        &db,
        &interrupted_worker,
        &interrupted_task,
        None,
        None,
    )
    .unwrap();
    sessions::end_turn(
        &db,
        &interrupted,
        "error",
        Some("fixture failure"),
        None,
        false,
    )
    .unwrap();
    crate::session_collaboration::recover(&db).unwrap();
    assert_eq!(message_status(&db, &interrupted_task), "interrupted");
    assert_eq!(Durable::read(&db).unwrap().workers, 0);
}

#[test]
fn durable_workers_exclude_sessions_without_a_collaboration_link() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let parent = collaboration_parent(&db);
    let plain = collaboration_parent(&db);
    let turn = sessions::begin_turn(&db, &plain, None, None).unwrap();
    crate::session_collaboration::handle(
        &db,
        "session.collaboration.send",
        &json!({"sessionId":plain,"sourceSessionId":parent,
            "pluginId":"pi.session-orchestrator","content":"Review the change",
            "idempotencyKey":"plain-session-task","kind":"task"}),
    )
    .unwrap();
    let durable = Durable::read(&db).unwrap();
    assert!(
        durable.turns,
        "the unlinked session really has a running turn"
    );
    assert_eq!(
        durable.workers, 0,
        "a task delivered to an ordinary session is not a Worker"
    );
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
}

#[test]
fn missing_worker_link_source_is_an_error_not_an_idle_report() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    db.conn()
        .execute_batch("DROP TABLE session_collaboration_links")
        .unwrap();
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
