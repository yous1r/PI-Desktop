//! Additive command-center migration.
//!
//! The command-center tables are strictly additive: an existing user database
//! gains eight tables, three indexes and three retention triggers, and no
//! existing table, row or index is rewritten or dropped. There is therefore no
//! data transformation step and no reason to rewrite the database file.
//!
//! This helper deliberately does **not** own the schema version. The versioned
//! upgrade step that calls it owns `PRAGMA user_version`, the pre-migration
//! backup and the commit, so the command-center tables land inside one
//! version bump together with every other pending change rather than forcing a
//! version of their own. Call it from inside the caller's transaction:
//!
//! ```ignore
//! let tx = conn.unchecked_transaction()?;
//! db::command_center_migration::migrate(&tx)?;
//! tx.pragma_update(None, "user_version", next)?;
//! tx.commit()?;
//! ```
//!
//! The DDL is the same constant the fresh-create path uses, so a new database
//! and an upgraded one cannot drift. [`validate`] proves that by rebuilding the
//! definition in memory and comparing every `cc_*` object, including trigger
//! bodies.

use anyhow::{Context as _, Result};
use rusqlite::Connection;

use super::create_migration_backup;
use std::path::Path;

/// Create the command-center tables, indexes and triggers if they are missing.
///
/// Idempotent: re-running it on an already migrated database changes nothing.
/// Run it inside the caller's migration transaction.
pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(crate::command_center::SCHEMA_DDL)?;
    validate(conn)
}

/// Fail closed when a control operation runs against an unmigrated database.
pub(crate) fn ensure(conn: &Connection) -> Result<()> {
    crate::command_center::ensure_schema(conn)
}

/// Compare every live `cc_*` object with [`crate::command_center::SCHEMA_DDL`].
pub(crate) fn validate(conn: &Connection) -> Result<()> {
    crate::command_center::validate_schema(conn)
}

/// Versioned v30 -> v31 upgrade. Owns the pre-migration backup, the version
/// stamp and the transaction so the additive DDL lands in one atomic step.
pub(crate) fn migrate_v30_to_v31(conn: &Connection, path: &Path) -> Result<()> {
    let from: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    anyhow::ensure!(
        from == 30,
        "unsupported source schema for command center: {from}"
    );
    let backup = create_migration_backup(conn, path, from)?;
    let tx = conn.unchecked_transaction()?;
    migrate(&tx)?;
    tx.pragma_update(None, "user_version", 31i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v{from} to v31 command-center migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migration_backup_path, Database, SCHEMA_VERSION};

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user_version")
    }

    fn scratch() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        std::fs::create_dir_all(&root).expect("repo target directory");
        let directory = tempfile::tempdir_in(root).expect("scratch directory");
        let path = directory.path().join("pi.sqlite");
        (directory, path)
    }

    /// Remove the additive command-center objects so the file looks like v30.
    fn strip_command_center(conn: &Connection) {
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .expect("disable foreign keys");
        let mut objects: Vec<(String, String)> = conn
            .prepare(
                "SELECT type, name FROM sqlite_master
                 WHERE tbl_name LIKE 'cc_%' AND sql IS NOT NULL
                   AND type IN ('table', 'index', 'trigger')",
            )
            .expect("list command-center objects")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query objects")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect objects");
        let rank = |kind: &str| match kind {
            "trigger" => 0,
            "index" => 1,
            _ => 2,
        };
        objects.sort_by_key(|(kind, _)| rank(kind));
        for (kind, name) in objects {
            let keyword = match kind.as_str() {
                "trigger" => "TRIGGER",
                "index" => "INDEX",
                _ => "TABLE",
            };
            conn.execute_batch(&format!("DROP {keyword} IF EXISTS \"{name}\";"))
                .expect("drop command-center object");
        }
        conn.pragma_update(None, "user_version", 30i64)
            .expect("stamp v30");
    }

    #[test]
    fn fresh_database_is_current_and_has_command_center_tables() {
        let (_directory, path) = scratch();
        let db = Database::open(&path).expect("open fresh database");
        assert_eq!(SCHEMA_VERSION, 31);
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for table in crate::command_center::SCHEMA_TABLES {
            let exists: i64 = db
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("count table");
            assert_eq!(exists, 1, "{table} missing on a fresh database");
        }
        super::validate(db.conn()).expect("fresh schema validates");
    }

    #[test]
    fn upgrade_from_v30_is_atomic_and_keeps_existing_rows() {
        let (_directory, path) = scratch();
        {
            let db = Database::open(&path).expect("open fresh database");
            db.kv_set("takeover", "kept", &serde_json::json!({"value": 7}))
                .expect("seed existing row");
            strip_command_center(db.conn());
            assert_eq!(version(db.conn()), 30);
        }
        let backup = migration_backup_path(&path, 30);

        let db = Database::open(&path).expect("upgrade v30 database");
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        let kept = db
            .kv_get("takeover", "kept")
            .expect("read existing row")
            .expect("existing row survived");
        assert_eq!(kept["value"], 7);
        for table in crate::command_center::SCHEMA_TABLES {
            let exists: i64 = db
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("count table");
            assert_eq!(exists, 1, "{table} missing after upgrade");
        }
        assert!(backup.exists(), "pre-migration backup {}", backup.display());
        drop(db);

        let reopened = Database::open(&path).expect("reopen upgraded database");
        assert_eq!(version(reopened.conn()), SCHEMA_VERSION);
        assert_eq!(
            reopened
                .kv_get("takeover", "kept")
                .expect("read after reopen")
                .expect("row after reopen")["value"],
            7
        );
    }

    #[test]
    fn versioned_step_refuses_a_database_that_is_not_v30() {
        let (_directory, path) = scratch();
        let db = Database::open(&path).expect("open fresh database");
        let error = migrate_v30_to_v31(db.conn(), &path).expect_err("wrong source version");
        assert!(format!("{error}").contains("unsupported source schema"));
    }
}
