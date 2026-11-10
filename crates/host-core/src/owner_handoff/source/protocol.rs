//! Versioned running-source queries. Mutations remain unavailable until the
//! source admission and durable transition workflow is implemented.
use super::super::model::{self, Build, Transfer, VERSION};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "owner-transfer";
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
    Status {
        version: u32,
        request_id: String,
        source_epoch: String,
        transfer_id: String,
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
            | Self::Status {
                version,
                request_id,
                source_epoch,
                ..
            } => (*version, request_id, source_epoch),
        }
    }
    fn validate(&self) -> Result<()> {
        let (version, id, epoch) = self.identity();
        if version != VERSION {
            bail!("HANDOFF_INVALID_REQUEST");
        }
        model::uuid(id)?;
        model::uuid(epoch)?;
        match self {
            Self::Preflight { target_build, .. } => target_build.validate(),
            Self::Status { transfer_id, .. } => model::uuid(transfer_id),
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
                Command::Status { transfer_id, .. },
            ) => {
                record.validate()?;
                if record.id != *transfer_id
                    || record.source_epoch != epoch
                    || record.profile != profile
                {
                    bail!("HANDOFF_INVALID_RESPONSE");
                }
                Ok(())
            }
            _ => bail!("HANDOFF_INVALID_RESPONSE"),
        }
    }
}
