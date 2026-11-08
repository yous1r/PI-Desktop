//! Restricted pre-AppState operations. The caller holds the directory OS lock.
use super::model::{self, Build, Owner, Phase, Transfer, VERSION};
use super::repository::Journal;
use super::startup::{prove_owner, NativeProof};
use super::transitions::{Mutation, Request};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Status {
        version: u32,
        transfer_id: String,
    },
    Claim {
        version: u32,
        request_id: String,
        transfer_id: String,
        source_epoch: String,
        expected_revision: i64,
        target_epoch: String,
        capability: String,
    },
    Recover {
        version: u32,
        request_id: String,
        transfer_id: String,
        source_epoch: String,
        expected_revision: i64,
        target_epoch: String,
        capability: String,
    },
}
impl Command {
    fn identity(&self) -> (u32, &str) {
        match self {
            Self::Status {
                version,
                transfer_id,
            }
            | Self::Claim {
                version,
                transfer_id,
                ..
            }
            | Self::Recover {
                version,
                transfer_id,
                ..
            } => (*version, transfer_id),
        }
    }
}

pub(super) struct ContextIdentity {
    pub owner: Owner,
    pub build: Build,
}

pub(super) fn execute(
    path: &Path,
    context: &ContextIdentity,
    command: &Command,
    proof: &mut impl NativeProof,
) -> Result<Transfer> {
    model::encode(command)?;
    let (version, id) = command.identity();
    if version != VERSION {
        bail!("HANDOFF_UNSUPPORTED_VERSION");
    }
    model::uuid(id)?;
    context.owner.validate()?;
    context.build.validate()?;
    // No write-capable connection is opened before identity, capability and all
    // native closure checks pass. Ordinary database maintenance is never called.
    let journal = Journal::open(path, true)?;
    let current = journal.transfer(id)?;
    if current.profile != context.owner.profile || current.requester.sid != context.owner.host.sid {
        bail!("HANDOFF_PROFILE_MISMATCH");
    }
    if matches!(command, Command::Status { .. }) {
        return Ok(current);
    }
    if current.target_build != context.build {
        bail!("HANDOFF_INCOMPATIBLE_BUILD");
    }
    let request = match command {
        Command::Claim {
            request_id,
            transfer_id,
            source_epoch,
            expected_revision,
            target_epoch,
            capability,
            ..
        }
        | Command::Recover {
            request_id,
            transfer_id,
            source_epoch,
            expected_revision,
            target_epoch,
            capability,
            ..
        } => {
            model::uuid(target_epoch)?;
            model::uuid(capability)?;
            let capability_hash = model::digest(capability.as_bytes());
            let mutation = if matches!(command, Command::Claim { .. }) {
                if *target_epoch != current.target_epoch
                    || capability_hash != current.capability_hash
                {
                    bail!("HANDOFF_CAPABILITY_MISMATCH");
                }
                let mut owner = context.owner.clone();
                owner.epoch = target_epoch.clone();
                Mutation::Claim { owner }
            } else {
                Mutation::Recover {
                    target_epoch: target_epoch.clone(),
                    capability_hash,
                }
            };
            Request {
                id: request_id.clone(),
                transfer_id: transfer_id.clone(),
                source_epoch: source_epoch.clone(),
                expected_revision: *expected_revision,
                mutation,
            }
        }
        Command::Status { .. } => unreachable!(),
    };
    let principal = &context.owner.host.sid;
    // A receipt is a historical result, never permission to start execution.
    if let Some(receipt) = journal.receipt(principal, &request)? {
        return Ok(receipt);
    }
    if current.source_epoch != request.source_epoch || current.revision != request.expected_revision
    {
        bail!("HANDOFF_STALE_REVISION");
    }
    if current.phase.terminal() {
        bail!("HANDOFF_TERMINAL");
    }
    if matches!(command, Command::Claim { .. }) && current.phase != Phase::ReleasePending {
        bail!("HANDOFF_INVALID_TRANSITION");
    }
    if journal.active_transfer(&current.profile)?.as_ref() != Some(&current) {
        bail!("HANDOFF_TRANSFER_CHANGED");
    }
    let source = journal
        .owner(&current.source_epoch)?
        .context("HANDOFF_SOURCE_MISSING")?;
    check_owner(&source, &current)?;
    // Sources must have registered containment before they become transferable.
    if journal.generations(&source.epoch, 0)?.is_empty() {
        bail!("HANDOFF_SOURCE_UNSUPPORTED");
    }
    prove_owner(&journal, &source, proof)?;
    let target = journal.owner(&current.target_epoch)?;
    if current.phase == Phase::TargetClaimed {
        let target = target.as_ref().context("HANDOFF_TARGET_MISSING")?;
        check_owner(target, &current)?;
        prove_owner(&journal, target, proof)?;
    } else if target.is_some() {
        bail!("HANDOFF_TARGET_IDENTITY_REUSED");
    }
    for active in journal.active_owners()? {
        if active.epoch != source.epoch && target.as_ref().is_none_or(|target| active != *target) {
            bail!("HANDOFF_UNEXPECTED_OWNER");
        }
    }
    drop(journal);
    Journal::open(path, false)?.mutate(principal, &request)
}

fn check_owner(owner: &Owner, transfer: &Transfer) -> Result<()> {
    if owner.profile != transfer.profile || owner.host.sid != transfer.requester.sid {
        bail!("HANDOFF_PROFILE_MISMATCH");
    }
    Ok(())
}
