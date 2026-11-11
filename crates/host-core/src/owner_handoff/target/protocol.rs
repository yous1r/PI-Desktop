//! Private launch envelope. The nested command is the committed shared
//! OwnerHandoffBootstrapCommand shape (including its snake_case field names).
use crate::owner_handoff::{
    model::{self, Build, VERSION},
    service::{Command, ContextIdentity},
};
use anyhow::{bail, Result};
use serde::Deserialize;

pub(super) const MAX_REVISION: i64 = 9_007_199_254_740_991;

// Deliberately no Debug/Serialize: this value contains the raw launch capability.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BootstrapRequest {
    version: u32,
    profile_id: String,
    target_build: Build,
    command: Command,
}

impl BootstrapRequest {
    pub(crate) fn parse(frame: &[u8]) -> Result<Self> {
        if frame.is_empty() || frame.len() > model::MAX_RECORD_BYTES {
            bail!("HANDOFF_INVALID_FRAME");
        }
        // Never include serde's error text: an unknown field/value can contain
        // attacker-supplied secrets. Duplicate fields are rejected by serde.
        let request: Self = serde_json::from_slice(frame)
            .map_err(|_| anyhow::anyhow!("HANDOFF_INVALID_REQUEST"))?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<()> {
        if self.version != VERSION {
            bail!("HANDOFF_UNSUPPORTED_VERSION");
        }
        model::hash(&self.profile_id)?;
        self.target_build.validate()?;
        match &self.command {
            Command::Claim {
                version,
                request_id,
                transfer_id,
                source_epoch,
                expected_revision,
                target_epoch,
                capability,
            }
            | Command::Recover {
                version,
                request_id,
                transfer_id,
                source_epoch,
                expected_revision,
                target_epoch,
                capability,
            } => {
                if *version != VERSION {
                    bail!("HANDOFF_UNSUPPORTED_VERSION");
                }
                for value in [
                    request_id,
                    transfer_id,
                    source_epoch,
                    target_epoch,
                    capability,
                ] {
                    // uuid::Error may reproduce its input. Keep this boundary
                    // classified and do not echo the raw capability.
                    model::uuid(value).map_err(|_| anyhow::anyhow!("HANDOFF_INVALID_IDENTITY"))?;
                }
                if source_epoch == target_epoch {
                    bail!("HANDOFF_INVALID_IDENTITY");
                }
                if !(1..=MAX_REVISION).contains(expected_revision) {
                    bail!("HANDOFF_INVALID_REVISION");
                }
            }
            Command::Status { .. } => bail!("HANDOFF_INVALID_REQUEST"),
        }
        Ok(())
    }

    pub(super) fn check_context(&self, context: &ContextIdentity) -> Result<()> {
        self.validate()?;
        context.owner.validate()?;
        context.build.validate()?;
        if self.profile_id != context.owner.profile {
            bail!("HANDOFF_PROFILE_MISMATCH");
        }
        if self.target_build != context.build {
            bail!("HANDOFF_INCOMPATIBLE_BUILD");
        }
        if self.target_epoch() != context.owner.epoch {
            bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
        }
        Ok(())
    }

    pub(super) fn command(&self) -> &Command {
        &self.command
    }
    pub(super) fn is_claim(&self) -> bool {
        matches!(self.command, Command::Claim { .. })
    }
    pub(super) fn transfer_id(&self) -> &str {
        match &self.command {
            Command::Claim { transfer_id, .. }
            | Command::Recover { transfer_id, .. }
            | Command::Status { transfer_id, .. } => transfer_id,
        }
    }
    pub(super) fn target_epoch(&self) -> &str {
        match &self.command {
            Command::Claim { target_epoch, .. } | Command::Recover { target_epoch, .. } => {
                target_epoch
            }
            Command::Status { .. } => unreachable!("validated target request"),
        }
    }
}
