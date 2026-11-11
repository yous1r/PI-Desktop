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

    fn allows_unrooted_generation(&self) -> bool {
        true
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
    pub(crate) fn new(bootstrap: super::bootstrap::TargetBootstrap, build: Build) -> Result<Self> {
        build.validate()?;
        if build != bootstrap.record().target_build {
            bail!("HANDOFF_INCOMPATIBLE_BUILD");
        }
        Ok(Self {
            bootstrap,
            build,
            event_epoch: uuid::Uuid::new_v4().to_string(),
        })
    }

    pub(crate) fn prepare(&self) -> Result<PreparedReady<'_>> {
        let owner = self.bootstrap.owner();
        let id = uuid::Uuid::new_v4().to_string();
        let generation = Generation {
            version: VERSION,
            job_name: Generation::job_name(&owner.profile, &owner.epoch, &id),
            id,
            owner_epoch: owner.epoch.clone(),
            profile: owner.profile.clone(),
            root: None,
        };
        let prepared_generation = self.bootstrap.prepare_generation(generation)?;
        let generation_id = prepared_generation.record().id.clone();
        let registered = match prepared_generation.register_unrooted() {
            Ok(registered) => registered,
            Err(error) => {
                close_generation_best_effort(&self.bootstrap.authority.path, &generation_id);
                return Err(error);
            }
        };
        let generation_record = registered.record().clone();
        let mut prepared = PreparedReady {
            bootstrap: &self.bootstrap,
            generation_id,
            registered: Some(registered),
            resources: None,
            committed: false,
        };
        let facts = ReadyFacts::from_claim(
            &self.bootstrap.authority,
            generation_record,
            self.build.clone(),
            self.event_epoch.clone(),
        )?;
        prepared.resources = Some(TargetReadyResources::new(
            Arc::clone(&self.bootstrap.authority),
            facts,
        )?);
        Ok(prepared)
    }
}

/// One-shot Ready attempt. Dropping before commit closes the generation this
/// slice registered, so a failed initialization stays explicitly recoverable
/// and never leaves an open unrooted generation behind.
pub(crate) struct PreparedReady<'a> {
    bootstrap: &'a super::bootstrap::TargetBootstrap,
    generation_id: String,
    registered: Option<RegisteredGeneration>,
    resources: Option<TargetReadyResources>,
    committed: bool,
}

impl PreparedReady<'_> {
    pub(crate) fn commit(mut self, request: &ReadyRequest) -> Result<ReadyOutcome> {
        request.check(self.bootstrap)?;
        let registered = self
            .registered
            .take()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_TARGET_NOT_INITIALIZED"))?;
        let resources = self
            .resources
            .take()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_TARGET_NOT_INITIALIZED"))?;
        let target = ReadyTarget::new(registered, resources, request.request_id())?;
        let outcome = target.commit()?;
        self.committed = true;
        Ok(outcome)
    }
}

impl Drop for PreparedReady<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        close_generation_best_effort(&self.bootstrap.authority.path, &self.generation_id);
    }
}

fn close_generation_best_effort(path: &std::path::Path, generation: &str) {
    match Journal::open(path, false).and_then(|mut journal| journal.close_generation(generation)) {
        Ok(()) => {}
        Err(error) => tracing::error!(%error, "failed to close target ready generation"),
    }
}
