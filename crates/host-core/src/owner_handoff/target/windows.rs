//! Capture native identity once, claim on inherited framed stdio, and return to
//! main in this SAME process. Never launch another serving Host after claiming.
use super::{bootstrap, BootstrapRequest, TargetBootstrap};
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
    /// another execution_owners row.
    pub(crate) identity: Identity,
    pub(crate) coordinator: Arc<Coordinator>,
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
