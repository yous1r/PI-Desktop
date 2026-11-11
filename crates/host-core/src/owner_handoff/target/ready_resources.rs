//! Restricted target-mode readiness. Publishes Ready only for the claimed
//! generation after re-reading the retained claim authority and durable
//! records inside the commit guard. This slice performs no scheduler, AppState,
//! recovery replay or turn/tool restoration; a later serving slice must extend
//! the initialization behind the same trait before admission can open.
use super::{
    bootstrap::Authority,
    preparation::RegisteredGeneration,
    protocol::ReadyRequest,
    ready::{EventStream, ReadyOutcome, ReadyResources, ReadyTarget},
};
use crate::owner_handoff::{
    model::{self, Build, Generation, Owner, Phase, VERSION},
    repository::{read_generation, read_transfer, Journal},
};
use anyhow::{bail, Result};
use std::sync::Arc;

/// Every readiness fact this restricted target can prove. All values come from
/// the retained claim authority or the exact durable generation; no wire flag,
/// cached success or permissive default is accepted.
#[derive(Clone)]
pub(crate) struct ReadyFacts {
    pub(crate) owner: Owner,
    pub(crate) generation: Generation,
    pub(crate) build: Build,
    pub(crate) capability_hash: String,
    pub(crate) event_epoch: String,
    pub(crate) ready_version: u32,
}

impl ReadyFacts {
    fn from_claim(
        authority: &Authority,
        generation: Generation,
        build: Build,
        event_epoch: String,
    ) -> Result<Self> {
        let facts = Self {
            owner: authority.owner.clone(),
            generation,
            build,
            capability_hash: authority.claimed.capability_hash.clone(),
            event_epoch,
            ready_version: VERSION,
        };
        facts.validate()?;
        Ok(facts)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        self.owner.validate()?;
        self.generation.validate()?;
        self.build.validate()?;
        model::hash(&self.capability_hash)?;
        if self.ready_version != VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        if self.generation.owner_epoch != self.owner.epoch
            || self.generation.profile != self.owner.profile
        {
            bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
        }
        EventStream {
            epoch: &self.event_epoch,
            protocol_version: crate::state::PROTOCOL_VERSION,
        }
        .validate()?;
        Ok(())
    }
}

/// `ReadyResources` implementation for the restricted target. `event_stream`
/// and `with_ready` are the only paths that can reach `ReadyTarget::commit`;
/// both re-verify the retained authority and durable generation first.
pub(crate) struct TargetReadyResources {
    authority: Arc<Authority>,
    facts: ReadyFacts,
}

impl TargetReadyResources {
    pub(crate) fn new(authority: Arc<Authority>, facts: ReadyFacts) -> Result<Self> {
        facts.validate()?;
        let claimed = &authority.claimed;
        if facts.build != claimed.target_build {
            bail!("HANDOFF_INCOMPATIBLE_BUILD");
        }
        if claimed.phase != Phase::TargetClaimed {
            bail!("HANDOFF_TARGET_NOT_CLAIMED");
        }
        if claimed.target_epoch != facts.owner.epoch
            || claimed.profile != facts.owner.profile
            || claimed.capability_hash != facts.capability_hash
        {
            bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
        }
        Ok(Self { authority, facts })
    }

    fn verify(&self, owner: &Owner, generation: &Generation) -> Result<()> {
        if owner != &self.facts.owner || generation != &self.facts.generation {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        self.facts.validate()?;
        let journal = Journal::open(&self.authority.path, true)?;
        // Current transfer, owner activity and exact claimed revision.
        super::journal::require_claimed(&journal.conn, &self.authority)?;
        let exists: bool = journal.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_generations WHERE id=?1)",
            [&self.facts.generation.id],
            |row| row.get(0),
        )?;
        if !exists {
            bail!("HANDOFF_TARGET_NOT_INITIALIZED");
        }
        let stored = read_generation(&journal.conn, &self.facts.generation.id)?;
        if stored != self.facts.generation {
            bail!("HANDOFF_GENERATION_CHANGED");
        }
        let closed: bool = journal.conn.query_row(
            "SELECT closed FROM execution_generations WHERE id=?1",
            [&self.facts.generation.id],
            |row| row.get(0),
        )?;
        if closed {
            bail!("HANDOFF_GENERATION_CLOSED");
        }
        let current = read_transfer(&journal.conn, &self.authority.claimed.id)?;
        if current != self.authority.claimed {
            bail!("HANDOFF_STALE_REVISION");
        }
        if current.capability_hash != self.facts.capability_hash
            || current.target_build != self.facts.build
        {
            bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
        }
        Ok(())
    }
}

impl ReadyResources for TargetReadyResources {
    fn event_stream(&self) -> Result<EventStream<'_>> {
        let stream = EventStream {
            epoch: &self.facts.event_epoch,
            protocol_version: crate::state::PROTOCOL_VERSION,
        };
        stream.validate()?;
        if self.facts.ready_version != VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        Ok(stream)
    }

    fn with_ready<T>(
        &self,
        owner: &Owner,
        generation: &Generation,
        commit: impl FnOnce(EventStream<'_>) -> Result<T>,
    ) -> Result<T> {
        self.verify(owner, generation)?;
        commit(self.event_stream()?)
    }
}

/// Restricted target initialization: registers exactly one unrooted durable
/// generation for the claimed owner and builds the matching provider. This is
/// durable registration evidence only; it proves no native sidecar is running
/// and grants no execution.
pub(crate) struct TargetReadyPublisher {
    bootstrap: super::bootstrap::TargetBootstrap,
    build: Build,
    event_epoch: String,
}

impl TargetReadyPublisher {
    pub(crate) fn new(
        bootstrap: super::bootstrap::TargetBootstrap,
        build: Build,
        event_epoch: String,
    ) -> Result<Self> {
        build.validate()?;
        if build != bootstrap.record().target_build {
            bail!("HANDOFF_INCOMPATIBLE_BUILD");
        }
        Ok(Self {
            bootstrap,
            build,
            event_epoch,
        })
    }

    /// Bind a generation whose Job/pipe/root registration already succeeded to
    /// the Ready transaction with the live hub event epoch from the target
    /// protocol. No second generation is created here.
    pub(crate) fn into_ready_target(
        self,
        registered: RegisteredGeneration,
        request_id: &str,
    ) -> Result<ReadyTarget<TargetReadyResources>> {
        let facts = ReadyFacts::from_claim(
            &self.bootstrap.authority,
            registered.record().clone(),
            self.build,
            self.event_epoch,
        )?;
        let resources = TargetReadyResources::new(Arc::clone(&self.bootstrap.authority), facts)?;
        ReadyTarget::new(registered, resources, request_id)
    }
}
