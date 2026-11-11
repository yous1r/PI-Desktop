//! Capture native identity once, claim on inherited framed stdio, publish
//! Restricted Ready in this SAME process, and never launch another serving Host.
use super::{
    bootstrap,
    protocol::{ready_error_reply, ready_reply},
    ready_resources::TargetReadyPublisher,
    BootstrapRequest, ReadyRequest, TargetBootstrap,
};
use crate::data_directory_owner::{DataDirectoryOwner, IN_USE_MARKER};
use crate::execution_fence::native::{exited, Coordinator};
use crate::owner_control::identity::Identity;
use crate::owner_handoff::{
    model::{self, Build, Owner, VERSION},
    native::{record, Proof},
    service::ContextIdentity,
    stdio,
};
use anyhow::{bail, Result};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const LOCK_WAIT: Duration = Duration::from_secs(10);
const MAX_COMMANDS: usize = 4;

pub(crate) struct NativeTarget {
    pub(crate) bootstrap: TargetBootstrap,
    /// Move these captured originals into Registry's adopt constructor. That
    /// constructor must compare the owner and verify this coordinator is alive;
    /// it must not mint a fresh epoch, capture a replacement parent, or insert
    /// another execution_owners row. Retained here for the serving slice.
    pub(crate) identity: Identity,
    pub(crate) coordinator: Arc<Coordinator>,
    pub(crate) build: Build,
}

/// Call before AppState, migration, ordinary startup inspection, runtime launch
/// or NDJSON RPC. The caller recognizes/validates the mode flag separately.
/// A successful claim sends its framed result before stdout becomes NDJSON.
/// A failed write leaves the durable claim intact and fails closed.
pub(crate) async fn receive(directory: &Path) -> Result<NativeTarget> {
    if !directory.join("pi.sqlite").is_file() {
        bail!("HANDOFF_DATABASE_MISSING");
    }
    let identity = Identity::current()?;
    let coordinator = Arc::new(Coordinator::capture(&identity)?);
    let profile = crate::owner_control::profile_id(directory)?;
    let build = Build::current()?;
    // Parse before acquiring the lock; neither waiting nor bad frames may open
    // AppState or create an execution generation.
    let frame = stdio::receive(&coordinator)
        .await?
        .ok_or_else(|| anyhow::anyhow!("HANDOFF_BOOTSTRAP_EOF"))?;
    let mut request = BootstrapRequest::parse(&frame)?;
    let lock = acquire(directory, &coordinator).await?;
    for index in 0..MAX_COMMANDS {
        ensure_coordinator(&coordinator)?;
        let context = ContextIdentity {
            owner: Owner {
                version: VERSION,
                epoch: request.target_epoch().into(),
                profile: profile.clone(),
                host: record(std::process::id(), &identity),
                coordinator: record(coordinator.pid, &coordinator.identity),
            },
            build: build.clone(),
        };
        if request.is_claim() {
            let bootstrap =
                bootstrap::claim_locked(directory, lock, &context, &request, &mut Proof)?;
            ensure_coordinator(&coordinator)?;
            let reply = model::encode(&serde_json::json!({
                "version": VERSION, "record": bootstrap.record(),
            }))?;
            stdio::send(&coordinator, reply.into_bytes()).await?;
            // No implicit Ready: caller still owes all restricted initialization
            // and the exact original-resource/native-generation ready guard.
            return Ok(NativeTarget {
                bootstrap,
                identity,
                coordinator,
                build,
            });
        }
        let recovered =
            bootstrap::execute_locked(directory, &lock, &context, &request, &mut Proof)?;
        let reply = model::encode(&serde_json::json!({"version": VERSION, "record": recovered}))?;
        stdio::send(&coordinator, reply.into_bytes()).await?;
        // Recover is explicit and separate from Claim. A missing/lost next
        // frame never starts the target or retries a previous command.
        if index + 1 == MAX_COMMANDS {
            bail!("HANDOFF_BOOTSTRAP_LIMIT");
        }
        let frame = stdio::receive(&coordinator)
            .await?
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_BOOTSTRAP_EOF"))?;
        request = BootstrapRequest::parse(&frame)?;
    }
    bail!("HANDOFF_BOOTSTRAP_LIMIT")
}

/// Publish Ready after one claim. Any refusal sends a bounded classified error
/// frame when the channel is still usable, then returns the error so `main`
/// exits without ordinary startup. Success leaves the process waiting for the
/// supervisor to close the private channel; this build has no serving loop yet.
pub(crate) async fn publish_ready(target: NativeTarget) -> Result<()> {
    let NativeTarget {
        bootstrap,
        identity: _identity,
        coordinator,
        build,
    } = target;
    let result = async {
        let publisher = TargetReadyPublisher::new(bootstrap, build)?;
        let prepared = publisher.prepare()?;
        let frame = stdio::receive(&coordinator)
            .await?
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_READY_EOF"))?;
        let request = ReadyRequest::parse(&frame)?;
        let outcome = prepared.commit(&request)?;
        stdio::send(&coordinator, ready_reply(&outcome)?).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        if let Ok(reply) = ready_error_reply(&error) {
            // Best effort: the classified code remains on stderr via `main`
            // even when the peer is already gone.
            let _ = stdio::send(&coordinator, reply).await;
        }
        return Err(error);
    }
    // The same claimed process stays alive until the supervisor finishes with
    // it. A second command is not part of this slice and must not be replayed.
    // Idle waits poll the bounded pipe reader; each retry is fresh I/O, not a
    // protocol resend.
    loop {
        match stdio::receive(&coordinator).await {
            Ok(None) => return Ok(()),
            Ok(Some(_)) => bail!("HANDOFF_TARGET_COMMAND_UNSUPPORTED"),
            Err(error) if error.to_string() == "HANDOFF_IO_TIMEOUT" => continue,
            Err(error) => return Err(error),
        }
    }
}

fn ensure_coordinator(coordinator: &Coordinator) -> Result<()> {
    if exited(coordinator.handle.as_raw_handle())? {
        bail!("HANDOFF_COORDINATOR_EXITED");
    }
    Ok(())
}

async fn acquire(directory: &Path, coordinator: &Coordinator) -> Result<Arc<DataDirectoryOwner>> {
    let deadline = tokio::time::Instant::now() + LOCK_WAIT;
    loop {
        ensure_coordinator(coordinator)?;
        match DataDirectoryOwner::acquire(directory) {
            Ok(lock) => return Ok(Arc::new(lock)),
            Err(error) if error.to_string().starts_with(IN_USE_MARKER) => {
                if tokio::time::Instant::now() >= deadline {
                    bail!("HANDOFF_LOCK_TIMEOUT");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error),
        }
    }
}
