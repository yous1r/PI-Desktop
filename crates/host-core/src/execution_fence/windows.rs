mod handoff;
pub use handoff::SourceOwner;

use super::native::{self, Coordinator, Job};
use crate::owner_control::identity::{
    authenticate_with_access, Identity, Peer, SecurityDescriptor,
};
use crate::owner_control::protocol::{read_frame, write_frame};
use crate::owner_handoff::{
    model::{Generation, Owner, VERSION},
    native::record,
    repository::Journal,
    target::{PreparedGeneration, RegisteredGeneration},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::System::Threading::{
    PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

pub const START_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ticket {
    pub version: u32,
    pub generation: String,
    pub address: String,
    pub capability: String,
    pub owner_pid: u32,
    pub owner_created_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub generation: String,
    pub state: &'static str,
    pub active_processes: u32,
    pub root_exited: bool,
    pub confirmed: bool,
}
struct Progress {
    state: &'static str,
    root: Option<Peer>,
}
fn lock(progress: &Mutex<Progress>) -> Result<MutexGuard<'_, Progress>> {
    progress
        .lock()
        .map_err(|_| anyhow::anyhow!("EXECUTION_FENCE_STATE_UNAVAILABLE"))
}
pub struct Lease {
    pub generation: String,
    job: Arc<Job>,
    progress: Arc<Mutex<Progress>>,
    task: tokio::task::JoinHandle<()>,
}
impl Lease {
    pub fn status(&self) -> Result<Status> {
        let progress = lock(&self.progress)?;
        self.status_locked(&progress)
    }
    fn status_locked(&self, progress: &Progress) -> Result<Status> {
        let active = self.job.active()?;
        let root_exited = progress
            .root
            .as_ref()
            .map(|peer| native::exited(peer.handle.as_raw_handle()))
            .transpose()?
            .unwrap_or(false);
        let closed = matches!(progress.state, "closed" | "failed" | "stopping");
        let confirmed = closed
            && active == 0
            && (root_exited || progress.root.is_none())
            && self.task.is_finished();
        Ok(Status {
            generation: self.generation.clone(),
            state: if confirmed { "closed" } else { progress.state },
            active_processes: active,
            root_exited,
            confirmed,
        })
    }
    pub async fn stop(&self, timeout_ms: u64) -> Result<Status> {
        {
            let mut progress = lock(&self.progress)?;
            progress.state = "stopping";
            // Serialize stopping against the assignment transaction.
            self.job.terminate()?;
        }
        self.task.abort();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let status = self.status()?;
            // A pending registration must be fully cancelled, not merely signalled.
            if (status.confirmed && self.task.is_finished())
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(Status {
                    confirmed: status.confirmed && self.task.is_finished(),
                    ..status
                });
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.task.abort();
        if let Err(error) = self.job.terminate() {
            tracing::error!(%error, "execution fence cleanup failed");
        }
    }
}
pub struct Registry {
    identity: Identity,
    coordinator: Arc<Coordinator>,
    current: Option<Arc<Lease>>,
    owner: Owner,
    journal: Option<Arc<Mutex<Journal>>>,
}
impl Registry {
    /// Adopt the captured successor owner/coordinator instead of minting a new
    /// owner epoch. The journal must already contain this exact active owner;
    /// no registration row is inserted and normal `start` behavior is unchanged.
    pub fn adopt(
        directory: &Path,
        identity: Identity,
        coordinator: Arc<Coordinator>,
        owner: Owner,
    ) -> Result<Self> {
        owner.validate()?;
        if record(std::process::id(), &identity) != owner.host
            || record(coordinator.pid, &coordinator.identity) != owner.coordinator
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        if native::exited(coordinator.handle.as_raw_handle())? {
            bail!("HANDOFF_COORDINATOR_EXITED");
        }
        let journal = Journal::open(&directory.join("pi.sqlite"), false)?;
        // Exact active row only; a retired/replaced owner is never adopted.
        journal.inspect_source(&owner, None)?;
        Ok(Self {
            identity,
            coordinator,
            current: None,
            owner,
            journal: Some(Arc::new(Mutex::new(journal))),
        })
    }
    #[cfg(test)]
    pub(crate) fn for_test(
        directory: &Path,
        identity: Identity,
        coordinator: Arc<Coordinator>,
        owner: Owner,
    ) -> Result<Self> {
        let journal = Journal::open(&directory.join("pi.sqlite"), false)?;
        journal.inspect_source(&owner, None)?;
        Ok(Self {
            identity,
            coordinator,
            current: None,
            owner,
            journal: Some(Arc::new(Mutex::new(journal))),
        })
    }
    pub fn start(directory: &Path) -> Result<Self> {
        let identity = Identity::current()?;
        let coordinator = Arc::new(Coordinator::capture(&identity)?);
        let owner = Owner {
            version: VERSION,
            epoch: uuid::Uuid::new_v4().to_string(),
            profile: crate::owner_control::profile_id(directory)?,
            host: record(std::process::id(), &identity),
            coordinator: record(coordinator.pid, &coordinator.identity),
        };
        Ok(Self {
            identity,
            coordinator,
            current: None,
            owner,
            journal: None,
        })
    }
    pub fn epoch(&self) -> &str {
        &self.owner.epoch
    }
    /// Captured successor owner retained by adoption (`start` keeps its own).
    pub fn owner(&self) -> &Owner {
        &self.owner
    }
    /// Current generation only after a real registration bound its root.
    pub fn active_generation(&self) -> Option<&str> {
        self.current.as_ref().map(|lease| lease.generation.as_str())
    }
    pub fn inspect(&self, epoch: &str, profile: &str, generation: &str) -> Result<Status> {
        if self.owner.epoch != epoch || self.owner.profile != profile {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        if native::exited(self.coordinator.handle.as_raw_handle())? {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let lease = self.lease(generation)?;
        // Registration holds progress before the journal. Inspection follows
        // that order and refuses contention rather than waiting for effects.
        let progress = lease
            .progress
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_NATIVE_STATE_UNAVAILABLE"))?;
        let root = progress
            .root
            .as_ref()
            .map(|peer| record(peer.pid, &peer.identity));
        let journal = self
            .journal
            .as_ref()
            .context("HANDOFF_OWNER_NOT_REGISTERED")?
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?;
        journal.inspect_generation(&self.owner, generation, root.as_ref())?;
        lease.status_locked(&progress)
    }
    pub fn read_source(
        &self,
        transfer: Option<(&str, &str, &str)>,
    ) -> Result<(
        String,
        String,
        Option<crate::owner_handoff::model::Transfer>,
    )> {
        if native::exited(self.coordinator.handle.as_raw_handle())? {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        if let Some((epoch, profile, _)) = transfer {
            if epoch != self.owner.epoch || profile != self.owner.profile {
                bail!("HANDOFF_OWNER_CHANGED");
            }
        }
        let journal = self
            .journal
            .as_ref()
            .context("HANDOFF_OWNER_NOT_REGISTERED")?
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?;
        let record = journal.inspect_source(&self.owner, transfer.map(|(_, _, id)| id))?;
        Ok((self.owner.epoch.clone(), self.owner.profile.clone(), record))
    }
    pub fn bind_journal(&mut self, directory: &Path) -> Result<()> {
        if self.journal.is_some() {
            bail!("HANDOFF_OWNER_ALREADY_REGISTERED");
        }
        let mut journal = Journal::open(&directory.join("pi.sqlite"), false)?;
        journal.register_owner(&self.owner)?;
        self.journal = Some(Arc::new(Mutex::new(journal)));
        Ok(())
    }
    pub fn prepare(&mut self) -> Result<Ticket> {
        let journal = self
            .journal
            .as_ref()
            .context("HANDOFF_OWNER_NOT_REGISTERED")?
            .clone();
        if native::exited(self.coordinator.handle.as_raw_handle())? {
            bail!("EXECUTION_FENCE_COORDINATOR_EXITED");
        }
        if let Some(current) = &self.current {
            if !current.status()?.confirmed || !current.task.is_finished() {
                bail!("EXECUTION_FENCE_BUSY");
            }
            journal
                .lock()
                .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
                .close_generation(&current.generation)?;
        }
        let generation = uuid::Uuid::new_v4().to_string();
        let registration = Generation {
            version: VERSION,
            id: generation.clone(),
            owner_epoch: self.owner.epoch.clone(),
            profile: self.owner.profile.clone(),
            job_name: Generation::job_name(&self.owner.profile, &self.owner.epoch, &generation),
            root: None,
        };
        journal
            .lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
            .register_generation(&registration)?;
        let ticket = self.ticket_for(&generation);
        let binder = RootBinder::Normal {
            journal,
            generation: generation.clone(),
        };
        self.start_registration(ticket.clone(), generation, registration.job_name, binder)?;
        Ok(ticket)
    }

    /// Target-only preparation. The generation was already registered by the
    /// restricted claim path; only the Job/one-use pipe/registration actor are
    /// created here, and the exact captured owner epoch is retained. Normal
    /// `prepare` keeps minting and registering its own generation.
    pub(crate) fn prepare_prepared(
        &mut self,
        prepared: PreparedGeneration,
    ) -> Result<(Ticket, Arc<Mutex<Option<RegisteredGeneration>>>)> {
        if native::exited(self.coordinator.handle.as_raw_handle())? {
            bail!("EXECUTION_FENCE_COORDINATOR_EXITED");
        }
        if self.current.is_some() {
            bail!("EXECUTION_FENCE_BUSY");
        }
        let record = prepared.record();
        record.validate()?;
        if record.owner_epoch != self.owner.epoch
            || record.profile != self.owner.profile
            || record.root.is_some()
        {
            bail!("HANDOFF_INVALID_REGISTRATION");
        }
        let generation = record.id.clone();
        let job_name = record.job_name.clone();
        let ticket = self.ticket_for(&generation);
        let bound = Arc::new(Mutex::new(None));
        let binder = RootBinder::Target {
            prepared: Some(prepared),
            bound: Arc::clone(&bound),
        };
        self.start_registration(ticket.clone(), generation, job_name, binder)?;
        Ok((ticket, bound))
    }

    fn ticket_for(&self, generation: &str) -> Ticket {
        Ticket {
            version: 1,
            address: format!(r"\\.\pipe\pi-execution-v1-{generation}"),
            generation: generation.to_string(),
            capability: uuid::Uuid::new_v4().to_string(),
            owner_pid: std::process::id(),
            owner_created_at: self.identity.created_at.to_string(),
        }
    }

    fn start_registration(
        &mut self,
        ticket: Ticket,
        generation: String,
        job_name: String,
        binder: RootBinder,
    ) -> Result<()> {
        let security = SecurityDescriptor::for_user(&self.identity.sid)?;
        let mut attributes = security.attributes();
        let pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .max_instances(1)
                .in_buffer_size(16 * 1024)
                .out_buffer_size(16 * 1024)
                .create_with_security_attributes_raw(
                    &ticket.address,
                    std::ptr::from_mut(&mut attributes).cast(),
                )
        }?;
        let job = Arc::new(Job::create(&job_name, &self.identity.sid)?);
        let progress = Arc::new(Mutex::new(Progress {
            state: "pending",
            root: None,
        }));
        let actor = Registration {
            ticket: ticket.clone(),
            identity: self.identity.clone(),
            coordinator: self.coordinator.clone(),
            job: Arc::clone(&job),
            progress: Arc::clone(&progress),
            issued_at: native::now(),
            binder,
        };
        let task = tokio::spawn(async move {
            actor.run(pipe).await;
        });
        self.current = Some(Arc::new(Lease {
            generation,
            job,
            progress,
            task,
        }));
        Ok(())
    }

    /// Wait until the sidecar registration actor bound a root for this exact
    /// generation. A failed actor, closed generation or timeout is a refusal;
    /// success means the exact ticket handshake and bind_root completed.
    pub(crate) async fn wait_root(&self, generation: &str, timeout: Duration) -> Result<()> {
        let lease = self.lease(generation)?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let status = lease.status()?;
            if status.state == "running" && status.active_processes > 0 && !lease.task.is_finished()
            {
                return Ok(());
            }
            if status.state == "failed" || status.state == "closed" || lease.task.is_finished() {
                bail!("HANDOFF_TARGET_ROOT_BIND_FAILED");
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("HANDOFF_TARGET_ROOT_TIMEOUT");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Stop the exact target lease and close its durable generation after any
    /// failed initialization. The claim/transfer row is left untouched so the
    /// explicit Recover path can rotate the target epoch later.
    pub(crate) async fn abort_target(&mut self, generation: &str) -> Result<()> {
        if let Ok(lease) = self.lease(generation) {
            // Binding a sidecar without Ready must not leave an owned process.
            let _ = lease.stop(2_000).await;
        }
        if let Some(journal) = &self.journal {
            journal
                .lock()
                .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
                .close_generation(generation)?;
        }
        if self
            .current
            .as_ref()
            .is_some_and(|lease| lease.generation == generation)
        {
            self.current = None;
        }
        Ok(())
    }
    pub fn lease(&self, generation: &str) -> Result<Arc<Lease>> {
        self.current
            .as_ref()
            .filter(|lease| lease.generation == generation)
            .cloned()
            .context("EXECUTION_FENCE_STALE")
    }
}
enum RootBinder {
    Normal {
        journal: Arc<Mutex<Journal>>,
        generation: String,
    },
    Target {
        prepared: Option<PreparedGeneration>,
        bound: Arc<Mutex<Option<RegisteredGeneration>>>,
    },
}
impl RootBinder {
    fn bind(&mut self, root: &crate::owner_handoff::model::ProcessIdentity) -> Result<()> {
        match self {
            Self::Normal {
                journal,
                generation,
            } => journal
                .lock()
                .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
                .bind_root(generation, root),
            Self::Target { prepared, bound } => {
                let prepared = prepared
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("HANDOFF_TARGET_ROOT_ALREADY_BOUND"))?;
                let registered = prepared.bind_root(root)?;
                let mut slot = bound
                    .lock()
                    .map_err(|_| anyhow::anyhow!("HANDOFF_NATIVE_STATE_UNAVAILABLE"))?;
                if slot.is_some() {
                    bail!("HANDOFF_TARGET_ROOT_ALREADY_BOUND");
                }
                *slot = Some(registered);
                Ok(())
            }
        }
    }
}
struct Registration {
    ticket: Ticket,
    identity: Identity,
    coordinator: Arc<Coordinator>,
    job: Arc<Job>,
    progress: Arc<Mutex<Progress>>,
    issued_at: u64,
    binder: RootBinder,
}
impl Registration {
    async fn register(&mut self, pipe: &mut NamedPipeServer) -> Result<()> {
        pipe.connect().await?;
        let peer = authenticate_with_access(
            pipe.as_raw_handle(),
            true,
            &self.identity,
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
        )?;
        if peer.pid == std::process::id()
            || peer.identity.created_at < self.issued_at
            || peer.identity.created_at <= self.coordinator.identity.created_at
            || native::parent_pid(peer.pid)? != self.coordinator.pid
            || native::exited(self.coordinator.handle.as_raw_handle())?
            || native::exited(peer.handle.as_raw_handle())?
        {
            bail!("EXECUTION_FENCE_PARENT_MISMATCH");
        }
        pipe.write_u8(1).await?;
        let request: Ticket = serde_json::from_slice(&read_frame(pipe).await?)?;
        if request != self.ticket {
            bail!("EXECUTION_FENCE_TICKET_MISMATCH");
        }
        {
            let mut progress = lock(&self.progress)?;
            if progress.state != "pending"
                || native::exited(self.coordinator.handle.as_raw_handle())?
            {
                bail!("EXECUTION_FENCE_CANCELLED");
            }
            self.binder.bind(&record(peer.pid, &peer.identity))?;
            self.job.assign(peer.handle.as_raw_handle())?;
            progress.root = Some(peer);
        }
        write_frame(pipe, self.ticket.generation.as_bytes()).await?;
        if pipe.read_u8().await? != 0 {
            bail!("EXECUTION_FENCE_INVALID_ACK");
        }
        // Publish `running` only after the sidecar acknowledged the exact
        // generation, so Ready cannot race an unconfirmed handshake.
        lock(&self.progress)?.state = "running";
        Ok(())
    }
    async fn supervise(&self) -> Result<()> {
        loop {
            let root_exited = {
                let progress = lock(&self.progress)?;
                progress
                    .root
                    .as_ref()
                    .map(|peer| native::exited(peer.handle.as_raw_handle()))
                    .transpose()?
                    .unwrap_or(false)
            };
            if root_exited || native::exited(self.coordinator.handle.as_raw_handle())? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    async fn run(mut self, mut pipe: NamedPipeServer) {
        let registered = tokio::time::timeout(START_TIMEOUT, self.register(&mut pipe)).await;
        // Close the one-use endpoint before supervision; no reconnection/replay.
        drop(pipe);
        let result = match registered {
            Ok(Ok(())) => self.supervise().await,
            Ok(Err(error)) => Err(error),
            Err(_) => Err(anyhow::anyhow!("EXECUTION_FENCE_START_TIMEOUT")),
        };
        if let Err(error) = &result {
            tracing::warn!(%error, "execution fence registration or supervision failed");
        }
        if let Ok(mut progress) = lock(&self.progress) {
            progress.state = if result.is_ok() { "closed" } else { "failed" };
        }
        if let Err(error) = self.job.terminate() {
            tracing::error!(%error, "execution fence termination failed");
        }
    }
}

#[cfg(test)]
mod tests;
