//! Versioned durable ownership records. No raw launch capability is stored here.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const VERSION: u32 = 1;
pub const MAX_RECORD_BYTES: usize = 16 * 1024;
pub const PAGE_SIZE: usize = 100;

pub fn uuid(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value)?;
    if parsed.is_nil() || parsed.to_string() != value {
        bail!("HANDOFF_INVALID_IDENTITY");
    }
    Ok(())
}
pub fn hash(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("HANDOFF_INVALID_DIGEST");
    }
    Ok(())
}
pub fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub created_at: String,
    pub sid: String,
    pub image: String,
}
impl ProcessIdentity {
    pub fn validate(&self) -> Result<()> {
        let created = self.created_at.parse::<u64>()?;
        if self.pid == 0
            || created == 0
            || created.to_string() != self.created_at
            || !self.sid.starts_with("S-1-")
            || self.sid.len() > 184
            || self.image.is_empty()
            || self.image.len() > 8192
            || self.image.contains('\0')
            || self.sid.contains('\0')
        {
            bail!("HANDOFF_INVALID_PROCESS_IDENTITY");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub version: u32,
    pub epoch: String,
    pub profile: String,
    pub host: ProcessIdentity,
    pub coordinator: ProcessIdentity,
}
impl Owner {
    pub fn validate(&self) -> Result<()> {
        if self.version != VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        uuid(&self.epoch)?;
        hash(&self.profile)?;
        self.host.validate()?;
        self.coordinator.validate()?;
        if self.host.sid != self.coordinator.sid || self.host.pid == self.coordinator.pid {
            bail!("HANDOFF_INVALID_OWNER");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Generation {
    pub version: u32,
    pub id: String,
    pub owner_epoch: String,
    pub profile: String,
    pub job_name: String,
    pub root: Option<ProcessIdentity>,
}
impl Generation {
    pub fn job_name(profile: &str, owner: &str, generation: &str) -> String {
        format!(r"Global\pi-execution-v1-{profile}-{owner}-{generation}")
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        uuid(&self.id)?;
        uuid(&self.owner_epoch)?;
        hash(&self.profile)?;
        if self.job_name != Self::job_name(&self.profile, &self.owner_epoch, &self.id) {
            bail!("HANDOFF_INVALID_CONTAINMENT");
        }
        if let Some(root) = &self.root {
            root.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Prepared,
    SourceFencing,
    SourceFenced,
    ReleasePending,
    TargetClaimed,
    Ready,
    Cancelled,
}
impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::SourceFencing => "source_fencing",
            Self::SourceFenced => "source_fenced",
            Self::ReleasePending => "release_pending",
            Self::TargetClaimed => "target_claimed",
            Self::Ready => "ready",
            Self::Cancelled => "cancelled",
        }
    }
    #[cfg(test)]
    pub fn can_advance(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Prepared, Self::SourceFencing | Self::Cancelled)
                | (Self::SourceFencing, Self::SourceFenced)
                | (Self::SourceFenced, Self::ReleasePending)
                | (Self::TargetClaimed, Self::Ready)
        )
    }
    pub fn terminal(self) -> bool {
        matches!(self, Self::Ready | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Build {
    pub sha256: String,
    pub schema: u32,
    pub protocol: u32,
}
impl Build {
    pub fn validate(&self) -> Result<()> {
        hash(&self.sha256)?;
        if self.schema != crate::db::SCHEMA_VERSION as u32 || self.protocol != VERSION {
            bail!("HANDOFF_INCOMPATIBLE_BUILD");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transfer {
    pub version: u32,
    pub id: String,
    pub profile: String,
    pub source_epoch: String,
    pub target_epoch: String,
    pub source_build: Build,
    pub target_build: Build,
    pub requester: ProcessIdentity,
    pub capability_hash: String,
    pub revision: i64,
    pub phase: Phase,
    pub recovery_attempt: u32,
    pub last_failure: Option<String>,
}
impl Transfer {
    pub fn validate(&self) -> Result<()> {
        if self.version != VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        uuid(&self.id)?;
        uuid(&self.source_epoch)?;
        uuid(&self.target_epoch)?;
        hash(&self.profile)?;
        hash(&self.capability_hash)?;
        self.source_build.validate()?;
        self.target_build.validate()?;
        self.requester.validate()?;
        if self.source_epoch == self.target_epoch
            || !(1..=9_007_199_254_740_991).contains(&self.revision)
            || self.last_failure.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 128
                    || !value.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
        {
            bail!("HANDOFF_INVALID_TRANSFER");
        }
        Ok(())
    }
}

pub fn encode<T: Serialize>(value: &T) -> Result<String> {
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > MAX_RECORD_BYTES {
        bail!("HANDOFF_RECORD_TOO_LARGE");
    }
    Ok(encoded)
}
pub fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    if value.len() > MAX_RECORD_BYTES {
        bail!("HANDOFF_RECORD_TOO_LARGE");
    }
    Ok(serde_json::from_str(value)?)
}
