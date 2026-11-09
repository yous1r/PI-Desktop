use super::*;

#[test]
fn owner_handoff_v27_upgrade_preserves_profile_and_keeps_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE IF EXISTS owner_handoff_receipts;
             DROP TABLE IF EXISTS owner_handoffs;
             DROP TABLE IF EXISTS execution_generations;
             DROP TABLE IF EXISTS execution_owners;
             PRAGMA user_version = 27;
             INSERT INTO sessions(id, title, created_at, updated_at)
               VALUES('kept-session', 'Existing conversation', 1, 2);",
            )
            .unwrap();
        db.kv_set(
            "app",
            "kept",
            &serde_json::json!({"nested": [1, "original"]}),
        )
        .unwrap();
    }
    let transcript = directory.path().join("kept-transcript.jsonl");
    std::fs::write(&transcript, b"existing transcript bytes\n").unwrap();
    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        version, SCHEMA_VERSION,
        "handoff records need a versioned migration"
    );
    assert!(migration_backup_path(&path, 27).is_file());
    assert_eq!(
        db.kv_get("app", "kept").unwrap(),
        Some(serde_json::json!({"nested": [1, "original"]}))
    );
    let title: String = db
        .conn()
        .query_row(
            "SELECT title FROM sessions WHERE id='kept-session'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(title, "Existing conversation");
    for table in [
        "execution_owners",
        "owner_handoffs",
        "owner_handoff_receipts",
    ] {
        let count: i64 = db
            .conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
    assert_eq!(
        std::fs::read(&transcript).unwrap(),
        b"existing transcript bytes\n"
    );
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened.kv_get("app", "kept").unwrap(),
        Some(serde_json::json!({"nested": [1, "original"]}))
    );
}

#[test]
fn owner_handoff_fresh_schema_has_retained_independent_tables() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    for table in [
        "execution_owners",
        "owner_handoffs",
        "owner_handoff_receipts",
    ] {
        let sql: String = db
            .conn()
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!sql.contains("REFERENCES sessions"));
        assert!(!sql.contains("ON DELETE CASCADE"));
    }
}

#[test]
fn owner_handoff_failed_migration_retains_version_and_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE owner_handoff_receipts;
            DROP TABLE owner_handoffs; DROP TABLE execution_generations;
            DROP TABLE execution_owners;
            CREATE TABLE execution_owners(unexpected TEXT);
            INSERT INTO execution_owners VALUES('preserved');
            PRAGMA user_version = 29;",
            )
            .unwrap();
    }
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 29);
    let value: String = conn
        .query_row("SELECT unexpected FROM execution_owners", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(value, "preserved");
    assert!(migration_backup_path(&path, 29).is_file());
}

#[test]
fn owner_handoff_v29_upgrade_retains_mode_and_profile_data() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.kv_set("app", "kept", &serde_json::json!("original"))
            .unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE owner_handoff_receipts; DROP TABLE owner_handoffs;
             DROP TABLE execution_generations; DROP TABLE execution_owners;
             PRAGMA user_version=29;",
            )
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.kv_get("app", "kept").unwrap(),
        Some(serde_json::json!("original"))
    );
    assert!(migration_backup_path(&path, 29).is_file());
    assert!(db.conn().prepare("SELECT * FROM mode_runs").is_ok());
    super::owner_handoff_migration::validate(db.conn()).unwrap();
}

#[test]
fn owner_handoff_legacy_v28_upgrade_retains_journal_rows() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO execution_owners(epoch,profile,record_json,retired)
               VALUES('retained-owner','retained-profile','{}',1);
             DROP TABLE mode_gate_results; DROP TABLE mode_runs; DROP TABLE mode_snapshots;
             ALTER TABLE sessions DROP COLUMN mode_snapshot_hash;
             PRAGMA user_version=28;",
            )
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    let row: String = db
        .conn()
        .query_row(
            "SELECT record_json FROM execution_owners WHERE epoch='retained-owner'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(row, "{}");
    assert!(migration_backup_path(&path, 28).is_file());
    assert!(migration_backup_path(&path, 29).is_file());
    assert!(db.conn().prepare("SELECT * FROM mode_runs").is_ok());
}
