//! Private launch envelope. The nested command is the committed shared
//! OwnerHandoffBootstrapCommand shape (including its snake_case field names).
use super::ready::ReadyOutcome;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum ReadyOperation {
    Ready,
}

/// Second and final command on the restricted channel. It carries only the
/// identity of the claim and one request ID; every readiness fact is read from
/// the retained authority and journal by the target provider.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadyRequest {
    version: u32,
    operation: ReadyOperation,
    request_id: String,
    transfer_id: String,
    target_epoch: String,
    expected_revision: i64,
}

impl ReadyRequest {
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
        match self.operation {
            ReadyOperation::Ready => {}
        }
        for value in [&self.request_id, &self.transfer_id, &self.target_epoch] {
            model::uuid(value).map_err(|_| anyhow::anyhow!("HANDOFF_INVALID_IDENTITY"))?;
        }
        if !(1..=MAX_REVISION).contains(&self.expected_revision) {
            bail!("HANDOFF_INVALID_REVISION");
        }
        Ok(())
    }

    /// Bind the command to the exact committed claim this process still holds.
    pub(super) fn check(&self, bootstrap: &super::bootstrap::TargetBootstrap) -> Result<()> {
        self.validate()?;
        if self.transfer_id != bootstrap.record().id || self.target_epoch != bootstrap.owner().epoch
        {
            bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
        }
        if self.expected_revision != bootstrap.record().revision {
            bail!("HANDOFF_STALE_REVISION");
        }
        Ok(())
    }

    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }
}

/// Bounded success frame consumed by the Node supervisor. The nested outcome
/// is the same `ReadyOutcome` serialized by the journal receipt path.
pub(super) fn ready_reply(outcome: &ReadyOutcome) -> Result<Vec<u8>> {
    Ok(model::encode(&serde_json::json!({"version": VERSION, "ready": outcome}))?.into_bytes())
}

/// Bounded classified refusal sent before the target process exits. The code
/// vocabulary is fixed; incidental text, paths and capabilities never leave.
pub(super) fn ready_error_reply(error: &anyhow::Error) -> Result<Vec<u8>> {
    let message = error.to_string();
    let code = if message.starts_with("HANDOFF_")
        && message.len() <= 128
        && message
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        message
    } else if error.downcast_ref::<rusqlite::Error>().is_some() {
        "HANDOFF_STORAGE_ERROR".into()
    } else {
        "HANDOFF_REFUSED".into()
    };
    Ok(
        model::encode(&serde_json::json!({"version": VERSION, "error": {"code": code}}))?
            .into_bytes(),
    )
}
