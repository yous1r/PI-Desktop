//! Bounded, transactionally consistent C2 monitoring cut on private stdio.
//!
//! Only the trusted Node composition consumes this cut. Its RACP page adapter
//! must still authorize each session/workspace for the authenticated connection.
//! No transcript, prompt, credential or model context is read here.
use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::command_center_rpc::{envelope, in_scope, roles_allow, verify_binding, Auth};
use super::{rpc_err, JsonRpcError};
use crate::command_center::state::ReservationState;
use crate::command_center::tx::immediate;
use crate::command_center::{api::wire, goal, identity::TaskTarget, limits, reservation, schema};
use crate::db::now_ms;
use crate::state::AppState;

const MAX_TASKS: usize = 100;
const MAX_CUT_BYTES: usize = 256 * 1024;

pub(crate) async fn handle(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    // The public page adapter rechecks its own scope; the private cut is fenced
    // to this concrete Rust process even when native containment is disabled.
    let result = (|| {
        let request = envelope(&params)?;
        verify_binding(
            &request.binding,
            &request.input,
            Some(st.command_center_owner_epoch()),
            true,
        )?;
        wire::keys(&request.input, &["version", "hostId"], &[])?;
        if wire::integer(&request.input, "version", 1)? != 1 {
            bail!("CC_INVALID_ARGUMENT: unsupported monitor version");
        }
        if !roles_allow(&request.auth.roles, "viewer") {
            bail!("CC_FORBIDDEN: monitor requires an authenticated read role");
        }
        let approvals: HashMap<String, usize> = st
            .permissions
            .pending_requests(None)
            .into_iter()
            .fold(HashMap::new(), |mut counts, pending| {
                *counts.entry(pending.request.session_id).or_default() += 1;
                counts
            });
        immediate(st.db.conn(), |conn| {
            capture(
                conn,
                st.command_center_owner_epoch(),
                &request.auth,
                now_ms(),
                &approvals,
            )
        })
    })();
    result.map_err(|error| {
        // Do not expose SQLite diagnostics or filesystem details to a client.
        let code = error
            .to_string()
            .split(':')
            .next()
            .unwrap_or("CC_INTERNAL")
            .to_owned();
        let code = if code.starts_with("CC_")
            && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
        {
            code
        } else {
            "CC_INTERNAL".to_owned()
        };
        rpc_err(
            1000,
            format!("{code}: monitor cut refused"),
            "COMMAND_CENTER_REFUSED",
        )
    })
}

fn timestamp(ms: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| anyhow::anyhow!("CC_CORRUPT_STORAGE: invalid monitor timestamp"))
}

fn task_json(task: &TaskTarget) -> Value {
    match task {
        TaskTarget::Session { session_id } => json!({"kind":"session", "sessionId":session_id}),
        TaskTarget::Delegation {
            parent_session_id,
            delegation_id,
        } => {
            json!({"kind":"delegation", "parentSessionId":parent_session_id, "delegationId":delegation_id})
        }
    }
}

fn capture(
    conn: &Connection,
    epoch: &str,
    auth: &Auth,
    now: i64,
    approvals: &HashMap<String, usize>,
) -> Result<Value> {
    schema::ensure(conn)?;
    limits::validate_uuid(epoch)?;
    let mut query = conn.prepare(
        "SELECT execution_key FROM (
            SELECT execution_key, updated_at,
                row_number() OVER (PARTITION BY task_key ORDER BY
                    state NOT IN ('completed','aborted','failed','launch_failed') DESC,
                    updated_at DESC, execution_key DESC) AS rank
            FROM cc_execution_reservations
        ) WHERE rank=1 ORDER BY updated_at DESC, execution_key LIMIT ?1",
    )?;
    // Reading one extra row makes a truncated cut an explicit refusal rather
    // than silently reporting that the omitted tasks do not exist.
    let keys = query
        .query_map([(MAX_TASKS + 1) as i64], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if keys.len() > MAX_TASKS {
        bail!("CC_RESPONSE_LIMIT: monitor task cut exceeds row budget");
    }
    let mut rows = Vec::with_capacity(keys.len());
    for key in keys {
        let row = reservation::reservation(conn, &key)?.ok_or_else(|| {
            anyhow::anyhow!("CC_CORRUPT_STORAGE: monitor reservation disappeared")
        })?;
        row.target.validate()?;
        let task = row.target.task();
        // Optional narrower grants are respected on the private cut too. Empty
        // grants are the trusted Node discovery read, not public authorization.
        if (!auth.workspace_ids.is_empty() && !in_scope(&auth.workspace_ids, &row.workspace_id))
            || (!auth.session_ids.is_empty()
                && !in_scope(&auth.session_ids, task.membership_session()))
        {
            continue;
        }
        let head = goal::goal_head(conn, &task)?;
        let desired = head.as_ref().map_or(0, |head| head.desired_revision);
        let effective = head.as_ref().map_or(0, |head| head.effective_revision);
        let label_source = task
            .delegation_id()
            .unwrap_or_else(|| task.membership_session());
        let status = match row.state {
            // Interrupted owners keep capacity until native closure is proven.
            ReservationState::Interrupted => "outcome_unknown",
            other => other.as_str(),
        };
        let mut summary = json!({
            "target": task_json(&task), "commandWorkspaceId": row.workspace_id,
            "label": label_source.chars().take(128).collect::<String>(),
            "status": status, "desiredGoalRevision": desired,
            "effectiveGoalRevision": effective,
            "pendingApprovals": approvals.get(task.membership_session()).copied().unwrap_or(0),
            // Input-question ownership is in the Node runtime; that projection
            // is not inferred from a capacity state or transcript body here.
            "pendingInputs": 0,
            "updatedAt": timestamp(row.updated_at)?,
        });
        if row.retains_capacity() && row.owner_epoch == epoch {
            summary["execution"] = match &row.target {
                crate::command_center::identity::ExecutionTarget::Session {
                    session_id,
                    turn_id,
                } => json!({"kind":"session", "sessionId":session_id, "turnId":turn_id}),
                crate::command_center::identity::ExecutionTarget::Delegation {
                    parent_session_id,
                    parent_turn_id,
                    delegation_id,
                    generation,
                } => json!({"kind":"delegation", "parentSessionId":parent_session_id,
                    "parentTurnId":parent_turn_id, "delegationId":delegation_id,
                    "executionGeneration":generation}),
            };
        }
        if let Some(parent_key) = &row.parent_key {
            summary["parent"] = task_json(&crate::command_center::identity::parse_task_key(
                parent_key,
            )?);
        }
        rows.push(summary);
    }
    // C2 keeps reservation rows and transition evidence; revisions only advance.
    // This cut watermark is monotonic for the queried summaries, not an event
    // stream sequence. Callers refresh explicitly rather than inventing deltas.
    let sequence: i64 = conn.query_row(
        "SELECT (SELECT count(*) FROM cc_execution_reservations)
              + (SELECT count(*) FROM cc_reservation_events)
              + (SELECT coalesce(sum(desired_revision+effective_revision),0) FROM cc_goal_heads)",
        [],
        |row| row.get(0),
    )?;
    limits::validate_revision(sequence, 0)?;
    let result = json!({"version":1, "cursor":{"epoch":epoch,"sequence":sequence},
        "generatedAt":timestamp(now)?, "rows":rows});
    if serde_json::to_vec(&result)?.len() > MAX_CUT_BYTES {
        bail!("CC_RESPONSE_LIMIT: monitor task cut exceeds byte budget");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_center::identity::ExecutionTarget;
    use crate::command_center::reservation::{ReservationRequest, ReservationTransition};
    use crate::command_center::{workspace, BindSession};
    const EPOCH: &str = "38a81348-53cb-4996-b8e9-c22647502819";
    const WS: &str = "c8b23ec9-a5a5-4b9f-a2a5-e5c203a6b6b1";
    const NOW: i64 = 1_730_000_000_000;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(schema::DDL).expect("schema");
        workspace::create_workspace(&conn, WS, "Tests", true, NOW).expect("workspace");
        workspace::bind_session(
            &conn,
            &BindSession {
                session_id: "s1".into(),
                workspace_id: WS.into(),
                expected_revision: None,
                now: NOW,
            },
        )
        .expect("membership");
        conn
    }
    fn auth() -> Auth {
        Auth {
            subject: "dev-monitor".into(),
            roles: vec!["viewer".into()],
            session_ids: vec!["s1".into()],
            workspace_ids: vec![WS.into()],
        }
    }
    fn reserve(conn: &Connection, turn: &str) {
        reservation::reserve(
            conn,
            &ReservationRequest {
                target: ExecutionTarget::session("s1", turn),
                workspace_id: WS.into(),
                expected_membership_revision: 1,
                owner_epoch: EPOCH.into(),
                parent_key: None,
                now: NOW,
            },
        )
        .expect("reserve");
    }
    #[test]
    fn empty_cut_does_not_invent_tasks() {
        let cut = capture(&database(), EPOCH, &auth(), NOW, &HashMap::new()).expect("cut");
        assert_eq!(cut["rows"], json!([]));
        assert_eq!(cut["cursor"], json!({"epoch":EPOCH,"sequence":0}));
    }
    #[test]
    fn reservation_state_and_goal_head_are_the_summary_source() {
        let conn = database();
        reserve(&conn, "t1");
        let before = capture(&conn, EPOCH, &auth(), NOW, &HashMap::new()).expect("first cut");
        assert_eq!(before["rows"][0]["execution"]["turnId"], "t1");
        reservation::transition(
            &conn,
            &ReservationTransition {
                execution_key: ExecutionTarget::session("s1", "t1").key(),
                owner_epoch: EPOCH.into(),
                from: ReservationState::Reserved,
                to: ReservationState::Starting,
                evidence: "launcher admitted".into(),
                now: NOW + 1,
            },
        )
        .expect("transition");
        let after = capture(&conn, EPOCH, &auth(), NOW + 1, &HashMap::new()).expect("second cut");
        assert_eq!(after["rows"][0]["status"], "starting");
        assert!(after["cursor"]["sequence"].as_i64() > before["cursor"]["sequence"].as_i64());
    }
    #[test]
    fn settled_history_and_replaced_owner_do_not_fabricate_active_turns() {
        let conn = database();
        reserve(&conn, "t1");
        reservation::transition(
            &conn,
            &ReservationTransition {
                execution_key: ExecutionTarget::session("s1", "t1").key(),
                owner_epoch: EPOCH.into(),
                from: ReservationState::Reserved,
                to: ReservationState::Aborted,
                evidence: "cancelled before spawn".into(),
                now: NOW + 1,
            },
        )
        .expect("release");
        reserve(&conn, "t2");
        let cut = capture(&conn, EPOCH, &auth(), NOW + 2, &HashMap::new()).expect("cut");
        assert_eq!(cut["rows"].as_array().expect("rows").len(), 1);
        assert_eq!(cut["rows"][0]["execution"]["turnId"], "t2");
        let other = capture(
            &conn,
            "ae1d71d7-1109-4683-ae68-398fb363c7b2",
            &auth(),
            NOW + 2,
            &HashMap::new(),
        )
        .expect("new owner cut");
        assert!(other["rows"][0].get("execution").is_none());
    }
    #[test]
    fn narrower_private_scope_is_filtered() {
        let conn = database();
        reserve(&conn, "t1");
        let mut grants = auth();
        grants.session_ids = vec!["other-session".into()];
        let cut = capture(&conn, EPOCH, &grants, NOW, &HashMap::new()).expect("cut");
        assert_eq!(cut["rows"], json!([]));
    }
}
