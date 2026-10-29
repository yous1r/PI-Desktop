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
use crate::db::{MirrorBaselineEntry, MirrorBreakpointRecord};
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
        _ => Err(rpc_err(
            1003,
            format!("unknown mirror method: {method}"),
            "UNSUPPORTED",
        )),
    }
}
