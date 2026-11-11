//! Retained intervention receipts: the idempotency and recovery ledger.
//!
//! A receipt is written before any effect is reported back, and it is never
//! deleted. Two rules follow from that:
//!
//! * the same authenticated principal replaying the same `requestId` with the
//!   same canonical payload returns the stored receipt instead of running the
//!   operation again, and a *different* payload under the same key is rejected
//!   with `CC_IDEMPOTENCY_CONFLICT` rather than re-executed;
//! * the principal is an input from authenticated transport state, so a
//!   request can never choose the identity that a receipt is filed under.
//!
//! Recording also owns the authorization-relevant fences. A control request
//! names a command workspace, a membership revision and an execution-owner
//! epoch; all three must still match durable state, and the concrete execution
//! must still hold a non-terminal reservation. Stop is the only intent that
//! skips the desired-goal-revision fence, so a late cancellation is never
//! refused because a goal advanced. Stop still has to address the exact live
//! execution: a replaced generation has a different execution key and is
//! therefore `CC_TARGET_NOT_FOUND`.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::identity::ExecutionTarget;
use super::limits::{
    next_revision, validate_host_id, validate_now, validate_principal, validate_revision,
    validate_uuid, ReceiptError, PAGE_SIZE,
};
use super::payload::{InterventionIntent, InterventionRequest};
use super::reservation::{self, Reservation};
use super::state::{Operation, ReceiptStatus};
use super::tx::immediate;
use super::{goal, notification, workspace};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Receipt {
    pub(crate) sequence: i64,
    pub(crate) host_id: String,
    pub(crate) principal: String,
    pub(crate) request_id: String,
    pub(crate) fingerprint: String,
    pub(crate) operation: Operation,
    pub(crate) workspace_id: String,
    pub(crate) owner_epoch: String,
    pub(crate) membership_revision: i64,
    pub(crate) target: ExecutionTarget,
    pub(crate) status: ReceiptStatus,
    pub(crate) revision: i64,
    pub(crate) desired_revision: i64,
    pub(crate) effective_revision: i64,
    pub(crate) error: Option<ReceiptError>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl Receipt {
    /// True when the intent carried a goal revision that a runtime can still
    /// consume. Stop and the textual intents never enter `consumed`.
    pub(crate) fn awaits_consumption(&self) -> bool {
        self.operation.has_goal_revision() && self.status == ReceiptStatus::Accepted
    }
}

/// Result of one recording attempt. `replayed` tells the caller that the
/// operation was already recorded and must not run again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InterventionOutcome {
    pub(crate) receipt: Receipt,
    pub(crate) replayed: bool,
}

/// Fenced lifecycle move for a receipt that already exists.
///
/// The receipt is addressed by its durable `sequence`, not by
/// `(principal, requestId)`: consumer-side transitions are reported by the
/// runtime, which is not the principal that filed the intervention.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReceiptTransition {
    pub(crate) sequence: i64,
    pub(crate) expected_revision: i64,
    pub(crate) to: ReceiptStatus,
    pub(crate) error: Option<ReceiptError>,
    pub(crate) now: i64,
}

const SELECT_RECEIPT: &str = "SELECT sequence, host_id, principal, request_id, fingerprint, \
     operation, workspace_id, owner_epoch, membership_revision, kind, session_id, turn_id, \
     parent_session_id, parent_turn_id, delegation_id, generation, status, revision, \
     desired_revision, effective_revision, error_code, error_message, created_at, updated_at \
     FROM cc_intervention_receipts";

fn read_receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Receipt>> {
    let kind: String = row.get(9)?;
    let session_id: Option<String> = row.get(10)?;
    let turn_id: Option<String> = row.get(11)?;
    let parent_session_id: Option<String> = row.get(12)?;
    let parent_turn_id: Option<String> = row.get(13)?;
    let delegation_id: Option<String> = row.get(14)?;
    let generation: Option<i64> = row.get(15)?;
    let target = match ExecutionTarget::from_parts(
        &kind,
        session_id.as_deref(),
        turn_id.as_deref(),
        parent_session_id.as_deref(),
        parent_turn_id.as_deref(),
        delegation_id.as_deref(),
        generation,
    ) {
        Ok(target) => target,
        Err(error) => return Ok(Err(error)),
    };
    let operation: String = row.get(5)?;
    let operation = match Operation::parse(&operation) {
        Ok(operation) => operation,
        Err(error) => return Ok(Err(error)),
    };
    let status: String = row.get(16)?;
    let status = match ReceiptStatus::parse(&status) {
        Ok(status) => status,
        Err(error) => return Ok(Err(error)),
    };
    let error_code: Option<String> = row.get(20)?;
    let error_message: Option<String> = row.get(21)?;
    let error = match (error_code, error_message) {
        (Some(code), Some(message)) => match ReceiptError::new(&code, &message) {
            Ok(error) => Some(error),
            Err(error) => return Ok(Err(error)),
        },
        (None, None) => None,
        _ => {
            return Ok(Err(anyhow::anyhow!(
                "CC_CORRUPT_STORAGE: receipt stores an incomplete error pair"
            )))
        }
    };
    Ok(Ok(Receipt {
        sequence: row.get(0)?,
        host_id: row.get(1)?,
        principal: row.get(2)?,
        request_id: row.get(3)?,
        fingerprint: row.get(4)?,
        operation,
        workspace_id: row.get(6)?,
        owner_epoch: row.get(7)?,
        membership_revision: row.get(8)?,
        target,
        status,
        revision: row.get(17)?,
        desired_revision: row.get(18)?,
        effective_revision: row.get(19)?,
        error,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
    }))
}

pub(crate) fn receipt(
    conn: &Connection,
    host_id: &str,
    principal: &str,
    request_id: &str,
) -> Result<Option<Receipt>> {
    validate_uuid(request_id)?;
    let row = conn
        .query_row(
            &format!("{SELECT_RECEIPT} WHERE host_id = ?1 AND principal = ?2 AND request_id = ?3"),
            params![host_id, principal, request_id],
            read_receipt,
        )
        .optional()?;
    match row {
        Some(result) => Ok(Some(result?)),
        None => Ok(None),
    }
}

pub(crate) fn receipt_by_sequence(conn: &Connection, sequence: i64) -> Result<Option<Receipt>> {
    validate_revision(sequence, 1)?;
    let row = conn
        .query_row(
            &format!("{SELECT_RECEIPT} WHERE sequence = ?1"),
            [sequence],
            read_receipt,
        )
        .optional()?;
    match row {
        Some(result) => Ok(Some(result?)),
        None => Ok(None),
    }
}

/// One bounded page of the caller's own receipts, oldest first.
///
/// A principal only ever pages its own ledger: another user's interventions are
/// not observable through this read, and there is no unscoped variant.
pub(crate) fn receipts_page(
    conn: &Connection,
    host_id: &str,
    principal: &str,
    after_sequence: i64,
    limit: i64,
) -> Result<Vec<Receipt>> {
    validate_host_id(host_id)?;
    validate_principal(principal)?;
    if after_sequence < 0 {
        bail!("CC_INVALID_ARGUMENT: afterSequence must be non-negative");
    }
    if limit < 1 || limit > PAGE_SIZE {
        bail!("CC_INVALID_ARGUMENT: limit must be between 1 and {PAGE_SIZE}");
    }
    let mut statement = conn.prepare(&format!(
        "{SELECT_RECEIPT} WHERE host_id = ?1 AND principal = ?2 AND sequence > ?3 \
         ORDER BY sequence LIMIT ?4"
    ))?;
    let rows = statement
        .query_map(
            params![host_id, principal, after_sequence, limit],
            read_receipt,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut receipts = Vec::with_capacity(rows.len());
    for row in rows {
        receipts.push(row?);
    }
    Ok(receipts)
}

/// Record one validated intervention and apply its durable effect.
pub(crate) fn record_intervention(
    conn: &Connection,
    host_id: &str,
    principal: &str,
    request: &InterventionRequest,
    now: i64,
) -> Result<InterventionOutcome> {
    immediate(conn, |conn| {
        record_intervention_in(conn, host_id, principal, request, now)
    })
}

/// Recording for callers that already hold the immediate transaction, so the
/// receipt, the goal revision, the parent notification and any caller-owned
/// history commit or roll back together.
pub(crate) fn record_intervention_in(
    conn: &Connection,
    host_id: &str,
    principal: &str,
    request: &InterventionRequest,
    now: i64,
) -> Result<InterventionOutcome> {
    validate_host_id(host_id)?;
    validate_principal(principal)?;
    validate_now(now)?;
    request.validate()?;
    let fingerprint = request.fingerprint()?;
    if let Some(existing) = receipt(conn, host_id, principal, &request.request_id)? {
        if existing.fingerprint != fingerprint {
            bail!(
                "CC_IDEMPOTENCY_CONFLICT: request {} was already recorded with a different payload",
                request.request_id
            );
        }
        return Ok(InterventionOutcome {
            receipt: existing,
            replayed: true,
        });
    }

    let task = request.target.task();
    let membership = workspace::require_membership(conn, request.target.membership_session())?;
    if membership.workspace_id != request.command_workspace_id {
        bail!(
            "CC_MEMBERSHIP_CONFLICT: session {} belongs to command workspace {}",
            request.target.membership_session(),
            membership.workspace_id
        );
    }
    if membership.revision != request.expected_membership_revision {
        bail!(
            "CC_MEMBERSHIP_CONFLICT: session {} membership is at revision {}",
            request.target.membership_session(),
            membership.revision
        );
    }
    let workspace =
        workspace::workspace(conn, &request.command_workspace_id)?.ok_or_else(|| {
            anyhow::anyhow!(
                "CC_WORKSPACE_NOT_FOUND: command workspace {} is unknown",
                request.command_workspace_id
            )
        })?;
    if !workspace.enabled {
        bail!(
            "CC_WORKSPACE_DISABLED: command workspace {} is not enabled",
            request.command_workspace_id
        );
    }
    let execution = reservation::reservation(conn, &request.target.key())?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_TARGET_NOT_FOUND: execution {} has no live reservation",
            request.target.key()
        )
    })?;
    require_live_execution(&execution, request)?;

    let head = goal::goal_head(conn, &task)?;
    let (desired, effective) = match &head {
        Some(head) => (head.desired_revision, head.effective_revision),
        None => (0, 0),
    };
    if request.operation() != Operation::Stop {
        let expected = request.expected_goal_revision.unwrap_or(0);
        if desired != expected {
            bail!(
                "CC_GOAL_CONFLICT: task {} desired revision is {desired}, not {expected}",
                task.key()
            );
        }
    }

    let (desired_revision, effective_revision) = match &request.intent {
        InterventionIntent::ReviseGoal {
            objective,
            constraints,
        } => {
            let commit = goal::GoalCommit {
                target: task.clone(),
                expected_desired_revision: desired,
                objective: objective.clone(),
                constraints: constraints.clone(),
                actor: principal.to_owned(),
                request_id: request.request_id.clone(),
                now,
            };
            let head = goal::commit_revision_in(conn, &commit)?;
            (head.desired_revision, head.effective_revision)
        }
        _ => (desired, effective),
    };

    let (kind, session_id, turn_id, parent_session_id, parent_turn_id, delegation_id, generation) =
        execution_columns(&request.target);
    conn.execute(
        "INSERT INTO cc_intervention_receipts(sequence, host_id, principal, request_id,
           fingerprint, operation, workspace_id, owner_epoch, membership_revision, kind,
           session_id, turn_id, parent_session_id, parent_turn_id, delegation_id, generation,
           status, revision, desired_revision, effective_revision, error_code, error_message,
           created_at, updated_at)
         VALUES(NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
           'recorded', 1, ?16, ?17, NULL, NULL, ?18, ?18)",
        params![
            host_id,
            principal,
            request.request_id,
            fingerprint,
            request.operation().as_str(),
            request.command_workspace_id,
            request.expected_host_epoch,
            membership.revision,
            kind,
            session_id,
            turn_id,
            parent_session_id,
            parent_turn_id,
            delegation_id,
            generation,
            desired_revision,
            effective_revision,
            now,
        ],
    )?;

    if request.operation() == Operation::ReviseGoal {
        if let Some(parent_key) = &execution.parent_key {
            notification::record_pending_in(
                conn,
                &notification::PendingNotification {
                    child_task_key: task.key(),
                    parent_task_key: parent_key.clone(),
                    child_revision: desired_revision,
                    execution_key: request.target.key(),
                    host_id: host_id.to_owned(),
                    principal: principal.to_owned(),
                    request_id: request.request_id.clone(),
                    now,
                },
            )?;
        }
    }

    let stored = receipt(conn, host_id, principal, &request.request_id)?
        .ok_or_else(|| anyhow::anyhow!("CC_CORRUPT_STORAGE: receipt insert was not readable"))?;
    Ok(InterventionOutcome {
        receipt: stored,
        replayed: false,
    })
}

fn require_live_execution(execution: &Reservation, request: &InterventionRequest) -> Result<()> {
    if execution.workspace_id != request.command_workspace_id {
        bail!(
            "CC_RESERVATION_CONFLICT: execution {} is owned by command workspace {}",
            execution.execution_key,
            execution.workspace_id
        );
    }
    if execution.owner_epoch != request.expected_host_epoch {
        bail!(
            "CC_EPOCH_CONFLICT: execution {} belongs to execution owner {}",
            execution.execution_key,
            execution.owner_epoch
        );
    }
    if execution.state.terminal() {
        bail!(
            "CC_TARGET_SETTLED: execution {} already released its capacity as {}",
            execution.execution_key,
            execution.state.as_str()
        );
    }
    Ok(())
}

fn execution_columns(
    target: &ExecutionTarget,
) -> (
    &'static str,
    Option<&str>,
    Option<&str>,
    Option<&str>,
    Option<&str>,
    Option<&str>,
    Option<i64>,
) {
    match target {
        ExecutionTarget::Session {
            session_id,
            turn_id,
        } => (
            "session",
            Some(session_id.as_str()),
            Some(turn_id.as_str()),
            None,
            None,
            None,
            None,
        ),
        ExecutionTarget::Delegation {
            parent_session_id,
            parent_turn_id,
            delegation_id,
            generation,
        } => (
            "delegation",
            None,
            None,
            Some(parent_session_id.as_str()),
            Some(parent_turn_id.as_str()),
            Some(delegation_id.as_str()),
            Some(*generation),
        ),
    }
}

pub(crate) fn transition_receipt(
    conn: &Connection,
    transition: &ReceiptTransition,
) -> Result<Receipt> {
    immediate(conn, |conn| transition_receipt_in(conn, transition))
}

/// Move a receipt to the next lifecycle state with a compare-and-set on its
/// revision, so two consumers cannot both report the same outcome.
pub(crate) fn transition_receipt_in(
    conn: &Connection,
    transition: &ReceiptTransition,
) -> Result<Receipt> {
    validate_revision(transition.sequence, 1)?;
    validate_revision(transition.expected_revision, 1)?;
    validate_now(transition.now)?;
    if transition.to == ReceiptStatus::Consumed {
        bail!(
            "CC_TRANSITION_INVALID: consumption is recorded by an execution acknowledgement, \
             not by a receipt transition"
        );
    }
    match (&transition.error, transition.to) {
        (None, to) if to.requires_error() => bail!(
            "CC_INVALID_ARGUMENT: {} requires an error code and message",
            to.as_str()
        ),
        (Some(_), to) if to.forbids_error() => bail!(
            "CC_INVALID_ARGUMENT: {} must not carry an error",
            to.as_str()
        ),
        _ => {}
    }
    let current = receipt_by_sequence(conn, transition.sequence)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_RECEIPT_NOT_FOUND: receipt {} does not exist",
            transition.sequence
        )
    })?;
    if current.revision != transition.expected_revision {
        bail!(
            "CC_TRANSITION_CONFLICT: receipt {} is at revision {}",
            current.sequence,
            current.revision
        );
    }
    if !current.status.can_advance(transition.to) {
        bail!(
            "CC_TRANSITION_INVALID: receipt {} cannot become {} from {}",
            current.sequence,
            transition.to.as_str(),
            current.status.as_str()
        );
    }
    let revision = next_revision(current.revision)?;
    let changed = conn.execute(
        "UPDATE cc_intervention_receipts
         SET status = ?1, revision = ?2, error_code = ?3, error_message = ?4, updated_at = ?5
         WHERE sequence = ?6 AND revision = ?7 AND status = ?8",
        params![
            transition.to.as_str(),
            revision,
            transition.error.as_ref().map(|error| error.code.as_str()),
            transition
                .error
                .as_ref()
                .map(|error| error.message.as_str()),
            transition.now,
            current.sequence,
            current.revision,
            current.status.as_str(),
        ],
    )?;
    if changed != 1 {
        bail!(
            "CC_TRANSITION_CONFLICT: receipt {} changed during the {} transition",
            current.sequence,
            transition.to.as_str()
        );
    }
    receipt_by_sequence(conn, current.sequence)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_CORRUPT_STORAGE: receipt {} disappeared during a transition",
            current.sequence
        )
    })
}

/// Record the accepted -> consumed edge for exactly one execution revision.
///
/// Only [`goal::acknowledge_consumption_in`] calls this: `consumed` is the
/// statement "this concrete runtime revision is now in effect", so it may not
/// be reached by a bare status write.
pub(crate) fn consume_in(
    conn: &Connection,
    receipt: &Receipt,
    consumed_revision: i64,
    now: i64,
) -> Result<()> {
    validate_revision(consumed_revision, 1)?;
    validate_now(now)?;
    if receipt.status != ReceiptStatus::Accepted {
        bail!(
            "CC_TRANSITION_INVALID: receipt {} is {} and cannot be consumed",
            receipt.sequence,
            receipt.status.as_str()
        );
    }
    if consumed_revision != receipt.desired_revision {
        bail!(
            "CC_CONSUMPTION_CONFLICT: receipt {} committed desired revision {} but {} was \
             acknowledged",
            receipt.sequence,
            receipt.desired_revision,
            consumed_revision
        );
    }
    let revision = next_revision(receipt.revision)?;
    let changed = conn.execute(
        "UPDATE cc_intervention_receipts
         SET status = 'consumed', revision = ?1, effective_revision = ?2, updated_at = ?3
         WHERE sequence = ?4 AND revision = ?5 AND status = 'accepted'",
        params![
            revision,
            consumed_revision,
            now,
            receipt.sequence,
            receipt.revision
        ],
    )?;
    if changed != 1 {
        bail!(
            "CC_TRANSITION_CONFLICT: receipt {} changed during the consumption",
            receipt.sequence
        );
    }
    Ok(())
}
