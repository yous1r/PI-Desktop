//! Private stdio facts from the retained Rust owner, including before a
//! Sidecar generation exists. Discovery and execution authority are unchanged.
use super::model;
use crate::state::AppState;
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

pub const IDENTITY: &str = "ownerHandoff.identity";
pub const TRANSFER: &str = "ownerHandoff.readTransfer";
pub const BUDGET_MS: u64 = 2000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityRequest {
    version: u32,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferRequest {
    version: u32,
    request_id: String,
    source_epoch: String,
    profile_id: String,
    transfer_id: String,
}

enum Request {
    Identity(IdentityRequest),
    Transfer(TransferRequest),
}
impl Request {
    fn parse(method: &str, value: Value) -> Result<Self> {
        model::encode(&value)?;
        let request = match method {
            IDENTITY => Self::Identity(serde_json::from_value(value)?),
            TRANSFER => Self::Transfer(serde_json::from_value(value)?),
            _ => bail!("HANDOFF_INVALID_REQUEST"),
        };
        let (version, request_id) = match &request {
            Self::Identity(value) => (value.version, &value.request_id),
            Self::Transfer(value) => {
                model::uuid(&value.source_epoch)?;
                model::hash(&value.profile_id)?;
                model::uuid(&value.transfer_id)?;
                (value.version, &value.request_id)
            }
        };
        if version != model::VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        model::uuid(request_id)?;
        Ok(request)
    }
}

pub async fn handle(state: Arc<Mutex<AppState>>, method: &str, value: Value) -> Result<Value> {
    let request = Request::parse(method, value)?;
    #[cfg(windows)]
    {
        let state = state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_BUSY"))?;
        let registry = state
            .execution_fence
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_OWNER_UNAVAILABLE"))?;
        let result = match request {
            Request::Identity(request) => {
                let (epoch, profile, _) = registry.read_source(None)?;
                json!({"version":model::VERSION,"requestId":request.request_id,"sourceEpoch":epoch,"profileId":profile})
            }
            Request::Transfer(request) => {
                let (epoch, profile, record) = registry.read_source(Some((
                    &request.source_epoch,
                    &request.profile_id,
                    &request.transfer_id,
                )))?;
                let record = record.ok_or_else(|| anyhow::anyhow!("HANDOFF_TRANSFER_MISSING"))?;
                json!({"version":model::VERSION,"requestId":request.request_id,"sourceEpoch":epoch,"profileId":profile,"transferId":request.transfer_id,"record":record})
            }
        };
        model::encode(&result)?;
        Ok(result)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, request);
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}

#[cfg(test)]
mod tests;
