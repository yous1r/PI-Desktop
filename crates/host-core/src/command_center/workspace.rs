//! Command workspace and session-membership authority.
//!
//! A workspace is an operational group, never a project, directory or view.
//! Membership is the single source of truth for which workspace a session
//! belongs to at a given revision; every admission and control mutation carries
//! that revision as a fence.
//!
//! First-release rules enforced here:
//!
//! * at most three enabled workspaces per Host, at most 100 saved ones;
//! * a live execution belongs to exactly one workspace, so a session may not
//!   move while any of its reservations is still non-terminal;
//! * a workspace may not be disabled or deleted while live reservations would
//!   be stranded;
//! * a workspace that ever admitted work keeps its history: delete is refused
//!   as soon as any reservation or membership row references it, and disable is
//!   the supported retirement path.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::limits::{
    next_revision, validate_canonical_id, validate_label, validate_now, validate_revision,
    validate_uuid, MAX_ENABLED_WORKSPACES, MAX_WORKSPACES,
};
use super::reservation::{live_for_membership, live_for_workspace};
use super::tx::immediate;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Workspace {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Membership {
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    pub(crate) revision: i64,
}

/// A bind that creates membership, or moves it while the session is idle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BindSession {
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    /// Observed membership revision. `None` is only valid when no membership
    /// exists yet, so a stale client cannot silently overwrite a live binding.
    pub(crate) expected_revision: Option<i64>,
    pub(crate) now: i64,
}

fn read_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        name: row.get(1)?,
        enabled: row.get(2)?,
        revision: row.get(3)?,
    })
}

fn read_membership(row: &rusqlite::Row<'_>) -> rusqlite::Result<Membership> {
    Ok(Membership {
        session_id: row.get(0)?,
        workspace_id: row.get(1)?,
        revision: row.get(2)?,
    })
}

pub(crate) fn workspace(conn: &Connection, id: &str) -> Result<Option<Workspace>> {
    validate_uuid(id)?;
    Ok(conn
        .query_row(
            "SELECT id, name, enabled, revision FROM cc_workspaces WHERE id = ?1",
            [id],
            read_workspace,
        )
        .optional()?)
}

/// Saved workspaces in creation order. The contract page bound is 100 rows.
pub(crate) fn workspaces(conn: &Connection) -> Result<Vec<Workspace>> {
    let mut statement = conn.prepare(
        "SELECT id, name, enabled, revision FROM cc_workspaces
         ORDER BY created_at, id LIMIT ?1",
    )?;
    let rows = statement
        .query_map([MAX_WORKSPACES], read_workspace)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn require_enabled_slot(conn: &Connection, excluding: Option<&str>) -> Result<()> {
    let enabled: i64 = match excluding {
        Some(id) => conn.query_row(
            "SELECT COUNT(*) FROM cc_workspaces WHERE enabled = 1 AND id <> ?1",
            [id],
            |row| row.get(0),
        )?,
        None => conn.query_row(
            "SELECT COUNT(*) FROM cc_workspaces WHERE enabled = 1",
            [],
            |row| row.get(0),
        )?,
    };
    if enabled >= MAX_ENABLED_WORKSPACES {
        bail!(
            "CC_QUOTA_EXCEEDED: at most {MAX_ENABLED_WORKSPACES} enabled command workspaces \
             are allowed; disable one before enabling another"
        );
    }
    Ok(())
}

pub(crate) fn create_workspace(
    conn: &Connection,
    id: &str,
    name: &str,
    enabled: bool,
    now: i64,
) -> Result<Workspace> {
    immediate(conn, |conn| {
        create_workspace_in(conn, id, name, enabled, now)
    })
}

pub(crate) fn create_workspace_in(
    conn: &Connection,
    id: &str,
    name: &str,
    enabled: bool,
    now: i64,
) -> Result<Workspace> {
    validate_uuid(id)?;
    validate_label(name)?;
    validate_now(now)?;
    if workspace(conn, id)?.is_some() {
        bail!("CC_WORKSPACE_EXISTS: command workspace {id} already exists");
    }
    let saved: i64 = conn.query_row("SELECT COUNT(*) FROM cc_workspaces", [], |row| row.get(0))?;
    if saved >= MAX_WORKSPACES {
        bail!("CC_WORKSPACE_LIMIT: at most {MAX_WORKSPACES} command workspaces are stored");
    }
    if enabled {
        require_enabled_slot(conn, None)?;
    }
    conn.execute(
        "INSERT INTO cc_workspaces(id, name, enabled, revision, created_at, updated_at)
         VALUES(?1, ?2, ?3, 1, ?4, ?4)",
        params![id, name, enabled as i64, now],
    )?;
    Ok(Workspace {
        id: id.to_owned(),
        name: name.to_owned(),
        enabled,
        revision: 1,
    })
}

pub(crate) fn rename_workspace(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    name: &str,
    now: i64,
) -> Result<Workspace> {
    immediate(conn, |conn| {
        rename_workspace_in(conn, id, expected_revision, name, now)
    })
}

pub(crate) fn rename_workspace_in(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    name: &str,
    now: i64,
) -> Result<Workspace> {
    validate_uuid(id)?;
    validate_label(name)?;
    validate_revision(expected_revision, 1)?;
    validate_now(now)?;
    let current = workspace(conn, id)?.ok_or_else(|| {
        anyhow::anyhow!("CC_WORKSPACE_NOT_FOUND: command workspace {id} is unknown")
    })?;
    if current.revision != expected_revision {
        bail!(
            "CC_WORKSPACE_CONFLICT: command workspace {id} is at revision {}",
            current.revision
        );
    }
    if current.name == name {
        return Ok(current);
    }
    let revision = next_revision(current.revision)?;
    let changed = conn.execute(
        "UPDATE cc_workspaces SET name = ?1, revision = ?2, updated_at = ?3
         WHERE id = ?4 AND revision = ?5",
        params![name, revision, now, id, expected_revision],
    )?;
    if changed != 1 {
        bail!("CC_WORKSPACE_CONFLICT: command workspace {id} changed during the rename");
    }
    Ok(Workspace {
        name: name.to_owned(),
        revision,
        ..current
    })
}

pub(crate) fn set_workspace_enabled(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    enabled: bool,
    now: i64,
) -> Result<Workspace> {
    immediate(conn, |conn| {
        set_workspace_enabled_in(conn, id, expected_revision, enabled, now)
    })
}

pub(crate) fn set_workspace_enabled_in(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    enabled: bool,
    now: i64,
) -> Result<Workspace> {
    validate_uuid(id)?;
    validate_revision(expected_revision, 1)?;
    validate_now(now)?;
    let current = workspace(conn, id)?.ok_or_else(|| {
        anyhow::anyhow!("CC_WORKSPACE_NOT_FOUND: command workspace {id} is unknown")
    })?;
    if current.revision != expected_revision {
        bail!(
            "CC_WORKSPACE_CONFLICT: command workspace {id} is at revision {}",
            current.revision
        );
    }
    if current.enabled == enabled {
        return Ok(current);
    }
    if enabled {
        require_enabled_slot(conn, Some(id))?;
    } else {
        let live = live_for_workspace(conn, id)?;
        if live > 0 {
            bail!(
                "CC_WORKSPACE_LIVE: command workspace {id} still owns {live} live execution(s); \
                 settle or reconcile them before disabling it"
            );
        }
    }
    let revision = next_revision(current.revision)?;
    let changed = conn.execute(
        "UPDATE cc_workspaces SET enabled = ?1, revision = ?2, updated_at = ?3
         WHERE id = ?4 AND revision = ?5",
        params![enabled as i64, revision, now, id, expected_revision],
    )?;
    if changed != 1 {
        bail!("CC_WORKSPACE_CONFLICT: command workspace {id} changed during the update");
    }
    Ok(Workspace {
        enabled,
        revision,
        ..current
    })
}

/// Delete an unused workspace. History keeps the row otherwise: disable it.
pub(crate) fn delete_workspace(conn: &Connection, id: &str, expected_revision: i64) -> Result<()> {
    immediate(conn, |conn| {
        delete_workspace_in(conn, id, expected_revision)
    })
}

pub(crate) fn delete_workspace_in(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
) -> Result<()> {
    validate_uuid(id)?;
    validate_revision(expected_revision, 1)?;
    let current = workspace(conn, id)?.ok_or_else(|| {
        anyhow::anyhow!("CC_WORKSPACE_NOT_FOUND: command workspace {id} is unknown")
    })?;
    if current.revision != expected_revision {
        bail!(
            "CC_WORKSPACE_CONFLICT: command workspace {id} is at revision {}",
            current.revision
        );
    }
    let members: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cc_session_memberships WHERE workspace_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    let reservations: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cc_execution_reservations WHERE workspace_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    if members > 0 || reservations > 0 {
        bail!(
            "CC_WORKSPACE_LIVE: command workspace {id} still has {members} membership(s) and \
             {reservations} retained reservation(s); disable it instead of deleting history"
        );
    }
    let changed = conn.execute(
        "DELETE FROM cc_workspaces WHERE id = ?1 AND revision = ?2",
        params![id, expected_revision],
    )?;
    if changed != 1 {
        bail!("CC_WORKSPACE_CONFLICT: command workspace {id} changed during the delete");
    }
    Ok(())
}

pub(crate) fn membership(conn: &Connection, session_id: &str) -> Result<Option<Membership>> {
    validate_canonical_id(session_id, "sessionId")?;
    Ok(conn
        .query_row(
            "SELECT session_id, workspace_id, revision FROM cc_session_memberships
             WHERE session_id = ?1",
            [session_id],
            read_membership,
        )
        .optional()?)
}

/// Membership required by admission and control; a missing row is a target
/// error, not an invalid argument.
pub(crate) fn require_membership(conn: &Connection, session_id: &str) -> Result<Membership> {
    membership(conn, session_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_TARGET_NOT_FOUND: session {session_id} is not assigned to a command workspace"
        )
    })
}

pub(crate) fn bind_session(conn: &Connection, request: &BindSession) -> Result<Membership> {
    immediate(conn, |conn| bind_session_in(conn, request))
}

pub(crate) fn bind_session_in(conn: &Connection, request: &BindSession) -> Result<Membership> {
    validate_canonical_id(&request.session_id, "sessionId")?;
    validate_uuid(&request.workspace_id)?;
    validate_now(request.now)?;
    if let Some(revision) = request.expected_revision {
        validate_revision(revision, 1)?;
    }
    let target = workspace(conn, &request.workspace_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "CC_WORKSPACE_NOT_FOUND: command workspace {} is unknown",
            request.workspace_id
        )
    })?;
    let current = membership(conn, &request.session_id)?;
    match (current, request.expected_revision) {
        (None, None) => {
            if !target.enabled {
                bail!(
                    "CC_WORKSPACE_DISABLED: command workspace {} is not enabled",
                    request.workspace_id
                );
            }
            conn.execute(
                "INSERT INTO cc_session_memberships(session_id, workspace_id, revision, bound_at, updated_at)
                 VALUES(?1, ?2, 1, ?3, ?3)",
                params![request.session_id, request.workspace_id, request.now],
            )?;
            Ok(Membership {
                session_id: request.session_id.clone(),
                workspace_id: request.workspace_id.clone(),
                revision: 1,
            })
        }
        (None, Some(_)) => bail!(
            "CC_MEMBERSHIP_CONFLICT: session {} has no membership but the client named a revision",
            request.session_id
        ),
        (Some(current), None) => bail!(
            "CC_MEMBERSHIP_CONFLICT: session {} is already bound; name its current revision {}",
            request.session_id,
            current.revision
        ),
        (Some(current), Some(expected)) => {
            if current.revision != expected {
                bail!(
                    "CC_MEMBERSHIP_CONFLICT: session {} membership is at revision {}",
                    request.session_id,
                    current.revision
                );
            }
            if current.workspace_id == request.workspace_id {
                return Ok(current);
            }
            if !target.enabled {
                bail!(
                    "CC_WORKSPACE_DISABLED: command workspace {} is not enabled",
                    request.workspace_id
                );
            }
            let live = live_for_membership(conn, &request.session_id)?;
            if live > 0 {
                bail!(
                    "CC_MEMBERSHIP_LIVE: session {} still owns {live} live execution(s); \
                     membership cannot change while it is live",
                    request.session_id
                );
            }
            let revision = next_revision(current.revision)?;
            let changed = conn.execute(
                "UPDATE cc_session_memberships
                 SET workspace_id = ?1, revision = ?2, updated_at = ?3
                 WHERE session_id = ?4 AND revision = ?5",
                params![
                    request.workspace_id,
                    revision,
                    request.now,
                    request.session_id,
                    expected
                ],
            )?;
            if changed != 1 {
                bail!(
                    "CC_MEMBERSHIP_CONFLICT: session {} membership changed during the move",
                    request.session_id
                );
            }
            Ok(Membership {
                session_id: request.session_id.clone(),
                workspace_id: request.workspace_id.clone(),
                revision,
            })
        }
    }
}
