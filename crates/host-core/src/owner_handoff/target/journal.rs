//! Target-only Ready transaction. Uses schema-30 retention tables and a distinct
//! fingerprint domain; no generic Advance or caller-selected phase is exposed.
use super::{
    bootstrap::Authority,
    protocol::MAX_REVISION,
    ready::{self, EventStream, ReadyOutcome},
};
use crate::owner_handoff::{
    model::{self, Generation, Owner, Phase, Transfer},
    repository::{read_generation, read_owner, read_transfer, Journal},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub(super) struct ReadyIntent {
    pub(super) request_id: String,
    pub(super) claimed: Transfer,
    pub(super) owner: Owner,
    pub(super) generation: Generation,
    pub(super) event_epoch: String,
    pub(super) protocol_version: u32,
    /// True only for the restricted target Ready slice where no sidecar root
    /// exists yet. It never permits a replacement root or a second generation.
    /// Excluded from the wire/fingerprint domain so historical Ready receipts
    /// keep their exact identity; it only relaxes the in-memory root guard.
    #[serde(skip)]
    pub(super) restricted: bool,
}
impl ReadyIntent {
    pub(super) fn validate(&self) -> Result<()> {
        model::uuid(&self.request_id)?;
        self.claimed.validate()?;
        self.owner.validate()?;
        self.generation.validate()?;
        EventStream {
            epoch: &self.event_epoch,
            protocol_version: self.protocol_version,
        }
        .validate()?;
        if self.claimed.phase != Phase::TargetClaimed
            || self.claimed.revision >= MAX_REVISION
            || self.owner.epoch != self.claimed.target_epoch
            || self.owner.profile != self.claimed.profile
            || self.owner.host.sid != self.claimed.requester.sid
            || self.generation.owner_epoch != self.owner.epoch
            || self.generation.profile != self.owner.profile
            || (!self.restricted && self.generation.root.is_none())
            || self.generation.root.as_ref().is_some_and(|root| {
                root.sid != self.owner.host.sid
                    || root.pid == self.owner.host.pid
                    || root.pid == self.owner.coordinator.pid
            })
        {
            bail!("HANDOFF_INVALID_READY");
        }
        model::encode(self)?;
        Ok(())
    }
    fn fingerprint(&self) -> Result<String> {
        self.validate()?;
        let mut bytes = b"owner-transfer-target-ready-v1\0".to_vec();
        bytes.extend_from_slice(model::encode(self)?.as_bytes());
        Ok(model::digest(&bytes))
    }
    fn result(&self) -> Result<ReadyOutcome> {
        let mut record = self.claimed.clone();
        record.phase = Phase::Ready;
        record.revision += 1; // validate reserves the next safe revision.
        record.last_failure = None;
        record.validate()?;
        ready::outcome(record, self)
    }
}

pub(super) fn require_owner(conn: &Connection, owner: &Owner) -> Result<()> {
    owner.validate()?;
    if read_owner(conn, &owner.epoch)? != *owner {
        bail!("HANDOFF_OWNER_CHANGED");
    }
    let (retired, active): (bool, i64) = conn.query_row(
        "SELECT retired,(SELECT count(*) FROM execution_owners WHERE retired=0) FROM execution_owners WHERE epoch=?1",
        [&owner.epoch], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if retired || active != 1 {
        bail!("HANDOFF_OWNER_CHANGED");
    }
    Ok(())
}

pub(super) fn require_claimed(conn: &Connection, authority: &Authority) -> Result<Transfer> {
    let claimed = &authority.claimed;
    let owner = &authority.owner;
    claimed.validate()?;
    require_owner(conn, owner)?;
    if claimed.phase != Phase::TargetClaimed
        || claimed.target_epoch != owner.epoch
        || claimed.profile != owner.profile
        || claimed.requester.sid != owner.host.sid
    {
        bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
    }
    let current = read_transfer(conn, &claimed.id)?;
    if current != *claimed {
        bail!("HANDOFF_STALE_REVISION");
    }
    let (source_retired, active): (bool, i64) = conn.query_row(
        "SELECT retired,(SELECT count(*) FROM owner_handoffs WHERE phase NOT IN ('ready','cancelled')) FROM execution_owners WHERE epoch=?1",
        [&claimed.source_epoch], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !source_retired || active != 1 {
        bail!("HANDOFF_TRANSFER_CHANGED");
    }
    Ok(current)
}

fn receipt(conn: &Connection, intent: &ReadyIntent) -> Result<Option<ReadyOutcome>> {
    let stored: Option<(String, String, String)> = conn.query_row(
        "SELECT fingerprint,transfer_id,result_json FROM owner_handoff_receipts WHERE principal=?1 AND request_id=?2",
        params![intent.owner.host.sid, intent.request_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    let Some((fingerprint, transfer_id, raw)) = stored else {
        return Ok(None);
    };
    if fingerprint != intent.fingerprint()? {
        bail!("HANDOFF_REQUEST_CONFLICT");
    }
    let outcome: ReadyOutcome = model::decode(&raw)?;
    if transfer_id != intent.claimed.id || outcome != intent.result()? {
        bail!("HANDOFF_CORRUPT_RECEIPT");
    }
    Ok(Some(outcome))
}

impl Journal {
    pub(in crate::owner_handoff::target) fn target_ready_receipt(
        &self,
        intent: &ReadyIntent,
    ) -> Result<Option<ReadyOutcome>> {
        intent.validate()?;
        receipt(&self.conn, intent)
    }

    /// Only ReadyTarget invokes this, inside the retained resource/native
    /// guard. The SQL checks durable registration, not native liveness.
    pub(in crate::owner_handoff::target) fn target_ready(
        &mut self,
        authority: &Authority,
        intent: &ReadyIntent,
    ) -> Result<ReadyOutcome> {
        intent.validate()?;
        if intent.owner != authority.owner || intent.claimed != authority.claimed {
            bail!("HANDOFF_TARGET_IDENTITY_MISMATCH");
        }
        self.transaction(|conn| {
            if let Some(result) = receipt(conn, intent)? {
                return Ok(result);
            }
            require_claimed(conn, authority)?;
            let stored = read_generation(conn, &intent.generation.id)?;
            let (closed, active): (bool, i64) = conn.query_row(
                "SELECT closed,(SELECT count(*) FROM execution_generations WHERE owner_epoch=?1 AND closed=0) FROM execution_generations WHERE id=?2 AND owner_epoch=?1",
                params![intent.owner.epoch, intent.generation.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if stored != intent.generation || closed || active != 1 {
                bail!("HANDOFF_GENERATION_CHANGED");
            }
            let result = intent.result()?;
            if conn.execute(
                "UPDATE owner_handoffs SET revision=?1,phase='ready',record_json=?2 WHERE id=?3 AND source_epoch=?4 AND target_epoch=?5 AND revision=?6 AND phase='target_claimed'",
                params![result.record.revision, model::encode(&result.record)?, intent.claimed.id,
                    intent.claimed.source_epoch, intent.owner.epoch, intent.claimed.revision],
            )? != 1 {
                bail!("HANDOFF_STALE_REVISION");
            }
            conn.execute(
                "INSERT INTO owner_handoff_receipts(principal,request_id,transfer_id,fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
                params![intent.owner.host.sid, intent.request_id, intent.claimed.id,
                    intent.fingerprint()?, model::encode(&result)?],
            )?;
            Ok(result)
        })
    }

    /// Target-scoped read for the adopted registry. The registry must verify its
    /// original native coordinator/current pointer before exposing this via RPC.
    pub(crate) fn inspect_target(&self, owner: &Owner, transfer_id: &str) -> Result<Transfer> {
        model::uuid(transfer_id)?;
        crate::owner_handoff::read_budget::bounded_read(&self.conn, || {
            let tx = self.conn.unchecked_transaction()?;
            require_owner(&tx, owner)?;
            let record = read_transfer(&tx, transfer_id)?;
            if record.target_epoch != owner.epoch
                || record.profile != owner.profile
                || record.requester.sid != owner.host.sid
                || !matches!(record.phase, Phase::TargetClaimed | Phase::Ready)
            {
                bail!("HANDOFF_OWNER_CHANGED");
            }
            tx.commit()?;
            Ok(record)
        })
    }
}
