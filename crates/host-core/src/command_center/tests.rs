//! Shared harness, additive-migration proof and workspace/membership rules.
//!
//! Every test runs on a real SQLite connection built from the production DDL, so
//! the storage constraints, triggers and foreign keys are exercised rather than
//! mocked. Fixtures use fixed identities so a failure names the same execution
//! the contract documents.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use super::identity::{ExecutionTarget, TaskTarget};
use super::payload::{InterventionIntent, InterventionRequest};
use super::state::{Operation, ReservationState, StopScope};
use super::{goal, reservation, workspace};

pub(super) const HOST_ID: &str = "host_7c1e0a93b4d2f681";
pub(super) const PRINCIPAL: &str = "local:owner";
pub(super) const OTHER_PRINCIPAL: &str = "local:reviewer";
pub(super) const EPOCH: &str = "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14";
pub(super) const STALE_EPOCH: &str = "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28";
pub(super) const WORKSPACE: &str = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
pub(super) const WORKSPACE_B: &str = "8a2e5d31-9b4c-4a67-8d23-3f8b0c1e5a42";
pub(super) const WORKSPACE_C: &str = "9b3f6e42-ac5d-4b78-9e34-4a9c1d2f6b53";
pub(super) const WORKSPACE_D: &str = "ac4a7f53-bd6e-4c89-af45-5bad2e3a7c64";
pub(super) const REQUEST_ID: &str = "b4a1c8d2-5e6f-4a70-8b93-1c2d3e4f5a60";
pub(super) const STOP_REQUEST_ID: &str = "c5b2d9e3-6f70-4b81-9ca4-2d3e4f5a6b71";
pub(super) const OTHER_REQUEST_ID: &str = "d6c3eaf4-7a81-4c92-adb5-3e4f5a6b7c82";
pub(super) const PARENT_SESSION: &str = "sess-parent-1";
pub(super) const PARENT_TURN: &str = "turn-parent-3";
pub(super) const REPLACEMENT_TURN: &str = "turn-parent-4";
pub(super) const DELEGATION: &str = "del-chain-7";
pub(super) const MAIN_SESSION: &str = "sess-main-1";
pub(super) const NOW: i64 = 1_700_000_000_000;

/// A migrated database with foreign keys enforced, exactly as the Host opens it.
pub(super) fn database() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");
    conn.execute_batch(super::SCHEMA_DDL)
        .expect("create command-center tables");
    conn
}

/// Panic with the offending message when `result` does not fail with `needle`.
pub(super) fn expect_error<T: std::fmt::Debug>(result: Result<T>, needle: &str) -> String {
    match result {
        Ok(value) => panic!("expected an error containing {needle}, got {value:?}"),
        Err(error) => {
            let text = format!("{error}");
            assert!(text.contains(needle), "expected {needle}, got {text}");
            text
        }
    }
}

pub(super) fn create_workspace(conn: &Connection, id: &str, name: &str) {
    workspace::create_workspace(conn, id, name, true, NOW).expect("create enabled workspace");
}

/// Seed an established binding directly. Bindings created through
/// [`workspace::bind_session`] always start at revision 1, but the contract
/// fixture is a session that has already been moved several times.
pub(super) fn seed_membership(conn: &Connection, session: &str, workspace_id: &str, revision: i64) {
    conn.execute(
        "INSERT INTO cc_session_memberships(session_id, workspace_id, revision, bound_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?4)",
        params![session, workspace_id, revision, NOW],
    )
    .expect("seed membership");
}

pub(super) fn seed_goal_head(conn: &Connection, target: &TaskTarget, desired: i64, effective: i64) {
    let (kind, session_id, parent_session_id, delegation_id): (
        &str,
        Option<&str>,
        Option<&str>,
        Option<&str>,
    ) = match target {
        TaskTarget::Session { session_id } => ("session", Some(session_id.as_str()), None, None),
        TaskTarget::Delegation {
            parent_session_id,
            delegation_id,
        } => (
            "delegation",
            None,
            Some(parent_session_id.as_str()),
            Some(delegation_id.as_str()),
        ),
    };
    conn.execute(
        "INSERT INTO cc_goal_heads(task_key, kind, session_id, parent_session_id, delegation_id,
           desired_revision, effective_revision, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            target.key(),
            kind,
            session_id,
            parent_session_id,
            delegation_id,
            desired,
            effective,
            NOW
        ],
    )
    .expect("seed goal head");
}

/// Seed the immutable revision rows that lead up to a seeded head, so
/// `parentRevision` points at a revision that really exists.
pub(super) fn seed_goal_history(conn: &Connection, target: &TaskTarget, desired: i64) {
    for revision in 1..=desired {
        conn.execute(
            "INSERT INTO cc_goal_revisions(task_key, revision, objective, constraints_json,
               actor, request_id, parent_revision, created_at)
             VALUES(?1, ?2, ?3, '[]', ?4, ?5, ?6, ?7)",
            params![
                target.key(),
                revision,
                format!("Seeded objective {revision}"),
                PRINCIPAL,
                REQUEST_ID,
                (revision > 1).then_some(revision - 1),
                NOW
            ],
        )
        .expect("seed goal revision");
    }
}

pub(super) fn session_execution(session: &str) -> ExecutionTarget {
    ExecutionTarget::session(session, "turn-1")
}

pub(super) fn child_execution(
    parent_turn: &str,
    delegation: &str,
    generation: i64,
) -> ExecutionTarget {
    ExecutionTarget::delegation(PARENT_SESSION, parent_turn, delegation, generation)
}

/// The exact concrete execution the control fixture addresses.
pub(super) fn fixture_execution() -> ExecutionTarget {
    child_execution(PARENT_TURN, DELEGATION, 2)
}

pub(super) fn fixture_task() -> TaskTarget {
    TaskTarget::delegation(PARENT_SESSION, DELEGATION)
}

/// Stable goal owner of the fixture's parent session, as its own task key.
pub(super) fn parent_task() -> TaskTarget {
    TaskTarget::session(PARENT_SESSION)
}

pub(super) fn admit(
    conn: &Connection,
    workspace_id: &str,
    target: &ExecutionTarget,
    revision: i64,
) -> Result<reservation::Reservation> {
    reservation::reserve(
        conn,
        &reservation::ReservationRequest {
            target: target.clone(),
            workspace_id: workspace_id.to_owned(),
            expected_membership_revision: revision,
            owner_epoch: EPOCH.to_owned(),
            parent_key: None,
            now: NOW,
        },
    )
}

pub(super) fn transition(
    conn: &Connection,
    target: &ExecutionTarget,
    from: ReservationState,
    to: ReservationState,
    evidence: &str,
) -> Result<reservation::Reservation> {
    reservation::transition(
        conn,
        &reservation::ReservationTransition {
            execution_key: target.key(),
            owner_epoch: EPOCH.to_owned(),
            from,
            to,
            evidence: evidence.to_owned(),
            now: NOW + 1,
        },
    )
}

/// The frozen `command-center-control.json` request: `reviseGoal`, generation 2.
pub(super) fn fixture_request() -> InterventionRequest {
    InterventionRequest {
        version: 1,
        request_id: REQUEST_ID.to_owned(),
        host_id: HOST_ID.to_owned(),
        expected_host_epoch: EPOCH.to_owned(),
        command_workspace_id: WORKSPACE.to_owned(),
        expected_membership_revision: 7,
        expected_goal_revision: Some(4),
        target: fixture_execution(),
        intent: InterventionIntent::ReviseGoal {
            objective: "Ship the bounded command-center control contracts with executable \
                        fixtures."
                .to_owned(),
            constraints: vec![
                "Do not add Rust persistence in C1".to_owned(),
                "Keep existing IPC and RACP behavior unchanged".to_owned(),
            ],
        },
    }
}

/// The frozen Stop request: no goal fence, same concrete execution.
pub(super) fn fixture_stop() -> InterventionRequest {
    InterventionRequest {
        version: 1,
        request_id: STOP_REQUEST_ID.to_owned(),
        host_id: HOST_ID.to_owned(),
        expected_host_epoch: EPOCH.to_owned(),
        command_workspace_id: WORKSPACE.to_owned(),
        expected_membership_revision: 7,
        expected_goal_revision: None,
        target: fixture_execution(),
        intent: InterventionIntent::Stop {
            scope: StopScope::Subtree,
        },
    }
}

/// Workspace, membership at revision 7, goal head at 4/4 and the live child.
///
/// This is the state the shared fixture assumes: the request names desired
/// revision 4, so the committed result is 5 with effective still at 4.
pub(super) fn fixture_scene(conn: &Connection) {
    create_workspace(conn, WORKSPACE, "Alpha");
    seed_membership(conn, PARENT_SESSION, WORKSPACE, 7);
    seed_goal_head(conn, &fixture_task(), 4, 4);
    seed_goal_history(conn, &fixture_task(), 4);
    admit(conn, WORKSPACE, &fixture_execution(), 7).expect("admit the fixture child");
}

pub(super) fn receipt_count(conn: &Connection) -> i64 {
    row_count(conn, "cc_intervention_receipts")
}

pub(super) fn goal_revision_count(conn: &Connection) -> i64 {
    row_count(conn, "cc_goal_revisions")
}

pub(super) fn notification_count(conn: &Connection) -> i64 {
    row_count(conn, "cc_parent_notifications")
}

pub(super) fn row_count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .expect("count rows")
}

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read user_version")
}

fn object_count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )
    .expect("count objects")
}

#[test]
fn migration_adds_tables_without_touching_existing_data() {
    // Host scratch space instead of the OS temp directory: some managed
    // Windows hosts deny directory creation under the short-name temp path.
    let scratch = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
    std::fs::create_dir_all(&scratch).expect("repo target directory");
    let directory = tempfile::tempdir_in(&scratch).expect("temp directory");
    let path = directory.path().join("additive.sqlite");
    {
        let conn = Connection::open(&path).expect("open file database");
        conn.execute_batch(
            "PRAGMA user_version = 30;
             CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL);
             INSERT INTO sessions(id, title) VALUES('sess-keep', 'Kept work');",
        )
        .expect("seed a pre-existing user database");

        crate::db::command_center_migration::migrate(&conn).expect("migrate");

        // The versioned step that calls this helper owns the version bump.
        assert_eq!(
            user_version(&conn),
            30,
            "migrate must not bump user_version"
        );
        let title: String = conn
            .query_row(
                "SELECT title FROM sessions WHERE id = 'sess-keep'",
                [],
                |row| row.get(0),
            )
            .expect("existing row survived");
        assert_eq!(title, "Kept work");
        for table in super::SCHEMA_TABLES {
            assert_eq!(
                object_count(&conn, table),
                1,
                "{table} missing after migrate"
            );
        }

        // Idempotent: a second run changes nothing and does not fail.
        crate::db::command_center_migration::migrate(&conn).expect("migrate twice");
        for table in super::SCHEMA_TABLES {
            assert_eq!(object_count(&conn, table), 1, "{table} duplicated");
        }
    }
    // Reopening the file proves the definition persisted, not just this process.
    let conn = Connection::open(&path).expect("reopen file database");
    crate::db::command_center_migration::validate(&conn).expect("validate after reopen");
    drop(conn);
    std::fs::remove_file(&path).ok();
}

#[test]
fn validate_detects_storage_drift_and_migrate_repairs_it() {
    let conn = database();
    conn.execute_batch("DROP TRIGGER cc_intervention_receipts_retained;")
        .expect("drop the retention trigger");
    expect_error(
        crate::db::command_center_migration::validate(&conn),
        "CC_INVALID_SCHEMA",
    );
    // Re-running the additive migration restores a missing object.
    crate::db::command_center_migration::migrate(&conn).expect("repair");
}

#[test]
fn operations_fail_closed_without_the_migration() {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    expect_error(
        crate::db::command_center_migration::ensure(&conn),
        "CC_STORAGE_UNAVAILABLE",
    );
}

#[test]
fn at_most_three_workspaces_are_enabled() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    create_workspace(&conn, WORKSPACE_B, "Beta");
    create_workspace(&conn, WORKSPACE_C, "Gamma");

    let error = expect_error(
        workspace::create_workspace(&conn, WORKSPACE_D, "Delta", true, NOW),
        "CC_QUOTA_EXCEEDED",
    );
    assert!(error.contains('3'), "{error}");

    // A disabled workspace is saved but does not occupy an enabled slot.
    workspace::create_workspace(&conn, WORKSPACE_D, "Delta", false, NOW)
        .expect("save a disabled workspace");
    expect_error(
        workspace::set_workspace_enabled(&conn, WORKSPACE_D, 1, true, NOW),
        "CC_QUOTA_EXCEEDED",
    );

    workspace::set_workspace_enabled(&conn, WORKSPACE, 1, false, NOW).expect("disable Alpha");
    let enabled =
        workspace::set_workspace_enabled(&conn, WORKSPACE_D, 1, true, NOW).expect("enable Delta");
    assert!(enabled.enabled);
    assert_eq!(enabled.revision, 2);
}

#[test]
fn membership_cannot_move_while_the_session_is_live() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    create_workspace(&conn, WORKSPACE_B, "Beta");
    seed_membership(&conn, PARENT_SESSION, WORKSPACE, 7);
    let target = session_execution(PARENT_SESSION);
    admit(&conn, WORKSPACE, &target, 7).expect("admit");

    let request = workspace::BindSession {
        session_id: PARENT_SESSION.to_owned(),
        workspace_id: WORKSPACE_B.to_owned(),
        expected_revision: Some(7),
        now: NOW,
    };
    expect_error(
        workspace::bind_session(&conn, &request),
        "CC_MEMBERSHIP_LIVE",
    );
    assert_eq!(
        workspace::membership(&conn, PARENT_SESSION)
            .expect("read membership")
            .expect("membership exists")
            .workspace_id,
        WORKSPACE
    );

    transition(
        &conn,
        &target,
        ReservationState::Reserved,
        ReservationState::Failed,
        "launch_failed:spawn",
    )
    .expect("release the slot");

    let moved = workspace::bind_session(&conn, &request).expect("move once idle");
    assert_eq!(moved.workspace_id, WORKSPACE_B);
    assert_eq!(moved.revision, 8);
}

#[test]
fn workspace_cannot_be_disabled_while_it_holds_live_work() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, MAIN_SESSION, WORKSPACE, 1);
    let target = session_execution(MAIN_SESSION);
    admit(&conn, WORKSPACE, &target, 1).expect("admit");

    let error = expect_error(
        workspace::set_workspace_enabled(&conn, WORKSPACE, 1, false, NOW),
        "CC_WORKSPACE_LIVE",
    );
    assert!(error.contains('1'), "{error}");

    transition(
        &conn,
        &target,
        ReservationState::Reserved,
        ReservationState::Aborted,
        "owner_cancelled",
    )
    .expect("release");
    let disabled = workspace::set_workspace_enabled(&conn, WORKSPACE, 1, false, NOW)
        .expect("disable once idle");
    assert!(!disabled.enabled);
}

#[test]
fn workspace_delete_is_refused_once_history_exists() {
    let conn = database();
    workspace::create_workspace(&conn, WORKSPACE_D, "Delta", false, NOW)
        .expect("create an unused workspace");
    workspace::delete_workspace(&conn, WORKSPACE_D, 1).expect("delete a pristine workspace");
    assert!(workspace::workspace(&conn, WORKSPACE_D)
        .expect("read workspace")
        .is_none());

    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, MAIN_SESSION, WORKSPACE, 1);
    let error = expect_error(
        workspace::delete_workspace(&conn, WORKSPACE, 1),
        "CC_WORKSPACE_LIVE",
    );
    assert!(error.contains("disable"), "{error}");
}

#[test]
fn workspace_revision_fences_a_concurrent_rename() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    let renamed = workspace::rename_workspace(&conn, WORKSPACE, 1, "Alpha renamed", NOW)
        .expect("rename at revision 1");
    assert_eq!(renamed.revision, 2);
    expect_error(
        workspace::rename_workspace(&conn, WORKSPACE, 1, "Stale name", NOW),
        "CC_WORKSPACE_CONFLICT",
    );
    let stored = workspace::workspace(&conn, WORKSPACE)
        .expect("read workspace")
        .expect("workspace exists");
    assert_eq!(stored.name, "Alpha renamed");
}

#[test]
fn replaying_a_binding_needs_the_current_revision() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    let first = workspace::BindSession {
        session_id: MAIN_SESSION.to_owned(),
        workspace_id: WORKSPACE.to_owned(),
        expected_revision: None,
        now: NOW,
    };
    assert_eq!(
        workspace::bind_session(&conn, &first)
            .expect("bind")
            .revision,
        1
    );

    let replayed = workspace::BindSession {
        expected_revision: Some(1),
        ..first.clone()
    };
    assert_eq!(
        workspace::bind_session(&conn, &replayed)
            .expect("replay at the current revision")
            .revision,
        1
    );

    let stale = workspace::BindSession {
        workspace_id: WORKSPACE_B.to_owned(),
        expected_revision: Some(2),
        ..first
    };
    create_workspace(&conn, WORKSPACE_B, "Beta");
    expect_error(
        workspace::bind_session(&conn, &stale),
        "CC_MEMBERSHIP_CONFLICT",
    );
}

#[test]
fn admission_requires_a_membership_row() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    let target = session_execution("sess-unassigned");
    expect_error(admit(&conn, WORKSPACE, &target, 1), "CC_TARGET_NOT_FOUND");
}

#[test]
fn an_uncommitted_goal_head_reads_as_no_revision() {
    let conn = database();
    assert!(goal::goal_head(&conn, &fixture_task())
        .expect("read head")
        .is_none());
    let absent: Option<i64> = conn
        .query_row(
            "SELECT revision FROM cc_goal_revisions WHERE task_key = ?1",
            [fixture_task().key()],
            |row| row.get(0),
        )
        .optional()
        .expect("query revisions");
    assert!(absent.is_none());
    assert_eq!(Operation::ReviseGoal.as_str(), "reviseGoal");
}
