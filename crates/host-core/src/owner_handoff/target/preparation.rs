//! Narrow capability for exactly one fenced, idle target sidecar. Ordinary
//! Journal::register_generation/bind_root continue refusing target_claimed.
use super::bootstrap::{Authority, TargetBootstrap};
use super::journal::require_claimed;
use crate::owner_handoff::{
    model::{self, Generation, Owner, ProcessIdentity},
    repository::{read_generation, Journal},
};
use anyhow::{bail, Result};
use rusqlite::params;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct PreparedGeneration {
    authority: Arc<Authority>,
    generation: Generation,
}

/// Constructed only by the original registration rendezvous. This is durable
/// registration evidence, not proof the native Job/runner is still running.
pub(crate) struct RegisteredGeneration {
    pub(super) authority: Arc<Authority>,
    pub(super) generation: Generation,
}

impl TargetBootstrap {
    /// Registry integration creates the protected Job/pipe first, then calls
    /// this before returning its ticket. Keep normal admission closed and allow
    /// only idle sidecar initialization (no plugins, queue/schedule dispatch,
    /// model/tool calls or restoration of external execution resources).
    pub(crate) fn prepare_generation(&self, generation: Generation) -> Result<PreparedGeneration> {
        generation.validate()?;
        if generation.owner_epoch != self.owner().epoch
            || generation.profile != self.owner().profile
            || generation.root.is_some()
        {
            bail!("HANDOFF_INVALID_REGISTRATION");
        }
        let mut journal = Journal::open(&self.authority.path, false)?;
        journal.transaction(|conn| {
            require_claimed(conn, &self.authority)?;
            // A failed initialization must be recovered explicitly. Closing a
            // failed generation never grants this capability a second launch.
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_generations WHERE owner_epoch=?1)",
                [&self.owner().epoch],
                |row| row.get(0),
            )?;
            if exists {
                bail!("HANDOFF_TARGET_ALREADY_INITIALIZING");
            }
            conn.execute(
                "INSERT INTO execution_generations(id,owner_epoch,record_json) VALUES(?1,?2,?3)",
                params![
                    generation.id,
                    generation.owner_epoch,
                    model::encode(&generation)?
                ],
            )?;
            Ok(())
        })?;
        Ok(PreparedGeneration {
            authority: self.authority.clone(),
            generation,
        })
    }
}

impl PreparedGeneration {
    pub(crate) fn owner(&self) -> &Owner {
        &self.authority.owner
    }
    pub(crate) fn record(&self) -> &Generation {
        &self.generation
    }
    /// Ready-only registration for the first restricted target slice. No
    /// sidecar/Job root exists yet, so this returns the exact durable
    /// generation without a native root. A later serving slice must replace
    /// this with the existing `bind_root` path (real runner identity, Job
    /// membership and registry progress lock) before exposing execution.
    pub(crate) fn register_unrooted(self) -> Result<RegisteredGeneration> {
        let mut journal = Journal::open(&self.authority.path, false)?;
        journal.transaction(|conn| {
            require_claimed(conn, &self.authority)?;
            let stored = read_generation(conn, &self.generation.id)?;
            if stored != self.generation {
                bail!("HANDOFF_GENERATION_CHANGED");
            }
            let closed: bool = conn.query_row(
                "SELECT closed FROM execution_generations WHERE id=?1",
                [&self.generation.id],
                |row| row.get(0),
            )?;
            if closed {
                bail!("HANDOFF_GENERATION_CLOSED");
            }
            Ok(())
        })?;
        Ok(RegisteredGeneration {
            authority: self.authority,
            generation: self.generation,
        })
    }
    /// Call only with the authenticated original runner's native identity,
    /// after the existing SID/image/parent/creation/capability checks. Preserve
    /// the Registry progress lock through root binding and Job assignment.
    /// Never map an RPC-provided PID/identity directly to this method.
    pub(crate) fn bind_root(&self, root: &ProcessIdentity) -> Result<RegisteredGeneration> {
        root.validate()?;
        let owner = &self.authority.owner;
        if root.sid != owner.host.sid
            || root.pid == owner.host.pid
            || root.pid == owner.coordinator.pid
        {
            bail!("HANDOFF_INVALID_REGISTRATION");
        }
        let mut bound = self.generation.clone();
        bound.root = Some(root.clone());
        let mut journal = Journal::open(&self.authority.path, false)?;
        journal.transaction(|conn| {
            require_claimed(conn, &self.authority)?;
            let stored = read_generation(conn, &self.generation.id)?;
            if stored != self.generation || stored.root.is_some() {
                bail!("HANDOFF_OWNER_CHANGED");
            }
            if conn.execute(
                "UPDATE execution_generations SET record_json=?1 WHERE id=?2 AND owner_epoch=?3 AND closed=0",
                params![model::encode(&bound)?, bound.id, owner.epoch],
            )? != 1 {
                bail!("HANDOFF_GENERATION_CLOSED");
            }
            Ok(())
        })?;
        Ok(RegisteredGeneration {
            authority: self.authority.clone(),
            generation: bound,
        })
    }
}

impl RegisteredGeneration {
    pub(crate) fn owner(&self) -> &Owner {
        &self.authority.owner
    }
    pub(crate) fn record(&self) -> &Generation {
        &self.generation
    }
}
