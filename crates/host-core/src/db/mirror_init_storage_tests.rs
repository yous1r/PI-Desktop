//! Tests for the mirror initialization storage added in schema v29: the
//! additive migration, the state row, the step receipts, their validation, and
//! the cascade that removes a project group's initialization state with the
//! group.

use super::*;

fn schema_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn assert_readable_backup(path: &Path, version: i64) {
    let backup_path = migration_backup_path(path, version);
    assert!(
        backup_path.exists(),
        "missing {} backup",
        backup_path.display()
    );
    let backup = Connection::open(&backup_path).unwrap();
    assert_eq!(schema_version(&backup), version);
    let integrity: String = backup
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}

fn receipt(step: &str) -> String {
    format!("{{\"version\":1,\"step\":\"{step}\"}}")
}

fn failure(step: MirrorInitStep) -> MirrorInitFailure {
    MirrorInitFailure {
        code: "HELPER_START_FAILED".into(),
        message: "The remote helper did not report readiness".into(),
        step,
    }
}

#[test]
fn fresh_database_opens_at_v29_with_mirror_init_tables() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(SCHEMA_VERSION, 29);
    assert_eq!(schema_version(db.conn()), 29);
    for table in ["mirror_init", "mirror_init_receipt"] {
        assert!(table_exists(db.conn(), table), "missing {table}");
    }
    let index: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            params!["idx_mirror_init_receipt_project"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(index, 1, "missing idx_mirror_init_receipt_project");

    // A project nobody initialized has no state row at all; the state machine
    // reads that as needs-init instead of inventing a stored default.
    assert!(db.get_mirror_init("group-fresh").unwrap().is_none());
    assert!(db
        .list_mirror_init_receipts("group-fresh")
        .unwrap()
        .is_empty());
}

/// A real v28 database has neither table. The upgrade must add both, keep the
/// v28 rows, and leave a readable pre-migration backup.
#[test]
fn v28_database_gains_mirror_init_storage_without_losing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.replace_mirror_baseline(
            "group-v28",
            &[MirrorBaselineEntry {
                rel_path: "src/main.rs".into(),
                size: 3,
                mtime_ms: 4,
                sha256: "a".repeat(64),
                synced_at: 5,
            }],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE mirror_init_receipt;
                 DROP TABLE mirror_init;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 28).unwrap();
    }

    let db = Database::open(&path).unwrap();
    assert_eq!(schema_version(db.conn()), SCHEMA_VERSION);
    assert_readable_backup(&path, 28);
    assert!(table_exists(db.conn(), "mirror_init"));
    assert!(table_exists(db.conn(), "mirror_init_receipt"));
    // The v28 mirror state is untouched by an additive step.
    assert_eq!(db.list_mirror_baseline("group-v28").unwrap().len(), 1);
    assert!(db.get_mirror_init("group-v28").unwrap().is_none());
}

/// A database that already carries the tables but reports v28 — an interrupted
/// launch, or a fixture downgraded in place — must migrate again without
/// losing the rows the first run created.
#[test]
fn mirror_init_migration_is_idempotent_on_a_second_run() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.set_mirror_init_state(
            "group-idem",
            MirrorInitState::Initializing,
            Some(MirrorInitStep::Ssh),
            None,
        )
        .unwrap();
        db.upsert_mirror_init_receipt("group-idem", MirrorInitStep::Ssh, &receipt("ssh"), 10)
            .unwrap();
        db.conn().pragma_update(None, "user_version", 28).unwrap();
    }

    let db = Database::open(&path).unwrap();
    assert_eq!(schema_version(db.conn()), SCHEMA_VERSION);
    assert_readable_backup(&path, 28);
    let state = db.get_mirror_init("group-idem").unwrap().unwrap();
    assert_eq!(state.state, MirrorInitState::Initializing);
    assert_eq!(state.step, Some(MirrorInitStep::Ssh));
    assert_eq!(db.list_mirror_init_receipts("group-idem").unwrap().len(), 1);
}

#[test]
fn state_transitions_round_trip_and_keep_the_first_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-state";

    let started = db
        .set_mirror_init_state(
            project,
            MirrorInitState::Initializing,
            Some(MirrorInitStep::Ssh),
            None,
        )
        .unwrap();
    assert_eq!(started.state, MirrorInitState::Initializing);
    assert_eq!(started.step, Some(MirrorInitStep::Ssh));
    assert!(started.error.is_none());
    let created_at = started.created_at;

    let failed = db
        .set_mirror_init_state(
            project,
            MirrorInitState::InitFailed,
            Some(MirrorInitStep::HelperStart),
            Some(&failure(MirrorInitStep::HelperStart)),
        )
        .unwrap();
    assert_eq!(failed.state, MirrorInitState::InitFailed);
    assert_eq!(failed.step, Some(MirrorInitStep::HelperStart));
    let stored_error = failed.error.clone().unwrap();
    assert_eq!(stored_error.code, "HELPER_START_FAILED");
    assert_eq!(stored_error.step, MirrorInitStep::HelperStart);
    // The failure row is a rewrite of the same project row, not a second one.
    assert_eq!(failed.created_at, created_at);
    assert!(failed.updated_at >= failed.created_at);

    let ready = db
        .set_mirror_init_state(project, MirrorInitState::Ready, None, None)
        .unwrap();
    assert_eq!(ready.state, MirrorInitState::Ready);
    assert!(ready.step.is_none());
    assert!(ready.error.is_none());
    assert_eq!(ready.created_at, created_at);
    assert_eq!(
        db.get_mirror_init(project).unwrap().unwrap().state,
        MirrorInitState::Ready
    );

    let needs_init = db
        .set_mirror_init_state(project, MirrorInitState::NeedsInit, None, None)
        .unwrap();
    assert_eq!(needs_init.state, MirrorInitState::NeedsInit);
}

/// A row that contradicts itself would make the next resume guess.
#[test]
fn state_rows_refuse_contradictions_and_untyped_failures() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-contradiction";

    // ready next to a failure reports success and an error at once.
    assert!(db
        .set_mirror_init_state(
            project,
            MirrorInitState::Ready,
            None,
            Some(&failure(MirrorInitStep::Manifest)),
        )
        .is_err());
    // initializing without a step cannot say what to resume.
    assert!(db
        .set_mirror_init_state(project, MirrorInitState::Initializing, None, None)
        .is_err());
    // needs-init is the absence of a run, so it carries neither step nor error.
    assert!(db
        .set_mirror_init_state(
            project,
            MirrorInitState::NeedsInit,
            Some(MirrorInitStep::Ssh),
            None
        )
        .is_err());
    // init-failed must name the failing step.
    assert!(db
        .set_mirror_init_state(project, MirrorInitState::InitFailed, None, None)
        .is_err());
    let mismatched = MirrorInitFailure {
        code: "MIRROR_INIT_FAILED".into(),
        message: "The mirror initialization step failed".into(),
        step: MirrorInitStep::EnvVerify,
    };
    assert!(db
        .set_mirror_init_state(
            project,
            MirrorInitState::InitFailed,
            Some(MirrorInitStep::Manifest),
            Some(&mismatched),
        )
        .is_err());

    // A diagnostic string is not a renderer-localizable code.
    let raw_stderr = MirrorInitFailure {
        code: "ssh: connect to host dev-box port 22: Connection refused".into(),
        message: "failed".into(),
        step: MirrorInitStep::Ssh,
    };
    assert!(db
        .set_mirror_init_state(
            project,
            MirrorInitState::InitFailed,
            Some(MirrorInitStep::Ssh),
            Some(&raw_stderr),
        )
        .is_err());
    let blank_message = MirrorInitFailure {
        code: "REMOTE_CONNECTION_FAILED".into(),
        message: "   ".into(),
        step: MirrorInitStep::Ssh,
    };
    assert!(db
        .set_mirror_init_state(
            project,
            MirrorInitState::InitFailed,
            Some(MirrorInitStep::Ssh),
            Some(&blank_message),
        )
        .is_err());

    assert!(db.get_mirror_init(project).unwrap().is_none());
}

#[test]
fn receipts_round_trip_in_completion_order_and_replace_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-receipts";

    db.upsert_mirror_init_receipt(project, MirrorInitStep::Ssh, &receipt("ssh"), 10)
        .unwrap();
    db.upsert_mirror_init_receipt(
        project,
        MirrorInitStep::HelperDir,
        &receipt("helper-dir"),
        20,
    )
    .unwrap();
    db.upsert_mirror_init_receipt(
        project,
        MirrorInitStep::HelperDeploy,
        &receipt("helper-deploy"),
        30,
    )
    .unwrap();

    let listed = db.list_mirror_init_receipts(project).unwrap();
    assert_eq!(
        listed.iter().map(|row| row.step).collect::<Vec<_>>(),
        vec![
            MirrorInitStep::Ssh,
            MirrorInitStep::HelperDir,
            MirrorInitStep::HelperDeploy
        ]
    );
    assert_eq!(listed[0].receipt, receipt("ssh"));
    assert_eq!(listed[0].updated_at, 10);

    // A retry that reaches the same step replaces the evidence; a stale digest
    // never survives next to the current one.
    db.upsert_mirror_init_receipt(
        project,
        MirrorInitStep::HelperDeploy,
        &receipt("helper-deploy-v2"),
        40,
    )
    .unwrap();
    let listed = db.list_mirror_init_receipts(project).unwrap();
    assert_eq!(listed.len(), 3);
    let deploy = listed
        .iter()
        .find(|row| row.step == MirrorInitStep::HelperDeploy)
        .unwrap();
    assert_eq!(deploy.receipt, receipt("helper-deploy-v2"));
    assert_eq!(deploy.updated_at, 40);

    assert!(db
        .delete_mirror_init_receipt(project, MirrorInitStep::HelperDir)
        .unwrap());
    assert!(!db
        .delete_mirror_init_receipt(project, MirrorInitStep::HelperDir)
        .unwrap());
    assert_eq!(db.list_mirror_init_receipts(project).unwrap().len(), 2);
    assert_eq!(db.clear_mirror_init_receipts(project).unwrap(), 2);
    assert!(db.list_mirror_init_receipts(project).unwrap().is_empty());
}

/// Bytes this layer would store and then be unable to interpret must be
/// refused before anything is written.
#[test]
fn receipts_refuse_unknown_steps_and_unusable_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-receipt-validation";

    // The step identifiers the state machine uses are exactly the spec order.
    for step in MIRROR_INIT_STEP_ORDER {
        assert_eq!(
            MirrorInitStep::from_id(step.as_str()),
            Some(step),
            "round trip failed for {}",
            step.as_str()
        );
    }
    for unknown in ["", "ssh ", "SSH", "helper", "adapter-install "] {
        assert!(
            MirrorInitStep::from_id(unknown).is_none(),
            "accepted unknown step {unknown:?}"
        );
    }
    // An id this build does not know never becomes durable state: the CHECK
    // constraint is the last line of defense behind the enum.
    assert!(db
        .conn()
        .execute(
            "INSERT INTO mirror_init_receipt (project_id, step, receipt_json, updated_at)
             VALUES (?1, 'unknown-step', '{}', 1)",
            params![project],
        )
        .is_err());

    for bad in ["", "not json", "[]", "\"text\"", "{}x"] {
        assert!(
            db.upsert_mirror_init_receipt(project, MirrorInitStep::Ssh, bad, 1)
                .is_err(),
            "accepted receipt {bad:?}"
        );
    }
    let oversized = format!(
        "{{\"blob\":\"{}\"}}",
        "x".repeat(MAX_MIRROR_INIT_RECEIPT_BYTES)
    );
    assert!(db
        .upsert_mirror_init_receipt(project, MirrorInitStep::Ssh, &oversized, 1)
        .is_err());
    // A NUL byte cannot survive the TEXT round trip, so it is refused up front.
    assert!(db
        .upsert_mirror_init_receipt(project, MirrorInitStep::Ssh, "{\"a\":\"\u{0}\"}", 1)
        .is_err());
    assert!(db.list_mirror_init_receipts(project).unwrap().is_empty());

    assert!(db
        .upsert_mirror_init_receipt(project, MirrorInitStep::Ssh, "{}", 1)
        .is_ok());
}

#[test]
fn project_ids_are_validated_before_anything_is_stored() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let long_id = "g".repeat(201);

    for bad in [
        "",
        "   ",
        " group",
        "group ",
        "gr\u{0}oup",
        long_id.as_str(),
    ] {
        assert!(
            db.get_mirror_init(bad).is_err(),
            "accepted project id {bad:?}"
        );
        assert!(db
            .set_mirror_init_state(bad, MirrorInitState::Ready, None, None)
            .is_err());
        assert!(db
            .upsert_mirror_init_receipt(bad, MirrorInitStep::Ssh, "{}", 1)
            .is_err());
        assert!(db.list_mirror_init_receipts(bad).is_err());
    }
    assert!(db
        .set_mirror_init_state("group-ok", MirrorInitState::Ready, None, None)
        .is_ok());
}

/// Initialization state belongs to the project group. Removing the group
/// removes it, in the same transaction, while another group is untouched.
#[test]
fn deleting_a_project_group_removes_its_mirror_init_state() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let group = db
        .create_remote_project_group(
            "app",
            RemoteWorkspace {
                host_key: "dev-box".into(),
                path: "/srv/app".into(),
            },
        )
        .unwrap();
    let other = db
        .create_remote_project_group(
            "other",
            RemoteWorkspace {
                host_key: "dev-box".into(),
                path: "/srv/other".into(),
            },
        )
        .unwrap();
    for project in [group.id.as_str(), other.id.as_str()] {
        db.set_mirror_init_state(
            project,
            MirrorInitState::Initializing,
            Some(MirrorInitStep::HelperDeploy),
            None,
        )
        .unwrap();
        db.upsert_mirror_init_receipt(project, MirrorInitStep::Ssh, &receipt("ssh"), 1)
            .unwrap();
    }

    db.delete_project_group_record(&group.id).unwrap();
    assert!(db.get_mirror_init(&group.id).unwrap().is_none());
    assert!(db.list_mirror_init_receipts(&group.id).unwrap().is_empty());
    assert!(db.get_mirror_init(&other.id).unwrap().is_some());
    assert_eq!(db.list_mirror_init_receipts(&other.id).unwrap().len(), 1);
}
