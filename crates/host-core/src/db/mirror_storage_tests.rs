//! Tests for the remote-mirror storage added in schema v28: the additive
//! migration, the baseline/breakpoint repositories, their validation, and the
//! cascade that removes a project group's mirror state with the group.

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

fn entry(rel_path: &str, size: i64, mtime_ms: i64) -> MirrorBaselineEntry {
    MirrorBaselineEntry {
        rel_path: rel_path.to_string(),
        size,
        mtime_ms,
        sha256: "a".repeat(64),
        synced_at: 1_000,
    }
}

fn breakpoint(
    rel_path: &str,
    line: i64,
    column: i64,
    condition: Option<&str>,
    enabled: bool,
) -> MirrorBreakpointRecord {
    MirrorBreakpointRecord {
        rel_path: rel_path.to_string(),
        line,
        column,
        condition: condition.map(str::to_string),
        enabled,
        updated_at: 5,
    }
}

#[test]
fn fresh_database_opens_at_v28_with_mirror_tables() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(SCHEMA_VERSION, 28);
    assert_eq!(schema_version(db.conn()), 28);
    for table in ["mirror_sync_baseline", "mirror_breakpoints"] {
        assert!(table_exists(db.conn(), table), "missing {table}");
    }
    for index in [
        "idx_mirror_sync_baseline_project",
        "idx_mirror_breakpoints_project",
    ] {
        let present: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                params![index],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(present, 1, "missing {index}");
    }
}

/// A real v27 database has neither table. The upgrade must add both, keep the
/// v27 rows, and leave a readable pre-migration backup.
#[test]
fn v27_database_gains_mirror_storage_without_losing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let session_id = {
        let db = Database::open(&path).unwrap();
        db.conn()
            .execute(
                "INSERT INTO projects (path, name, pinned, created_at, last_opened_at)
                 VALUES ('/work/app', 'app', 1, 1, 2)",
                [],
            )
            .unwrap();
        let session =
            crate::sessions::create_session(&db, Some("Kept".into()), None, None, None, None)
                .unwrap();
        db.kv_set("app", "currentProjectId", &serde_json::json!("/work/app"))
            .unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE mirror_sync_baseline;
                 DROP TABLE mirror_breakpoints;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 27).unwrap();
        session.id
    };

    let db = Database::open(&path).unwrap();
    assert_eq!(schema_version(db.conn()), SCHEMA_VERSION);
    assert_readable_backup(&path, 27);
    assert!(table_exists(db.conn(), "mirror_sync_baseline"));
    assert!(table_exists(db.conn(), "mirror_breakpoints"));
    let (name, pinned): (String, i64) = db
        .conn()
        .query_row(
            "SELECT name, pinned FROM projects WHERE path = '/work/app'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((name.as_str(), pinned), ("app", 1));
    assert!(crate::sessions::get_session(&db, &session_id)
        .unwrap()
        .is_some());
    assert_eq!(
        db.kv_get("app", "currentProjectId").unwrap(),
        Some(serde_json::json!("/work/app"))
    );
    assert!(db.list_mirror_baseline("group-1").unwrap().is_empty());
}

/// A database that already carries the tables but reports v27 — an interrupted
/// launch, or a fixture downgraded in place — must migrate again without
/// losing the rows the first run created.
#[test]
fn mirror_storage_migration_is_idempotent_on_a_second_run() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.replace_mirror_baseline("group-1", &[entry("src/main.rs", 10, 20)])
            .unwrap();
        db.upsert_mirror_breakpoint("group-1", &breakpoint("src/main.rs", 12, 0, None, true))
            .unwrap();
        db.conn().pragma_update(None, "user_version", 27).unwrap();
    }

    let db = Database::open(&path).unwrap();
    assert_eq!(schema_version(db.conn()), SCHEMA_VERSION);
    assert_readable_backup(&path, 27);
    assert_eq!(db.list_mirror_baseline("group-1").unwrap().len(), 1);
    assert_eq!(db.list_mirror_breakpoints("group-1").unwrap().len(), 1);
}

#[test]
fn baseline_replace_list_upsert_delete_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-baseline";

    db.replace_mirror_baseline(
        project,
        &[entry("src/b.rs", 20, 200), entry("src/a.rs", 10, 100)],
    )
    .unwrap();
    let listed = db.list_mirror_baseline(project).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|row| row.rel_path.as_str())
            .collect::<Vec<_>>(),
        vec!["src/a.rs", "src/b.rs"]
    );
    assert_eq!((listed[0].size, listed[0].mtime_ms), (10, 100));
    assert_eq!(listed[0].sha256, "a".repeat(64));

    // Upsert overwrites the same path instead of adding a row.
    db.upsert_mirror_baseline_entry(project, &entry("src/a.rs", 11, 101))
        .unwrap();
    let listed = db.list_mirror_baseline(project).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!((listed[0].size, listed[0].mtime_ms), (11, 101));

    // Upsert also inserts a path the baseline did not have.
    db.upsert_mirror_baseline_entry(project, &entry("README.md", 5, 50))
        .unwrap();
    assert_eq!(db.list_mirror_baseline(project).unwrap().len(), 3);

    assert!(db
        .delete_mirror_baseline_entry(project, "src/b.rs")
        .unwrap());
    assert!(!db
        .delete_mirror_baseline_entry(project, "src/b.rs")
        .unwrap());
    assert_eq!(db.list_mirror_baseline(project).unwrap().len(), 2);

    // Replace is a full replacement, not a merge.
    db.replace_mirror_baseline(project, &[entry("only.rs", 1, 1)])
        .unwrap();
    let listed = db.list_mirror_baseline(project).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].rel_path, "only.rs");

    assert_eq!(db.clear_mirror_baseline(project).unwrap(), 1);
    assert!(db.list_mirror_baseline(project).unwrap().is_empty());
}

/// One bad or oversized batch must leave the previous baseline exactly as it
/// was: a rescan either lands completely or not at all.
#[test]
fn replace_mirror_baseline_is_atomic_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-bounded";
    db.replace_mirror_baseline(project, &[entry("keep.rs", 1, 1)])
        .unwrap();

    let rejected = db.replace_mirror_baseline(
        project,
        &[entry("src/ok.rs", 1, 1), entry("../escape.rs", 1, 1)],
    );
    assert!(rejected.is_err());
    let listed = db.list_mirror_baseline(project).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].rel_path, "keep.rs");

    // A repeated path inside one batch is a caller bug, not a constraint error.
    assert!(db
        .replace_mirror_baseline(project, &[entry("a.rs", 1, 1), entry("a.rs", 2, 2)])
        .is_err());
    assert_eq!(db.list_mirror_baseline(project).unwrap().len(), 1);

    let oversized = (0..=MAX_MIRROR_ROWS_PER_WRITE)
        .map(|index| entry(&format!("f{index}.rs"), 1, 1))
        .collect::<Vec<_>>();
    assert!(db.replace_mirror_baseline(project, &oversized).is_err());
    assert_eq!(db.list_mirror_baseline(project).unwrap().len(), 1);

    let oversized_breakpoints = (0..=MAX_MIRROR_ROWS_PER_WRITE)
        .map(|line| breakpoint("src/main.rs", line as i64 + 1, 0, None, true))
        .collect::<Vec<_>>();
    assert!(db
        .replace_mirror_breakpoints(project, &oversized_breakpoints)
        .is_err());
    assert!(db.list_mirror_breakpoints(project).unwrap().is_empty());
}

#[test]
fn breakpoint_upsert_is_idempotent_per_position() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-breakpoints";

    db.upsert_mirror_breakpoint(project, &breakpoint("src/main.rs", 12, 0, None, true))
        .unwrap();
    db.upsert_mirror_breakpoint(
        project,
        &breakpoint("src/main.rs", 12, 0, Some("i == 3"), false),
    )
    .unwrap();
    let listed = db.list_mirror_breakpoints(project).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].condition.as_deref(), Some("i == 3"));
    assert!(!listed[0].enabled);
    assert_eq!(listed[0].updated_at, 5);

    // A column breakpoint is a different position, not an overwrite.
    db.upsert_mirror_breakpoint(project, &breakpoint("src/main.rs", 12, 4, None, true))
        .unwrap();
    assert_eq!(db.list_mirror_breakpoints(project).unwrap().len(), 2);

    // Replace shrinks the stored set; the editor never holds it authoritatively.
    db.replace_mirror_breakpoints(project, &[breakpoint("src/lib.rs", 3, 0, None, true)])
        .unwrap();
    let listed = db.list_mirror_breakpoints(project).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].rel_path, "src/lib.rs");

    assert!(db
        .delete_mirror_breakpoint(project, "src/lib.rs", 3, 0)
        .unwrap());
    assert!(!db
        .delete_mirror_breakpoint(project, "src/lib.rs", 3, 0)
        .unwrap());
    assert!(db.list_mirror_breakpoints(project).unwrap().is_empty());
}

/// Mirror state belongs to the project group. Removing the group removes it,
/// in the same transaction, while another group's state is untouched.
#[test]
fn deleting_a_project_group_removes_its_mirror_state() {
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
        db.replace_mirror_baseline(project, &[entry("src/main.rs", 3, 4)])
            .unwrap();
        db.upsert_mirror_breakpoint(project, &breakpoint("src/main.rs", 7, 0, None, true))
            .unwrap();
    }

    db.delete_project_group_record(&group.id).unwrap();
    assert!(db.list_mirror_baseline(&group.id).unwrap().is_empty());
    assert!(db.list_mirror_breakpoints(&group.id).unwrap().is_empty());
    assert_eq!(db.list_mirror_baseline(&other.id).unwrap().len(), 1);
    assert_eq!(db.list_mirror_breakpoints(&other.id).unwrap().len(), 1);
}

/// A row the helper would refuse to transfer must never become durable state.
#[test]
fn mirror_paths_refuse_escaping_absolute_and_credential_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-paths";

    for bad in [
        "",
        "../x",
        "src/../../x",
        "..",
        "/abs/x",
        "C:/x",
        "a\\b",
        "a//b",
        "./a",
        "a/",
        ".env",
        "sub/.env.local",
        ".ssh/id_ed25519",
        "id_rsa.pem",
        "certs/server.key",
    ] {
        assert!(
            db.upsert_mirror_baseline_entry(project, &entry(bad, 1, 1))
                .is_err(),
            "baseline accepted {bad:?}"
        );
        assert!(
            db.upsert_mirror_breakpoint(project, &breakpoint(bad, 1, 0, None, true))
                .is_err(),
            "breakpoint accepted {bad:?}"
        );
    }
    assert!(db.delete_mirror_baseline_entry(project, "../x").is_err());
    assert!(db
        .delete_mirror_breakpoint(project, "/abs/x", 1, 0)
        .is_err());
    assert!(db.replace_mirror_baseline(project, &[]).is_ok());
    assert!(db.replace_mirror_breakpoints(project, &[]).is_ok());

    db.upsert_mirror_baseline_entry(project, &entry("src/main.rs", 1, 1))
        .unwrap();
    assert_eq!(db.list_mirror_baseline(project).unwrap().len(), 1);
}

#[test]
fn mirror_baseline_values_are_validated() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-values";

    let mut negative_size = entry("src/main.rs", -1, 1);
    assert!(db
        .upsert_mirror_baseline_entry(project, &negative_size)
        .is_err());
    negative_size.size = 1;
    negative_size.mtime_ms = -1;
    assert!(db
        .upsert_mirror_baseline_entry(project, &negative_size)
        .is_err());

    let mut short_hash = entry("src/main.rs", 1, 1);
    short_hash.sha256 = "abc".into();
    assert!(db
        .upsert_mirror_baseline_entry(project, &short_hash)
        .is_err());
    short_hash.sha256 = "z".repeat(64);
    assert!(db
        .upsert_mirror_baseline_entry(project, &short_hash)
        .is_err());
    assert!(db.list_mirror_baseline(project).unwrap().is_empty());
}

#[test]
fn mirror_breakpoints_refuse_invalid_positions() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = "group-positions";

    for (line, column) in [(0, 0), (-1, 0), (1, -1)] {
        assert!(
            db.upsert_mirror_breakpoint(
                project,
                &breakpoint("src/main.rs", line, column, None, true)
            )
            .is_err(),
            "accepted line {line} column {column}"
        );
    }
    assert!(db
        .delete_mirror_breakpoint(project, "src/main.rs", 0, 0)
        .is_err());
    assert!(db
        .delete_mirror_breakpoint(project, "src/main.rs", 1, -1)
        .is_err());

    let long_condition = "x".repeat(513);
    assert!(db
        .upsert_mirror_breakpoint(
            project,
            &breakpoint("src/main.rs", 1, 0, Some(&long_condition), true)
        )
        .is_err());

    db.upsert_mirror_breakpoint(project, &breakpoint("src/main.rs", 1, 0, None, true))
        .unwrap();
    assert_eq!(db.list_mirror_breakpoints(project).unwrap().len(), 1);
}
