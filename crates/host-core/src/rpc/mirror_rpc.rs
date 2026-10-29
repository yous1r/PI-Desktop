//! `mirror.*` methods over the durable state of a remote mirror project
//! (spec 23 §6.2 / §7.2 / §8, ADR 0338).
//!
//! The baseline is what makes a conflict detectable: a file is only overwritten
//! when the remote copy still matches the row recorded the last time that path
//! was synchronized. Breakpoints are owned here rather than by the editor
//! plugin, so the gutter is a projection of these rows and never a second
//! source of truth.
//!
//! Every method names a project group id. None of them touches the filesystem,
//! the helper, or a host: this layer only records what a caller already
//! observed, so a malformed or escaped path is refused before it becomes
//! durable state.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::db::{
    MirrorBaselineEntry, MirrorBreakpointRecord, MirrorInitFailure, MirrorInitReceipt,
    MirrorInitRecord, MirrorInitState, MirrorInitStep, MAX_MIRROR_INIT_RECEIPT_BYTES,
};
use crate::state::AppState;

/// Storage failures are reported as an internal error; the message is the
/// repository's own, which names the rejected field and never a filesystem
/// path outside the project.
fn storage_error(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message, "INVALID_PARAMS")
}

fn str_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(&format!("{name} required")))
}

fn i64_param(params: &Value, name: &str) -> Result<i64, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(&format!("{name} required")))
}

fn array_param<'a>(params: &'a Value, name: &str) -> Result<&'a Vec<Value>, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(&format!("{name} required")))
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "mirror.baseline.list" => {
            let project_id = str_param(&params, "projectId")?;
            let st = state.lock().await;
            let entries = st
                .db
                .list_mirror_baseline(project_id)
                .map_err(storage_error)?;
            Ok(json!({ "entries": entries }))
        }
        "mirror.baseline.replace" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let raw = array_param(&params, "entries")?;
            let mut entries = Vec::with_capacity(raw.len());
            for value in raw {
                let entry: MirrorBaselineEntry = serde_json::from_value(value.clone())
                    .map_err(|_| invalid("entries must hold baseline objects"))?;
                entries.push(entry);
            }
            let count = entries.len();
            let st = state.lock().await;
            st.db
                .replace_mirror_baseline(&project_id, &entries)
                .map_err(storage_error)?;
            Ok(json!({ "count": count }))
        }
        "mirror.baseline.entry.upsert" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let entry: MirrorBaselineEntry = params
                .get("entry")
                .cloned()
                .ok_or_else(|| invalid("entry required"))
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|_| invalid("entry must be a baseline object"))
                })?;
            let st = state.lock().await;
            st.db
                .upsert_mirror_baseline_entry(&project_id, &entry)
                .map_err(storage_error)?;
            Ok(json!({ "entry": entry }))
        }
        "mirror.baseline.entry.delete" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let rel_path = str_param(&params, "relPath")?.to_owned();
            let st = state.lock().await;
            let removed = st
                .db
                .delete_mirror_baseline_entry(&project_id, &rel_path)
                .map_err(storage_error)?;
            Ok(json!({ "removed": removed }))
        }
        "mirror.baseline.clear" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let st = state.lock().await;
            let removed = st
                .db
                .clear_mirror_baseline(&project_id)
                .map_err(storage_error)?;
            Ok(json!({ "removed": removed }))
        }
        "mirror.breakpoints.list" => {
            let project_id = str_param(&params, "projectId")?;
            let st = state.lock().await;
            let breakpoints = st
                .db
                .list_mirror_breakpoints(project_id)
                .map_err(storage_error)?;
            Ok(json!({ "breakpoints": breakpoints }))
        }
        "mirror.breakpoints.replace" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let raw = array_param(&params, "breakpoints")?;
            let mut records = Vec::with_capacity(raw.len());
            for value in raw {
                let record: MirrorBreakpointRecord = serde_json::from_value(value.clone())
                    .map_err(|_| invalid("breakpoints must hold breakpoint objects"))?;
                records.push(record);
            }
            let count = records.len();
            let st = state.lock().await;
            st.db
                .replace_mirror_breakpoints(&project_id, &records)
                .map_err(storage_error)?;
            Ok(json!({ "count": count }))
        }
        "mirror.breakpoint.upsert" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let record: MirrorBreakpointRecord = params
                .get("breakpoint")
                .cloned()
                .ok_or_else(|| invalid("breakpoint required"))
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|_| invalid("breakpoint must be a breakpoint object"))
                })?;
            let st = state.lock().await;
            st.db
                .upsert_mirror_breakpoint(&project_id, &record)
                .map_err(storage_error)?;
            Ok(json!({ "breakpoint": record }))
        }
        "mirror.breakpoint.delete" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let rel_path = str_param(&params, "relPath")?.to_owned();
            let line = i64_param(&params, "line")?;
            // A whole-line breakpoint is column 0; the wire field is optional so
            // the editor does not have to send it for the common case.
            let column = params.get("column").and_then(Value::as_i64).unwrap_or(0);
            let st = state.lock().await;
            let removed = st
                .db
                .delete_mirror_breakpoint(&project_id, &rel_path, line, column)
                .map_err(storage_error)?;
            Ok(json!({ "removed": removed }))
        }
        "mirror.init.status" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let st = state.lock().await;
            init_status(&st, &project_id)
        }
        "mirror.init.receipt.upsert" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let step = init_step_param(&params, "step")?;
            let receipt = params
                .get("receipt")
                .ok_or_else(|| invalid("receipt required"))?;
            if !receipt.is_object() {
                return Err(invalid("receipt must be a receipt object"));
            }
            let serialized = serde_json::to_string(receipt)
                .map_err(|_| invalid("receipt must be a receipt object"))?;
            // Storage refuses an oversized blob as well; refusing it here keeps
            // the caller's failure a parameter error instead of an internal one.
            if serialized.len() > MAX_MIRROR_INIT_RECEIPT_BYTES {
                return Err(invalid("receipt exceeds the receipt size limit"));
            }
            let updated_at = match params.get("updatedAt") {
                None | Some(Value::Null) => crate::db::now_ms(),
                Some(value) => value
                    .as_i64()
                    .ok_or_else(|| invalid("updatedAt must be epoch milliseconds"))?,
            };
            let st = state.lock().await;
            let stored = st
                .db
                .upsert_mirror_init_receipt(&project_id, step, &serialized, updated_at)
                .map_err(storage_error)?;
            Ok(json!({
                "step": stored.step.as_str(),
                "receipt": receipt,
                "updatedAt": stored.updated_at,
            }))
        }
        "mirror.init.state" => {
            let project_id = str_param(&params, "projectId")?.to_owned();
            let target = MirrorInitState::from_id(str_param(&params, "state")?)
                .ok_or_else(|| invalid("state is not a known initialization state"))?;
            let step = match params.get("step") {
                None | Some(Value::Null) => None,
                Some(_) => Some(init_step_param(&params, "step")?),
            };
            let error = init_failure_param(&params)?;
            // A failed step and the failure's step are the same fact, so the
            // optional `step` follows the error when only the error was sent.
            let step = step.or_else(|| error.as_ref().map(|failure| failure.step));
            crate::db::validate_mirror_init_state(target, step, error.as_ref())
                .map_err(|_| invalid("state, step and error do not describe one transition"))?;
            let st = state.lock().await;
            st.db
                .set_mirror_init_state(&project_id, target, step, error.as_ref())
                .map_err(storage_error)?;
            init_status(&st, &project_id)
        }
        _ => Err(rpc_err(
            1003,
            format!("unknown mirror method: {method}"),
            "UNSUPPORTED",
        )),
    }
}

/// A step identifier from the wire. An identifier this build does not know is
/// a caller bug, so it is refused before the storage layer sees it.
fn init_step_param(params: &Value, name: &str) -> Result<MirrorInitStep, JsonRpcError> {
    let raw = str_param(params, name)?;
    MirrorInitStep::from_id(raw)
        .ok_or_else(|| invalid(&format!("{name} is not a known initialization step")))
}

/// The optional failure object of `mirror.init.state`. Its `step` is required:
/// a failure without a step cannot say where the retry resumes.
fn init_failure_param(params: &Value) -> Result<Option<MirrorInitFailure>, JsonRpcError> {
    let Some(value) = params.get("error") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if !value.is_object() {
        return Err(invalid("error must be an object"));
    }
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .ok_or_else(|| invalid("error.code required"))?;
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .ok_or_else(|| invalid("error.message required"))?;
    let step_raw = value
        .get("step")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("error.step required"))?;
    let step = MirrorInitStep::from_id(step_raw)
        .ok_or_else(|| invalid("error.step is not a known initialization step"))?;
    Ok(Some(MirrorInitFailure {
        code: code.to_string(),
        message: message.to_string(),
        step,
    }))
}

/// The state row often does not exist yet. Reporting that as `needs-init` with
/// no completed steps keeps "never started" and "started and failed" distinct
/// on the wire without inventing a stored default row.
fn init_status_payload(
    project_id: &str,
    record: Option<MirrorInitRecord>,
    receipts: &[MirrorInitReceipt],
) -> Result<Value, JsonRpcError> {
    let mut completed: Vec<&str> = Vec::with_capacity(receipts.len());
    let mut wire_receipts = Vec::with_capacity(receipts.len());
    for receipt in receipts {
        let parsed: Value = serde_json::from_str(&receipt.receipt).map_err(|_| {
            rpc_err(
                1000,
                "stored mirror init receipt is not valid JSON",
                "INTERNAL",
            )
        })?;
        completed.push(receipt.step.as_str());
        wire_receipts.push(json!({
            "step": receipt.step.as_str(),
            "receipt": parsed,
            "updatedAt": receipt.updated_at,
        }));
    }
    match record {
        Some(record) => Ok(json!({
            "projectGroupId": project_id,
            "state": record.state.as_str(),
            "step": record.step.map(MirrorInitStep::as_str),
            "error": record.error.as_ref().map(|failure| json!({
                "code": failure.code,
                "message": failure.message,
                "step": failure.step.as_str(),
            })),
            "completedSteps": completed,
            "receipts": wire_receipts,
            "createdAt": record.created_at,
            "updatedAt": record.updated_at,
        })),
        None => Ok(json!({
            "projectGroupId": project_id,
            "state": MirrorInitState::NeedsInit.as_str(),
            "step": Value::Null,
            "error": Value::Null,
            "completedSteps": completed,
            "receipts": wire_receipts,
            "createdAt": Value::Null,
            "updatedAt": Value::Null,
        })),
    }
}

/// The whole initialization state of one project: the state row plus the
/// receipts of the steps that already passed.
fn init_status(state: &AppState, project_id: &str) -> Result<Value, JsonRpcError> {
    let record = state
        .db
        .get_mirror_init(project_id)
        .map_err(storage_error)?;
    let receipts = state
        .db
        .list_mirror_init_receipts(project_id)
        .map_err(storage_error)?;
    init_status_payload(project_id, record, &receipts)
}
