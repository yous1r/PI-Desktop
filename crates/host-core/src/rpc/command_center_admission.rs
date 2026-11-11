//! Private `commandCenter.reservation.*` RPC adapter.
//!
//! Quota authority stays in [`crate::command_center::reservation`]: this module
//! validates the private envelope (binding + authenticated principal + scopes),
//! then runs the C2 `*_in` reservation functions and a live-count read inside a
//! single immediate transaction. It keeps no counter of its own.
//!
//! The boot owner epoch is mandatory here. A Host with no current epoch cannot
//! prove freshness, so admission refuses instead of silently skipping the check.

use std::sync::Arc;

use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::command_center::identity::ExecutionTarget;
use crate::command_center::limits;
use crate::command_center::reservation::{
    self, CapacityCounts, Reservation, ReservationRequest, ReservationTransition,
};
use crate::command_center::state::ReservationState;
use crate::command_center::tx::immediate;
use crate::command_center::{api::wire, BindSession};
use crate::db::now_ms;
use crate::state::AppState;

use super::command_center_rpc::{envelope, in_scope, roles_allow, verify_binding};
use super::{rpc_err, JsonRpcError};

/// Private wire method suffixes handled here.
const METHODS: [&str; 4] = ["reserve", "hold", "release", "state"];

fn required_role(method: &str) -> &'static str {
    if method == "state" {
        "viewer"
    } else {
        "controller"
    }
}

fn authorized_scope(
    auth: &super::command_center_rpc::Auth,
    workspace_id: &str,
    target: &ExecutionTarget,
) -> Result<()> {
    if !in_scope(&auth.workspace_ids, workspace_id) {
        bail!("CC_FORBIDDEN: workspace {workspace_id} is outside the authenticated scope");
    }
    if !in_scope(&auth.session_ids, target.membership_session()) {
        bail!(
            "CC_FORBIDDEN: session {} is outside the authenticated scope",
            target.membership_session()
        );
    }
    Ok(())
}

fn parse_reserve(input: &Value) -> Result<(String, i64, ExecutionTarget)> {
    wire::keys(
        input,
        &[
            "version",
            "hostId",
            "expectedHostEpoch",
            "commandWorkspaceId",
            "expectedMembershipRevision",
            "target",
        ],
        &[],
    )?;
    if wire::integer(input, "version", 1)? != 1 {
        bail!("CC_INVALID_ARGUMENT: unsupported admission version");
    }
    limits::validate_host_id(wire::string(input, "hostId")?)?;
    limits::validate_uuid(wire::string(input, "expectedHostEpoch")?)?;
    let workspace_id = wire::uuid(input, "commandWorkspaceId")?.to_owned();
    let membership_revision = wire::integer(input, "expectedMembershipRevision", 1)?;
    let target = wire::target(&input["target"])?;
    Ok((workspace_id, membership_revision, target))
}

fn parse_hold(
    input: &Value,
) -> Result<(
    String,
    ExecutionTarget,
    ReservationState,
    ReservationState,
    String,
)> {
    wire::keys(
        input,
        &[
            "version",
            "hostId",
            "expectedHostEpoch",
            "commandWorkspaceId",
            "target",
            "from",
            "to",
            "evidence",
        ],
        &[],
    )?;
    if wire::integer(input, "version", 1)? != 1 {
        bail!("CC_INVALID_ARGUMENT: unsupported admission version");
    }
    limits::validate_host_id(wire::string(input, "hostId")?)?;
    limits::validate_uuid(wire::string(input, "expectedHostEpoch")?)?;
    let workspace_id = wire::uuid(input, "commandWorkspaceId")?.to_owned();
    let target = wire::target(&input["target"])?;
    let from = ReservationState::parse(wire::string(input, "from")?)?;
    let to = ReservationState::parse(wire::string(input, "to")?)?;
    if from.terminal() || to.terminal() {
        bail!("CC_INVALID_ARGUMENT: hold must stay in a capacity-retaining state");
    }
    let evidence = wire::string(input, "evidence")?.to_owned();
    limits::validate_evidence(&evidence)?;
    Ok((workspace_id, target, from, to, evidence))
}

fn parse_release(input: &Value) -> Result<(String, ExecutionTarget, ReservationState, String)> {
    wire::keys(
        input,
        &[
            "version",
            "hostId",
            "expectedHostEpoch",
            "commandWorkspaceId",
            "target",
            "to",
            "evidence",
        ],
        &[],
    )?;
    if wire::integer(input, "version", 1)? != 1 {
        bail!("CC_INVALID_ARGUMENT: unsupported admission version");
    }
    limits::validate_host_id(wire::string(input, "hostId")?)?;
    limits::validate_uuid(wire::string(input, "expectedHostEpoch")?)?;
    let workspace_id = wire::uuid(input, "commandWorkspaceId")?.to_owned();
    let target = wire::target(&input["target"])?;
    let to = ReservationState::parse(wire::string(input, "to")?)?;
    if !to.terminal() {
        bail!("CC_INVALID_ARGUMENT: release must name a terminal reservation state");
    }
    let evidence = wire::string(input, "evidence")?.to_owned();
    limits::validate_evidence(&evidence)?;
    Ok((workspace_id, target, to, evidence))
}

fn workspace_live(counts: &CapacityCounts, workspace_id: &str) -> i64 {
    counts
        .workspaces
        .iter()
        .find(|(id, _)| id == workspace_id)
        .map(|(_, live)| *live)
        .unwrap_or(0)
}

fn reservation_json(row: &Reservation, counts: &CapacityCounts) -> Value {
    json!({
        "executionKey": row.execution_key,
        "workspaceId": row.workspace_id,
        "membershipRevision": row.membership_revision,
        "state": row.state.as_str(),
        "hostLive": counts.host,
        "workspaceLive": workspace_live(counts, &row.workspace_id),
    })
}

fn snapshot_json(counts: &CapacityCounts, visible_workspaces: &[String]) -> Value {
    json!({
        "version": 1,
        "hostLive": counts.host,
        "maxHostLive": limits::MAX_LIVE_PER_HOST,
        "maxWorkspaceLive": limits::MAX_LIVE_PER_WORKSPACE,
        "workspaces": counts.workspaces.iter()
            .filter(|(id, _)| in_scope(visible_workspaces, id))
            .map(|(id, live)| json!({
                "workspaceId": id,
                "live": live,
                "maxLive": limits::MAX_LIVE_PER_WORKSPACE,
            })).collect::<Vec<_>>(),
    })
}

/// Validate and execute one `commandCenter.reservation.*` request.
pub(crate) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let method = method
        .strip_prefix("commandCenter.reservation.")
        .ok_or_else(|| {
            rpc_err(
                1002,
                "unknown command-center admission method",
                "COMMAND_CENTER_REFUSED",
            )
        })?;
    if !METHODS.contains(&method) {
        return Err(rpc_err(
            1002,
            "unknown command-center admission method",
            "COMMAND_CENTER_REFUSED",
        ));
    }
    let st = state.lock().await;
    let current_epoch = st.command_center_owner_epoch().to_owned();
    handle_with_connection(st.db.conn(), &current_epoch, method, &params)
        .map_err(|error| rpc_err(1000, error.to_string(), "COMMAND_CENTER_REFUSED"))
}

fn handle_with_connection(
    conn: &Connection,
    current_epoch: &str,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let envelope = envelope(params)?;
    // Admission always requires the current boot epoch; `None` is a refusal,
    // never an unchecked success.
    verify_binding(
        &envelope.binding,
        &envelope.input,
        Some(current_epoch),
        true,
    )?;
    if !roles_allow(&envelope.auth.roles, required_role(method)) {
        bail!("CC_FORBIDDEN: the principal lacks the role for reservation.{method}");
    }
    if method == "state" {
        wire::keys(&envelope.input, &["version", "hostId"], &[])?;
        if wire::integer(&envelope.input, "version", 1)? != 1 {
            bail!("CC_INVALID_ARGUMENT: unsupported admission version");
        }
        limits::validate_host_id(wire::string(&envelope.input, "hostId")?)?;
        let counts = reservation::live_counts(conn)?;
        return Ok(snapshot_json(&counts, &envelope.auth.workspace_ids));
    }
    let binding = &envelope.binding;
    match method {
        "reserve" => {
            let (workspace_id, membership_revision, target) = parse_reserve(&envelope.input)?;
            authorized_scope(&envelope.auth, &workspace_id, &target)?;
            let request = ReservationRequest {
                target,
                workspace_id,
                expected_membership_revision: membership_revision,
                owner_epoch: binding.host_epoch.clone(),
                parent_key: None,
                now: now_ms(),
            };
            // Reserve and live-count read share one immediate transaction, so
            // the returned snapshot is the state that admitted this execution.
            let (row, counts) = immediate(conn, |conn| {
                let row = reservation::reserve_in(conn, &request)?;
                let counts = reservation::live_counts(conn)?;
                Ok((row, counts))
            })?;
            Ok(reservation_json(&row, &counts))
        }
        "hold" => {
            let (workspace_id, target, from, to, evidence) = parse_hold(&envelope.input)?;
            authorized_scope(&envelope.auth, &workspace_id, &target)?;
            let request = ReservationTransition {
                execution_key: target.key(),
                owner_epoch: binding.host_epoch.clone(),
                from,
                to,
                evidence,
                now: now_ms(),
            };
            let (row, counts) = immediate(conn, |conn| {
                let Some(current) = reservation::reservation(conn, &request.execution_key)? else {
                    bail!(
                        "CC_RESERVATION_NOT_FOUND: execution {} has no reservation",
                        request.execution_key
                    );
                };
                // The authenticated workspace scope must name the workspace that
                // actually owns this execution; a scope for another workspace
                // never authorizes transitioning this row.
                if current.workspace_id != workspace_id {
                    bail!(
                        "CC_RESERVATION_CONFLICT: execution {} is owned by command workspace {}",
                        current.execution_key,
                        current.workspace_id
                    );
                }
                if current.owner_epoch != binding.host_epoch {
                    bail!(
                        "CC_EPOCH_CONFLICT: execution {} belongs to execution owner {}",
                        current.execution_key,
                        current.owner_epoch
                    );
                }
                let row = reservation::transition_in(conn, &request)?;
                let counts = reservation::live_counts(conn)?;
                Ok((row, counts))
            })?;
            Ok(reservation_json(&row, &counts))
        }
        "release" => {
            let (workspace_id, target, to, evidence) = parse_release(&envelope.input)?;
            authorized_scope(&envelope.auth, &workspace_id, &target)?;
            let execution_key = target.key();
            let released = immediate(conn, |conn| {
                let Some(current) = reservation::reservation(conn, &execution_key)? else {
                    bail!("CC_RESERVATION_NOT_FOUND: execution {execution_key} has no reservation");
                };
                if current.owner_epoch != binding.host_epoch {
                    bail!(
                        "CC_EPOCH_CONFLICT: execution {execution_key} belongs to execution owner {}",
                        current.owner_epoch
                    );
                }
                if current.workspace_id != workspace_id {
                    bail!(
                        "CC_RESERVATION_CONFLICT: execution {execution_key} is owned by command workspace {}",
                        current.workspace_id
                    );
                }
                if current.state.terminal() {
                    // Exactly once: a repeated release observes the terminal row
                    // and writes no second transition event.
                    return Ok(false);
                }
                reservation::transition_in(
                    conn,
                    &ReservationTransition {
                        execution_key: execution_key.clone(),
                        owner_epoch: binding.host_epoch.clone(),
                        from: current.state,
                        to,
                        evidence,
                        now: now_ms(),
                    },
                )?;
                Ok(true)
            })?;
            Ok(json!({ "released": released }))
        }
        other => bail!("CC_INVALID_ARGUMENT: unsupported admission method {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_center::{schema, workspace};
    use std::time::Duration;

    const HOST_ID: &str = "host_7c1e0a93b4d2f681";
    const EPOCH: &str = "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14";
    const STALE_EPOCH: &str = "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28";
    const WORKSPACE_A: &str = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
    const WORKSPACE_B: &str = "8a2e5d31-9b4c-4a67-8d23-3f8b0c1e5a42";
    const WORKSPACE_C: &str = "9b3f6e42-ac5d-4b78-9e34-4a9c1d2f6b53";
    const SESSION_A: &str = "sess-main-a";
    const SESSION_B: &str = "sess-main-b";
    const SESSION_C: &str = "sess-main-c";
    const NOW: i64 = 1_700_000_000_000;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        conn.execute_batch(schema::DDL)
            .expect("create command-center tables");
        conn
    }

    fn bind(conn: &Connection, session: &str, workspace_id: &str) {
        workspace::bind_session(
            conn,
            &BindSession {
                session_id: session.to_owned(),
                workspace_id: workspace_id.to_owned(),
                expected_revision: None,
                now: NOW,
            },
        )
        .expect("bind session");
    }

    fn seed(conn: &Connection) {
        for (workspace_id, name) in [(WORKSPACE_A, "A"), (WORKSPACE_B, "B"), (WORKSPACE_C, "C")] {
            workspace::create_workspace(conn, workspace_id, name, true, NOW)
                .expect("create workspace");
        }
        bind(conn, SESSION_A, WORKSPACE_A);
        bind(conn, SESSION_B, WORKSPACE_B);
        bind(conn, SESSION_C, WORKSPACE_C);
    }

    fn envelope_for(input: Value, roles: &[&str], workspace_id: &str, session: &str) -> Value {
        json!({
            "binding": {"hostId": HOST_ID, "hostEpoch": EPOCH},
            "auth": {
                "subject": "local:owner",
                "roles": roles,
                "sessionIds": [session],
                "workspaceIds": [workspace_id],
            },
            "input": input,
        })
    }

    fn call(conn: &Connection, method: &str, params: &Value) -> Result<Value> {
        super::handle_with_connection(conn, EPOCH, method, params)
    }

    fn target(session: &str, index: u32) -> Value {
        json!({"kind": "session", "sessionId": session, "turnId": format!("turn-{index}")})
    }

    fn reserve_input(workspace_id: &str, session: &str, index: u32) -> Value {
        json!({
            "version": 1,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "commandWorkspaceId": workspace_id,
            "expectedMembershipRevision": 1,
            "target": target(session, index),
        })
    }

    fn hold_input(
        workspace_id: &str,
        session: &str,
        index: u32,
        from: &str,
        to: &str,
        evidence: &str,
    ) -> Value {
        json!({
            "version": 1,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "commandWorkspaceId": workspace_id,
            "target": target(session, index),
            "from": from,
            "to": to,
            "evidence": evidence,
        })
    }

    fn release_input(
        workspace_id: &str,
        session: &str,
        index: u32,
        to: &str,
        evidence: &str,
    ) -> Value {
        json!({
            "version": 1,
            "hostId": HOST_ID,
            "expectedHostEpoch": EPOCH,
            "commandWorkspaceId": workspace_id,
            "target": target(session, index),
            "to": to,
            "evidence": evidence,
        })
    }

    fn expect_error(result: Result<Value>, needle: &str) {
        match result {
            Ok(value) => panic!("expected {needle}, got {value}"),
            Err(error) => assert!(
                error.to_string().contains(needle),
                "expected {needle}, got {error}"
            ),
        }
    }

    #[test]
    fn twelve_per_workspace_and_thirteen_refused() {
        let conn = database();
        seed(&conn);
        for index in 0..12 {
            let params = envelope_for(
                reserve_input(WORKSPACE_A, SESSION_A, index),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            );
            let value = call(&conn, "reserve", &params).expect("reserve execution");
            assert_eq!(value["state"], "reserved");
        }
        let params = envelope_for(
            reserve_input(WORKSPACE_A, SESSION_A, 12),
            &["controller"],
            WORKSPACE_A,
            SESSION_A,
        );
        expect_error(call(&conn, "reserve", &params), "CC_QUOTA_EXCEEDED");
        let state = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("read capacity");
        assert_eq!(state["hostLive"], 12);
        assert_eq!(state["workspaces"][0]["live"], 12);
    }

    #[test]
    fn thirty_six_per_host_and_thirty_seventh_refused() {
        let conn = database();
        seed(&conn);
        let mut admitted = 0;
        for (workspace_id, session) in [
            (WORKSPACE_A, SESSION_A),
            (WORKSPACE_B, SESSION_B),
            (WORKSPACE_C, SESSION_C),
        ] {
            for index in 0..12 {
                let params = envelope_for(
                    reserve_input(workspace_id, session, index),
                    &["controller"],
                    workspace_id,
                    session,
                );
                call(&conn, "reserve", &params).expect("reserve execution");
                admitted += 1;
            }
        }
        assert_eq!(admitted, 36);
        let params = envelope_for(
            reserve_input(WORKSPACE_A, SESSION_A, 36),
            &["controller"],
            WORKSPACE_A,
            SESSION_A,
        );
        expect_error(call(&conn, "reserve", &params), "CC_QUOTA_EXCEEDED");
        let state = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("read capacity");
        assert_eq!(state["hostLive"], 36);
        assert_eq!(state["maxHostLive"], 36);
        assert_eq!(state["maxWorkspaceLive"], 12);
    }

    #[test]
    fn duplicate_reserve_is_idempotent_and_does_not_consume_a_second_slot() {
        let conn = database();
        seed(&conn);
        let params = envelope_for(
            reserve_input(WORKSPACE_A, SESSION_A, 1),
            &["controller"],
            WORKSPACE_A,
            SESSION_A,
        );
        let first = call(&conn, "reserve", &params).expect("reserve");
        let second = call(&conn, "reserve", &params).expect("replay reserve");
        assert_eq!(first["executionKey"], second["executionKey"]);
        assert_eq!(second["hostLive"], 1);
        assert_eq!(second["workspaceLive"], 1);
    }

    #[test]
    fn release_is_exactly_once_and_writes_one_event() {
        let conn = database();
        seed(&conn);
        call(
            &conn,
            "reserve",
            &envelope_for(
                reserve_input(WORKSPACE_A, SESSION_A, 1),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("reserve");
        let key =
            crate::command_center::identity::ExecutionTarget::session(SESSION_A, "turn-1").key();
        let first = call(
            &conn,
            "release",
            &envelope_for(
                release_input(WORKSPACE_A, SESSION_A, 1, "failed", "runtime-settled"),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("release");
        assert_eq!(first["released"], true);
        let second = call(
            &conn,
            "release",
            &envelope_for(
                release_input(WORKSPACE_A, SESSION_A, 1, "failed", "runtime-retry"),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("repeat release");
        assert_eq!(second["released"], false);
        let events = crate::command_center::reservation::events(&conn, &key).expect("events");
        assert_eq!(events.len(), 1);
        let state = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("capacity");
        assert_eq!(state["hostLive"], 0);
    }

    #[test]
    fn stopping_and_uncertain_states_retain_capacity() {
        let conn = database();
        seed(&conn);
        call(
            &conn,
            "reserve",
            &envelope_for(
                reserve_input(WORKSPACE_A, SESSION_A, 1),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("reserve");
        for (from, to, evidence) in [
            ("reserved", "starting", "runtime-launching"),
            ("starting", "running", "runtime-running"),
            ("running", "stopping", "runtime-stopping"),
        ] {
            call(
                &conn,
                "hold",
                &envelope_for(
                    hold_input(WORKSPACE_A, SESSION_A, 1, from, to, evidence),
                    &["controller"],
                    WORKSPACE_A,
                    SESSION_A,
                ),
            )
            .expect("hold live state");
        }
        let state = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("capacity");
        assert_eq!(state["hostLive"], 1);

        call(
            &conn,
            "hold",
            &envelope_for(
                hold_input(
                    WORKSPACE_A,
                    SESSION_A,
                    1,
                    "stopping",
                    "outcome_unknown",
                    "runtime-unknown",
                ),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("hold uncertain");
        let state = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("capacity");
        assert_eq!(state["hostLive"], 1);

        let release = call(
            &conn,
            "release",
            &envelope_for(
                release_input(WORKSPACE_A, SESSION_A, 1, "failed", "runtime-reconciled"),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("release uncertain");
        assert_eq!(release["released"], true);
    }

    #[test]
    fn stale_or_missing_boot_epoch_is_refused() {
        let conn = database();
        seed(&conn);
        let mut stale = envelope_for(
            reserve_input(WORKSPACE_A, SESSION_A, 1),
            &["controller"],
            WORKSPACE_A,
            SESSION_A,
        );
        stale["binding"]["hostEpoch"] = json!(STALE_EPOCH);
        stale["input"]["expectedHostEpoch"] = json!(STALE_EPOCH);
        expect_error(call(&conn, "reserve", &stale), "CC_EPOCH_CONFLICT");

        let binding = super::super::command_center_rpc::Binding {
            host_id: HOST_ID.to_owned(),
            host_epoch: EPOCH.to_owned(),
        };
        let input = reserve_input(WORKSPACE_A, SESSION_A, 1);
        let error = super::super::command_center_rpc::verify_binding(&binding, &input, None, true)
            .expect_err("a missing boot epoch must be refused");
        assert!(
            error.to_string().contains("CC_EPOCH_UNAVAILABLE"),
            "expected CC_EPOCH_UNAVAILABLE, got {error}"
        );
    }

    #[test]
    fn invalid_params_and_scopes_are_refused() {
        let conn = database();
        seed(&conn);
        let mut bad_version = reserve_input(WORKSPACE_A, SESSION_A, 1);
        bad_version["expectedMembershipRevision"] = json!(0);
        expect_error(
            call(
                &conn,
                "reserve",
                &envelope_for(bad_version, &["controller"], WORKSPACE_A, SESSION_A),
            ),
            "CC_INVALID_ARGUMENT",
        );

        let wrong_scope = envelope_for(
            reserve_input(WORKSPACE_B, SESSION_B, 1),
            &["controller"],
            WORKSPACE_A,
            SESSION_A,
        );
        expect_error(call(&conn, "reserve", &wrong_scope), "CC_FORBIDDEN");
        expect_error(
            call(
                &conn,
                "reserve",
                &envelope_for(
                    reserve_input(WORKSPACE_A, SESSION_A, 1),
                    &["viewer"],
                    WORKSPACE_A,
                    SESSION_A,
                ),
            ),
            "CC_FORBIDDEN",
        );

        call(
            &conn,
            "reserve",
            &envelope_for(
                reserve_input(WORKSPACE_A, SESSION_A, 1),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("reserve");
        expect_error(
            call(
                &conn,
                "release",
                &envelope_for(
                    release_input(WORKSPACE_A, SESSION_A, 1, "running", "bad"),
                    &["controller"],
                    WORKSPACE_A,
                    SESSION_A,
                ),
            ),
            "CC_INVALID_ARGUMENT",
        );
        expect_error(
            call(
                &conn,
                "hold",
                &envelope_for(
                    hold_input(WORKSPACE_A, SESSION_A, 1, "reserved", "completed", "bad"),
                    &["controller"],
                    WORKSPACE_A,
                    SESSION_A,
                ),
            ),
            "CC_INVALID_ARGUMENT",
        );
    }

    #[test]
    fn hold_and_release_refuse_execution_owned_by_another_workspace() {
        let conn = database();
        seed(&conn);
        call(
            &conn,
            "reserve",
            &envelope_for(
                reserve_input(WORKSPACE_A, SESSION_A, 1),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("reserve");
        expect_error(
            call(
                &conn,
                "hold",
                &envelope_for(
                    hold_input(
                        WORKSPACE_B,
                        SESSION_A,
                        1,
                        "reserved",
                        "starting",
                        "wrong-workspace",
                    ),
                    &["controller"],
                    WORKSPACE_B,
                    SESSION_A,
                ),
            ),
            "CC_RESERVATION_CONFLICT",
        );
        expect_error(
            call(
                &conn,
                "release",
                &envelope_for(
                    release_input(WORKSPACE_B, SESSION_A, 1, "failed", "wrong-workspace"),
                    &["controller"],
                    WORKSPACE_B,
                    SESSION_A,
                ),
            ),
            "CC_RESERVATION_CONFLICT",
        );
        let counts = crate::command_center::reservation::live_counts(&conn).expect("counts");
        assert_eq!(counts.host, 1);
    }

    #[test]
    fn snapshot_filters_workspace_rows_but_keeps_the_global_host_count() {
        let conn = database();
        seed(&conn);
        call(
            &conn,
            "reserve",
            &envelope_for(
                reserve_input(WORKSPACE_A, SESSION_A, 1),
                &["controller"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("reserve");
        let own = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_A,
                SESSION_A,
            ),
        )
        .expect("own scope");
        assert_eq!(own["hostLive"], 1);
        assert_eq!(own["workspaces"].as_array().expect("workspaces").len(), 1);
        assert_eq!(own["workspaces"][0]["workspaceId"], WORKSPACE_A);

        let other = call(
            &conn,
            "state",
            &envelope_for(
                json!({"version": 1, "hostId": HOST_ID}),
                &["viewer"],
                WORKSPACE_B,
                SESSION_B,
            ),
        )
        .expect("other scope");
        // Global quota usage stays visible; another workspace's row does not.
        assert_eq!(other["hostLive"], 1);
        assert_eq!(other["workspaces"].as_array().expect("workspaces").len(), 0);
    }

    #[test]
    fn unknown_workspace_or_membership_is_refused() {
        let conn = database();
        seed(&conn);
        let unknown_workspace = "ac4a7f53-bd6e-4c89-af45-5bad2e3a7c64";
        expect_error(
            call(
                &conn,
                "reserve",
                &envelope_for(
                    json!({
                        "version": 1, "hostId": HOST_ID, "expectedHostEpoch": EPOCH,
                        "commandWorkspaceId": unknown_workspace,
                        "expectedMembershipRevision": 1,
                        "target": target(SESSION_A, 1),
                    }),
                    &["controller"],
                    unknown_workspace,
                    SESSION_A,
                ),
            ),
            "CC_MEMBERSHIP_CONFLICT",
        );
        conn.execute(
            "DELETE FROM cc_session_memberships WHERE session_id = ?1",
            [SESSION_B],
        )
        .expect("remove membership");
        expect_error(
            call(
                &conn,
                "reserve",
                &envelope_for(
                    reserve_input(WORKSPACE_B, SESSION_B, 1),
                    &["controller"],
                    WORKSPACE_B,
                    SESSION_B,
                ),
            ),
            "CC_TARGET_NOT_FOUND",
        );
    }

    #[test]
    fn concurrent_file_database_writers_cannot_exceed_twelve() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("command-center.sqlite");
        {
            let conn = Connection::open(&path).expect("open database");
            conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
                .expect("database settings");
            conn.execute_batch(schema::DDL).expect("schema");
            seed(&conn);
        }
        let mut handles = Vec::new();
        for index in 0..16u32 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                let conn = Connection::open(&path).expect("thread database");
                conn.busy_timeout(Duration::from_secs(30))
                    .expect("busy timeout");
                conn.execute_batch("PRAGMA foreign_keys = ON;")
                    .expect("foreign keys");
                let params = envelope_for(
                    reserve_input(WORKSPACE_A, SESSION_A, index),
                    &["controller"],
                    WORKSPACE_A,
                    SESSION_A,
                );
                call(&conn, "reserve", &params)
            }));
        }
        let mut admitted = 0;
        for handle in handles {
            match handle.join().expect("thread") {
                Ok(_) => admitted += 1,
                Err(error) => assert!(
                    error.to_string().contains("CC_QUOTA_EXCEEDED")
                        || error.to_string().contains("CC_TRANSACTION"),
                    "unexpected race failure: {error}"
                ),
            }
        }
        assert_eq!(admitted, 12, "exactly twelve reservations may commit");
        let conn = Connection::open(&path).expect("verify database");
        let counts = crate::command_center::reservation::live_counts(&conn).expect("counts");
        assert_eq!(counts.host, 12);
    }
}
