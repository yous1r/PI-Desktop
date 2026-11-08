//! Transactional state transitions. Native/idle authority belongs to the caller;
//! this repository never launches, stops, replays or infers process closure.
use super::model::{self, Owner, Phase, Transfer};
use super::repository::{read_owner, read_transfer, Journal};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum Mutation {
    // Source orchestration remains test-only until complete idle inventory exists.
    #[cfg(test)]
    Prepare {
        record: Transfer,
    },
    #[cfg(test)]
    Advance {
        phase: Phase,
    },
    #[cfg(test)]
    Failure {
        code: String,
    },
    Claim {
        owner: Owner,
    },
    Recover {
        target_epoch: String,
        capability_hash: String,
    },
}
#[derive(Serialize)]
pub struct Request {
    pub id: String,
    pub transfer_id: String,
    pub source_epoch: String,
    pub expected_revision: i64,
    pub mutation: Mutation,
}
impl Journal {
    pub fn receipt(&self, principal: &str, request: &Request) -> Result<Option<Transfer>> {
        validate_request(principal, request)?;
        receipt(&self.conn, principal, request)
    }
    pub fn mutate(&mut self, principal: &str, request: &Request) -> Result<Transfer> {
        validate_request(principal, request)?;
        self.transaction(|conn| {
            if let Some(record) = receipt(conn, principal, request)? {
                return Ok(record);
            }
            let record = match &request.mutation {
                #[cfg(test)]
                Mutation::Prepare { record } => prepare(conn, principal, request, record)?,
                mutation => {
                    let mut record = read_transfer(conn, &request.transfer_id)?;
                    if record.source_epoch != request.source_epoch || record.revision != request.expected_revision {
                        bail!("HANDOFF_STALE_REVISION");
                    }
                    if record.requester.sid != principal { bail!("HANDOFF_PRINCIPAL_MISMATCH"); }
                    if record.phase.terminal() { bail!("HANDOFF_TERMINAL"); }
                    match mutation {
                        #[cfg(test)]
                        Mutation::Advance { phase } => {
                            if *phase == Phase::TargetClaimed || !record.phase.can_advance(*phase) {
                                bail!("HANDOFF_INVALID_TRANSITION");
                            }
                            record.phase = *phase;
                            record.last_failure = None;
                        }
                        #[cfg(test)]
                        Mutation::Failure { code } => record.last_failure = Some(code.clone()),
                        Mutation::Claim { owner } => {
                            owner.validate()?;
                            if record.phase != Phase::ReleasePending { bail!("HANDOFF_INVALID_TRANSITION"); }
                            if owner.epoch != record.target_epoch || owner.profile != record.profile
                                || owner.host.sid != principal {
                                bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
                            }
                            retire(conn, &record.source_epoch)?;
                            conn.execute("INSERT INTO execution_owners(epoch,profile,record_json) VALUES(?1,?2,?3)",
                                params![owner.epoch, owner.profile, model::encode(owner)?])?;
                            record.phase = Phase::TargetClaimed;
                            record.last_failure = None;
                        }
                        Mutation::Recover { target_epoch, capability_hash } => {
                            model::uuid(target_epoch)?;
                            model::hash(capability_hash)?;
                            if *target_epoch == record.target_epoch || *target_epoch == record.source_epoch
                                || *capability_hash == record.capability_hash {
                                bail!("HANDOFF_RECOVERY_MUST_ROTATE");
                            }
                            let used: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM execution_owners WHERE epoch=?1)", [target_epoch], |row| row.get(0))?;
                            if used { bail!("HANDOFF_TARGET_IDENTITY_REUSED"); }
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
                            record.recovery_attempt = record.recovery_attempt.checked_add(1)
                                .ok_or_else(|| anyhow::anyhow!("HANDOFF_REVISION_EXHAUSTED"))?;
                        }
                        #[cfg(test)]
                        Mutation::Prepare { .. } => unreachable!(),
                    }
                    record.revision = record.revision.checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("HANDOFF_REVISION_EXHAUSTED"))?;
                    record.validate()?;
                    update(conn, &record, request.expected_revision)?;
                    record
                }
            };
            conn.execute("INSERT INTO owner_handoff_receipts(principal,request_id,transfer_id,fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
                params![principal, request.id, record.id, fingerprint(request)?, model::encode(&record)?])?;
            Ok(record)
        })
    }
}
fn validate_request(principal: &str, request: &Request) -> Result<()> {
    model::uuid(&request.id)?;
    model::uuid(&request.transfer_id)?;
    model::uuid(&request.source_epoch)?;
    if !principal.starts_with("S-1-") || principal.len() > 184 || principal.contains('\0') {
        bail!("HANDOFF_INVALID_PRINCIPAL");
    }
    if !(0..=9_007_199_254_740_991).contains(&request.expected_revision) {
        bail!("HANDOFF_INVALID_REVISION");
    }
    model::encode(request)?;
    Ok(())
}
fn fingerprint(request: &Request) -> Result<String> {
    Ok(model::digest(model::encode(request)?.as_bytes()))
}
fn receipt(conn: &Connection, principal: &str, request: &Request) -> Result<Option<Transfer>> {
    let stored: Option<(String, String)> = conn.query_row(
        "SELECT fingerprint,result_json FROM owner_handoff_receipts WHERE principal=?1 AND request_id=?2",
        params![principal, request.id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((hash, raw)) = stored else {
        return Ok(None);
    };
    if hash != fingerprint(request)? {
        bail!("HANDOFF_REQUEST_CONFLICT");
    }
    let record: Transfer = model::decode(&raw)?;
    record.validate()?;
    if record.id != request.transfer_id || record.source_epoch != request.source_epoch {
        bail!("HANDOFF_CORRUPT_RECEIPT");
    }
    Ok(Some(record))
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
#[cfg(test)]
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
fn update(conn: &Connection, record: &Transfer, previous: i64) -> Result<()> {
    if conn.execute("UPDATE owner_handoffs SET target_epoch=?1,revision=?2,phase=?3,record_json=?4 WHERE id=?5 AND revision=?6",
        params![record.target_epoch,record.revision,record.phase.as_str(),model::encode(record)?,record.id,previous])? != 1 {
        bail!("HANDOFF_STALE_REVISION");
    }
    Ok(())
}
