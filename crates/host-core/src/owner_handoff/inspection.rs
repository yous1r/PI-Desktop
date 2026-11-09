//! Read-only facts from the running Rust owner. This is not an admission hold,
//! a complete Desktop inventory, or proof that every native family is closed.
use super::{activity::Snapshot, model};
use crate::state::AppState;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const METHOD: &str = "ownerHandoff.inspect";
pub const BUDGET_MS: u64 = 2000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    version: u32,
    request_id: String,
    source_epoch: String,
    profile_id: String,
    generation: String,
}
impl Request {
    fn parse(value: Value) -> Result<Self> {
        if serde_json::to_vec(&value)?.len() > model::MAX_RECORD_BYTES {
            bail!("HANDOFF_RECORD_TOO_LARGE");
        }
        let request: Self = serde_json::from_value(value)?;
        if request.version != model::VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        model::uuid(&request.request_id)?;
        model::uuid(&request.source_epoch)?;
        model::uuid(&request.generation)?;
        model::hash(&request.profile_id)?;
        Ok(request)
    }
}

/// Existence bits are conservative obligations, not execution counts. All
/// reads share one SQLite statement snapshot and never expire approvals or
/// recover/replay work. Configured schedules and paused, unclaimed modes do
/// not by themselves represent an executing task.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Durable {
    turns: bool,
    queued_turns: bool,
    plans: bool,
    approvals: bool,
    scheduled_runs: bool,
    mode_claims: bool,
    mode_waits: bool,
    worktrees: bool,
}
impl Durable {
    fn read(db: &crate::db::Database) -> Result<Self> {
        super::read_budget::bounded_read(db.conn(), || {
            Ok(db.conn().query_row(
            "SELECT
             EXISTS(SELECT 1 FROM turns WHERE ended_at IS NULL OR status NOT IN ('completed','aborted','error')),
             EXISTS(SELECT 1 FROM turn_queue),
             EXISTS(SELECT 1 FROM plan_approvals WHERE execution_state IN ('queued','running')),
             EXISTS(SELECT 1 FROM plan_approvals WHERE status='pending'),
             EXISTS(SELECT 1 FROM task_runs WHERE ended_at IS NULL OR status NOT IN ('completed','aborted','error')),
             EXISTS(SELECT 1 FROM mode_runs WHERE active_turn_id IS NOT NULL OR active_origin IS NOT NULL),
             EXISTS(SELECT 1 FROM mode_runs WHERE state IN ('running','waiting') OR pending_gate IS NOT NULL),
             EXISTS(SELECT 1 FROM worktrees WHERE status='creating' OR setup_status='running' OR session_id IS NULL)",
            [],
            |row| Ok(Self {
                turns: row.get(0)?, queued_turns: row.get(1)?, plans: row.get(2)?,
                approvals: row.get(3)?, scheduled_runs: row.get(4)?, mode_claims: row.get(5)?,
                mode_waits: row.get(6)?, worktrees: row.get(7)?,
            }),
        )?)
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Runtime {
    tools: bool,
    background_processes: bool,
    remote_executions: bool,
    plugin_executions: bool,
    permissions: bool,
    config_sync: bool,
}
impl Runtime {
    fn read(state: &AppState) -> Self {
        let tools = state.tool_budget.snapshot();
        Self {
            tools: tools.active != 0 || tools.queued != 0,
            background_processes: state.background_tasks.running_count() != 0,
            remote_executions: !state.remote_execs.is_empty(),
            plugin_executions: !state.plugin_execs.is_empty(),
            permissions: state.has_pending_permissions(),
            config_sync: state
                .config_sync_in_progress
                .load(std::sync::atomic::Ordering::SeqCst),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    version: u32,
    request_id: String,
    source_epoch: String,
    profile_id: String,
    generation: String,
    activity: Snapshot,
    runtime: Runtime,
    native_coverage: &'static str,
    durable: Durable,
    native: Value,
}

pub async fn handle(state: Arc<Mutex<AppState>>, value: Value) -> Result<Value> {
    let request = Request::parse(value)?;
    #[cfg(windows)]
    {
        let state = state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_BUSY"))?;
        let registry = state
            .execution_fence
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_OWNER_UNAVAILABLE"))?;
        let native = registry.inspect(
            &request.source_epoch,
            &request.profile_id,
            &request.generation,
        )?;
        let report = Report {
            version: model::VERSION,
            request_id: request.request_id,
            source_epoch: request.source_epoch,
            profile_id: request.profile_id,
            generation: request.generation,
            activity: state.handoff_activity.snapshot(),
            runtime: Runtime::read(&state),
            native_coverage: "execution_generation_only",
            durable: Durable::read(&state.db)?,
            native: serde_json::to_value(native)?,
        };
        let encoded = model::encode(&report)?;
        Ok(serde_json::from_str(&encoded)?)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, request);
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}

#[cfg(test)]
mod tests;
