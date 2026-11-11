//! Immutable goal revisions and explicit runtime consumption.
//!
//! Two revisions stay distinct on purpose:
//!
//! * `desired_revision` is the latest committed user intent and advances only
//!   through a compare-and-swap in [`commit_revision_in`];
//! * `effective_revision` is what the concrete runtime execution confirmed it
//!   consumed, and advances only through [`acknowledge_consumption_in`] with a
//!   receipt for that exact request, execution and revision.
//!
//! An accepted intent is therefore never reported as effective. A revision row
//! is append-only: the storage triggers reject UPDATE and DELETE.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::identity::TaskTarget;
use super::limits::{
    next_revision, validate_intent_text, validate_now, validate_principal, validate_revision,
    validate_uuid, MAX_CONSTRAINTS, MAX_CONSTRAINT_CHARS, MAX_REQUEST_BYTES,
};
use super::payload::{canonical_constraints, Consumption};
use super::receipt;
use super::state::ReceiptStatus;
use super::tx::immediate;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GoalHead {
    pub(crate) target: TaskTarget,
    pub(crate) desired_revision: i64,
    pub(crate) effective_revision: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GoalRevision {
    pub(crate) revision: i64,
    pub(crate) objective: String,
    pub(crate) constraints: Vec<String>,
    pub(crate) actor: String,
    pub(crate) request_id: String,
    pub(crate) parent_revision: Option<i64>,
    pub(crate) created_at: i64,
}

/// One committed user intent. `actor` is the authenticated principal and
/// `request_id` the intervention that carried it; neither is payload-chosen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GoalCommit {
    pub(crate) target: TaskTarget,
    pub(crate) expected_desired_revision: i64,
    pub(crate) objective: String,
    pub(crate) constraints: Vec<String>,
    pub(crate) actor: String,
    pub(crate) request_id: String,
    pub(crate) now: i64,
}

impl GoalCommit {
    fn validate(&self) -> Result<()> {
        self.target.validate()?;
        validate_revision(self.expected_desired_revision, 0)?;
        validate_intent_text(&self.objective, "objective", MAX_REQUEST_BYTES)?;
        if self.constraints.len() > MAX_CONSTRAINTS {
            bail!("CC_INVALID_REQUEST: at most {MAX_CONSTRAINTS} constraints are accepted");
        }
        for constraint in &self.constraints {
            validate_intent_text(constraint, "constraint", MAX_CONSTRAINT_CHARS)?;
        }
        canonical_constraints(&self.constraints)?;
        validate_principal(&self.actor)?;
        validate_uuid(&self.request_id)?;
        validate_now(self.now)
    }
}

fn read_head(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<GoalHead>> {
    let kind: String = row.get(0)?;
    let session_id: Option<String> = row.get(1)?;
    let parent_session_id: Option<String> = row.get(2)?;
    let delegation_id: Option<String> = row.get(3)?;
    let target = TaskTarget::from_parts(
        &kind,
        session_id.as_deref(),
        parent_session_id.as_deref(),
        delegation_id.as_deref(),
    );
    let target = match target {
        Ok(target) => target,
        Err(error) => return Ok(Err(error)),
    };
    Ok(Ok(GoalHead {
        target,
        desired_revision: row.get(4)?,
        effective_revision: row.get(5)?,
        updated_at: row.get(6)?,
    }))
}

pub(crate) fn goal_head(conn: &Connection, target: &TaskTarget) -> Result<Option<GoalHead>> {
    target.validate()?;
    let row = conn
        .query_row(
            "SELECT kind, session_id, parent_session_id, delegation_id, desired_revision,
                    effective_revision, updated_at
             FROM cc_goal_heads WHERE task_key = ?1",
            [target.key()],
            read_head,
        )
        .optional()?;
    match row {
        Some(result) => Ok(Some(result?)),
        None => Ok(None),
    }
}

pub(crate) fn goal_revision(
    conn: &Connection,
    target: &TaskTarget,
    revision: i64,
) -> Result<Option<GoalRevision>> {
    target.validate()?;
    validate_revision(revision, 1)?;
    let raw = conn
        .query_row(
            "SELECT revision, objective, constraints_json, actor, request_id, parent_revision,
                    created_at
             FROM cc_goal_revisions WHERE task_key = ?1 AND revision = ?2",
            params![target.key(), revision],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((revision, objective, constraints, actor, request_id, parent_revision, created_at)) =
        raw
    else {
        return Ok(None);
    };
    let constraints: Vec<String> = serde_json::from_str(&constraints).map_err(|_| {
        anyhow::anyhow!("CC_CORRUPT_STORAGE: stored constraints are not a string array")
    })?;
    Ok(Some(GoalRevision {
        revision,
        objective,
        constraints,
        actor,
        request_id,
        parent_revision,
        created_at,
    }))
}

pub(crate) fn commit_revision(conn: &Connection, commit: &GoalCommit) -> Result<GoalHead> {
    immediate(conn, |conn| commit_revision_in(conn, commit))
}

/// Commit one desired revision with a compare-and-swap on the observed head.
pub(crate) fn commit_revision_in(conn: &Connection, commit: &GoalCommit) -> Result<GoalHead> {
    commit.validate()?;
    let task_key = commit.target.key();
    let constraints_json = canonical_constraints(&commit.constraints)?;
    let current = goal_head(conn, &commit.target)?;
    let revision = match &current {
        None => {
            if commit.expected_desired_revision != 0 {
                bail!(
                    "CC_GOAL_CONFLICT: task {task_key} has no goal revision; expected 0, \
                     not {}",
                    commit.expected_desired_revision
                );
            }
            let (kind, session_id, parent_session_id, delegation_id) = match &commit.target {
                TaskTarget::Session { session_id } => {
                    ("session", Some(session_id.as_str()), None, None)
                }
                TaskTarget::Delegation {
                    parent_session_id,
                    delegation_id,
                } => (
                    "delegation",
                    None,
                    Some(parent_session_id.as_str()),
                    Some(delegation_id.as_str()),
                ),
            };
            conn.execute(
                "INSERT INTO cc_goal_heads(task_key, kind, session_id, parent_session_id,
                   delegation_id, desired_revision, effective_revision, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, 1, 0, ?6)",
                params![
                    task_key,
                    kind,
                    session_id,
                    parent_session_id,
                    delegation_id,
                    commit.now
                ],
            )?;
            1
        }
        Some(head) => {
            if head.desired_revision != commit.expected_desired_revision {
                bail!(
                    "CC_GOAL_CONFLICT: task {task_key} desired revision is {}",
                    head.desired_revision
                );
            }
            let next = next_revision(head.desired_revision)?;
            let changed = conn.execute(
                "UPDATE cc_goal_heads SET desired_revision = ?1, updated_at = ?2
                 WHERE task_key = ?3 AND desired_revision = ?4",
                params![next, commit.now, task_key, commit.expected_desired_revision],
            )?;
            if changed != 1 {
                bail!("CC_GOAL_CONFLICT: task {task_key} changed during the goal revision commit");
            }
            next
        }
    };
    conn.execute(
        "INSERT INTO cc_goal_revisions(task_key, revision, objective, constraints_json, actor,
           request_id, parent_revision, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            task_key,
            revision,
            commit.objective,
            constraints_json,
            commit.actor,
            commit.request_id,
            (revision > 1).then_some(revision - 1),
            commit.now,
        ],
    )?;
    goal_head(conn, &commit.target)?
        .ok_or_else(|| anyhow::anyhow!("CC_CORRUPT_STORAGE: goal head vanished after commit"))
}

/// Pure form of the shared `applyCommandCenterConsumption` helper.
///
/// A revision the Host has not committed is rejected, a delayed acknowledgement
/// never rolls `effective` back, and a duplicate is idempotent.
pub(crate) fn apply_consumption(head: &GoalHead, consumed_revision: i64) -> Result<GoalHead> {
    validate_revision(consumed_revision, 1)?;
    if consumed_revision > head.desired_revision {
        bail!(
            "CC_CONSUMPTION_AHEAD: revision {consumed_revision} is not a committed desired \
             revision ({})",
            head.desired_revision
        );
    }
    if consumed_revision < head.effective_revision {
        bail!(
            "CC_CONSUMPTION_STALE: revision {consumed_revision} is older than the effective \
             revision {}",
            head.effective_revision
        );
    }
    let mut next = head.clone();
    next.effective_revision = consumed_revision;
    Ok(next)
}

pub(crate) fn acknowledge_consumption(
    conn: &Connection,
    host_id: &str,
    principal: &str,
    consumption: &Consumption,
    now: i64,
) -> Result<GoalHead> {
    immediate(conn, |conn| {
        acknowledge_consumption_in(conn, host_id, principal, consumption, now)
    })
}

/// Advance `effective_revision` for exactly one acknowledged receipt.
///
/// The acknowledgement must name the same concrete execution (including the
/// native generation) as the receipt, so a delayed event for a replaced run can
/// never make the new run look consumed.
pub(crate) fn acknowledge_consumption_in(
    conn: &Connection,
    host_id: &str,
    principal: &str,
    consumption: &Consumption,
    now: i64,
) -> Result<GoalHead> {
    super::limits::validate_host_id(host_id)?;
    validate_principal(principal)?;
    consumption.validate()?;
    validate_now(now)?;
    let receipt =
        receipt::receipt(conn, host_id, principal, &consumption.request_id)?.ok_or_else(|| {
            anyhow::anyhow!(
                "CC_RECEIPT_NOT_FOUND: request {} has no durable receipt",
                consumption.request_id
            )
        })?;
    if !receipt.operation.has_goal_revision() {
        bail!(
            "CC_CONSUMPTION_CONFLICT: {} has no goal revision to consume",
            receipt.operation.as_str()
        );
    }
    if receipt.target.key() != consumption.target.key() {
        bail!(
            "CC_CONSUMPTION_TARGET: acknowledgement names execution {} instead of {}",
            consumption.target.key(),
            receipt.target.key()
        );
    }
    let task = consumption.target.task();
    match receipt.status {
        ReceiptStatus::Accepted => {}
        ReceiptStatus::Consumed => {
            if receipt.effective_revision == consumption.consumed_revision {
                return goal_head(conn, &task)?.ok_or_else(|| {
                    anyhow::anyhow!("CC_GOAL_MISSING: task {} has no goal head", task.key())
                });
            }
            bail!(
                "CC_CONSUMPTION_CONFLICT: receipt already consumed revision {}",
                receipt.effective_revision
            );
        }
        other => bail!(
            "CC_CONSUMPTION_CONFLICT: receipt is {} and cannot be consumed",
            other.as_str()
        ),
    }
    if receipt.desired_revision != consumption.consumed_revision {
        bail!(
            "CC_CONSUMPTION_CONFLICT: receipt committed desired revision {} but the \
             acknowledgement names {}",
            receipt.desired_revision,
            consumption.consumed_revision
        );
    }
    let head = goal_head(conn, &task)?
        .ok_or_else(|| anyhow::anyhow!("CC_GOAL_MISSING: task {} has no goal head", task.key()))?;
    let next = apply_consumption(&head, consumption.consumed_revision)?;
    if next.effective_revision != head.effective_revision {
        let changed = conn.execute(
            "UPDATE cc_goal_heads SET effective_revision = ?1, updated_at = ?2
             WHERE task_key = ?3 AND effective_revision = ?4",
            params![
                next.effective_revision,
                now,
                task.key(),
                head.effective_revision
            ],
        )?;
        if changed != 1 {
            bail!("CC_CONSUMPTION_CONFLICT: goal head changed during the acknowledgement");
        }
    }
    receipt::consume_in(conn, &receipt, consumption.consumed_revision, now)?;
    goal_head(conn, &task)?
        .ok_or_else(|| anyhow::anyhow!("CC_CORRUPT_STORAGE: goal head vanished after consumption"))
}
