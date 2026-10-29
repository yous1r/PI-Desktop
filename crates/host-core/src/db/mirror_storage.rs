//! Durable state for a remote mirror project: the drift-detection baseline and
//! the breakpoint set (spec 23 §6.2 / §7.2, persistence table in §8).
//!
//! Both tables are keyed by the owning project group id. A project group is a
//! `kv(projectGroups)` record rather than a table, so there is no foreign key
//! to cascade through: group-owned rows are removed by
//! [`Database::delete_project_group_record`] in the same transaction that drops
//! the group record, exactly like `projectGroupMemory` and
//! `projectGroupInstructions`.
//!
//! Every write validates its input first. A row that the helper would refuse to
//! transfer (an escaping, absolute, backslash or credential-shaped path) must
//! never become durable state, so it cannot be discovered later as a "synced"
//! file that does not exist on the host.

use super::*;

/// Upper bound on one replace call. A real project does not hold more files or
/// breakpoints than this, so a larger batch is a caller bug; refusing it keeps
/// one write from holding the single writer for an unbounded time.
pub const MAX_MIRROR_ROWS_PER_WRITE: usize = 100_000;

const MAX_MIRROR_PROJECT_ID_CHARS: usize = 200;
const MAX_MIRROR_REL_PATH_BYTES: usize = 4096;
const MAX_MIRROR_CONDITION_BYTES: usize = 512;
const SHA256_HEX_CHARS: usize = 64;

/// Shared verbatim by the fresh schema and the v27 -> v28 migration;
/// `IF NOT EXISTS` keeps a second run harmless.
///
/// The CHECK constraints are defense in depth behind the Rust validation
/// below: the repository layer is the real gate, and a constraint failure here
/// means the two drifted apart.
pub(crate) const MIRROR_STORAGE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS mirror_sync_baseline (
  project_id TEXT NOT NULL,
  rel_path   TEXT NOT NULL CHECK (
               length(rel_path) > 0 AND instr(rel_path, char(0)) = 0
             ),
  size       INTEGER NOT NULL CHECK (size >= 0),
  mtime_ms   INTEGER NOT NULL CHECK (mtime_ms >= 0),
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64),
  synced_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, rel_path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_mirror_sync_baseline_project
  ON mirror_sync_baseline(project_id);

CREATE TABLE IF NOT EXISTS mirror_breakpoints (
  project_id TEXT NOT NULL,
  rel_path   TEXT NOT NULL CHECK (
               length(rel_path) > 0 AND instr(rel_path, char(0)) = 0
             ),
  line       INTEGER NOT NULL CHECK (line >= 1),
  column     INTEGER NOT NULL DEFAULT 0 CHECK (column >= 0),
  condition  TEXT CHECK (
               condition IS NULL
               OR (length(condition) <= 512 AND instr(condition, char(0)) = 0)
             ),
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, rel_path, line, column)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_mirror_breakpoints_project
  ON mirror_breakpoints(project_id);
"#;

/// One drift-detection baseline row: what the remote mirror looked like the
/// last time this relative path was synchronized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorBaselineEntry {
    pub rel_path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub sha256: String,
    pub synced_at: i64,
}

/// One stored breakpoint. `column` is zero for a whole-line breakpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorBreakpointRecord {
    pub rel_path: String,
    pub line: i64,
    pub column: i64,
    pub condition: Option<String>,
    pub enabled: bool,
    pub updated_at: i64,
}

fn validate_mirror_project_id(project_id: &str) -> Result<&str> {
    if project_id.trim().is_empty()
        || project_id.trim() != project_id
        || project_id.chars().count() > MAX_MIRROR_PROJECT_ID_CHARS
        || project_id.chars().any(char::is_control)
    {
        return Err(anyhow!("mirror project id is invalid"));
    }
    Ok(project_id)
}

/// Credential-shaped components are refused in both directions by the helper
/// (spec 23 §10.4), so they can never be stored as synchronized state.
fn credential_shaped(component: &str) -> bool {
    let lower = component.to_ascii_lowercase();
    lower.starts_with(".env")
        || lower == ".ssh"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

fn validate_mirror_rel_path(rel_path: &str) -> Result<&str> {
    if rel_path.is_empty() || rel_path.len() > MAX_MIRROR_REL_PATH_BYTES {
        return Err(anyhow!("mirror path must be a non-empty relative path"));
    }
    if rel_path.contains('\0') || rel_path.contains('\\') {
        return Err(anyhow!(
            "mirror path must not contain NUL or a backslash: {rel_path:?}"
        ));
    }
    // `/x` is an absolute POSIX path and `C:/x` a Windows drive path; neither
    // is relative to the project root.
    if rel_path.starts_with('/') || rel_path.chars().nth(1) == Some(':') {
        return Err(anyhow!("mirror path must be relative: {rel_path:?}"));
    }
    for component in rel_path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(anyhow!(
                "mirror path must not contain an empty, '.' or '..' component: {rel_path:?}"
            ));
        }
        if credential_shaped(component) {
            return Err(anyhow!(
                "mirror path must not name credential material: {rel_path:?}"
            ));
        }
    }
    Ok(rel_path)
}

fn validate_mirror_baseline_entry(entry: &MirrorBaselineEntry) -> Result<()> {
    validate_mirror_rel_path(&entry.rel_path)?;
    if entry.size < 0 {
        return Err(anyhow!("mirror baseline size must not be negative"));
    }
    if entry.mtime_ms < 0 {
        return Err(anyhow!("mirror baseline mtime must not be negative"));
    }
    if entry.sha256.len() != SHA256_HEX_CHARS
        || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(anyhow!(
            "mirror baseline sha256 must be {SHA256_HEX_CHARS} hex characters"
        ));
    }
    Ok(())
}

fn validate_mirror_breakpoint(record: &MirrorBreakpointRecord) -> Result<()> {
    validate_mirror_rel_path(&record.rel_path)?;
    if record.line < 1 {
        return Err(anyhow!("mirror breakpoint line must be 1 or greater"));
    }
    if record.column < 0 {
        return Err(anyhow!("mirror breakpoint column must not be negative"));
    }
    if let Some(condition) = &record.condition {
        if condition.len() > MAX_MIRROR_CONDITION_BYTES || condition.contains('\0') {
            return Err(anyhow!(
                "mirror breakpoint condition must be at most \
                 {MAX_MIRROR_CONDITION_BYTES} bytes without NUL"
            ));
        }
    }
    Ok(())
}

fn check_mirror_batch_len(len: usize) -> Result<()> {
    if len > MAX_MIRROR_ROWS_PER_WRITE {
        return Err(anyhow!(
            "mirror write of {len} rows exceeds the {MAX_MIRROR_ROWS_PER_WRITE}-row limit"
        ));
    }
    Ok(())
}

/// Remove every mirror row owned by `project_id`. Takes a connection instead of
/// opening a transaction so the group deletion can commit it together with the
/// group record and its kv siblings.
pub(crate) fn delete_mirror_project_rows(conn: &Connection, project_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM mirror_sync_baseline WHERE project_id = ?1",
        params![project_id],
    )?;
    conn.execute(
        "DELETE FROM mirror_breakpoints WHERE project_id = ?1",
        params![project_id],
    )?;
    Ok(())
}

/// v28 is additive: it adds the mirror sync baseline and the breakpoint set.
/// No existing row changes, so the step only creates tables and indexes.
fn migrate_v27_to_v28_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute_batch(MIRROR_STORAGE_DDL)?;
    tx.pragma_update(None, "user_version", 28i64)?;
    Ok(())
}

pub(crate) fn migrate_v27_to_v28(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 27)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v27_to_v28_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v27 to v28 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

impl Database {
    /// Replace a project's whole baseline in one transaction, so a rescan is
    /// never observed half-applied by a concurrent conflict check.
    ///
    /// The caller owns two contracts. It must pass a complete scan of one
    /// successful pass, because a path absent from `entries` loses its baseline
    /// row and a later upload would no longer see a remote change as a
    /// conflict. It must also drop excluded and credential-shaped paths before
    /// calling, because one refused row rejects the whole batch and leaves the
    /// project with no baseline at all.
    pub fn replace_mirror_baseline(
        &self,
        project_id: &str,
        entries: &[MirrorBaselineEntry],
    ) -> Result<()> {
        let project_id = validate_mirror_project_id(project_id)?;
        check_mirror_batch_len(entries.len())?;
        let mut seen = std::collections::HashSet::with_capacity(entries.len());
        for entry in entries {
            validate_mirror_baseline_entry(entry)?;
            if !seen.insert(entry.rel_path.as_str()) {
                return Err(anyhow!(
                    "duplicate mirror baseline path in one batch: {:?}",
                    entry.rel_path
                ));
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM mirror_sync_baseline WHERE project_id = ?1",
            params![project_id],
        )?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO mirror_sync_baseline
                   (project_id, rel_path, size, mtime_ms, sha256, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for entry in entries {
                stmt.execute(params![
                    project_id,
                    entry.rel_path,
                    entry.size,
                    entry.mtime_ms,
                    entry.sha256,
                    entry.synced_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_mirror_baseline(&self, project_id: &str) -> Result<Vec<MirrorBaselineEntry>> {
        let project_id = validate_mirror_project_id(project_id)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT rel_path, size, mtime_ms, sha256, synced_at
             FROM mirror_sync_baseline
             WHERE project_id = ?1
             ORDER BY rel_path",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(MirrorBaselineEntry {
                rel_path: row.get(0)?,
                size: row.get(1)?,
                mtime_ms: row.get(2)?,
                sha256: row.get(3)?,
                synced_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn upsert_mirror_baseline_entry(
        &self,
        project_id: &str,
        entry: &MirrorBaselineEntry,
    ) -> Result<()> {
        let project_id = validate_mirror_project_id(project_id)?;
        validate_mirror_baseline_entry(entry)?;
        self.conn
            .prepare_cached(
                "INSERT INTO mirror_sync_baseline
                   (project_id, rel_path, size, mtime_ms, sha256, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(project_id, rel_path) DO UPDATE SET
                   size = excluded.size,
                   mtime_ms = excluded.mtime_ms,
                   sha256 = excluded.sha256,
                   synced_at = excluded.synced_at",
            )?
            .execute(params![
                project_id,
                entry.rel_path,
                entry.size,
                entry.mtime_ms,
                entry.sha256,
                entry.synced_at
            ])?;
        Ok(())
    }

    /// Returns whether a row was removed.
    pub fn delete_mirror_baseline_entry(&self, project_id: &str, rel_path: &str) -> Result<bool> {
        let project_id = validate_mirror_project_id(project_id)?;
        let rel_path = validate_mirror_rel_path(rel_path)?;
        let removed = self
            .conn
            .prepare_cached(
                "DELETE FROM mirror_sync_baseline WHERE project_id = ?1 AND rel_path = ?2",
            )?
            .execute(params![project_id, rel_path])?;
        Ok(removed > 0)
    }

    /// Returns the number of removed rows.
    pub fn clear_mirror_baseline(&self, project_id: &str) -> Result<usize> {
        let project_id = validate_mirror_project_id(project_id)?;
        Ok(self
            .conn
            .prepare_cached("DELETE FROM mirror_sync_baseline WHERE project_id = ?1")?
            .execute(params![project_id])?)
    }

    pub fn list_mirror_breakpoints(&self, project_id: &str) -> Result<Vec<MirrorBreakpointRecord>> {
        let project_id = validate_mirror_project_id(project_id)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT rel_path, line, column, condition, enabled, updated_at
             FROM mirror_breakpoints
             WHERE project_id = ?1
             ORDER BY rel_path, line, column",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(MirrorBreakpointRecord {
                rel_path: row.get(0)?,
                line: row.get(1)?,
                column: row.get(2)?,
                condition: row.get(3)?,
                enabled: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Idempotent per `(rel_path, line, column)`: a repeated toggle updates the
    /// stored condition/enabled state instead of adding a second breakpoint.
    pub fn upsert_mirror_breakpoint(
        &self,
        project_id: &str,
        record: &MirrorBreakpointRecord,
    ) -> Result<()> {
        let project_id = validate_mirror_project_id(project_id)?;
        validate_mirror_breakpoint(record)?;
        self.conn
            .prepare_cached(
                "INSERT INTO mirror_breakpoints
                   (project_id, rel_path, line, column, condition, enabled, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(project_id, rel_path, line, column) DO UPDATE SET
                   condition = excluded.condition,
                   enabled = excluded.enabled,
                   updated_at = excluded.updated_at",
            )?
            .execute(params![
                project_id,
                record.rel_path,
                record.line,
                record.column,
                record.condition,
                record.enabled,
                record.updated_at
            ])?;
        Ok(())
    }

    /// Returns whether a row was removed.
    pub fn delete_mirror_breakpoint(
        &self,
        project_id: &str,
        rel_path: &str,
        line: i64,
        column: i64,
    ) -> Result<bool> {
        let project_id = validate_mirror_project_id(project_id)?;
        let rel_path = validate_mirror_rel_path(rel_path)?;
        if line < 1 {
            return Err(anyhow!("mirror breakpoint line must be 1 or greater"));
        }
        if column < 0 {
            return Err(anyhow!("mirror breakpoint column must not be negative"));
        }
        let removed = self
            .conn
            .prepare_cached(
                "DELETE FROM mirror_breakpoints
                 WHERE project_id = ?1 AND rel_path = ?2 AND line = ?3 AND column = ?4",
            )?
            .execute(params![project_id, rel_path, line, column])?;
        Ok(removed > 0)
    }

    /// Replace a project's whole breakpoint set in one transaction. The editor
    /// plugin renders from these rows and never holds the authoritative set, so
    /// a replace is the only way a set shrinks.
    pub fn replace_mirror_breakpoints(
        &self,
        project_id: &str,
        entries: &[MirrorBreakpointRecord],
    ) -> Result<()> {
        let project_id = validate_mirror_project_id(project_id)?;
        check_mirror_batch_len(entries.len())?;
        let mut seen = std::collections::HashSet::with_capacity(entries.len());
        for record in entries {
            validate_mirror_breakpoint(record)?;
            if !seen.insert((record.rel_path.as_str(), record.line, record.column)) {
                return Err(anyhow!(
                    "duplicate mirror breakpoint in one batch: {:?}:{}:{}",
                    record.rel_path,
                    record.line,
                    record.column
                ));
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM mirror_breakpoints WHERE project_id = ?1",
            params![project_id],
        )?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO mirror_breakpoints
                   (project_id, rel_path, line, column, condition, enabled, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for record in entries {
                stmt.execute(params![
                    project_id,
                    record.rel_path,
                    record.line,
                    record.column,
                    record.condition,
                    record.enabled,
                    record.updated_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
