//! Transactional state transitions. Native/idle authority belongs to the caller;
//! this repository never launches, stops, replays or infers process closure.
#[cfg(test)]
use super::model::Phase;
use super::model::{self, Owner, Transfer};
use super::repository::Journal;
mod apply;
use anyhow::{bail, Result};
pub(super) use apply::apply;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum Mutation {
    // Only the authenticated source controller supplies a prepared record.
    Prepare {
        record: Transfer,
    },
    BeginFencing,
    ConfirmFenced,
    Release,
    Cancel,
    #[cfg(test)]
    Advance {
        phase: Phase,
    },
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
#[derive(Clone, Serialize)]
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
            let record = apply(conn, principal, request)?;
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
