//! Command-center C2 transport adapter.
//!
//! The TypeScript `RustCommandCenterRepository` sends one private stdio request
//! per C2 operation: `{ binding, auth, input }`. Auth and binding are transport
//! state, never RACP fields. This module validates that envelope, checks the
//! operation role and scopes, then delegates every durable rule to
//! [`crate::command_center`]; it owns no storage and no second receipt ledger.

use std::sync::Arc;

use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::command_center::api::{projection, wire};
use crate::command_center::limits::{self, ReceiptError};
use crate::command_center::state::ReceiptStatus;
use crate::command_center::{goal, receipt, workspace, BindSession, ReceiptTransition};
use crate::db::now_ms;
use crate::state::AppState;

use super::{rpc_err, JsonRpcError};

const VALID_ROLES: [&str; 4] = ["viewer", "controller", "approver", "owner"];
const MAX_SCOPE_IDS: usize = 256;

#[derive(Debug)]
pub(super) struct Binding {
    pub(super) host_id: String,
    pub(super) host_epoch: String,
}

#[derive(Debug)]
pub(super) struct Auth {
    pub(super) subject: String,
    pub(super) roles: Vec<String>,
    pub(super) session_ids: Vec<String>,
    pub(super) workspace_ids: Vec<String>,
}

#[derive(Debug)]
pub(super) struct Envelope {
    pub(super) binding: Binding,
    pub(super) auth: Auth,
    pub(super) input: Value,
}

fn string_array(value: &Value, key: &str) -> Result<Vec<String>> {
    let items = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: {key} must be an array"))?;
    if items.len() > MAX_SCOPE_IDS {
        bail!("CC_INVALID_ARGUMENT: {key} exceeds {MAX_SCOPE_IDS} entries");
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: {key} must contain strings"))
        })
        .collect()
}

pub(super) fn envelope(params: &Value) -> Result<Envelope> {
    wire::keys(params, &["binding", "auth", "input"], &[])?;
    let binding = params.get("binding").expect("validated");
    wire::keys(binding, &["hostId", "hostEpoch"], &[])?;
    let auth = params.get("auth").expect("validated");
    wire::keys(
        auth,
        &["subject", "roles", "sessionIds", "workspaceIds"],
        &[],
    )?;
    let host_id = wire::string(binding, "hostId")?.to_owned();
    limits::validate_host_id(&host_id)?;
    let host_epoch = wire::string(binding, "hostEpoch")?.to_owned();
    limits::validate_uuid(&host_epoch)?;
    let subject = wire::string(auth, "subject")?.to_owned();
    limits::validate_principal(&subject)?;
    let envelope = Envelope {
        binding: Binding {
            host_id,
            host_epoch,
        },
        auth: Auth {
            subject,
            roles: string_array(auth, "roles")?,
            session_ids: string_array(auth, "sessionIds")?,
            workspace_ids: string_array(auth, "workspaceIds")?,
        },
        input: params
            .get("input")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: input is required"))?,
    };
    Ok(envelope)
}

/// The binding must agree with the request identity and, when this Host runs an
/// exclusive owner epoch, with the current epoch. A stale binding is refused
/// before any repository call.
///
/// `require_epoch` makes a missing current epoch a refusal instead of a skip:
/// quota admission must never claim to have verified freshness on a Host that
/// has no boot owner epoch.
pub(super) fn verify_binding(
    binding: &Binding,
    input: &Value,
    current_epoch: Option<&str>,
    require_epoch: bool,
) -> Result<()> {
    let input_host = wire::string(input, "hostId")?;
    if input_host != binding.host_id {
        bail!("CC_CONFLICT: request host does not match the bound host");
    }
    if let Some(epoch) = input.get("expectedHostEpoch").and_then(Value::as_str) {
        if epoch != binding.host_epoch {
            bail!("CC_CONFLICT: request epoch does not match the bound host epoch");
        }
    }
    match current_epoch {
        Some(current) if binding.host_epoch != current => {
            bail!("CC_EPOCH_CONFLICT: the binding names a stale command-center owner epoch");
        }
        None if require_epoch => {
            bail!("CC_EPOCH_UNAVAILABLE: this Host has no boot owner epoch to verify against");
        }
        _ => {}
    }
    Ok(())
}

fn required_role(method: &str) -> &'static str {
    match method {
        "workspace.create" | "workspace.rename" | "workspace.setEnabled" | "workspace.delete" => {
            "owner"
        }
        "membership.bind" | "membership.remove" | "intervention.record" | "intervention.ack" => {
            "controller"
        }
        _ => "viewer",
    }
}

pub(super) fn roles_allow(roles: &[String], required: &str) -> bool {
    if roles
        .iter()
        .any(|role| !VALID_ROLES.contains(&role.as_str()))
    {
        return false;
    }
    if roles.iter().any(|role| role == "owner") {
        return true;
    }
    if required == "viewer" {
        return !roles.is_empty();
    }
    roles.iter().any(|role| role == required)
}

pub(super) fn in_scope(scopes: &[String], id: &str) -> bool {
    scopes.iter().any(|scope| scope == id)
}

/// Role first, then the request's own ids against the scopes minted by the
/// trusted adapter. Receipt reads stay principal-scoped in the C2 ledger.
fn authorize(auth: &Auth, method: &str, input: &Value) -> Result<()> {
    if !roles_allow(&auth.roles, required_role(method)) {
        bail!("CC_FORBIDDEN: the principal lacks the role for {method}");
    }
    if let Some(workspace_id) = input.get("commandWorkspaceId").and_then(Value::as_str) {
        if method != "workspace.create" && !in_scope(&auth.workspace_ids, workspace_id) {
            bail!("CC_FORBIDDEN: workspace {workspace_id} is outside the authenticated scope");
        }
    }
    if let Some(session_id) = input.get("sessionId").and_then(Value::as_str) {
        if !in_scope(&auth.session_ids, session_id) {
            bail!("CC_FORBIDDEN: session {session_id} is outside the authenticated scope");
        }
    }
    Ok(())
}

/// Validate and execute one `commandCenter.*` request.
///
/// The state lock is held for the whole call: the C2 layer opens its own
/// immediate transactions on the same connection, and the owner epoch cannot
/// change between validation and the repository call.
pub(crate) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let method = method.strip_prefix("commandCenter.").ok_or_else(|| {
        rpc_err(
            1002,
            "unknown command-center method",
            "COMMAND_CENTER_REFUSED",
        )
    })?;
    let st = state.lock().await;
    // The Host supplies its actual boot/fenced owner epoch; a generic mutation
    // never trusts a request-supplied epoch.
    let current_epoch = st.command_center_owner_epoch().to_owned();
    handle_with_connection(st.db.conn(), Some(&current_epoch), method, &params)
        .map_err(|error| rpc_err(1000, error.to_string(), "COMMAND_CENTER_REFUSED"))
}

fn handle_with_connection(
    conn: &Connection,
    current_epoch: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let envelope = envelope(params)?;
    verify_binding(&envelope.binding, &envelope.input, current_epoch, true)?;
    wire::validate(method, &envelope.input)?;
    authorize(&envelope.auth, method, &envelope.input)?;
    dispatch(
        conn,
        method,
        &envelope.input,
        &envelope.binding,
        &envelope.auth,
    )
}

fn dispatch(
    conn: &Connection,
    method: &str,
    input: &Value,
    binding: &Binding,
    auth: &Auth,
) -> Result<Value> {
    match method {
        "workspace.list" => {
            let rows = workspace::workspaces(conn)?;
            let visible = if auth.workspace_ids.is_empty() {
                rows
            } else {
                rows.into_iter()
                    .filter(|row| in_scope(&auth.workspace_ids, &row.id))
                    .collect()
            };
            Ok(json!({
                "workspaces": visible.iter().map(projection::workspace).collect::<Vec<_>>(),
            }))
        }
        "workspace.get" => {
            let id = wire::uuid(input, "commandWorkspaceId")?;
            Ok(match workspace::workspace(conn, id)? {
                Some(row) => projection::workspace(&row),
                None => Value::Null,
            })
        }
        "workspace.create" => {
            let id = wire::uuid(input, "commandWorkspaceId")?;
            let name = wire::label(input, "name")?;
            let enabled = wire::boolean(input, "enabled")?;
            let row = workspace::create_workspace(conn, id, name, enabled, now_ms())?;
            Ok(projection::workspace(&row))
        }
        "workspace.rename" => {
            let id = wire::uuid(input, "commandWorkspaceId")?;
            let revision = wire::integer(input, "expectedRevision", 1)?;
            let name = wire::label(input, "name")?;
            let row = workspace::rename_workspace(conn, id, revision, name, now_ms())?;
            Ok(projection::workspace(&row))
        }
        "workspace.setEnabled" => {
            let id = wire::uuid(input, "commandWorkspaceId")?;
            let revision = wire::integer(input, "expectedRevision", 1)?;
            let enabled = wire::boolean(input, "enabled")?;
            let row = workspace::set_workspace_enabled(conn, id, revision, enabled, now_ms())?;
            Ok(projection::workspace(&row))
        }
        "workspace.delete" => {
            let id = wire::uuid(input, "commandWorkspaceId")?;
            let revision = wire::integer(input, "expectedRevision", 1)?;
            workspace::delete_workspace(conn, id, revision)?;
            Ok(json!({ "deleted": true }))
        }
        "membership.get" => {
            let session_id = wire::canonical(input, "sessionId")?;
            Ok(match workspace::membership(conn, session_id)? {
                Some(row) => projection::membership(&row),
                None => Value::Null,
            })
        }
        "membership.list" => {
            let workspace_id = wire::uuid(input, "commandWorkspaceId")?;
            let after = input
                .get("afterSessionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let limit = wire::integer(input, "limit", 1)?;
            projection::memberships(conn, workspace_id, after, limit)
        }
        "membership.bind" => {
            let session_id = wire::canonical(input, "sessionId")?;
            let workspace_id = wire::uuid(input, "commandWorkspaceId")?;
            let expected_revision = match input.get("expectedRevision") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_i64().ok_or_else(|| {
                    anyhow::anyhow!("CC_INVALID_ARGUMENT: expectedRevision must be an integer")
                })?),
            };
            let row = workspace::bind_session(
                conn,
                &BindSession {
                    session_id: session_id.to_owned(),
                    workspace_id: workspace_id.to_owned(),
                    expected_revision,
                    now: now_ms(),
                },
            )?;
            Ok(projection::membership(&row))
        }
        "membership.remove" => bail!(
            "CC_CAPABILITY_UNAVAILABLE: membership removal requires retained revision tombstones"
        ),
        "intervention.record" => {
            let request = wire::intervention(input)?;
            let membership_session = request.target.membership_session();
            if !in_scope(&auth.session_ids, membership_session)
                || !in_scope(&auth.workspace_ids, &request.command_workspace_id)
            {
                bail!("CC_FORBIDDEN: the intervention target is outside the authenticated scope");
            }
            let outcome = receipt::record_intervention(
                conn,
                &binding.host_id,
                &auth.subject,
                &request,
                now_ms(),
            )?;
            Ok(json!({
                "entry": projection::receipt(&outcome.receipt)?,
                "replayed": outcome.replayed,
            }))
        }
        "intervention.ack" => {
            let request_id = wire::uuid(input, "requestId")?;
            let expected_revision = wire::integer(input, "expectedRevision", 1)?;
            let status = wire::string(input, "status")?;
            let stored = receipt::receipt(conn, &binding.host_id, &auth.subject, request_id)?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "CC_RECEIPT_NOT_FOUND: request {request_id} has no durable receipt"
                    )
                })?;
            if !in_scope(&auth.workspace_ids, &stored.workspace_id)
                || !in_scope(&auth.session_ids, stored.target.membership_session())
            {
                bail!("CC_FORBIDDEN: the receipt is outside the authenticated scope");
            }
            if stored.revision != expected_revision {
                bail!(
                    "CC_TRANSITION_CONFLICT: receipt {} is at revision {}",
                    stored.sequence,
                    stored.revision
                );
            }
            if status == "consumed" {
                let evidence = input
                    .get("consumption")
                    .filter(|value| !value.is_null())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "CC_INVALID_ARGUMENT: consumed requires the execution boundary evidence"
                        )
                    })?;
                let consumption = wire::consumption(evidence)?;
                let replayed = stored.status == ReceiptStatus::Consumed;
                goal::acknowledge_consumption(
                    conn,
                    &binding.host_id,
                    &auth.subject,
                    &consumption,
                    now_ms(),
                )?;
                let updated = receipt::receipt(conn, &binding.host_id, &auth.subject, request_id)?
                    .ok_or_else(|| {
                        anyhow::anyhow!("CC_CORRUPT_STORAGE: receipt vanished during consumption")
                    })?;
                return Ok(json!({
                    "entry": projection::receipt(&updated)?,
                    "replayed": replayed,
                }));
            }
            let to = ReceiptStatus::parse(status)?;
            if to == ReceiptStatus::Recorded {
                bail!(
                    "CC_INVALID_ARGUMENT: recorded is the dispatch claim, not an acknowledgement"
                );
            }
            let error = match input.get("error").filter(|value| !value.is_null()) {
                Some(error) => Some(ReceiptError::new(
                    wire::string(error, "code")?,
                    wire::string(error, "message")?,
                )?),
                None => None,
            };
            if let Some(effective) = input.get("effectiveGoalRevision").and_then(Value::as_i64) {
                if to != ReceiptStatus::Consumed && effective != stored.effective_revision {
                    bail!(
                        "CC_INVALID_ARGUMENT: effectiveGoalRevision advances only on consumption"
                    );
                }
            }
            let updated = receipt::transition_receipt(
                conn,
                &ReceiptTransition {
                    sequence: stored.sequence,
                    expected_revision,
                    to,
                    error,
                    now: now_ms(),
                },
            )?;
            Ok(json!({
                "entry": projection::receipt(&updated)?,
                "replayed": false,
            }))
        }
        "receipt.get" => {
            let request_id = wire::uuid(input, "requestId")?;
            Ok(
                match receipt::receipt(conn, &binding.host_id, &auth.subject, request_id)? {
                    Some(row) => projection::receipt(&row)?,
                    None => Value::Null,
                },
            )
        }
        "receipt.list" => {
            let after_sequence = wire::integer(input, "afterSequence", 0)?;
            let limit = wire::integer(input, "limit", 1)?;
            let rows = receipt::receipts_page(
                conn,
                &binding.host_id,
                &auth.subject,
                after_sequence,
                limit,
            )?;
            let next = if rows.len() == limit as usize {
                rows.last().map(|row| row.sequence)
            } else {
                None
            };
            let entries = rows
                .iter()
                .map(projection::receipt)
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({ "entries": entries, "nextAfterSequence": next }))
        }
        other => bail!("CC_INVALID_ARGUMENT: unsupported command-center method {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_center::identity::{ExecutionTarget, TaskTarget};
    use crate::command_center::reservation::{self, ReservationRequest};
    use crate::command_center::{goal, GoalCommit};
    use rusqlite::Connection;
    use serde_json::json;

    const HOST_ID: &str = "host_7c1e0a93b4d2f681";
    const EPOCH: &str = "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14";
    const STALE_EPOCH: &str = "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28";
    const WORKSPACE: &str = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
    const WORKSPACE_B: &str = "8a2e5d31-9b4c-4a67-8d23-3f8b0c1e5a42";
    const SESSION: &str = "sess-main-1";
    const TURN: &str = "turn-main-4";
    const REQUEST_ID: &str = "b4a1c8d2-5e6f-4a70-8b93-1c2d3e4f5a60";
    const NOW: i64 = 1_700_000_000_000;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        conn.execute_batch(crate::command_center::SCHEMA_DDL)
            .expect("create command-center tables");
        conn
    }

    fn envelope(
        input: Value,
        roles: &[&str],
        workspace_ids: Vec<&str>,
        session_ids: Vec<&str>,
    ) -> Value {
        json!({
            "binding": {"hostId": HOST_ID, "hostEpoch": EPOCH},
            "auth": {
                "subject": "local:owner",
                "roles": roles,
                "sessionIds": session_ids,
                "workspaceIds": workspace_ids,
            },
            "input": input,
        })
    }

    fn call(conn: &Connection, method: &str, params: Value) -> Result<Value> {
        super::handle_with_connection(conn, Some(EPOCH), method, &params)
    }

    fn expect_error<T: std::fmt::Debug>(result: Result<T>, needle: &str) {
        match result {
            Ok(value) => panic!("expected {needle}, got {value:?}"),
            Err(error) => assert!(
                error.to_string().contains(needle),
                "expected {needle}, got {error}"
            ),
        }
    }

    fn base_input() -> Value {
        json!({"version": 1, "hostId": HOST_ID})
    }

    fn create_workspace(conn: &Connection, workspace_id: &str) {
        let result = call(
            conn,
            "workspace.create",
            envelope(
                json!({
                    "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                    "commandWorkspaceId": workspace_id, "name": "Main", "enabled": true,
                }),
                &["owner"],
                vec![],
                vec![],
            ),
        )
        .expect("create workspace through RPC");
        assert_eq!(result["id"], workspace_id);
    }

    fn bind_session(conn: &Connection) {
        let result = call(
            conn,
            "membership.bind",
            envelope(
                json!({
                    "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                    "commandWorkspaceId": WORKSPACE, "sessionId": SESSION,
                    "expectedRevision": Value::Null,
                }),
                &["controller"],
                vec![WORKSPACE],
                vec![SESSION],
            ),
        )
        .expect("bind session through RPC");
        assert_eq!(result["revision"], 1);
    }

    fn reserve_live_execution(conn: &Connection) {
        reservation::reserve(
            conn,
            &ReservationRequest {
                target: ExecutionTarget::session(SESSION, TURN),
                workspace_id: WORKSPACE.to_owned(),
                expected_membership_revision: 1,
                owner_epoch: EPOCH.to_owned(),
                parent_key: None,
                now: NOW,
            },
        )
        .expect("reserve live execution");
    }

    fn intervention_record_input(text: &str) -> Value {
        json!({
            "version": 1,
            "requestId": REQUEST_ID,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "commandWorkspaceId": WORKSPACE,
            "expectedMembershipRevision": 1,
            "expectedGoalRevision": 0,
            "target": {"kind": "session", "sessionId": SESSION, "turnId": TURN},
            "intent": {"kind": "append", "text": text},
        })
    }

    fn seed_goal_to_four(conn: &Connection) {
        let target = TaskTarget::session(SESSION);
        for expected in 0..4 {
            goal::commit_revision(
                conn,
                &GoalCommit {
                    target: target.clone(),
                    expected_desired_revision: expected,
                    objective: format!("Seeded objective {expected}"),
                    constraints: vec![],
                    actor: "local:owner".to_owned(),
                    request_id: uuid::Uuid::new_v4().to_string(),
                    now: NOW + expected,
                },
            )
            .expect("seed desired goal revision");
        }
    }

    fn revise_goal_record_input() -> Value {
        json!({
            "version": 1,
            "requestId": REQUEST_ID,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "commandWorkspaceId": WORKSPACE,
            "expectedMembershipRevision": 1,
            "expectedGoalRevision": 4,
            "target": {"kind": "session", "sessionId": SESSION, "turnId": TURN},
            "intent": {"kind": "reviseGoal", "objective": "Ship the bounded control path", "constraints": []},
        })
    }

    fn consumption_input(expected_revision: i64, consumed_revision: i64, boundary: &str) -> Value {
        json!({
            "version": 1,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "requestId": REQUEST_ID,
            "expectedRevision": expected_revision,
            "status": "consumed",
            "effectiveGoalRevision": consumed_revision,
            "consumption": {
                "version": 1,
                "requestId": REQUEST_ID,
                "target": {"kind": "session", "sessionId": SESSION, "turnId": TURN},
                "consumedRevision": consumed_revision,
                "boundary": boundary,
            },
        })
    }

    fn record(conn: &Connection, text: &str) -> Result<Value> {
        call(
            conn,
            "intervention.record",
            envelope(
                intervention_record_input(text),
                &["controller"],
                vec![WORKSPACE],
                vec![SESSION],
            ),
        )
    }

    fn ack_input(expected_revision: i64, status: &str) -> Value {
        json!({
            "version": 1,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "requestId": REQUEST_ID,
            "expectedRevision": expected_revision,
            "status": status,
        })
    }

    fn ack(conn: &Connection, input: Value) -> Result<Value> {
        call(
            conn,
            "intervention.ack",
            envelope(input, &["controller"], vec![WORKSPACE], vec![SESSION]),
        )
    }

    #[test]
    fn workspace_create_get_list_and_rename_round_trip() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);

        let list = call(
            &conn,
            "workspace.list",
            envelope(base_input(), &["viewer"], vec![], vec![]),
        )
        .expect("list workspaces");
        let rows = list["workspaces"].as_array().expect("workspace array");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "Main");

        let get = call(
            &conn,
            "workspace.get",
            envelope(
                json!({"version": 1, "hostId": HOST_ID, "commandWorkspaceId": WORKSPACE}),
                &["viewer"],
                vec![WORKSPACE],
                vec![],
            ),
        )
        .expect("get workspace");
        assert_eq!(get["revision"], 1);

        let renamed = call(
            &conn,
            "workspace.rename",
            envelope(
                json!({
                    "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                    "commandWorkspaceId": WORKSPACE, "expectedRevision": 1, "name": "Renamed",
                }),
                &["owner"],
                vec![WORKSPACE],
                vec![],
            ),
        )
        .expect("rename workspace");
        assert_eq!(renamed["name"], "Renamed");
        assert_eq!(renamed["revision"], 2);

        let disabled = call(
            &conn,
            "workspace.setEnabled",
            envelope(
                json!({
                    "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                    "commandWorkspaceId": WORKSPACE, "expectedRevision": 2, "enabled": false,
                }),
                &["owner"],
                vec![WORKSPACE],
                vec![],
            ),
        )
        .expect("disable workspace");
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["revision"], 3);

        let deleted = call(
            &conn,
            "workspace.delete",
            envelope(
                json!({
                    "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                    "commandWorkspaceId": WORKSPACE, "expectedRevision": 3,
                }),
                &["owner"],
                vec![WORKSPACE],
                vec![],
            ),
        )
        .expect("delete workspace");
        assert_eq!(deleted["deleted"], true);
    }

    #[test]
    fn membership_bind_get_and_list_round_trip() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);
        bind_session(&conn);

        let get = call(
            &conn,
            "membership.get",
            envelope(
                json!({"version": 1, "hostId": HOST_ID, "sessionId": SESSION}),
                &["viewer"],
                vec![],
                vec![SESSION],
            ),
        )
        .expect("get membership");
        assert_eq!(get["commandWorkspaceId"], WORKSPACE);
        assert_eq!(get["revision"], 1);

        let list = call(
            &conn,
            "membership.list",
            envelope(
                json!({
                    "version": 1, "hostId": HOST_ID,
                    "commandWorkspaceId": WORKSPACE, "limit": 10,
                }),
                &["viewer"],
                vec![WORKSPACE],
                vec![],
            ),
        )
        .expect("list memberships");
        let rows = list["memberships"].as_array().expect("membership array");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["sessionId"], SESSION);
        assert!(list["nextAfterSessionId"].is_null());
    }

    #[test]
    fn intervention_record_is_idempotent_and_conflicts_on_changed_payload() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);
        bind_session(&conn);
        reserve_live_execution(&conn);

        let first = record(&conn, "continue").expect("record intervention");
        assert_eq!(first["replayed"], false);
        assert_eq!(first["entry"]["receipt"]["status"], "recorded");
        let sequence = first["entry"]["sequence"].as_i64().expect("sequence");

        let replay = record(&conn, "continue").expect("replay intervention");
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["entry"]["sequence"], sequence);

        expect_error(record(&conn, "changed payload"), "CC_IDEMPOTENCY_CONFLICT");
    }

    #[test]
    fn intervention_ack_persists_once_and_refuses_stale_revision() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);
        bind_session(&conn);
        reserve_live_execution(&conn);
        record(&conn, "continue").expect("record intervention");

        let accepted = ack(&conn, ack_input(1, "accepted")).expect("ack accepted");
        assert_eq!(accepted["entry"]["receipt"]["status"], "accepted");
        assert_eq!(accepted["entry"]["receipt"]["revision"], 2);

        expect_error(
            ack(&conn, ack_input(1, "accepted")),
            "CC_TRANSITION_CONFLICT",
        );
        expect_error(ack(&conn, ack_input(2, "recorded")), "CC_INVALID_ARGUMENT");

        let completed = ack(&conn, ack_input(2, "completed")).expect("ack completed");
        assert_eq!(completed["entry"]["receipt"]["status"], "completed");
        assert_eq!(completed["entry"]["receipt"]["revision"], 3);

        let receipt = call(
            &conn,
            "receipt.get",
            envelope(
                json!({"version": 1, "hostId": HOST_ID, "requestId": REQUEST_ID}),
                &["viewer"],
                vec![WORKSPACE],
                vec![SESSION],
            ),
        )
        .expect("get receipt");
        assert_eq!(receipt["receipt"]["status"], "completed");
        assert_eq!(receipt["sequence"], 1);

        expect_error(
            ack(&conn, ack_input(3, "interrupted")),
            "CC_TRANSITION_INVALID",
        );
    }

    #[test]
    fn receipt_and_membership_pagination_bounds_are_enforced() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);
        bind_session(&conn);
        reserve_live_execution(&conn);
        record(&conn, "continue").expect("record intervention");

        for limit in [0, 101] {
            expect_error(
                call(
                    &conn,
                    "receipt.list",
                    envelope(
                        json!({"version": 1, "hostId": HOST_ID, "afterSequence": 0, "limit": limit}),
                        &["viewer"],
                        vec![WORKSPACE],
                        vec![SESSION],
                    ),
                ),
                "CC_INVALID_ARGUMENT",
            );
        }
        let page = call(
            &conn,
            "receipt.list",
            envelope(
                json!({"version": 1, "hostId": HOST_ID, "afterSequence": 0, "limit": 1}),
                &["viewer"],
                vec![WORKSPACE],
                vec![SESSION],
            ),
        )
        .expect("page receipts");
        assert_eq!(page["entries"].as_array().expect("entries").len(), 1);
        assert_eq!(page["nextAfterSequence"], 1);

        expect_error(
            call(
                &conn,
                "membership.list",
                envelope(
                    json!({
                        "version": 1, "hostId": HOST_ID,
                        "commandWorkspaceId": WORKSPACE, "limit": 101,
                    }),
                    &["viewer"],
                    vec![WORKSPACE],
                    vec![],
                ),
            ),
            "CC_INVALID_ARGUMENT",
        );
    }

    #[test]
    fn role_scope_and_binding_denials_happen_before_storage() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);

        expect_error(
            call(
                &conn,
                "workspace.create",
                envelope(
                    json!({
                        "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                        "commandWorkspaceId": WORKSPACE_B, "name": "Other", "enabled": true,
                    }),
                    &["viewer"],
                    vec![],
                    vec![],
                ),
            ),
            "CC_FORBIDDEN",
        );

        expect_error(
            call(
                &conn,
                "workspace.rename",
                envelope(
                    json!({
                        "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                        "commandWorkspaceId": WORKSPACE, "expectedRevision": 1, "name": "Nope",
                    }),
                    &["owner"],
                    vec![],
                    vec![],
                ),
            ),
            "CC_FORBIDDEN",
        );

        let mut wrong_host = envelope(base_input(), &["viewer"], vec![], vec![]);
        wrong_host["binding"]["hostId"] = json!("host_other");
        expect_error(call(&conn, "workspace.list", wrong_host), "CC_CONFLICT");

        let mut wrong_epoch = envelope(
            json!({"version": 1, "hostId": HOST_ID, "expectedHostEpoch": STALE_EPOCH,
                "commandWorkspaceId": WORKSPACE, "expectedRevision": 1, "name": "Nope"}),
            &["owner"],
            vec![WORKSPACE],
            vec![],
        );
        wrong_epoch["binding"]["hostEpoch"] = json!(EPOCH);
        expect_error(call(&conn, "workspace.rename", wrong_epoch), "CC_CONFLICT");

        let stale = super::handle_with_connection(
            &conn,
            Some(STALE_EPOCH),
            "workspace.list",
            &envelope(base_input(), &["viewer"], vec![], vec![]),
        );
        expect_error(stale, "CC_EPOCH_CONFLICT");

        // The current epoch is Host state, never a request field: a stale
        // generic mutation is denied before any write.
        let before = workspace::workspace(&conn, WORKSPACE)
            .expect("read workspace")
            .expect("workspace exists");
        let stale_mutation = super::handle_with_connection(
            &conn,
            Some(STALE_EPOCH),
            "workspace.rename",
            &envelope(
                json!({
                    "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                    "commandWorkspaceId": WORKSPACE, "expectedRevision": 1, "name": "Stale write",
                }),
                &["owner"],
                vec![WORKSPACE],
                vec![],
            ),
        );
        expect_error(stale_mutation, "CC_EPOCH_CONFLICT");
        let after = workspace::workspace(&conn, WORKSPACE)
            .expect("read workspace")
            .expect("workspace exists");
        assert_eq!(after, before);

        expect_error(
            call(
                &conn,
                "membership.remove",
                envelope(
                    json!({
                        "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                        "commandWorkspaceId": WORKSPACE, "sessionId": SESSION, "expectedRevision": 1,
                    }),
                    &["controller"],
                    vec![WORKSPACE],
                    vec![SESSION],
                ),
            ),
            "CC_CAPABILITY_UNAVAILABLE",
        );

        expect_error(ack(&conn, ack_input(1, "accepted")), "CC_RECEIPT_NOT_FOUND");
    }

    #[test]
    fn consumed_ack_advances_effective_revision_once_with_boundary_evidence() {
        let conn = db();
        create_workspace(&conn, WORKSPACE);
        bind_session(&conn);
        reserve_live_execution(&conn);
        seed_goal_to_four(&conn);

        let recorded = call(
            &conn,
            "intervention.record",
            envelope(
                revise_goal_record_input(),
                &["controller"],
                vec![WORKSPACE],
                vec![SESSION],
            ),
        )
        .expect("record reviseGoal");
        assert_eq!(recorded["entry"]["receipt"]["status"], "recorded");
        assert_eq!(recorded["entry"]["receipt"]["desiredGoalRevision"], 5);

        let accepted = ack(&conn, ack_input(1, "accepted")).expect("accept intent");
        assert_eq!(accepted["entry"]["receipt"]["status"], "accepted");

        let consumed = ack(&conn, consumption_input(2, 5, "model_step")).expect("consume intent");
        assert_eq!(consumed["entry"]["receipt"]["status"], "consumed");
        assert_eq!(consumed["entry"]["receipt"]["revision"], 3);
        assert_eq!(consumed["entry"]["receipt"]["effectiveGoalRevision"], 5);
        assert_eq!(consumed["replayed"], false);

        let head = goal::goal_head(&conn, &TaskTarget::session(SESSION))
            .expect("read goal head")
            .expect("goal head exists");
        assert_eq!(head.effective_revision, 5);

        let duplicate =
            ack(&conn, consumption_input(3, 5, "model_step")).expect("idempotent consume");
        assert_eq!(duplicate["entry"]["receipt"]["status"], "consumed");
        assert_eq!(duplicate["replayed"], true);

        expect_error(
            ack(&conn, consumption_input(2, 5, "model_step")),
            "CC_TRANSITION_CONFLICT",
        );
        expect_error(
            ack(&conn, consumption_input(3, 4, "model_step")),
            "CC_CONSUMPTION_CONFLICT",
        );
        let mut missing = consumption_input(2, 5, "model_step");
        missing
            .as_object_mut()
            .expect("object")
            .remove("consumption");
        expect_error(ack(&conn, missing), "CC_INVALID_ARGUMENT");
        let mut bad_boundary = consumption_input(2, 5, "Invalid Boundary");
        bad_boundary["consumption"]["boundary"] = json!("Invalid Boundary");
        expect_error(ack(&conn, bad_boundary), "CC_INVALID_CONSUMPTION");
    }
}
