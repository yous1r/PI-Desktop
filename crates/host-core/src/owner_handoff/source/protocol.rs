//! Versioned running-source wire contract. Reads stay side-effect free; the
//! mutation commands are only the transport envelope. Admission closure,
//! durable journal transitions, native closure, receipts and idempotency
//! remain the source service's responsibility, so accepting a well-formed
//! mutation request never implies that the transfer advanced.
use super::super::model::{self, Build, Phase, Transfer, VERSION};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "owner-transfer";
/// Mutation exchanges may close admission, stop registered resources and
/// commit a durable receipt, so they get their own transport budget; the
/// two-second query budget stays with the native listener owner.
pub const MUTATION_TIMEOUT_MS: u64 = 45_000;
/// JavaScript safe-integer bound shared with every H0 revision field.
const REVISION_MAX: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Preflight {
        version: u32,
        request_id: String,
        source_epoch: String,
        target_build: Build,
    },
    Prepare {
        version: u32,
        request_id: String,
        source_epoch: String,
        transfer_id: String,
        expected_revision: u64,
        target_epoch: String,
        capability_hash: String,
        target_build: Build,
    },
    Status {
        version: u32,
        request_id: String,
        source_epoch: String,
        transfer_id: String,
    },
    Cancel {
        version: u32,
        request_id: String,
        source_epoch: String,
        transfer_id: String,
        expected_revision: u64,
    },
    Fence {
        version: u32,
        request_id: String,
        source_epoch: String,
        transfer_id: String,
        expected_revision: u64,
    },
    Release {
        version: u32,
        request_id: String,
        source_epoch: String,
        transfer_id: String,
        expected_revision: u64,
    },
}
impl Command {
    pub fn identity(&self) -> (u32, &str, &str) {
        match self {
            Self::Preflight {
                version,
                request_id,
                source_epoch,
                ..
            }
            | Self::Prepare {
                version,
                request_id,
                source_epoch,
                ..
            }
            | Self::Status {
                version,
                request_id,
                source_epoch,
                ..
            }
            | Self::Cancel {
                version,
                request_id,
                source_epoch,
                ..
            }
            | Self::Fence {
                version,
                request_id,
                source_epoch,
                ..
            }
            | Self::Release {
                version,
                request_id,
                source_epoch,
                ..
            } => (*version, request_id, source_epoch),
        }
    }
    pub fn transfer_id(&self) -> Option<&str> {
        match self {
            Self::Preflight { .. } => None,
            Self::Prepare { transfer_id, .. }
            | Self::Status { transfer_id, .. }
            | Self::Cancel { transfer_id, .. }
            | Self::Fence { transfer_id, .. }
            | Self::Release { transfer_id, .. } => Some(transfer_id),
        }
    }
    /// Only these commands close admission or advance the durable journal, so
    /// only they may use the mutation transport budget.
    pub fn is_mutation(&self) -> bool {
        matches!(
            self,
            Self::Prepare { .. } | Self::Cancel { .. } | Self::Fence { .. } | Self::Release { .. }
        )
    }
    /// Durable phase a fresh receipt must show. `None` means any valid phase;
    /// `status` observes whatever phase the journal currently holds.
    pub fn expected_phase(&self) -> Option<Phase> {
        match self {
            Self::Prepare { .. } => Some(Phase::Prepared),
            Self::Cancel { .. } => Some(Phase::Cancelled),
            Self::Fence { .. } => Some(Phase::SourceFenced),
            Self::Release { .. } => Some(Phase::ReleasePending),
            Self::Status { .. } | Self::Preflight { .. } => None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        let (version, id, epoch) = self.identity();
        if version != VERSION {
            bail!("HANDOFF_INVALID_REQUEST");
        }
        model::uuid(id)?;
        model::uuid(epoch)?;
        match self {
            Self::Preflight { target_build, .. } => target_build.validate(),
            Self::Status { transfer_id, .. } => model::uuid(transfer_id),
            Self::Prepare {
                transfer_id,
                expected_revision,
                target_epoch,
                capability_hash,
                target_build,
                ..
            } => {
                model::uuid(transfer_id)?;
                model::uuid(target_epoch)?;
                model::hash(capability_hash)?;
                target_build.validate()?;
                if *expected_revision != 0 || target_epoch.as_str() == epoch {
                    bail!("HANDOFF_INVALID_REQUEST");
                }
                Ok(())
            }
            Self::Cancel {
                transfer_id,
                expected_revision,
                ..
            }
            | Self::Fence {
                transfer_id,
                expected_revision,
                ..
            }
            | Self::Release {
                transfer_id,
                expected_revision,
                ..
            } => {
                model::uuid(transfer_id)?;
                if !(1..=REVISION_MAX).contains(expected_revision) {
                    bail!("HANDOFF_INVALID_REQUEST");
                }
                Ok(())
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol: String,
    pub version: u32,
    pub command: Command,
}
impl Request {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > model::MAX_RECORD_BYTES {
            bail!("HANDOFF_INVALID_REQUEST");
        }
        let request: Self = serde_json::from_slice(bytes)?;
        request.validate()?;
        Ok(request)
    }
    pub fn validate(&self) -> Result<()> {
        if self.protocol != PROTOCOL || self.version != VERSION {
            bail!("HANDOFF_INVALID_REQUEST");
        }
        self.command.validate()?;
        model::encode(self)?;
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preflight {
    pub version: u32,
    pub request_id: String,
    pub source_epoch: String,
    pub profile_id: String,
    pub source_build: Build,
    pub target_build: Build,
    pub requires_idle: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Body {
    Preflight(Preflight),
    Record { version: u32, record: Transfer },
    Failure { version: u32, error: Failure },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub code: Code,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Code {
    #[serde(rename = "HANDOFF_UNAVAILABLE")]
    Unavailable,
    #[serde(rename = "HANDOFF_OWNER_CHANGED")]
    OwnerChanged,
    #[serde(rename = "HANDOFF_INCOMPATIBLE_BUILD")]
    IncompatibleBuild,
    #[serde(rename = "HANDOFF_BUSY")]
    Busy,
    #[serde(rename = "HANDOFF_REQUEST_CONFLICT")]
    RequestConflict,
    #[serde(rename = "HANDOFF_STALE_REVISION")]
    StaleRevision,
    #[serde(rename = "HANDOFF_INVALID_TRANSITION")]
    InvalidTransition,
    #[serde(rename = "HANDOFF_CANCEL_UNCONFIRMED")]
    CancelUnconfirmed,
    #[serde(rename = "HANDOFF_FENCE_UNCONFIRMED")]
    FenceUnconfirmed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    pub protocol: String,
    pub version: u32,
    pub request_id: String,
    pub source_epoch: String,
    pub profile_id: String,
    pub result: Body,
}
impl Reply {
    pub fn new(request: &Request, profile: &str, result: Body) -> Self {
        let (_, id, epoch) = request.command.identity();
        Self {
            protocol: PROTOCOL.into(),
            version: VERSION,
            request_id: id.into(),
            source_epoch: epoch.into(),
            profile_id: profile.into(),
            result,
        }
    }
    pub fn validate(&self, request: &Request, profile: &str) -> Result<()> {
        request.validate()?;
        model::hash(profile)?;
        model::encode(self)?;
        let (_, id, epoch) = request.command.identity();
        if self.protocol != PROTOCOL
            || self.version != VERSION
            || self.request_id != id
            || self.source_epoch != epoch
            || self.profile_id != profile
        {
            bail!("HANDOFF_INVALID_RESPONSE");
        }
        match (&self.result, &request.command) {
            (
                Body::Failure {
                    version: VERSION, ..
                },
                _,
            ) => Ok(()),
            (Body::Preflight(value), Command::Preflight { target_build, .. }) => {
                value.source_build.validate()?;
                value.target_build.validate()?;
                if value.version != VERSION
                    || value.request_id != id
                    || value.source_epoch != epoch
                    || value.profile_id != profile
                    || !value.requires_idle
                    || value.target_build != *target_build
                {
                    bail!("HANDOFF_INVALID_RESPONSE");
                }
                Ok(())
            }
            (
                Body::Record {
                    version: VERSION,
                    record,
                },
                command,
            ) => {
                let Some(transfer_id) = command.transfer_id() else {
                    bail!("HANDOFF_INVALID_RESPONSE");
                };
                record.validate()?;
                if record.id.as_str() != transfer_id
                    || record.source_epoch != epoch
                    || record.profile != profile
                {
                    bail!("HANDOFF_INVALID_RESPONSE");
                }
                // Prepare pins the reserved successor exactly; the later
                // transitions keep the same transfer, source and profile.
                if let Command::Prepare {
                    target_epoch,
                    capability_hash,
                    target_build,
                    ..
                } = command
                {
                    if record.target_epoch != *target_epoch
                        || record.capability_hash != *capability_hash
                        || record.target_build != *target_build
                    {
                        bail!("HANDOFF_INVALID_RESPONSE");
                    }
                }
                // A replayed historic receipt may carry an older revision than
                // the caller's expectation, so revision progression stays with
                // the source service; only the operation's durable phase is
                // bound here.
                if command
                    .expected_phase()
                    .is_some_and(|phase| record.phase != phase)
                {
                    bail!("HANDOFF_INVALID_RESPONSE");
                }
                Ok(())
            }
            _ => bail!("HANDOFF_INVALID_RESPONSE"),
        }
    }
}
