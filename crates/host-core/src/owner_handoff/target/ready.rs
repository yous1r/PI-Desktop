//! Readiness retains original resources; it never accepts wire proof flags.
use super::{journal::ReadyIntent, preparation::RegisteredGeneration};
use crate::owner_handoff::{
    model::{self, Generation, Owner, Transfer, VERSION},
    repository::Journal,
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy)]
pub(crate) struct EventStream<'a> {
    pub(crate) epoch: &'a str,
    pub(crate) protocol_version: u32,
}
impl EventStream<'_> {
    pub(super) fn validate(self) -> Result<()> {
        if self.epoch.is_empty()
            || self.epoch.encode_utf16().count() > 256
            || self.epoch.contains('\0')
            || self.protocol_version != crate::state::PROTOCOL_VERSION
        {
            bail!("HANDOFF_INVALID_READY");
        }
        Ok(())
    }
}

/// Trusted, process-local integration seam. The full serving implementation is
/// owned by the original AppState/recovery completion, closed Rust + Node
/// admission holds, initialized idle sidecar, capability publication and live
/// event stream.
///
/// The restricted `--owner-target` slice supplies a narrower implementation
/// (`ready_resources::TargetReadyResources`) that proves the retained claim
/// authority, exact target generation, build, capability hash, event epoch and
/// ready version. It REQUIRES the generation to have been bound to a real
/// native root by the execution-fence registration join; unrooted generations
/// are refused before any Ready write. Full serving still requires the live
/// hub epoch and the framed serving loop.
///
/// `with_ready` MUST refuse incomplete initialization, uncertainty, disposal or
/// pending work. It must verify the exact current Registry/Lease/Job/root and
/// captured coordinator handles (including creation identity and running Job
/// membership), not merely a durable registration or PID. Keep the existing
/// registry/progress and resource lifecycle guards through `commit`; no await,
/// resource replacement, admission reopening or stop may interleave. Supply
/// the epoch from the retained live event source. Do not implement this with
/// RPC-provided idle/native booleans, status JSON, or cached success flags.
///
/// This seam deliberately has no default implementation or permissive adapter.
/// Native current-pointer checks belong beside Registry's private resources.
pub(crate) trait ReadyResources {
    fn event_stream(&self) -> Result<EventStream<'_>>;
    fn with_ready<T>(
        &self,
        owner: &Owner,
        generation: &Generation,
        commit: impl FnOnce(EventStream<'_>) -> Result<T>,
    ) -> Result<T>;
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadyPublication {
    pub version: u32,
    pub transfer_id: String,
    pub profile_id: String,
    pub owner_epoch: String,
    pub record_revision: i64,
    pub event_epoch: String,
    pub protocol_version: u32,
    pub snapshot_required: bool,
}

/// A committed/historical result, NEVER an admission capability. A lost output
/// or a later resource failure cannot roll the transaction back. Consumers must
/// reconcile this record and freshly validate retained resources before opening
/// their original admission holds; a different process cannot adopt it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadyOutcome {
    pub record: Transfer,
    pub ready: ReadyPublication,
}

pub(crate) struct ReadyTarget<R: ReadyResources> {
    resources: R,
    intent: ReadyIntent,
    // Resource teardown precedes release of this retained directory guard.
    registered: RegisteredGeneration,
}
impl<R: ReadyResources> ReadyTarget<R> {
    /// Capture once. The request ID is retained across an ambiguous output;
    /// creating another ReadyTarget is not an automatic retry mechanism.
    pub(crate) fn new(
        registered: RegisteredGeneration,
        resources: R,
        request_id: &str,
    ) -> Result<Self> {
        let stream = resources.event_stream()?;
        stream.validate()?;
        let intent = ReadyIntent {
            claimed: registered.authority.claimed.clone(),
            request_id: request_id.into(),
            owner: registered.authority.owner.clone(),
            generation: registered.generation.clone(),
            event_epoch: stream.epoch.into(),
            protocol_version: stream.protocol_version,
        };
        intent.validate()?;
        Ok(Self {
            registered,
            resources,
            intent,
        })
    }

    pub(crate) fn commit(&self) -> Result<ReadyOutcome> {
        let authority = &self.registered.authority;
        // Historical receipt reads do not run initialization again. Returning
        // this result does not certify the resources are currently available.
        if let Some(result) =
            Journal::open(&authority.path, true)?.target_ready_receipt(&self.intent)?
        {
            return Ok(result);
        }
        self.resources
            .with_ready(&authority.owner, &self.registered.generation, |stream| {
                stream.validate()?;
                if stream.epoch != self.intent.event_epoch
                    || stream.protocol_version != self.intent.protocol_version
                {
                    bail!("HANDOFF_EVENT_STREAM_CHANGED");
                }
                Journal::open(&authority.path, false)?.target_ready(authority, &self.intent)
            })
    }

    /// Only the retained original resource owner may perform subsequent
    /// publication/attachment. This accessor itself never reopens admission.
    pub(crate) fn resources(&self) -> &R {
        &self.resources
    }
}

pub(super) fn outcome(record: Transfer, intent: &ReadyIntent) -> Result<ReadyOutcome> {
    let ready = ReadyPublication {
        version: VERSION,
        transfer_id: record.id.clone(),
        profile_id: record.profile.clone(),
        owner_epoch: record.target_epoch.clone(),
        record_revision: record.revision,
        event_epoch: intent.event_epoch.clone(),
        protocol_version: intent.protocol_version,
        snapshot_required: true,
    };
    let result = ReadyOutcome { record, ready };
    model::encode(&result)?;
    Ok(result)
}
