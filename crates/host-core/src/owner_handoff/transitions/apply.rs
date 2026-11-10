//! Transaction-local transitions, shared by legacy control and source receipts.
//! The caller retains native authority; these writes never infer process exit.
use super::{Mutation, Request};
use crate::owner_handoff::{
    model::{self, Phase, Transfer},
    repository::{read_owner, read_transfer},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};

pub(in crate::owner_handoff) fn apply(
    conn: &Connection,
    principal: &str,
    request: &Request,
) -> Result<Transfer> {
    if let Mutation::Prepare { record } = &request.mutation {
        return prepare(conn, principal, request, record);
    }
    let mut record = read_transfer(conn, &request.transfer_id)?;
    if record.source_epoch != request.source_epoch || record.revision != request.expected_revision {
        bail!("HANDOFF_STALE_REVISION");
    }
    if record.requester.sid != principal {
        bail!("HANDOFF_PRINCIPAL_MISMATCH");
    }
    if record.phase.terminal() {
        bail!("HANDOFF_TERMINAL");
    }
    match &request.mutation {
        Mutation::BeginFencing => source_step(
            conn,
            principal,
            &mut record,
            Phase::Prepared,
            Phase::SourceFencing,
        )?,
        Mutation::ConfirmFenced => source_step(
            conn,
            principal,
            &mut record,
            Phase::SourceFencing,
            Phase::SourceFenced,
        )?,
        Mutation::Release => source_step(
            conn,
            principal,
            &mut record,
            Phase::SourceFenced,
            Phase::ReleasePending,
        )?,
        Mutation::Cancel => source_step(
            conn,
            principal,
            &mut record,
            Phase::Prepared,
            Phase::Cancelled,
        )?,
        #[cfg(test)]
        Mutation::Advance { phase } => {
            if *phase == Phase::TargetClaimed || !record.phase.can_advance(*phase) {
                bail!("HANDOFF_INVALID_TRANSITION");
            }
            record.phase = *phase;
            record.last_failure = None;
        }
        Mutation::Failure { code } => {
            if !matches!(record.phase, Phase::Prepared | Phase::SourceFencing) {
                bail!("HANDOFF_INVALID_TRANSITION");
            }
            let phase = record.phase;
            source_step(conn, principal, &mut record, phase, phase)?;
            record.last_failure = Some(code.clone());
        }
        Mutation::Claim { owner } => {
            owner.validate()?;
            if record.phase != Phase::ReleasePending {
                bail!("HANDOFF_INVALID_TRANSITION");
            }
            if owner.epoch != record.target_epoch
                || owner.profile != record.profile
                || owner.host.sid != principal
            {
                bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
            }
            retire(conn, &record.source_epoch)?;
            conn.execute(
                "INSERT INTO execution_owners(epoch,profile,record_json) VALUES(?1,?2,?3)",
                params![owner.epoch, owner.profile, model::encode(owner)?],
            )?;
            record.phase = Phase::TargetClaimed;
            record.last_failure = None;
        }
        Mutation::Recover {
            target_epoch,
            capability_hash,
        } => {
            model::uuid(target_epoch)?;
            model::hash(capability_hash)?;
            if *target_epoch == record.target_epoch
                || *target_epoch == record.source_epoch
                || *capability_hash == record.capability_hash
            {
                bail!("HANDOFF_RECOVERY_MUST_ROTATE");
            }
            let used: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_owners WHERE epoch=?1)",
                [target_epoch],
                |row| row.get(0),
            )?;
            if used {
                bail!("HANDOFF_TARGET_IDENTITY_REUSED");
            }
            retire(conn, &record.source_epoch)?;
            if record.phase == Phase::TargetClaimed {
                let previous = read_owner(conn, &record.target_epoch)?;
                if previous.profile != record.profile || previous.host.sid != principal {
                    bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
                }
                retire(conn, &record.target_epoch)?;
            }
            record.target_epoch = target_epoch.clone();
            record.capability_hash = capability_hash.clone();
            record.phase = Phase::ReleasePending;
            record.last_failure = None;
            record.recovery_attempt = record
                .recovery_attempt
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("HANDOFF_REVISION_EXHAUSTED"))?;
        }
        Mutation::Prepare { .. } => unreachable!(),
    }
    record.revision = record
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("HANDOFF_REVISION_EXHAUSTED"))?;
    record.validate()?;
    if conn.execute("UPDATE owner_handoffs SET target_epoch=?1,revision=?2,phase=?3,record_json=?4 WHERE id=?5 AND revision=?6",
        params![record.target_epoch,record.revision,record.phase.as_str(),model::encode(&record)?,record.id,request.expected_revision])? != 1 {
        bail!("HANDOFF_STALE_REVISION");
    }
    Ok(record)
}

fn source_step(
    conn: &Connection,
    principal: &str,
    record: &mut Transfer,
    from: Phase,
    to: Phase,
) -> Result<()> {
    if record.phase != from {
        bail!("HANDOFF_INVALID_TRANSITION");
    }
    let owner = read_owner(conn, &record.source_epoch)?;
    let retired: bool = conn.query_row(
        "SELECT retired FROM execution_owners WHERE epoch=?1",
        [&owner.epoch],
        |row| row.get(0),
    )?;
    if retired || owner.profile != record.profile || owner.host.sid != principal {
        bail!("HANDOFF_OWNER_CHANGED");
    }
    record.phase = to;
    record.last_failure = None;
    Ok(())
}
fn retire(conn: &Connection, epoch: &str) -> Result<()> {
    if conn.execute(
        "UPDATE execution_owners SET retired=1 WHERE epoch=?1",
        [epoch],
    )? != 1
    {
        bail!("HANDOFF_OWNER_CHANGED");
    }
    Ok(())
}
fn prepare(
    conn: &Connection,
    principal: &str,
    request: &Request,
    record: &Transfer,
) -> Result<Transfer> {
    record.validate()?;
    if request.expected_revision != 0
        || record.revision != 1
        || record.phase != Phase::Prepared
        || record.id != request.transfer_id
        || record.source_epoch != request.source_epoch
        || record.recovery_attempt != 0
        || record.last_failure.is_some()
    {
        bail!("HANDOFF_INVALID_PREPARE");
    }
    let owner = read_owner(conn, &record.source_epoch)?;
    let retired: bool = conn.query_row(
        "SELECT retired FROM execution_owners WHERE epoch=?1",
        [&owner.epoch],
        |row| row.get(0),
    )?;
    let registered: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM execution_generations WHERE owner_epoch=?1)",
        [&owner.epoch],
        |row| row.get(0),
    )?;
    if retired || !registered {
        bail!("HANDOFF_SOURCE_UNSUPPORTED");
    }
    if owner.profile != record.profile
        || owner.host.sid != principal
        || record.requester.sid != principal
    {
        bail!("HANDOFF_PROFILE_MISMATCH");
    }
    conn.execute("INSERT INTO owner_handoffs(id,profile,source_epoch,target_epoch,revision,phase,record_json) VALUES(?1,?2,?3,?4,1,'prepared',?5)",
        params![record.id, record.profile, record.source_epoch, record.target_epoch, model::encode(record)?])?;
    Ok(record.clone())
}
