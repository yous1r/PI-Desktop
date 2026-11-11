//! Additive `cc_` storage for the command-center control path.
//!
//! One DDL definition is shared by the fresh-create path and the versioned
//! upgrade in [`crate::db::command_center_migration`], so the two cannot drift.
//! Every statement is `IF NOT EXISTS`: an existing user database only gains
//! tables, and no existing row, table or index is rewritten.
//!
//! Retention is a storage rule here, not a convention: goal revisions are
//! immutable, control receipts cannot be deleted, because the first release
//! keeps them for idempotency and recovery, and every reservation transition
//! appends evidence. A later explicit deletion contract has to replace these
//! triggers deliberately.

use anyhow::{bail, Result};
use rusqlite::Connection;

/// Tables that must exist before any control operation may run.
pub(crate) const TABLES: [&str; 8] = [
    "cc_workspaces",
    "cc_session_memberships",
    "cc_execution_reservations",
    "cc_reservation_events",
    "cc_goal_heads",
    "cc_goal_revisions",
    "cc_intervention_receipts",
    "cc_parent_notifications",
];

pub(crate) const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS cc_workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256 AND instr(name, char(0)) = 0),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision   INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cc_workspaces_enabled ON cc_workspaces(enabled);

CREATE TABLE IF NOT EXISTS cc_session_memberships (
  session_id   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cc_workspaces(id),
  revision     INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  bound_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cc_memberships_workspace
  ON cc_session_memberships(workspace_id);

CREATE TABLE IF NOT EXISTS cc_execution_reservations (
  execution_key       TEXT PRIMARY KEY,
  task_key            TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('session', 'delegation')),
  workspace_id        TEXT NOT NULL REFERENCES cc_workspaces(id),
  membership_session  TEXT NOT NULL,
  membership_revision INTEGER NOT NULL CHECK (membership_revision >= 1),
  owner_epoch         TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('reserved', 'starting', 'running',
    'waiting_tool', 'waiting_human', 'stopping', 'outcome_unknown', 'interrupted',
    'completed', 'aborted', 'failed', 'launch_failed')),
  session_id          TEXT,
  turn_id             TEXT,
  parent_session_id   TEXT,
  parent_turn_id      TEXT,
  delegation_id       TEXT,
  generation          INTEGER CHECK (generation IS NULL OR generation >= 1),
  parent_key          TEXT,
  reserved_at         INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  released_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cc_reservations_workspace
  ON cc_execution_reservations(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_cc_reservations_membership
  ON cc_execution_reservations(membership_session);
CREATE INDEX IF NOT EXISTS idx_cc_reservations_task
  ON cc_execution_reservations(task_key);

-- Append-only transition evidence. Capacity release is only proven by a row
-- here, so "exactly one release" and "evidence-backed release from interrupted
-- or outcome_unknown" are durable facts rather than caller convention.
CREATE TABLE IF NOT EXISTS cc_reservation_events (
  sequence      INTEGER PRIMARY KEY,
  execution_key TEXT NOT NULL,
  from_state    TEXT NOT NULL CHECK (from_state IN ('reserved', 'starting', 'running',
    'waiting_tool', 'waiting_human', 'stopping', 'outcome_unknown', 'interrupted',
    'completed', 'aborted', 'failed', 'launch_failed')),
  to_state      TEXT NOT NULL CHECK (to_state IN ('reserved', 'starting', 'running',
    'waiting_tool', 'waiting_human', 'stopping', 'outcome_unknown', 'interrupted',
    'completed', 'aborted', 'failed', 'launch_failed')),
  evidence      TEXT NOT NULL CHECK (length(evidence) BETWEEN 1 AND 128
    AND instr(evidence, char(0)) = 0),
  recorded_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cc_reservation_events_key
  ON cc_reservation_events(execution_key, sequence);

CREATE TABLE IF NOT EXISTS cc_goal_heads (
  task_key           TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('session', 'delegation')),
  session_id         TEXT,
  parent_session_id  TEXT,
  delegation_id      TEXT,
  desired_revision   INTEGER NOT NULL CHECK (desired_revision BETWEEN 0 AND 9007199254740991),
  effective_revision INTEGER NOT NULL CHECK (effective_revision BETWEEN 0 AND 9007199254740991),
  updated_at         INTEGER NOT NULL,
  CHECK (effective_revision <= desired_revision),
  CHECK ((kind = 'session' AND session_id IS NOT NULL AND parent_session_id IS NULL
          AND delegation_id IS NULL)
      OR (kind = 'delegation' AND session_id IS NULL AND parent_session_id IS NOT NULL
          AND delegation_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS cc_goal_revisions (
  task_key         TEXT NOT NULL REFERENCES cc_goal_heads(task_key),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  objective        TEXT NOT NULL CHECK (length(objective) >= 1 AND instr(objective, char(0)) = 0),
  constraints_json TEXT NOT NULL CHECK (length(CAST(constraints_json AS BLOB)) <= 4096),
  actor            TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
  request_id       TEXT NOT NULL,
  parent_revision  INTEGER CHECK (parent_revision IS NULL OR parent_revision >= 1),
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (task_key, revision)
);
CREATE TRIGGER IF NOT EXISTS cc_goal_revisions_immutable_update
  BEFORE UPDATE ON cc_goal_revisions
BEGIN
  SELECT RAISE(ABORT, 'CC_GOAL_REVISION_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS cc_goal_revisions_immutable_delete
  BEFORE DELETE ON cc_goal_revisions
BEGIN
  SELECT RAISE(ABORT, 'CC_GOAL_REVISION_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS cc_intervention_receipts (
  sequence            INTEGER PRIMARY KEY,
  host_id             TEXT NOT NULL,
  principal           TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  fingerprint         TEXT NOT NULL CHECK (length(fingerprint) = 64),
  operation           TEXT NOT NULL CHECK (operation IN ('append', 'steer', 'reviseGoal', 'stop')),
  workspace_id        TEXT NOT NULL,
  owner_epoch         TEXT NOT NULL,
  membership_revision INTEGER NOT NULL CHECK (membership_revision >= 1),
  kind                TEXT NOT NULL CHECK (kind IN ('session', 'delegation')),
  session_id          TEXT,
  turn_id             TEXT,
  parent_session_id   TEXT,
  parent_turn_id      TEXT,
  delegation_id       TEXT,
  generation          INTEGER CHECK (generation IS NULL OR generation >= 1),
  status              TEXT NOT NULL CHECK (status IN ('recorded', 'accepted', 'consumed',
    'completed', 'rejected', 'conflicted', 'interrupted', 'outcome_unknown')),
  revision            INTEGER NOT NULL CHECK (revision >= 1),
  desired_revision    INTEGER NOT NULL CHECK (desired_revision BETWEEN 0 AND 9007199254740991),
  effective_revision  INTEGER NOT NULL CHECK (effective_revision BETWEEN 0 AND 9007199254740991),
  error_code          TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 64)),
  error_message       TEXT CHECK (error_message IS NULL OR (length(error_message) BETWEEN 1 AND 512)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (host_id, principal, request_id),
  CHECK (effective_revision <= desired_revision),
  CHECK (operation <> 'stop' OR status <> 'consumed'),
  CHECK ((status NOT IN ('rejected', 'conflicted')) OR error_code IS NOT NULL),
  CHECK ((status NOT IN ('recorded', 'accepted', 'consumed', 'completed')) OR error_code IS NULL),
  CHECK ((error_code IS NULL) = (error_message IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_cc_receipts_scope
  ON cc_intervention_receipts(host_id, principal, sequence);
CREATE INDEX IF NOT EXISTS idx_cc_receipts_request ON cc_intervention_receipts(request_id);
CREATE TRIGGER IF NOT EXISTS cc_intervention_receipts_retained
  BEFORE DELETE ON cc_intervention_receipts
BEGIN
  SELECT RAISE(ABORT, 'CC_RECEIPT_RETAINED');
END;

CREATE TABLE IF NOT EXISTS cc_parent_notifications (
  sequence           INTEGER PRIMARY KEY,
  child_task_key     TEXT NOT NULL,
  parent_task_key    TEXT NOT NULL,
  child_revision     INTEGER NOT NULL CHECK (child_revision >= 1),
  execution_key      TEXT NOT NULL,
  host_id            TEXT NOT NULL,
  principal          TEXT NOT NULL,
  request_id         TEXT NOT NULL,
  delivery_state     TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered',
    'superseded', 'parent_settled')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (child_task_key, child_revision)
);
CREATE INDEX IF NOT EXISTS idx_cc_notifications_parent
  ON cc_parent_notifications(parent_task_key, delivery_state);
"#;

/// Fail closed when the additive migration has not run for this database.
pub(crate) fn ensure(conn: &Connection) -> Result<()> {
    let placeholders = vec!["?"; TABLES.len()].join(", ");
    let present: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ({placeholders})"
        ),
        rusqlite::params_from_iter(TABLES.iter()),
        |row| row.get(0),
    )?;
    if present != TABLES.len() as i64 {
        bail!("CC_STORAGE_UNAVAILABLE: command-center tables are not migrated");
    }
    Ok(())
}

fn objects(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    let mut statement = conn.prepare(
        "SELECT name, type, COALESCE(sql, '') FROM sqlite_master \
         WHERE name GLOB 'cc_*' ORDER BY name",
    )?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Compare live storage objects with a reference database built from [`DDL`].
pub(crate) fn validate(conn: &Connection) -> Result<()> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(DDL)?;
    if objects(conn)? != objects(&expected)? {
        bail!("CC_INVALID_SCHEMA: command-center storage does not match the migration");
    }
    Ok(())
}
