//! Additive v30 ownership journal. Records never cascade from user sessions.
use super::{create_migration_backup, Connection, Context, Path, Result};

pub(crate) const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS execution_owners (
  sequence INTEGER PRIMARY KEY,
  epoch TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) <= 16384),
  retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_owner_active
  ON execution_owners(profile) WHERE retired = 0;
CREATE TABLE IF NOT EXISTS execution_generations (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  owner_epoch TEXT NOT NULL REFERENCES execution_owners(epoch),
  record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) <= 16384),
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_generation_active
  ON execution_generations(owner_epoch) WHERE closed = 0;
CREATE TABLE IF NOT EXISTS owner_handoffs (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL,
  source_epoch TEXT NOT NULL REFERENCES execution_owners(epoch),
  target_epoch TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  phase TEXT NOT NULL CHECK(phase IN ('prepared', 'source_fencing', 'source_fenced',
    'release_pending', 'target_claimed', 'ready', 'cancelled')),
  record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) <= 16384)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_handoff_active
  ON owner_handoffs(profile) WHERE phase NOT IN ('ready', 'cancelled');
CREATE TABLE IF NOT EXISTS owner_handoff_receipts (
  sequence INTEGER PRIMARY KEY,
  principal TEXT NOT NULL,
  request_id TEXT NOT NULL,
  transfer_id TEXT NOT NULL REFERENCES owner_handoffs(id),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 16384),
  UNIQUE(principal, request_id)
);
CREATE INDEX IF NOT EXISTS idx_owner_handoff_receipts_transfer
  ON owner_handoff_receipts(transfer_id, sequence);
"#;

fn schema(conn: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
    let mut statement = conn.prepare(
        "SELECT name, type, sql FROM sqlite_master
         WHERE tbl_name IN ('execution_owners', 'execution_generations',
           'owner_handoffs', 'owner_handoff_receipts') ORDER BY name",
    )?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn validate(conn: &Connection) -> Result<()> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(DDL)?;
    if schema(conn)? != schema(&expected)? {
        anyhow::bail!("HANDOFF_INVALID_SCHEMA");
    }
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let from: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    anyhow::ensure!(
        from == 29,
        "unsupported source schema for ownership: {from}"
    );
    let backup = create_migration_backup(conn, path, from)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(DDL)?;
    validate(&tx)?;
    tx.pragma_update(None, "user_version", 30i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v29 to v30 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
