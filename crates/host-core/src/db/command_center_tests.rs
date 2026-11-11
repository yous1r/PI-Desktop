//! Populated profile upgrades use the real Database::open entry point.
use super::*;

fn remove_command_center(conn: &Connection) {
    conn.execute_batch(
        "DROP TABLE cc_parent_notifications;
         DROP TABLE cc_intervention_receipts;
         DROP TABLE cc_goal_revisions;
         DROP TABLE cc_goal_heads;
         DROP TABLE cc_reservation_events;
         DROP TABLE cc_execution_reservations;
         DROP TABLE cc_session_memberships;
         DROP TABLE cc_workspaces;
         PRAGMA user_version=30;",
    ).unwrap();
}
fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap()
}
fn seed_profile(path: &Path) {
    let db = Database::open(path).unwrap();
    remove_command_center(db.conn());
    db.conn().execute_batch(
        "INSERT INTO sessions(id,title,created_at,updated_at)
           VALUES('kept-session','Existing conversation',1,2);
         INSERT INTO turns(id,session_id,status,started_at,ended_at)
           VALUES('kept-turn','kept-session','completed',1,2);
         INSERT INTO execution_owners(epoch,profile,record_json,retired)
           VALUES('kept-owner','kept-profile','{}',1);
         INSERT INTO owner_handoffs(id,profile,source_epoch,target_epoch,revision,phase,record_json)
           VALUES('kept-transfer','kept-profile','kept-owner','kept-target',2,'cancelled','{}');",
    ).unwrap();
    db.kv_set("app", "kept", &serde_json::json!({"content":["original",1]})).unwrap();
}

#[test]
fn command_center_v30_upgrade_preserves_existing_rows_backup_and_transcript() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    seed_profile(&path);
    let transcript = directory.path().join("retained-transcript.jsonl");
    std::fs::write(&transcript, b"retained transcript bytes\n").unwrap();
    let db = Database::open(&path).unwrap();
    assert_eq!(version(db.conn()), 31);
    command_center_migration::validate(db.conn()).unwrap();
    assert_eq!(db.kv_get("app", "kept").unwrap(), Some(serde_json::json!({"content":["original",1]})));
    for (table, column, id) in [
        ("sessions", "id", "kept-session"),
        ("turns", "id", "kept-turn"),
        ("execution_owners", "epoch", "kept-owner"),
        ("owner_handoffs", "id", "kept-transfer"),
    ] {
        let count: i64 = db.conn().query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE {column}=?1"),
            [id], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1, "{table}");
    }
    for table in crate::command_center::SCHEMA_TABLES {
        let count: i64 = db.conn().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "migration must not invent command-center work");
    }
    assert_eq!(std::fs::read(&transcript).unwrap(), b"retained transcript bytes\n");
    let backup_path = migration_backup_path(&path, 30);
    let backup = Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(version(&backup), 30);
    assert_eq!(backup.query_row("SELECT title FROM sessions WHERE id='kept-session'", [], |row| row.get::<_,String>(0)).unwrap(), "Existing conversation");
    let count: i64 = backup.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'cc_%'", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
    drop(backup);
    drop(db);
    let backup_bytes = std::fs::read(&backup_path).unwrap();
    let reopened = Database::open(&path).unwrap();
    assert_eq!(version(reopened.conn()), 31);
    assert_eq!(std::fs::read(&backup_path).unwrap(), backup_bytes, "reopen does not overwrite the pre-upgrade backup");
}

#[test]
fn command_center_failed_v30_upgrade_rolls_back_and_keeps_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    seed_profile(&path);
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE cc_workspaces(unexpected TEXT); INSERT INTO cc_workspaces VALUES('preserved');").unwrap();
    }
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 30);
    assert_eq!(conn.query_row("SELECT unexpected FROM cc_workspaces", [], |row| row.get::<_,String>(0)).unwrap(), "preserved");
    let created: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='cc_session_memberships'", [], |row| row.get(0)).unwrap();
    assert_eq!(created, 0, "partial DDL must roll back");
    assert!(migration_backup_path(&path, 30).is_file());
    assert_eq!(conn.query_row("SELECT title FROM sessions WHERE id='kept-session'", [], |row| row.get::<_,String>(0)).unwrap(), "Existing conversation");
}

#[test]
fn command_center_current_schema_refuses_missing_retention_trigger() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn().execute_batch("DROP TRIGGER cc_intervention_receipts_retained;").unwrap();
    }
    assert!(Database::open(&path).is_err(), "missing retention is not a healthy database");
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 31);
    let triggers: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='cc_intervention_receipts_retained'", [], |row| row.get(0)).unwrap();
    assert_eq!(triggers, 0, "validation must not silently repair a current schema");
}

#[test]
fn command_center_current_schema_refuses_missing_capacity_index() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn().execute_batch("DROP INDEX idx_cc_reservations_workspace;").unwrap();
    }
    assert!(Database::open(&path).is_err(), "bounded capacity queries need their migration index");
}

#[test]
fn command_center_fresh_and_upgraded_schema_are_identical() {
    let fresh_directory = tempfile::tempdir().unwrap();
    let old_directory = tempfile::tempdir().unwrap();
    let path = old_directory.path().join("pi.sqlite");
    seed_profile(&path);
    let upgraded = Database::open(&path).unwrap();
    let fresh = Database::open_in_dir(fresh_directory.path()).unwrap();
    fn objects(conn: &Connection) -> Vec<(String, String)> {
        let mut statement = conn.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'cc_*' OR name GLOB 'idx_cc_*' ORDER BY name").unwrap();
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }
    assert_eq!(objects(upgraded.conn()), objects(fresh.conn()));
    assert_eq!(version(upgraded.conn()), version(fresh.conn()));
}
