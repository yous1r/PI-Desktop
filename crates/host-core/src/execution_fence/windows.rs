use super::native::{self, Coordinator, Job};
use crate::owner_control::identity::{
    authenticate_with_access, Identity, Peer, SecurityDescriptor,
};
use crate::owner_control::protocol::{read_frame, write_frame};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::os::windows::io::AsRawHandle;
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
}
impl Registry {
    pub fn start() -> Result<Self> {
        let identity = Identity::current()?;
        let coordinator = Arc::new(Coordinator::capture(&identity)?);
        Ok(Self {
            identity,
            coordinator,
            current: None,
        })
    }
    pub fn prepare(&mut self) -> Result<Ticket> {
        if native::exited(self.coordinator.handle.as_raw_handle())? {
            bail!("EXECUTION_FENCE_COORDINATOR_EXITED");
        }
        if let Some(current) = &self.current {
            if !current.status()?.confirmed || !current.task.is_finished() {
                bail!("EXECUTION_FENCE_BUSY");
            }
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
        let job = Arc::new(Job::create()?);
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
