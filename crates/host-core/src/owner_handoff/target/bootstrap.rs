//! No AppState/database maintenance is reachable before the closure proof.
use super::protocol::BootstrapRequest;
use crate::data_directory_owner::DataDirectoryOwner;
use crate::owner_handoff::{
    model::{Owner, Phase, Transfer, PAGE_SIZE},
    repository::Journal,
    service::{self, ContextIdentity},
    startup::{prove_owner, NativeProof},
};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;

// Conservative, bounded refusal; history is never deleted to fit this budget.
const MAX_HISTORY: i64 = 6_400;

/// In-process proof created only after restricted claim and a fresh journal
/// comparison. Every initialization capability retains this same directory lock.
pub(super) struct Authority {
    pub(super) owner: Owner,
    pub(super) claimed: Transfer,
    pub(super) path: PathBuf,
    pub(super) lock: Arc<DataDirectoryOwner>,
}

pub(crate) struct TargetBootstrap {
    pub(super) authority: Arc<Authority>,
}
impl TargetBootstrap {
    pub(crate) fn owner(&self) -> &Owner {
        &self.authority.owner
    }
    pub(crate) fn record(&self) -> &Transfer {
        &self.authority.claimed
    }
    /// Retain an additional guard in main BEFORE constructing the runtime;
    /// drop it only after the runtime and every owned resource have stopped.
    pub(crate) fn directory_owner(&self) -> Arc<DataDirectoryOwner> {
        self.authority.lock.clone()
    }
}

pub(super) fn execute_locked(
    directory: &Path,
    _lock: &DataDirectoryOwner,
    context: &ContextIdentity,
    request: &BootstrapRequest,
    proof: &mut impl NativeProof,
) -> Result<Transfer> {
    request.check_context(context)?;
    let path = directory.join("pi.sqlite");
    if !path.is_file() {
        bail!("HANDOFF_DATABASE_MISSING");
    }
    let journal = Journal::open(&path, true)?;
    let current = journal.transfer(request.transfer_id())?;
    if current.profile != context.owner.profile || current.requester.sid != context.owner.host.sid {
        bail!("HANDOFF_PROFILE_MISMATCH");
    }
    if current.target_build != context.build {
        bail!("HANDOFF_INCOMPATIBLE_BUILD");
    }
    prove_predecessors(&journal, context, request, &current, proof)?;
    drop(journal);
    // Reuse the committed Claim/Recover fingerprints, CAS and native checks.
    // Recover only rotates the reservation; it never implicitly claims it.
    service::execute(&path, context, request.command(), proof)
}

pub(super) fn claim_locked(
    directory: &Path,
    lock: Arc<DataDirectoryOwner>,
    context: &ContextIdentity,
    request: &BootstrapRequest,
    proof: &mut impl NativeProof,
) -> Result<TargetBootstrap> {
    if !request.is_claim() {
        bail!("HANDOFF_CLAIM_REQUIRED");
    }
    let record = execute_locked(directory, &lock, context, request, proof)?;
    let path = directory.join("pi.sqlite");
    let journal = Journal::open(&path, true)?;
    // A historical claim receipt cannot bypass the current reservation, exact
    // native process identity, or the normal unfinished-transfer startup guard.
    let authority = Authority {
        owner: context.owner.clone(),
        claimed: record,
        path,
        lock,
    };
    super::journal::require_claimed(&journal.conn, &authority)?;
    Ok(TargetBootstrap {
        authority: Arc::new(authority),
    })
}

fn prove_predecessors(
    journal: &Journal,
    context: &ContextIdentity,
    request: &BootstrapRequest,
    current: &Transfer,
    proof: &mut impl NativeProof,
) -> Result<()> {
    for table in ["execution_owners", "execution_generations"] {
        // Table names are literals, never command input. Include retired/closed
        // history: a durable closure flag is not evidence of native closure.
        let count: i64 = journal.conn.query_row(
            &format!("SELECT count(*) FROM (SELECT 1 FROM {table} LIMIT ?1)"),
            [MAX_HISTORY + 1],
            |row| row.get(0),
        )?;
        if count > MAX_HISTORY {
            bail!("HANDOFF_HISTORY_LIMIT");
        }
        let invalid_cursor: bool = journal.conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE sequence<=0)"),
            [],
            |row| row.get(0),
        )?;
        if invalid_cursor {
            bail!("HANDOFF_CORRUPT_HISTORY");
        }
    }
    let mut cursor = 0i64;
    loop {
        let mut statement = journal.conn.prepare(
            "SELECT sequence,epoch FROM execution_owners WHERE sequence>?1 ORDER BY sequence LIMIT ?2",
        )?;
        let rows = statement
            .query_map(rusqlite::params![cursor, PAGE_SIZE as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            return Ok(());
        }
        for (sequence, epoch) in rows {
            let owner = crate::owner_handoff::repository::read_owner(&journal.conn, &epoch)?;
            if owner.profile != context.owner.profile || owner.host.sid != context.owner.host.sid {
                bail!("HANDOFF_PROFILE_MISMATCH");
            }
            let retained_claim = request.is_claim()
                && current.phase == Phase::TargetClaimed
                && current.target_epoch == owner.epoch
                && owner == context.owner;
            if !retained_claim {
                prove_owner(journal, &owner, proof)?;
            }
            cursor = sequence;
        }
    }
}
