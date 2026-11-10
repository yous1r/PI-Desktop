use super::protocol::{Body, Code, Command, Failure, Preflight, Reply, Request};
use crate::{
    owner_handoff::model::{Build, VERSION},
    state::AppState,
};
use anyhow::{bail, Result};
use std::sync::Arc;
use tokio::sync::Mutex;

pub(super) struct Service {
    state: Arc<Mutex<AppState>>,
    epoch: String,
    pub profile: String,
    build: Build,
}
impl Service {
    pub fn capture(state: Arc<Mutex<AppState>>) -> Result<Option<Self>> {
        // Called before startup background tasks are spawned. No optional
        // coordinator query or native execution generation is needed.
        let guard = state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_UNAVAILABLE"))?;
        let Some(registry) = &guard.execution_fence else {
            return Ok(None);
        };
        let (epoch, profile, _) = registry.read_source(None)?;
        drop(guard);
        Ok(Some(Self {
            state,
            epoch,
            profile,
            build: Build::current()?,
        }))
    }
    fn read(&self, request: &Request) -> Result<Body> {
        request.validate()?;
        if request.command.identity().2 != self.epoch {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let guard = self
            .state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_UNAVAILABLE"))?;
        let registry = guard
            .execution_fence
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_OWNER_CHANGED"))?;
        let transfer = match &request.command {
            Command::Status { transfer_id, .. } => Some((
                self.epoch.as_str(),
                self.profile.as_str(),
                transfer_id.as_str(),
            )),
            _ => None,
        };
        let (epoch, profile, record) = registry.read_source(transfer)?;
        if epoch != self.epoch || profile != self.profile {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        match &request.command {
            Command::Preflight {
                target_build,
                request_id,
                ..
            } => {
                if *target_build != self.build {
                    bail!("HANDOFF_INCOMPATIBLE_BUILD");
                }
                Ok(Body::Preflight(Preflight {
                    version: VERSION,
                    request_id: request_id.clone(),
                    source_epoch: epoch,
                    profile_id: profile,
                    source_build: self.build.clone(),
                    target_build: target_build.clone(),
                    requires_idle: true,
                }))
            }
            Command::Status { .. } => Ok(Body::Record {
                version: VERSION,
                record: record.ok_or_else(|| anyhow::anyhow!("HANDOFF_UNAVAILABLE"))?,
            }),
        }
    }
    pub fn execute(&self, request: &Request) -> Reply {
        let result = self.read(request).unwrap_or_else(|error| Body::Failure {
            version: VERSION,
            error: Failure {
                code: match error.to_string().as_str() {
                    "HANDOFF_OWNER_CHANGED" => Code::OwnerChanged,
                    "HANDOFF_INCOMPATIBLE_BUILD" => Code::IncompatibleBuild,
                    _ => Code::Unavailable,
                },
            },
        });
        Reply::new(request, &self.profile, result)
    }
}
