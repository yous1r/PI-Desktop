//! Opt-in native execution containment. Durable handoff is a separate layer.
#[cfg(windows)]
pub(crate) mod native;
#[cfg(windows)]
mod runner;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{Registry, SourceOwner};
#[cfg(not(windows))]
pub struct Registry;

use crate::state::AppState;
use anyhow::{bail, Result};
#[cfg(windows)]
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

pub fn start(directory: &std::path::Path) -> Result<Option<Registry>> {
    if !std::env::args().any(|arg| arg == "--execution-fence") {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        Ok(Some(Registry::start(directory)?))
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        bail!("EXECUTION_FENCE_UNSUPPORTED")
    }
}
pub fn owner_epoch(registry: &Option<Registry>) -> Option<&str> {
    #[cfg(windows)]
    {
        registry.as_ref().map(Registry::epoch)
    }
    #[cfg(not(windows))]
    {
        let _ = registry;
        None
    }
}
pub fn bind_journal(registry: &mut Option<Registry>, directory: &std::path::Path) -> Result<()> {
    #[cfg(windows)]
    if let Some(registry) = registry {
        registry.bind_journal(directory)?;
    }
    #[cfg(not(windows))]
    let _ = (registry, directory);
    Ok(())
}
pub async fn run_cli() -> Result<Option<i32>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !args
        .first()
        .is_some_and(|arg| arg == "--internal-execution-runner")
    {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        Ok(Some(runner::run(&args).await?))
    }
    #[cfg(not(windows))]
    {
        bail!("EXECUTION_FENCE_UNSUPPORTED")
    }
}
#[cfg(windows)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[cfg(windows)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    generation: String,
}
#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stop {
    generation: String,
    timeout_ms: u64,
}

pub async fn handle(state: Arc<Mutex<AppState>>, method: &str, params: Value) -> Result<Value> {
    #[cfg(windows)]
    {
        match method {
            "executionFence.prepare" => {
                let _: Empty = serde_json::from_value(params)?;
                let mut state = state.lock().await;
                let registry = state
                    .execution_fence
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("EXECUTION_FENCE_UNAVAILABLE"))?;
                Ok(serde_json::to_value(registry.prepare()?)?)
            }
            "executionFence.status" | "executionFence.stop" => {
                let (generation, timeout) = if method == "executionFence.stop" {
                    let request: Stop = serde_json::from_value(params)?;
                    if request.timeout_ms > 2000 {
                        bail!("EXECUTION_FENCE_INVALID_TIMEOUT");
                    }
                    (request.generation, Some(request.timeout_ms))
                } else {
                    let request: Query = serde_json::from_value(params)?;
                    (request.generation, None)
                };
                let lease = {
                    let state = state.lock().await;
                    state
                        .execution_fence
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("EXECUTION_FENCE_UNAVAILABLE"))?
                        .lease(&generation)?
                };
                let result = match timeout {
                    Some(timeout) => lease.stop(timeout).await?,
                    None => lease.status()?,
                };
                Ok(serde_json::to_value(result)?)
            }
            _ => bail!("EXECUTION_FENCE_UNKNOWN_METHOD"),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (state, method, params);
        bail!("EXECUTION_FENCE_UNSUPPORTED")
    }
}
