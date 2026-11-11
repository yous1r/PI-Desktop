//! Durable execution reservations: the single authority for Agent capacity.
//!
//! Every admission source (Desktop, remote, scheduled work, plugins, native
//! Task delegation, Worker creation) must call [`reserve_in`] inside one
//! immediate transaction before a runtime exists. Rust owns the check and the
//! insert, so a client cache can never grant a slot.
//!
//! Capacity rules enforced here:
//!
//! * twelve live reservations per command workspace, thirty-six per Host;
//! * `reserved`, `starting`, `running`, `waiting_tool`, `waiting_human`,
//!   `stopping`, `outcome_unknown` and `interrupted` all retain their slot;
//! * only `completed`, `aborted`, `failed` and `launch_failed` release it, and
//!   a terminal row can never transition again, so release happens exactly
//!   once and is proven by the appended event row;
//! * the existing ten-child per-session ceiling is *not* modelled here. It is
//!   an additional delegation-admission constraint owned by the delegation
//!   registry; a native child still counts as one reservation of its own.
//!
//! The Host-wide count is the table-wide live count on purpose: one SQLite
//! database belongs to exactly one Host installation, and `owner_epoch` is what
//! separates execution-owner generations inside it.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::identity::{validate_task_key, ExecutionTarget};
use super::limits::{
    validate_evidence, validate_now, validate_revision, validate_uuid, MAX_LIVE_PER_HOST,
    MAX_LIVE_PER_WORKSPACE,
};
use super::state::ReservationState;
use super::tx::immediate;
use super::workspace;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reservation {
    pub(crate) execution_key: String,
    pub(crate) task_key: String,
    pub(crate) target: ExecutionTarget,
    pub(crate) workspace_id: String,
    pub(crate) membership_session: String,
    pub(crate) membership_revision: i64,
    pub(crate) owner_epoch: String,
    pub(crate) state: ReservationState,
    /// Stable parent task key supplied by the admission source. It is trusted
    /// admission data, never a value the control request can choose.
    pub(crate) parent_key: Option<String>,
    pub(crate) reserved_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) released_at: Option<i64>,
}

impl Reservation {
    /// True while this reservation still occupies a capacity slot.
    pub(crate) fn retains_capacity(&self) -> bool {
        self.state.retains_capacity()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReservationRequest {
    pub(crate) target: ExecutionTarget,
    pub(crate) workspace_id: String,
    pub(crate) expected_membership_revision: i64,
    pub(crate) owner_epoch: String,
    pub(crate) parent_key: Option<String>,
    pub(crate) now: i64,
}

impl ReservationRequest {
    fn validate(&self) -> Result<()> {
        self.target.validate()?;
        validate_uuid(&self.workspace_id)?;
        validate_uuid(&self.owner_epoch)?;
        validate_revision(self.expected_membership_revision, 1)?;
        validate_now(self.now)?;
        if let Some(parent_key) = &self.parent_key {
            // Trusted admission data, but it becomes the parent side of a durable
            // notification, so it must already be a canonical task key: an opaque
            // string, a foreign encoding or an unbounded value would leave the
            // parent unable to read what its child committed.
            validate_task_key(parent_key)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReservationTransition {
    pub(crate) execution_key: String,
    pub(crate) owner_epoch: String,
    pub(crate) from: ReservationState,
    pub(crate) to: ReservationState,
    pub(crate) evidence: String,
    pub(crate) now: i64,
}

impl ReservationTransition {
    fn validate(&self) -> Result<()> {
        validate_uuid(&self.owner_epoch)?;
        validate_evidence(&self.evidence)?;
        validate_now(self.now)?;
        if self.from == self.to {
            bail!(
                "CC_TRANSITION_INVALID: reservation is already {}",
                self.from.as_str()
            );
        }
        if !self.from.can_advance(self.to) {
            bail!(
                "CC_TRANSITION_INVALID: {} cannot become {}",
                self.from.as_str(),
                self.to.as_str()
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReservationEvent {
    pub(crate) from: ReservationState,
    pub(crate) to: ReservationState,
    pub(crate) evidence: String,
    pub(crate) recorded_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CapacityCounts {
    pub(crate) host: i64,
    pub(crate) workspaces: Vec<(String, i64)>,
}

/// SQL predicate for reservations that still occupy a slot. Derived from the
/// state table so a new terminal state cannot leave a stale literal behind.
fn live_predicate() -> String {
    format!("state NOT IN ({})", ReservationState::TERMINAL_SQL)
}

fn read_reservation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Reservation>> {
    let kind: String = row.get(2)?;
    let session_id: Option<String> = row.get(8)?;
    let turn_id: Option<String> = row.get(9)?;
    let parent_session_id: Option<String> = row.get(10)?;
    let parent_turn_id: Option<String> = row.get(11)?;
    let delegation_id: Option<String> = row.get(12)?;
    let generation: Option<i64> = row.get(13)?;
    let target = ExecutionTarget::from_parts(
        &kind,
        session_id.as_deref(),
        turn_id.as_deref(),
        parent_session_id.as_deref(),
        parent_turn_id.as_deref(),
        delegation_id.as_deref(),
        generation,
    );
    let target = match target {
        Ok(target) => target,
        Err(error) => return Ok(Err(error)),
    };
    let state: String = row.get(7)?;
    let state = match ReservationState::parse(&state) {
        Ok(state) => state,
        Err(error) => return Ok(Err(error)),
    };
    Ok(Ok(Reservation {
        execution_key: row.get(0)?,
        task_key: row.get(1)?,
        target,
        membership_session: row.get(4)?,
        membership_revision: row.get(5)?,
        owner_epoch: row.get(6)?,
        state,
        workspace_id: row.get(3)?,
        parent_key: row.get(14)?,
        reserved_at: row.get(15)?,
        updated_at: row.get(16)?,
        released_at: row.get(17)?,
    }))
}

const SELECT_RESERVATION: &str = "SELECT execution_key, task_key, kind, workspace_id, \
     membership_session, membership_revision, owner_epoch, state, session_id, turn_id, \
     parent_session_id, parent_turn_id, delegation_id, generation, parent_key, reserved_at, \
     updated_at, released_at FROM cc_execution_reservations";

pub(crate) fn reservation(conn: &Connection, execution_key: &str) -> Result<Option<Reservation>> {
    let row = conn
        .query_row(
            &format!("{SELECT_RESERVATION} WHERE execution_key = ?1"),
            [execution_key],
            read_reservation,
        )
        .optional()?;
    match row {
        Some(result) => Ok(Some(result?)),
        None => Ok(None),
    }
}

pub(crate) fn reserve(conn: &Connection, request: &ReservationRequest) -> Result<Reservation> {
    immediate(conn, |conn| reserve_in(conn, request))
}

/// Admit one execution. Callers must already hold the immediate transaction.
pub(crate) fn reserve_in(conn: &Connection, request: &ReservationRequest) -> Result<Reservation> {
    request.validate()?;
    let task = request.target.task();
    let membership = workspace::require_membership(conn, request.target.membership_session())?;
    if membership.workspace_id != request.workspace_id {
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
    let workspace = workspace::workspace(conn, &request.workspace_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_WORKSPACE_NOT_FOUND: command workspace {} is unknown",
            request.workspace_id
        )
    })?;
    if !workspace.enabled {
        bail!(
            "CC_WORKSPACE_DISABLED: command workspace {} is not enabled",
            request.workspace_id
        );
    }

    let execution_key = request.target.key();
    if let Some(existing) = reservation(conn, &execution_key)? {
        if existing.workspace_id != request.workspace_id {
            bail!(
                "CC_RESERVATION_CONFLICT: execution {execution_key} is owned by command workspace {}",
                existing.workspace_id
            );
        }
        if existing.owner_epoch != request.owner_epoch {
            bail!(
                "CC_EPOCH_CONFLICT: execution {execution_key} belongs to execution owner {}",
                existing.owner_epoch
            );
        }
        if existing.target != request.target || existing.task_key != task.key() {
            bail!("CC_CORRUPT_STORAGE: reservation {execution_key} columns disagree");
        }
        return Ok(existing);
    }

    let host = live_host_count(conn)?;
    if host >= MAX_LIVE_PER_HOST {
        bail!(
            "CC_QUOTA_EXCEEDED: Host already holds {host} live executions \
             (limit {MAX_LIVE_PER_HOST})"
        );
    }
    let workspace_live = live_for_workspace(conn, &request.workspace_id)?;
    if workspace_live >= MAX_LIVE_PER_WORKSPACE {
        bail!(
            "CC_QUOTA_EXCEEDED: command workspace {} already holds {workspace_live} live \
             executions (limit {MAX_LIVE_PER_WORKSPACE})",
            request.workspace_id
        );
    }

    let (kind, session_id, turn_id, parent_session_id, parent_turn_id, delegation_id, generation) =
        match &request.target {
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
        };
    conn.execute(
        "INSERT INTO cc_execution_reservations(execution_key, task_key, kind, workspace_id,
           membership_session, membership_revision, owner_epoch, state, session_id, turn_id,
           parent_session_id, parent_turn_id, delegation_id, generation, parent_key,
           reserved_at, updated_at, released_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reserved', ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?15, NULL)",
        params![
            execution_key,
            task.key(),
            kind,
            request.workspace_id,
            request.target.membership_session(),
            membership.revision,
            request.owner_epoch,
            session_id,
            turn_id,
            parent_session_id,
            parent_turn_id,
            delegation_id,
            generation,
            request.parent_key,
            request.now,
        ],
    )?;
    reservation(conn, &execution_key)?
        .ok_or_else(|| anyhow::anyhow!("CC_CORRUPT_STORAGE: reservation insert was not readable"))
}

pub(crate) fn transition(
    conn: &Connection,
    request: &ReservationTransition,
) -> Result<Reservation> {
    immediate(conn, |conn| transition_in(conn, request))
}

/// Apply one reservation transition with a compare-and-set on the observed
/// state and the acting execution-owner epoch.
pub(crate) fn transition_in(
    conn: &Connection,
    request: &ReservationTransition,
) -> Result<Reservation> {
    request.validate()?;
    apply_transition_in(conn, request)
}

fn apply_transition_in(conn: &Connection, request: &ReservationTransition) -> Result<Reservation> {
    let current = reservation(conn, &request.execution_key)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_RESERVATION_NOT_FOUND: execution {} has no reservation",
            request.execution_key
        )
    })?;
    if current.owner_epoch != request.owner_epoch {
        bail!(
            "CC_EPOCH_CONFLICT: execution {} belongs to execution owner {}",
            request.execution_key,
            current.owner_epoch
        );
    }
    if current.state != request.from {
        bail!(
            "CC_TRANSITION_CONFLICT: execution {} is {} and not {}",
            request.execution_key,
            current.state.as_str(),
            request.from.as_str()
        );
    }
    if current.state.terminal() {
        bail!(
            "CC_TRANSITION_CONFLICT: execution {} already released its capacity as {}",
            request.execution_key,
            current.state.as_str()
        );
    }
    let release = request.to.terminal() as i64;
    let changed = conn.execute(
        "UPDATE cc_execution_reservations
         SET state = ?1, updated_at = ?2,
             released_at = CASE WHEN ?3 = 1 THEN ?2 ELSE released_at END
         WHERE execution_key = ?4 AND state = ?5",
        params![
            request.to.as_str(),
            request.now,
            release,
            request.execution_key,
            request.from.as_str()
        ],
    )?;
    if changed != 1 {
        bail!(
            "CC_TRANSITION_CONFLICT: execution {} changed during the {} transition",
            request.execution_key,
            request.to.as_str()
        );
    }
    record_event_in(
        conn,
        &request.execution_key,
        request.from,
        request.to,
        &request.evidence,
        request.now,
    )?;
    reservation(conn, &request.execution_key)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_CORRUPT_STORAGE: reservation {} disappeared during a transition",
            request.execution_key
        )
    })
}

fn record_event_in(
    conn: &Connection,
    execution_key: &str,
    from: ReservationState,
    to: ReservationState,
    evidence: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO cc_reservation_events(execution_key, from_state, to_state, evidence, recorded_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![execution_key, from.as_str(), to.as_str(), evidence, now],
    )?;
    Ok(())
}

pub(crate) fn events(conn: &Connection, execution_key: &str) -> Result<Vec<ReservationEvent>> {
    let mut statement = conn.prepare(
        "SELECT from_state, to_state, evidence, recorded_at FROM cc_reservation_events
         WHERE execution_key = ?1 ORDER BY sequence",
    )?;
    let rows = statement
        .query_map([execution_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(from, to, evidence, recorded_at)| {
            Ok(ReservationEvent {
                from: ReservationState::parse(&from)?,
                to: ReservationState::parse(&to)?,
                evidence,
                recorded_at,
            })
        })
        .collect()
}

/// Reconcile every non-terminal reservation of a superseded execution-owner
/// generation to `interrupted`.
///
/// The caller must hold the fence proof that the previous owner is stopped;
/// that proof stays in the execution-owner journal, and this function only
/// records the consequence. Capacity is retained: an interrupted execution is
/// released later by a [`transition_in`] with settlement evidence.
pub(crate) fn interrupt_epoch(
    conn: &Connection,
    current_epoch: &str,
    previous_epoch: &str,
    evidence: &str,
    now: i64,
) -> Result<usize> {
    immediate(conn, |conn| {
        interrupt_epoch_in(conn, current_epoch, previous_epoch, evidence, now)
    })
}

pub(crate) fn interrupt_epoch_in(
    conn: &Connection,
    current_epoch: &str,
    previous_epoch: &str,
    evidence: &str,
    now: i64,
) -> Result<usize> {
    validate_uuid(current_epoch)?;
    validate_uuid(previous_epoch)?;
    validate_evidence(evidence)?;
    validate_now(now)?;
    if current_epoch == previous_epoch {
        bail!("CC_INVALID_ARGUMENT: the current and previous execution owners are the same");
    }
    let candidates = {
        let mut statement = conn.prepare(
            "SELECT execution_key, state FROM cc_execution_reservations
             WHERE owner_epoch = ?1 ORDER BY reserved_at, execution_key",
        )?;
        let rows = statement
            .query_map([previous_epoch], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut interrupted = 0usize;
    for (execution_key, state) in candidates {
        let from = ReservationState::parse(&state)?;
        if from.terminal() || from == ReservationState::Interrupted {
            continue;
        }
        if !from.can_advance(ReservationState::Interrupted) {
            continue;
        }
        let changed = conn.execute(
            "UPDATE cc_execution_reservations SET state = 'interrupted', updated_at = ?1
             WHERE execution_key = ?2 AND state = ?3",
            params![now, execution_key, from.as_str()],
        )?;
        if changed == 1 {
            record_event_in(
                conn,
                &execution_key,
                from,
                ReservationState::Interrupted,
                evidence,
                now,
            )?;
            interrupted += 1;
        }
    }
    Ok(interrupted)
}

pub(crate) fn live_for_workspace(conn: &Connection, workspace_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM cc_execution_reservations
             WHERE workspace_id = ?1 AND {}",
            live_predicate()
        ),
        [workspace_id],
        |row| row.get(0),
    )?)
}

pub(crate) fn live_for_membership(conn: &Connection, membership_session: &str) -> Result<i64> {
    Ok(conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM cc_execution_reservations
             WHERE membership_session = ?1 AND {}",
            live_predicate()
        ),
        [membership_session],
        |row| row.get(0),
    )?)
}

fn live_host_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM cc_execution_reservations WHERE {}",
            live_predicate()
        ),
        [],
        |row| row.get(0),
    )?)
}

/// Capacity snapshot for tests, the monitor projection and diagnostics.
pub(crate) fn live_counts(conn: &Connection) -> Result<CapacityCounts> {
    let host = live_host_count(conn)?;
    let mut statement = conn.prepare(&format!(
        "SELECT workspace_id, COUNT(*) FROM cc_execution_reservations
         WHERE {} GROUP BY workspace_id ORDER BY workspace_id",
        live_predicate()
    ))?;
    let workspaces = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(CapacityCounts { host, workspaces })
}
