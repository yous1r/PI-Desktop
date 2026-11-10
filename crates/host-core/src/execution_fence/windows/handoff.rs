//! Immutable native binding to one running original-owner generation.
//!
//! A binding keeps the exact coordinator, lease, job and journal objects that
//! were captured while the generation was running, together with the exact
//! durable records that registered it. Every later decision compares those
//! retained handles and records; the owner is never looked up again by epoch,
//! generation id or pid, so a replacement can never be adopted.
use super::{native, Coordinator, Lease, Registry};
use crate::owner_handoff::{
    model::{self, Generation, Owner, ProcessIdentity},
    native::record,
    repository::Journal,
};
use anyhow::{bail, Context, Result};
use std::os::windows::io::AsRawHandle;
use std::sync::{Arc, Mutex, MutexGuard};

/// Bounded generation pages walked before authority is refused.
const AUTHORITY_PAGES: usize = 64;

/// Original-owner source binding, retained for the whole fence lifetime.
#[derive(Clone)]
pub struct SourceOwner {
    owner: Owner,
    registration: Generation,
    root: ProcessIdentity,
    coordinator: Arc<Coordinator>,
    lease: Arc<Lease>,
    journal: Arc<Mutex<Journal>>,
}
impl SourceOwner {
    pub fn owner(&self) -> &Owner {
        &self.owner
    }
    pub fn generation(&self) -> &str {
        &self.registration.id
    }
    /// Exact original journal handle for the caller's atomic transaction.
    pub fn journal(&self) -> Arc<Mutex<Journal>> {
        Arc::clone(&self.journal)
    }
    /// Original owner, profile, root and generation, verified through the
    /// retained native handles and the exact journal this binding captured.
    /// The original generation stays authoritative after closure; a closed
    /// record is not a replacement.
    pub fn check_authority(&self) -> Result<()> {
        self.owner.validate()?;
        self.registration.validate()?;
        if self.registration.owner_epoch != self.owner.epoch
            || self.registration.profile != self.owner.profile
            || self.registration.root.as_ref() != Some(&self.root)
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        coordinator_live(&self.coordinator)?;
        // The captured root peer must still be the same process object; exit is
        // allowed here because a stopped original generation keeps authority.
        self.retained_root_exited()?;
        let journal = self.journal_guard()?;
        // Original owner and profile, still admitted, read from that journal.
        journal.inspect_source(&self.owner, None)?;
        if find_generation(&journal, &self.owner.epoch, &self.registration.id)? != self.registration
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        Ok(())
    }
    /// Stops the exact retained lease and confirms only observed effects: the
    /// recorded root handle signalled exit, the owned job holds no process and
    /// the registration task settled. A successful request or a delivered kill
    /// never confirms exit, and the durable generation is not closed here.
    pub async fn stop(&self, timeout_ms: u64) -> Result<()> {
        self.check_authority()?;
        let status = self.lease.stop(timeout_ms).await?;
        if status.generation != self.registration.id {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        if !status.confirmed
            || !self.lease.task.is_finished()
            || !self.retained_root_exited()?
            || self.lease.job.active()? != 0
        {
            bail!("EXECUTION_FENCE_STOP_UNCONFIRMED");
        }
        coordinator_live(&self.coordinator)?;
        let journal = self.journal_guard()?;
        // Either the open or the caller-closed original record, never another.
        if find_generation(&journal, &self.owner.epoch, &self.registration.id)? != self.registration
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        Ok(())
    }
    fn journal_guard(&self) -> Result<MutexGuard<'_, Journal>> {
        self.journal
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))
    }
    /// Whether the exact retained root handle has signalled exit. No pid is
    /// reopened; the captured identity is compared before the wait.
    fn retained_root_exited(&self) -> Result<bool> {
        let progress = self
            .lease
            .progress
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_NATIVE_STATE_UNAVAILABLE"))?;
        let retained = progress
            .root
            .as_ref()
            .context("EXECUTION_FENCE_ROOT_UNCONFIRMED")?;
        if record(retained.pid, &retained.identity) != self.root {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        native::exited(retained.handle.as_raw_handle())
    }
}
impl Registry {
    /// Binds the running, root-bound current generation to its exact native and
    /// durable objects. A live original coordinator and the exact original
    /// journal record are required; nothing is created by this call.
    pub fn capture_source(&self) -> Result<SourceOwner> {
        let lease = self
            .current
            .as_ref()
            .context("EXECUTION_FENCE_STALE")?
            .clone();
        let journal = self
            .journal
            .as_ref()
            .context("HANDOFF_OWNER_NOT_REGISTERED")?
            .clone();
        coordinator_live(&self.coordinator)?;
        // Progress is held across the journal read so a concurrent stop cannot
        // interleave with the registration proof. Lock order: progress, journal.
        let progress = lease
            .progress
            .try_lock()
            .map_err(|_| anyhow::anyhow!("HANDOFF_NATIVE_STATE_UNAVAILABLE"))?;
        if progress.state != "running" || lease.task.is_finished() {
            bail!("EXECUTION_FENCE_STALE");
        }
        let root = progress
            .root
            .as_ref()
            .map(|peer| record(peer.pid, &peer.identity))
            .context("EXECUTION_FENCE_STALE")?;
        let registration = {
            let journal = journal
                .try_lock()
                .map_err(|_| anyhow::anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?;
            let registration = find_generation(&journal, &self.owner.epoch, &lease.generation)?;
            // Still open, unretired and rooted at the process this lease bound.
            journal.inspect_generation(&self.owner, &lease.generation, Some(&root))?;
            registration
        };
        if registration.root.as_ref() != Some(&root) {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        Ok(SourceOwner {
            owner: self.owner.clone(),
            registration,
            root,
            coordinator: Arc::clone(&self.coordinator),
            lease: Arc::clone(&lease),
            journal,
        })
    }
    /// Verifies a binding still names this registry's exact original objects and
    /// keeps original-owner authority. A replacement lease, journal, coordinator
    /// or owner is refused instead of adopted.
    pub fn matches_source(&self, binding: &SourceOwner) -> Result<()> {
        if self.owner != binding.owner
            || !Arc::ptr_eq(&self.coordinator, &binding.coordinator)
            || !Arc::ptr_eq(
                self.journal
                    .as_ref()
                    .context("HANDOFF_OWNER_NOT_REGISTERED")?,
                &binding.journal,
            )
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let current = self.current.as_ref().context("EXECUTION_FENCE_STALE")?;
        if !Arc::ptr_eq(current, &binding.lease) || current.generation != binding.generation() {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        coordinator_live(&self.coordinator)?;
        binding.check_authority()
    }
}
/// The retained coordinator must still be the live original parent.
fn coordinator_live(coordinator: &Coordinator) -> Result<()> {
    if native::exited(coordinator.handle.as_raw_handle())? {
        bail!("HANDOFF_OWNER_CHANGED");
    }
    Ok(())
}
/// Exact durable record by bounded generation paging. Closed rows are read as
/// well, so an original generation stays recognisable after the caller's
/// closure; a missing record is never treated as authority.
fn find_generation(journal: &Journal, epoch: &str, id: &str) -> Result<Generation> {
    model::uuid(id)?;
    let mut after = 0_i64;
    for _ in 0..AUTHORITY_PAGES {
        let page = journal.generations(epoch, after)?;
        let full = page.len() == model::PAGE_SIZE;
        for (sequence, registration) in page {
            after = sequence;
            if registration.id == id {
                return Ok(registration);
            }
        }
        if !full {
            break;
        }
    }
    bail!("HANDOFF_GENERATION_MISSING")
}

#[cfg(test)]
mod tests;
