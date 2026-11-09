use super::native::{self, Coordinator, Job};
use crate::owner_control::identity::{
    authenticate_with_access, Identity, Peer, SecurityDescriptor,
};
use crate::owner_control::protocol::{read_frame, write_frame};
use crate::owner_handoff::{
    model::{Generation, Owner, VERSION},
    native::record,
    repository::Journal,
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
        let ticket = Ticket {
            version: 1,
            address: format!(r"\\.\pipe\pi-execution-v1-{generation}"),
            generation: generation.clone(),
            capability: uuid::Uuid::new_v4().to_string(),
            owner_pid: std::process::id(),
            owner_created_at: self.identity.created_at.to_string(),
        };
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
        let registration = Generation {
            version: VERSION,
            id: generation.clone(),
            owner_epoch: self.owner.epoch.clone(),
            profile: self.owner.profile.clone(),
            job_name: Generation::job_name(&self.owner.profile, &self.owner.epoch, &generation),
            root: None,
        };
        let job = Arc::new(Job::create(&registration.job_name, &self.identity.sid)?);
        journal
            .lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
            .register_generation(&registration)?;
        let progress = Arc::new(Mutex::new(Progress {
            state: "pending",
            root: None,
        }));
        let actor = Registration {
            ticket: ticket.clone(),
            identity: self.identity.clone(),
            coordinator: self.coordinator.clone(),
            job: job.clone(),
            progress: progress.clone(),
            issued_at: native::now(),
            journal,
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
        Ok(ticket)
    }
    pub fn lease(&self, generation: &str) -> Result<Arc<Lease>> {
        self.current
            .as_ref()
            .filter(|lease| lease.generation == generation)
            .cloned()
            .context("EXECUTION_FENCE_STALE")
    }
}
struct Registration {
    ticket: Ticket,
    identity: Identity,
    coordinator: Arc<Coordinator>,
    job: Arc<Job>,
    progress: Arc<Mutex<Progress>>,
    issued_at: u64,
    journal: Arc<Mutex<Journal>>,
}
impl Registration {
    async fn register(&self, pipe: &mut NamedPipeServer) -> Result<()> {
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
            self.journal
                .lock()
                .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
                .bind_root(&self.ticket.generation, &record(peer.pid, &peer.identity))?;
            self.job.assign(peer.handle.as_raw_handle())?;
            progress.root = Some(peer);
            progress.state = "running";
        }
        write_frame(pipe, self.ticket.generation.as_bytes()).await?;
        if pipe.read_u8().await? != 0 {
            bail!("EXECUTION_FENCE_INVALID_ACK");
        }
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
    async fn run(self, mut pipe: NamedPipeServer) {
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
