#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, Context, Result};
pub(crate) use rusqlite::{params, Connection, OptionalExtension};
pub(crate) use serde::Serialize;
pub(crate) use serde_json::Value;
pub(crate) use std::path::{Path, PathBuf};

/// Current SQLite schema version.
pub const SCHEMA_VERSION: i64 = 29;

/// Absolute approval deadline for a newly submitted Plan or Goal proposal.
pub const PLAN_APPROVAL_TIMEOUT_MS: i64 = 30 * 60 * 1000;

/// Durable notification rows kept globally.
pub const NOTIFICATION_KEEP: i64 = 200;

mod migrations;
mod mode_runs_migration;
mod model;
mod model_discovery_migration;
mod plugin_providers_migration;
mod project_groups;
mod repositories;
mod schema;
mod session_collaboration_migration;
mod session_fast_mode_migration;
mod session_title_source_migration;
mod tool_image_storage_migration;
mod worktree_migration;
pub(crate) use migrations::{
    archive_legacy_db, create_migration_backup, migrate_and_validate_top_level_mode,
    migrate_app_settings, migrate_v10_to_v15, migrate_v11_to_v15, migrate_v12_to_v15,
    migrate_v13_to_v15, migrate_v14_to_v15, migrate_v17_to_v18, migrate_v18_to_v19,
    migrate_v19_to_v20, migrate_v20_to_v21, migrate_v7_to_v8, migrate_v8_to_v15, migrate_v9_to_v15,
    migration_backup_path, validate_session_modes,
};
pub(crate) use mode_runs_migration::MODE_RUNS_SCHEMA;
pub(crate) use model::PlanWorkRow;
pub use model::{Database, ProjectMemoryEntryRecord, ProjectMemoryRecord, ProjectRecord};
pub use project_groups::{
    ProjectGroupContextRecord, ProjectGroupRecord, ProjectGroupRoot, RemoteWorkspace,
    REMOTE_PROJECT_PREFIX,
};
pub(crate) use repositories::{
    canonical_project_path, normalize_project_path, project_display_name,
    strip_obsolete_plan_approval_permission_mode, upsert_project_row, MAX_PROJECT_MEMORY_BYTES,
    OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE,
};
pub(crate) use schema::{PLAN_APPROVALS_SCHEMA, SCHEMA_LATEST, SESSION_TODO_DDL};
pub(crate) use session_fast_mode_migration::migrate_v26_to_v27;
pub(crate) use session_title_source_migration::migrate_v22_to_v23;
pub(crate) use worktree_migration::{migrate_v23_to_v24, WORKTREE_DDL};

impl Database {
    /// Run one immediate transaction with SQLite WAL `synchronous=FULL`, then
    /// restore this connection's exact previous setting before returning.
    /// Callers in Host hold the database owner lock around this method.
    pub(crate) fn with_full_synchronous_immediate_transaction<T>(
        &self,
        operation: impl FnOnce(&rusqlite::Connection) -> Result<T>,
    ) -> Result<T> {
        let connection = self.conn();
        let previous: i64 = connection.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
        connection.pragma_update(None, "synchronous", 2i64)?;
        let mut synchronous_guard = SynchronousRestoreGuard {
            connection,
            previous,
            restored: false,
        };

        let result = (|| {
            connection.execute_batch("BEGIN IMMEDIATE")?;
            let mut transaction_guard = ImmediateTransactionGuard {
                connection,
                committed: false,
            };
            let value = operation(connection)?;
            transaction_guard.commit()?;
            Ok(value)
        })();
        let restore_result = synchronous_guard.restore();
        match (result, restore_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => {
                Err(error.context("restore SQLite synchronous mode after full-sync transaction"))
            }
            (Err(error), Err(restore_error)) => Err(error.context(format!(
                "also failed to restore SQLite synchronous mode: {restore_error}"
            ))),
        }
    }
}

struct ImmediateTransactionGuard<'a> {
    connection: &'a rusqlite::Connection,
    committed: bool,
}

impl ImmediateTransactionGuard<'_> {
    fn commit(&mut self) -> Result<()> {
        self.connection.execute_batch("COMMIT")?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for ImmediateTransactionGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            if let Err(error) = self.connection.execute_batch("ROLLBACK") {
                tracing::error!(%error, "failed to roll back personal todo transaction");
            }
        }
    }
}

struct SynchronousRestoreGuard<'a> {
    connection: &'a rusqlite::Connection,
    previous: i64,
    restored: bool,
}

impl SynchronousRestoreGuard<'_> {
    fn restore(&mut self) -> Result<()> {
        self.connection
            .pragma_update(None, "synchronous", self.previous)?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for SynchronousRestoreGuard<'_> {
    fn drop(&mut self) {
        if !self.restored {
            if let Err(error) = self
                .connection
                .pragma_update(None, "synchronous", self.previous)
            {
                tracing::error!(%error, "failed to restore SQLite synchronous mode");
            }
        }
    }
}
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Parse an RFC3339 timestamp into epoch ms, falling back to `now`.
pub fn ts_to_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| now_ms())
}

/// Epoch ms -> RFC3339 (UTC, `Z` suffix) for the wire format.
pub fn ms_to_ts(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
