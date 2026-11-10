//! One source request may own several durable fencing steps. Its fingerprint
//! is separate from the frozen claim/recovery receipt format.
use super::protocol::Command;
use crate::owner_handoff::{
    model::{self, Phase, Transfer},
    repository::{read_generation, read_transfer, Journal},
    transitions::{self, Mutation, Request},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone)]
pub(super) enum Step {
    Prepare(Transfer),
    BeginFencing,
    FenceFailure(String),
    ConfirmFenced { generation: String },
    CancelPending(Transfer),
    Cancel,
    Release,
}

pub(super) fn fingerprint(command: &Command) -> Result<String> {
    command.validate()?;
    if !command.is_mutation() {
        bail!("HANDOFF_INVALID_REQUEST");
    }
    let mut bytes = b"owner-transfer-source-v1\0".to_vec();
    bytes.extend_from_slice(model::encode(command)?.as_bytes());
    Ok(model::digest(&bytes))
}
fn validate(principal: &str, command: &Command) -> Result<()> {
    fingerprint(command)?;
    if !principal.starts_with("S-1-") || principal.len() > 184 || principal.contains('\0') {
        bail!("HANDOFF_INVALID_PRINCIPAL");
    }
    Ok(())
}
fn receipt(conn: &Connection, principal: &str, command: &Command) -> Result<Option<Transfer>> {
    let stored: Option<(String, String)> = conn.query_row(
        "SELECT fingerprint,result_json FROM owner_handoff_receipts WHERE principal=?1 AND request_id=?2",
        params![principal, command.identity().1], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((hash, raw)) = stored else {
        return Ok(None);
    };
    if hash != fingerprint(command)? {
        bail!("HANDOFF_REQUEST_CONFLICT");
    }
    let record: Transfer = model::decode(&raw)?;
    record.validate()?;
    if Some(record.id.as_str()) != command.transfer_id()
        || record.source_epoch != command.identity().2
        || record.requester.sid != principal
    {
        bail!("HANDOFF_CORRUPT_RECEIPT");
    }
    let intermediate =
        matches!(command, Command::Fence { .. }) && record.phase == Phase::SourceFencing;
    if !intermediate && command.expected_phase() != Some(record.phase) {
        bail!("HANDOFF_CORRUPT_RECEIPT");
    }
    if let Command::Prepare {
        target_epoch,
        target_build,
        capability_hash,
        ..
    } = command
    {
        if record.target_epoch != *target_epoch
            || record.target_build != *target_build
            || record.capability_hash != *capability_hash
        {
            bail!("HANDOFF_CORRUPT_RECEIPT");
        }
    }
    Ok(Some(record))
}

impl Journal {
    pub(super) fn source_receipt(
        &self,
        principal: &str,
        command: &Command,
    ) -> Result<Option<Transfer>> {
        validate(principal, command)?;
        receipt(&self.conn, principal, command)
    }
    /// Called only by the original source controller after its corresponding
    /// native/idle proof. Receipt progress and the phase CAS commit together.
    pub(super) fn source_step(
        &mut self,
        principal: &str,
        command: &Command,
        step: Step,
    ) -> Result<Transfer> {
        validate(principal, command)?;
        let allowed = matches!(
            (command, &step),
            (Command::Prepare { .. }, Step::Prepare(_))
                | (
                    Command::Fence { .. },
                    Step::BeginFencing | Step::ConfirmFenced { .. } | Step::FenceFailure(_)
                )
                | (
                    Command::Cancel { .. },
                    Step::Cancel | Step::CancelPending(_)
                )
                | (Command::Release { .. }, Step::Release)
        );
        if !allowed {
            bail!("HANDOFF_INVALID_TRANSITION");
        }
        self.transaction(|conn| {
            let previous = receipt(conn, principal, command)?;
            if let Some(record) = &previous {
                if command.expected_phase() == Some(record.phase) {
                    return Ok(record.clone());
                }
                if read_transfer(conn, &record.id)? != *record {
                    bail!("HANDOFF_STALE_REVISION");
                }
                if matches!(step, Step::BeginFencing) || matches!(&step, Step::FenceFailure(code) if record.last_failure.as_ref() == Some(code)) {
                    return Ok(record.clone());
                }
            }
            let expected_revision = match command {
                Command::Prepare { expected_revision, .. }
                | Command::Cancel { expected_revision, .. }
                | Command::Fence { expected_revision, .. }
                | Command::Release { expected_revision, .. } => *expected_revision as i64,
                _ => bail!("HANDOFF_INVALID_REQUEST"),
            };
            let mutation = match step {
                Step::Prepare(record) => {
                    if let Command::Prepare { target_epoch, capability_hash, target_build, .. } = command {
                        if record.target_epoch != *target_epoch || record.capability_hash != *capability_hash
                            || record.target_build != *target_build { bail!("HANDOFF_INVALID_PREPARE"); }
                    }
                    Mutation::Prepare { record }
                }
                Step::BeginFencing => Mutation::BeginFencing,
                Step::Cancel => Mutation::Cancel,
                Step::Release => Mutation::Release,
                Step::CancelPending(record) => {
                    // A retained local hold proves no native fencing began.
                    // Publish only the terminal cancellation: the intermediate
                    // prepare row and cancel CAS are in this one transaction.
                    if expected_revision != 1 { bail!("HANDOFF_STALE_REVISION"); }
                    let present: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM owner_handoffs WHERE id=?1)", [&record.id], |row| row.get(0))?;
                    if present {
                        if read_transfer(conn, &record.id)? != record { bail!("HANDOFF_STALE_REVISION"); }
                    } else {
                        transitions::apply(conn, principal, &Request {
                            id: command.identity().1.into(), transfer_id: command.transfer_id().ok_or_else(|| anyhow::anyhow!("HANDOFF_INVALID_REQUEST"))?.into(),
                            source_epoch: command.identity().2.into(), expected_revision: 0,
                            mutation: Mutation::Prepare { record },
                        })?;
                    }
                    Mutation::Cancel
                }
                Step::FenceFailure(code) => {
                    if previous.is_none() { bail!("HANDOFF_INVALID_TRANSITION"); }
                    Mutation::Failure { code }
                }
                Step::ConfirmFenced { generation } => {
                    if previous.is_none() { bail!("HANDOFF_INVALID_TRANSITION"); }
                    let original = read_generation(conn, &generation)?;
                    if original.owner_epoch != command.identity().2 || original.root.is_none() {
                        bail!("HANDOFF_OWNER_CHANGED");
                    }
                    if conn.execute("UPDATE execution_generations SET closed=1 WHERE id=?1 AND owner_epoch=?2",
                        params![generation, command.identity().2])? != 1 {
                        bail!("HANDOFF_OWNER_CHANGED");
                    }
                    Mutation::ConfirmFenced
                }
            };
            let request = Request {
                id: command.identity().1.into(),
                transfer_id: command.transfer_id().ok_or_else(|| anyhow::anyhow!("HANDOFF_INVALID_REQUEST"))?.into(),
                source_epoch: command.identity().2.into(),
                expected_revision: previous.as_ref().map_or(expected_revision, |record| record.revision),
                mutation,
            };
            let record = transitions::apply(conn, principal, &request)?;
            conn.execute("INSERT INTO owner_handoff_receipts(principal,request_id,transfer_id,fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(principal,request_id) DO UPDATE SET result_json=excluded.result_json",
                params![principal, request.id, record.id, fingerprint(command)?, model::encode(&record)?])?;
            Ok(record)
        })
    }
}

#[cfg(test)]
mod tests;
