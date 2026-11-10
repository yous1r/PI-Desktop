use super::protocol::{Body, Code, Command, Failure, Preflight, Reply, Request};
use super::{controller::Controller, operations::Operations, ports::Native};
use crate::owner_control::identity::Peer;
use crate::owner_handoff::activity::Activity;
use crate::{
    owner_handoff::model::{Build, VERSION},
    state::AppState,
};
use anyhow::{bail, Result};
use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(super) struct Service {
    state: Arc<Mutex<AppState>>,
    epoch: String,
    pub profile: String,
    build: Build,
    activity: Activity,
    operations: Operations,
    controller: Mutex<Option<Controller<Native>>>,
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
        let activity = guard.handoff_activity.clone();
        drop(guard);
        Ok(Some(Self {
            state,
            epoch,
            profile,
            build: Build::current()?,
            activity,
            operations: Operations::default(),
            controller: Mutex::new(None),
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
            _ => bail!("HANDOFF_INVALID_REQUEST"),
        }
    }
    pub fn execute(&self, request: &Request) -> Reply {
        let result = self.read(request).unwrap_or_else(failure);
        Reply::new(request, &self.profile, result)
    }
    pub async fn mutation(self: &Arc<Self>, request: &Request, peer: Arc<Peer>) -> Reply {
        let result = async {
            request.validate()?;
            if request.command.identity().2 != self.epoch {
                bail!("HANDOFF_OWNER_CHANGED");
            }
            let fingerprint = super::journal::fingerprint(&request.command)?;
            let source = self.clone();
            let command = request.command.clone();
            let principal = peer.identity.sid.clone();
            self.operations
                .run(
                    &principal,
                    request.command.identity().1,
                    fingerprint,
                    async move {
                        let result = async {
                            if crate::execution_fence::native::exited(peer.handle.as_raw_handle())?
                            {
                                bail!("HANDOFF_OWNER_CHANGED");
                            }
                            let requester =
                                crate::owner_handoff::native::record(peer.pid, &peer.identity);
                            let mut controller = source.controller.lock().await;
                            if controller.is_none()
                                || (matches!(command, Command::Prepare { .. })
                                    && controller.as_ref().is_some_and(Controller::can_replace))
                            {
                                let ports = Native::capture(
                                    source.state.clone(),
                                    &source.epoch,
                                    &source.profile,
                                )?;
                                *controller = Some(Controller::new(ports, source.build.clone()));
                            }
                            let record = controller
                                .as_mut()
                                .ok_or_else(|| anyhow::anyhow!("HANDOFF_UNAVAILABLE"))?
                                .execute(&command, &requester)
                                .await?;
                            // Keep the original authenticated peer handle until the
                            // accepted operation settles, even if its caller exits.
                            drop(peer);
                            Ok(Body::Record {
                                version: VERSION,
                                record,
                            })
                        }
                        .await;
                        result.unwrap_or_else(failure)
                    },
                )
                .await
        }
        .await
        .unwrap_or_else(failure);
        Reply::new(request, &self.profile, result)
    }
    pub fn seal(&self) {
        self.activity.close();
        self.operations.seal();
        if let Ok(state) = self.state.try_lock() {
            if let Some(exchange) = &state.handoff_exchange {
                exchange.close();
            }
        }
    }
    pub async fn close(&self) {
        self.seal();
        self.operations.close().await;
    }
}
fn failure(error: anyhow::Error) -> Body {
    Body::Failure {
        version: VERSION,
        error: Failure {
            code: match error.to_string().as_str() {
                "HANDOFF_OWNER_CHANGED" => Code::OwnerChanged,
                "HANDOFF_INCOMPATIBLE_BUILD" => Code::IncompatibleBuild,
                "HANDOFF_BUSY" => Code::Busy,
                "HANDOFF_REQUEST_CONFLICT" => Code::RequestConflict,
                "HANDOFF_STALE_REVISION" => Code::StaleRevision,
                "HANDOFF_INVALID_TRANSITION" | "HANDOFF_TERMINAL" => Code::InvalidTransition,
                "HANDOFF_CANCEL_UNCONFIRMED" => Code::CancelUnconfirmed,
                "HANDOFF_FENCE_UNCONFIRMED" => Code::FenceUnconfirmed,
                _ => Code::Unavailable,
            },
        },
    }
}
