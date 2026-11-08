use super::*;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::Connection;
use std::cell::RefCell;
use std::time::Duration;

#[derive(Clone, Copy)]
enum ContentionPoint {
    BeforeExpiry,
    AfterExpiry,
}

struct Writer {
    conn: Connection,
    started: bool,
    release_on_busy: bool,
    committed: bool,
    error: Option<String>,
}

impl Writer {
    fn start(&mut self) {
        self.started = true;
        if let Err(error) = self.conn.execute_batch(
            "BEGIN IMMEDIATE;
             INSERT INTO audit_log (ts, kind, payload_json)
             VALUES (0, 'contention_fixture', '{}');",
        ) {
            self.error = Some(error.to_string());
        }
    }
}

// SQLite callbacks cannot capture state. Each test owns its two connections on
// one thread; neither sleeps nor scheduling races determine when the writer exits.
thread_local! {
    static WRITER: RefCell<Option<Writer>> = const { RefCell::new(None) };
}

fn after_commit(event: TraceEvent<'_>) {
    if let TraceEvent::Profile(statement, _) = event {
        if statement.sql().trim_end_matches(';') == "COMMIT" {
            WRITER.with_borrow_mut(|writer| {
                if let Some(writer) = writer.as_mut().filter(|writer| !writer.started) {
                    writer.start();
                }
            });
        }
    }
}

fn release_writer(attempt: i32) -> bool {
    WRITER.with_borrow_mut(|writer| {
        let Some(writer) = writer.as_mut() else {
            return false;
        };
        if attempt != 0 || !writer.started || !writer.release_on_busy {
            return false;
        }
        match writer.conn.execute_batch("COMMIT") {
            Ok(()) => {
                writer.committed = true;
                true
            }
            Err(error) => {
                writer.error = Some(error.to_string());
                false
            }
        }
    })
}

struct WriterGuard<'a>(&'a Connection);

impl Drop for WriterGuard<'_> {
    fn drop(&mut self) {
        self.0.trace_v2(TraceEventCodes::empty(), None);
        self.0.busy_timeout(Duration::from_secs(5)).unwrap();
        // Dropping the independent connection rolls back a still-held writer,
        // including when the expected-success assertion fails on the old code.
        WRITER.with_borrow_mut(|writer| *writer = None);
    }
}

fn with_writer<T>(
    db: &Database,
    path: &Path,
    point: ContentionPoint,
    release_on_busy: bool,
    operation: impl FnOnce() -> T,
) -> (T, bool) {
    let conn = Connection::open(path).unwrap();
    conn.busy_timeout(Duration::ZERO).unwrap();
    let mut writer = Writer {
        conn,
        started: false,
        release_on_busy,
        committed: false,
        error: None,
    };
    if matches!(point, ContentionPoint::BeforeExpiry) {
        writer.start();
    }
    WRITER.with_borrow_mut(|slot| {
        assert!(slot.is_none());
        *slot = Some(writer);
    });
    let _guard = WriterGuard(db.conn());
    db.conn().busy_handler(Some(release_writer)).unwrap();
    if matches!(point, ContentionPoint::AfterExpiry) {
        // The first transaction is lazy expiry. Start a new independent writer
        // after its commit, before the public resolve operation continues.
        db.conn()
            .trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(after_commit));
    }
    let result = operation();
    let committed = WRITER.with_borrow(|writer| {
        let writer = writer.as_ref().unwrap();
        assert!(writer.started, "the competing writer must acquire its lock");
        assert!(writer.error.is_none(), "writer failed: {:?}", writer.error);
        writer.committed
    });
    (result, committed)
}

fn proposal(db: &Database, root: &Path, kind: &str) -> PlanProposal {
    let session = sessions::create_session(
        db,
        Some("Contended approval".into()),
        Some(kind.into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = sessions::begin_turn(db, &session.id, None, None).unwrap();
    PlanManager
        .submit(
            db,
            PlanSubmitParams {
                workspace_root: root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "submit-contract",
                kind,
                title: "Contended approval",
                markdown: "# Contract\n- preserve atomic approval",
                question: "Proceed?",
            },
        )
        .unwrap()
}

fn approve(db: &Database, root: &Path, proposal: &PlanProposal) -> Result<PlanResolution> {
    PlanManager.resolve(
        db,
        PlanResolveParams {
            workspace_root: Some(root),
            proposal_id: &proposal.id,
            session_id: &proposal.session_id,
            turn_id: &proposal.turn_id,
            tool_call_id: &proposal.tool_call_id,
            version: Some(proposal.version),
            action: "approve",
            target_permission_mode: Some("accept-edits"),
        },
    )
}

fn audit_count(db: &Database, kind: &str) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE kind = ?1",
            [kind],
            |row| row.get(0),
        )
        .unwrap()
}

fn approval_waits_for_writer(point: ContentionPoint) {
    for kind in [KIND_PLAN, KIND_GOAL] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let proposal = proposal(&db, dir.path(), kind);
        let (result, writer_committed) = with_writer(&db, &path, point, true, || {
            approve(&db, dir.path(), &proposal)
        });
        let resolution = result.unwrap();
        assert!(writer_committed);
        let execution = resolution.execution.unwrap();
        assert_eq!(execution.kind, kind);
        assert_eq!(execution.state, EXECUTION_QUEUED);
        let session = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(session.summary.mode, "agent");
        assert_eq!(session.summary.permission_mode, "accept-edits");
        let duplicate = approve(&db, dir.path(), &proposal).unwrap();
        assert_eq!(duplicate.execution.unwrap().id, execution.id);
        assert_eq!(PlanManager.queued_executions(&db, None).unwrap().len(), 1);
        assert_eq!(audit_count(&db, "plan_approval_resolved"), 1);
        assert_eq!(audit_count(&db, "contention_fixture"), 1);
        assert_eq!(audit_count(&db, "plan_approval_expired"), 0);
    }
}

#[test]
fn approval_waits_for_writer_before_expiry() {
    approval_waits_for_writer(ContentionPoint::BeforeExpiry);
}

#[test]
fn approval_waits_for_writer_after_expiry() {
    approval_waits_for_writer(ContentionPoint::AfterExpiry);
}

#[test]
fn lazy_expiry_waits_for_writer_and_audits_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let proposal = proposal(&db, dir.path(), KIND_PLAN);
    db.conn()
        .execute(
            "UPDATE plan_approvals SET expires_at = 1 WHERE request_id = ?1",
            [&proposal.id],
        )
        .unwrap();
    let (result, writer_committed) =
        with_writer(&db, &path, ContentionPoint::BeforeExpiry, true, || {
            PlanManager.pending_for_session(&db, Some(&proposal.session_id))
        });
    assert!(result.unwrap().is_empty());
    assert!(writer_committed);
    assert!(PlanManager
        .pending_for_session(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());
    let expired = get_proposal(&db, &proposal.id).unwrap().unwrap();
    assert_eq!(expired.status, STATUS_EXPIRED);
    assert_eq!(expired.version, proposal.version + 1);
    assert_eq!(expired.error_code.as_deref(), Some("PLAN_APPROVAL_TIMEOUT"));
    assert_eq!(audit_count(&db, "plan_approval_expired"), 1);
    assert_eq!(audit_count(&db, "contention_fixture"), 1);
    assert!(PlanManager.queued_executions(&db, None).unwrap().is_empty());
}

#[test]
fn unreleased_writer_leaves_approval_and_session_unchanged() {
    for point in [ContentionPoint::BeforeExpiry, ContentionPoint::AfterExpiry] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let proposal = proposal(&db, dir.path(), KIND_PLAN);
        let before = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap();
        let (result, writer_committed) = with_writer(&db, &path, point, false, || {
            approve(&db, dir.path(), &proposal)
        });
        let error = result.unwrap_err();
        let sqlite = error.downcast_ref::<rusqlite::Error>().unwrap();
        assert_eq!(
            sqlite.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert!(!writer_committed);
        let pending = get_proposal(&db, &proposal.id).unwrap().unwrap();
        assert_eq!(pending.status, STATUS_PENDING);
        assert_eq!(pending.version, proposal.version);
        assert!(PlanManager.queued_executions(&db, None).unwrap().is_empty());
        let session = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(session.summary.mode, before.summary.mode);
        assert_eq!(
            session.summary.permission_mode,
            before.summary.permission_mode
        );
        assert_eq!(audit_count(&db, "plan_approval_resolved"), 0);
        assert_eq!(audit_count(&db, "contention_fixture"), 0);
    }
}

#[test]
fn approval_observes_expiry_committed_by_the_competing_writer() {
    for point in [ContentionPoint::BeforeExpiry, ContentionPoint::AfterExpiry] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let proposal = proposal(&db, dir.path(), KIND_PLAN);
        let (result, writer_committed) = with_writer(&db, &path, point, true, || {
            db.conn()
                .busy_handler(Some(|attempt| {
                    if attempt != 0 {
                        return false;
                    }
                    WRITER.with_borrow_mut(|writer| {
                        let writer = writer.as_mut().unwrap();
                        if let Err(error) = writer.conn.execute(
                            "UPDATE plan_approvals SET expires_at = 1 WHERE status = 'pending'",
                            [],
                        ) {
                            writer.error = Some(error.to_string());
                        }
                    });
                    release_writer(attempt)
                }))
                .unwrap();
            approve(&db, dir.path(), &proposal)
        });
        assert!(writer_committed);
        let expected = match point {
            ContentionPoint::BeforeExpiry => "PLAN_APPROVAL_TIMEOUT",
            ContentionPoint::AfterExpiry => "PLAN_APPROVAL_STALE",
        };
        assert_eq!(result.unwrap_err().to_string(), expected);
        assert!(PlanManager.queued_executions(&db, None).unwrap().is_empty());
        let session = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(session.summary.mode, KIND_PLAN);
        assert_eq!(session.summary.permission_mode, "inherit");
        assert_eq!(audit_count(&db, "plan_approval_resolved"), 0);
        assert_eq!(audit_count(&db, "contention_fixture"), 1);
        assert!(PlanManager
            .pending_for_session(&db, Some(&proposal.session_id))
            .unwrap()
            .is_empty());
        assert_eq!(audit_count(&db, "plan_approval_expired"), 1);
    }
}
