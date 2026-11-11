//! Capture native identity once, claim on inherited framed stdio, publish
//! Restricted Ready in this SAME process, and never launch another serving Host.
use super::{
    bootstrap,
    protocol::{
        launch_sidecar_reply, ready_error_reply, ready_reply, AttachEpoch, BootstrapRequest,
    },
    ready_resources::TargetReadyPublisher,
    TargetBootstrap,
};
use crate::data_directory_owner::{DataDirectoryOwner, IN_USE_MARKER};
use crate::execution_fence::native::{exited, Coordinator};
use crate::execution_fence::Registry;
use crate::owner_control::identity::Identity;
use crate::owner_handoff::{
    model::{self, Build, Generation, Owner, VERSION},
    native::{record, Proof},
    service::ContextIdentity,
    stdio,
};
use crate::state::AppState;
use anyhow::{bail, Result};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const LOCK_WAIT: Duration = Duration::from_secs(10);
const MAX_COMMANDS: usize = 4;
/// Bound on the time a target waits for the sidecar registration handshake.
const ROOT_WAIT: Duration = Duration::from_secs(10);

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

/// Prepare the real target root and publish Ready after one claim.
///
/// Order is fixed: restricted AppState -> adopt captured owner -> prepare the
/// target generation (Job/one-use pipe/ticket) -> send `launch-sidecar` ->
/// accept `attach-epoch` -> wait for the fake/real sidecar `bind_root` with a
/// bounded timeout -> commit Ready with that exact live epoch -> serve framed
/// JSON-RPC on the same channel. Any refusal closes the target generation and
/// leaves the durable claim recoverable; ordinary startup is never reached.
pub(crate) async fn publish_ready(target: NativeTarget, directory: &Path) -> Result<()> {
    let NativeTarget {
        bootstrap,
        identity,
        coordinator,
        build,
    } = target;
    let mut state = AppState::open_restricted_target(directory)?;
    let mut registry = Registry::adopt(
        directory,
        identity,
        Arc::clone(&coordinator),
        bootstrap.owner().clone(),
    )?;
    let owner = bootstrap.owner();
    let generation = Generation {
        version: VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        owner_epoch: owner.epoch.clone(),
        profile: owner.profile.clone(),
        job_name: String::new(),
        root: None,
    };
    let mut generation = generation;
    generation.job_name = Generation::job_name(&owner.profile, &owner.epoch, &generation.id);
    let prepared = bootstrap.prepare_generation(generation)?;
    let generation_id = prepared.record().id.clone();
    let (ticket, bound) = registry.prepare_prepared(prepared)?;

    let join = async {
        let launch = launch_sidecar_reply(
            bootstrap.record().id.as_str(),
            bootstrap.owner().epoch.as_str(),
            &ticket,
        )?;
        stdio::send(&coordinator, launch).await?;
        let frame = stdio::receive(&coordinator)
            .await?
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_ATTACH_EPOCH_EOF"))?;
        let attach = AttachEpoch::parse(&frame)?;
        attach.check(&bootstrap)?;
        let event_epoch = attach.event_epoch().to_string();
        let request_id = attach.request_id().to_string();
        registry.wait_root(&generation_id, ROOT_WAIT).await?;
        let registered = bound
            .lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_NATIVE_STATE_UNAVAILABLE"))?
            .take()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_TARGET_ROOT_BIND_FAILED"))?;
        let publisher = TargetReadyPublisher::new(bootstrap, build, event_epoch.clone())?;
        let ready = publisher.into_ready_target(registered, &request_id)?;
        let outcome = ready.commit()?;
        stdio::send(&coordinator, ready_reply(&outcome)?).await?;
        Ok::<String, anyhow::Error>(event_epoch)
    }
    .await;

    match join {
        Ok(event_epoch) => {
            state.set_event_epoch(Some(event_epoch));
            state.execution_fence = Some(registry);
            // The served process retains the claim lock through main's
            // target_owner value. Only after Ready (real root + live epoch)
            // does the inherited channel switch to framed JSON-RPC serving.
            let state = Arc::new(tokio::sync::Mutex::new(state));
            crate::rpc::target_serve::serve_target(state).await
        }
        Err(error) => {
            if let Err(cleanup) = registry.abort_target(&generation_id).await {
                tracing::error!(%cleanup, "failed to abort target generation after refusal");
            }
            if let Ok(reply) = ready_error_reply(&error) {
                let _ = stdio::send(&coordinator, reply).await;
            }
            Err(error)
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
