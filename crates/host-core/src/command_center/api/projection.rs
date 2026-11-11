//! Transport projections and bounded reads; no second storage authority.
use super::super::{
    identity::ExecutionTarget,
    receipt::Receipt,
    workspace::{Membership, Workspace},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(crate) fn workspace(row: &Workspace) -> Value {
    json!({"id": row.id, "name": row.name, "enabled": row.enabled, "revision": row.revision})
}
pub(crate) fn membership(row: &Membership) -> Value {
    json!({"sessionId": row.session_id, "commandWorkspaceId": row.workspace_id, "revision": row.revision})
}
fn target(row: &ExecutionTarget) -> Value {
    match row {
        ExecutionTarget::Session {
            session_id,
            turn_id,
        } => json!({"kind":"session", "sessionId":session_id, "turnId":turn_id}),
        ExecutionTarget::Delegation {
            parent_session_id,
            parent_turn_id,
            delegation_id,
            generation,
        } => {
            json!({"kind":"delegation", "parentSessionId":parent_session_id, "parentTurnId":parent_turn_id, "delegationId":delegation_id, "executionGeneration":generation})
        }
    }
}
pub(crate) fn receipt(row: &Receipt) -> Result<Value> {
    let mut receipt = json!({
        "version":1, "requestId":row.request_id, "fingerprint":row.fingerprint,
        "target":target(&row.target), "operation":row.operation.as_str(), "status":row.status.as_str(),
        "revision":row.revision, "desiredGoalRevision":row.desired_revision, "effectiveGoalRevision":row.effective_revision,
    });
    if let Some(error) = &row.error {
        receipt["error"] = json!({"code":error.code, "message":error.message});
    }
    if serde_json::to_vec(&receipt)?.len() > 16 * 1024 {
        bail!("CC_RESPONSE_LIMIT: receipt exceeds budget");
    }
    Ok(
        json!({"receipt":receipt, "hostId":row.host_id, "hostEpoch":row.owner_epoch,
        "commandWorkspaceId":row.workspace_id, "membershipRevision":row.membership_revision, "sequence":row.sequence}),
    )
}
/// C2 owns membership mutations. This projection only pages its existing table.
pub(crate) fn memberships(
    conn: &Connection,
    workspace_id: &str,
    after: &str,
    limit: i64,
) -> Result<Value> {
    let mut query = conn.prepare("SELECT session_id, workspace_id, revision FROM cc_session_memberships WHERE workspace_id=?1 AND session_id>?2 ORDER BY session_id LIMIT ?3")?;
    let rows = query
        .query_map(params![workspace_id, after, limit], |row| {
            Ok(Membership {
                session_id: row.get(0)?,
                workspace_id: row.get(1)?,
                revision: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = if rows.len() == limit as usize {
        rows.last().map(|row| row.session_id.as_str())
    } else {
        None
    };
    Ok(
        json!({"memberships":rows.iter().map(membership).collect::<Vec<_>>(), "nextAfterSessionId":next}),
    )
}
