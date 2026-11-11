//! Durable parent notifications for child goal revisions.
//!
//! A native child that receives a new desired goal revision must not rely on the
//! parent being awake at that instant. The revision is queued here inside the
//! same transaction that commits it, so a parent that reloads, restarts or
//! settles later can still read what its children were told.
//!
//! Delivery is bookkeeping, not a second effect: the goal revision is already
//! durable, and replaying it cannot duplicate anything. That is why delivery is
//! idempotent while supersession and parent settlement are one-way.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::identity::{parse_execution_key, parse_task_key, validate_task_key};
use super::limits::{
    validate_host_id, validate_now, validate_principal, validate_revision, validate_uuid, PAGE_SIZE,
};
use super::tx::immediate;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationState {
    Pending,
    Delivered,
    /// A newer revision of the same child replaced this one before delivery.
    Superseded,
    /// The parent settled; nothing will consume this notification any more.
    ParentSettled,
}

impl NotificationState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Delivered => "delivered",
            Self::Superseded => "superseded",
            Self::ParentSettled => "parent_settled",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "pending" => Self::Pending,
            "delivered" => Self::Delivered,
            "superseded" => Self::Superseded,
            "parent_settled" => Self::ParentSettled,
            other => bail!("CC_CORRUPT_STORAGE: unknown notification state {other}"),
        })
    }

    /// States a delivery attempt may still act on.
    pub(crate) fn open(self) -> bool {
        matches!(self, Self::Pending | Self::Delivered)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParentNotification {
    pub(crate) sequence: i64,
    pub(crate) child_task_key: String,
    pub(crate) parent_task_key: String,
    pub(crate) child_revision: i64,
    pub(crate) execution_key: String,
    pub(crate) host_id: String,
    pub(crate) principal: String,
    pub(crate) request_id: String,
    pub(crate) state: NotificationState,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

/// A notification to queue. `child_revision` is the revision that was just
/// committed, so the parent can tell which intent the child received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingNotification {
    pub(crate) child_task_key: String,
    pub(crate) parent_task_key: String,
    pub(crate) child_revision: i64,
    pub(crate) execution_key: String,
    pub(crate) host_id: String,
    pub(crate) principal: String,
    pub(crate) request_id: String,
    pub(crate) now: i64,
}

impl PendingNotification {
    fn validate(&self) -> Result<()> {
        // Task and execution keys are tuples of bounded identifiers, so they are
        // longer than one identifier: measuring them against the component limit
        // would reject a valid long child or parent. This checks the tuple shape
        // instead, and the length cap it uses scales with the components.
        let child = parse_task_key(&self.child_task_key)?;
        let execution = parse_execution_key(&self.execution_key)?;
        if execution.task() != child {
            bail!("CC_INVALID_ARGUMENT: executionKey does not belong to childTaskKey");
        }
        validate_task_key(&self.parent_task_key)?;
        validate_host_id(&self.host_id)?;
        validate_principal(&self.principal)?;
        validate_uuid(&self.request_id)?;
        validate_revision(self.child_revision, 1)?;
        validate_now(self.now)?;
        if self.child_task_key == self.parent_task_key {
            bail!("CC_INVALID_ARGUMENT: a task cannot notify itself of a goal revision");
        }
        Ok(())
    }
}

const SELECT_NOTIFICATION: &str = "SELECT sequence, child_task_key, parent_task_key, \
     child_revision, execution_key, host_id, principal, request_id, delivery_state, created_at, \
     updated_at FROM cc_parent_notifications";

fn read_notification(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ParentNotification>> {
    let state: String = row.get(8)?;
    let state = match NotificationState::parse(&state) {
        Ok(state) => state,
        Err(error) => return Ok(Err(error)),
    };
    Ok(Ok(ParentNotification {
        sequence: row.get(0)?,
        child_task_key: row.get(1)?,
        parent_task_key: row.get(2)?,
        child_revision: row.get(3)?,
        execution_key: row.get(4)?,
        host_id: row.get(5)?,
        principal: row.get(6)?,
        request_id: row.get(7)?,
        state,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    }))
}

pub(crate) fn notification(
    conn: &Connection,
    child_task_key: &str,
    child_revision: i64,
) -> Result<Option<ParentNotification>> {
    validate_task_key(child_task_key)?;
    validate_revision(child_revision, 1)?;
    let row = conn
        .query_row(
            &format!("{SELECT_NOTIFICATION} WHERE child_task_key = ?1 AND child_revision = ?2"),
            params![child_task_key, child_revision],
            read_notification,
        )
        .optional()?;
    match row {
        Some(result) => Ok(Some(result?)),
        None => Ok(None),
    }
}

/// Queue one notification for callers that already hold the transaction.
///
/// Older *pending* revisions of the same child are marked `superseded` in the
/// same statement sequence: a parent that has not caught up only needs the
/// latest revision, and the row survives as evidence of what it missed.
pub(crate) fn record_pending_in(
    conn: &Connection,
    pending: &PendingNotification,
) -> Result<ParentNotification> {
    pending.validate()?;
    conn.execute(
        "UPDATE cc_parent_notifications SET delivery_state = 'superseded', updated_at = ?1
         WHERE child_task_key = ?2 AND child_revision < ?3 AND delivery_state = 'pending'",
        params![pending.now, pending.child_task_key, pending.child_revision],
    )?;
    conn.execute(
        "INSERT INTO cc_parent_notifications(sequence, child_task_key, parent_task_key,
           child_revision, execution_key, host_id, principal, request_id, delivery_state,
           created_at, updated_at)
         VALUES(NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)
         ON CONFLICT(child_task_key, child_revision) DO NOTHING",
        params![
            pending.child_task_key,
            pending.parent_task_key,
            pending.child_revision,
            pending.execution_key,
            pending.host_id,
            pending.principal,
            pending.request_id,
            pending.now,
        ],
    )?;
    let stored =
        notification(conn, &pending.child_task_key, pending.child_revision)?.ok_or_else(|| {
            anyhow::anyhow!("CC_CORRUPT_STORAGE: notification insert was not readable")
        })?;
    if stored.parent_task_key != pending.parent_task_key
        || stored.execution_key != pending.execution_key
        || stored.request_id != pending.request_id
        || stored.principal != pending.principal
    {
        bail!(
            "CC_CORRUPT_STORAGE: notification for {} revision {} belongs to another \
             intervention",
            pending.child_task_key,
            pending.child_revision
        );
    }
    Ok(stored)
}

pub(crate) fn record_pending(
    conn: &Connection,
    pending: &PendingNotification,
) -> Result<ParentNotification> {
    immediate(conn, |conn| record_pending_in(conn, pending))
}

/// Open notifications for one parent, oldest first.
pub(crate) fn pending_for_parent(
    conn: &Connection,
    parent_task_key: &str,
    limit: i64,
) -> Result<Vec<ParentNotification>> {
    validate_task_key(parent_task_key)?;
    if limit < 1 || limit > PAGE_SIZE {
        bail!("CC_INVALID_ARGUMENT: limit must be between 1 and {PAGE_SIZE}");
    }
    let mut statement = conn.prepare(&format!(
        "{SELECT_NOTIFICATION} WHERE parent_task_key = ?1
         AND delivery_state IN ('pending', 'delivered') ORDER BY sequence LIMIT ?2"
    ))?;
    let rows = statement
        .query_map(params![parent_task_key, limit], read_notification)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut notifications = Vec::with_capacity(rows.len());
    for row in rows {
        notifications.push(row?);
    }
    Ok(notifications)
}

/// Mark one notification as delivered. Repeating it is a no-op, because a
/// parent that lost its connection may legitimately report the same delivery
/// twice and the underlying goal revision is already durable.
pub(crate) fn deliver_notification(
    conn: &Connection,
    child_task_key: &str,
    child_revision: i64,
    now: i64,
) -> Result<ParentNotification> {
    immediate(conn, |conn| {
        deliver_notification_in(conn, child_task_key, child_revision, now)
    })
}

pub(crate) fn deliver_notification_in(
    conn: &Connection,
    child_task_key: &str,
    child_revision: i64,
    now: i64,
) -> Result<ParentNotification> {
    validate_now(now)?;
    let current = require(conn, child_task_key, child_revision)?;
    match current.state {
        NotificationState::Delivered => return Ok(current),
        NotificationState::Pending => {}
        other => bail!(
            "CC_TRANSITION_INVALID: notification {} for {} revision {} is {} and cannot be \
             delivered",
            current.sequence,
            current.child_task_key,
            current.child_revision,
            other.as_str()
        ),
    }
    let changed = conn.execute(
        "UPDATE cc_parent_notifications SET delivery_state = 'delivered', updated_at = ?1
         WHERE sequence = ?2 AND delivery_state = 'pending'",
        params![now, current.sequence],
    )?;
    if changed != 1 {
        bail!(
            "CC_TRANSITION_CONFLICT: notification {} changed during delivery",
            current.sequence
        );
    }
    require(conn, child_task_key, child_revision)
}

/// Close every open notification of a parent that has settled.
///
/// Nothing will read them afterwards, and keeping them open would suggest work
/// that can no longer happen.
pub(crate) fn settle_for_parent(
    conn: &Connection,
    parent_task_key: &str,
    now: i64,
) -> Result<usize> {
    immediate(conn, |conn| {
        settle_for_parent_in(conn, parent_task_key, now)
    })
}

pub(crate) fn settle_for_parent_in(
    conn: &Connection,
    parent_task_key: &str,
    now: i64,
) -> Result<usize> {
    validate_task_key(parent_task_key)?;
    validate_now(now)?;
    Ok(conn.execute(
        "UPDATE cc_parent_notifications SET delivery_state = 'parent_settled', updated_at = ?1
         WHERE parent_task_key = ?2 AND delivery_state IN ('pending', 'delivered')",
        params![now, parent_task_key],
    )?)
}

fn require(
    conn: &Connection,
    child_task_key: &str,
    child_revision: i64,
) -> Result<ParentNotification> {
    notification(conn, child_task_key, child_revision)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_NOTIFICATION_NOT_FOUND: {} revision {} has no notification",
            child_task_key,
            child_revision
        )
    })
}
