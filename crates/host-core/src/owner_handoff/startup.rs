//! Runs under the data-directory lock, before normal database open or recovery.
use super::model::{Generation, Owner};
use super::repository::Journal;
use anyhow::{bail, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub(super) trait NativeProof {
    fn owner_ended(&mut self, owner: &Owner) -> Result<()>;
    fn generation_ended(&mut self, generation: &Generation) -> Result<()>;
}

pub(super) fn inspect(
    path: &Path,
    profile: Option<&str>,
    proof: &mut impl NativeProof,
) -> Result<Vec<String>> {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_file() => bail!("HANDOFF_DATABASE_NOT_REGULAR"),
        Ok(_) => {}
    }
    let probe = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    probe.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
    let version: i64 = probe.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > crate::db::SCHEMA_VERSION {
        bail!("HANDOFF_UNSUPPORTED_SCHEMA");
    }
    let present: bool = probe.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN
         ('execution_owners','execution_generations','owner_handoffs','owner_handoff_receipts'))",
        [], |row| row.get(0))?;
    if version < 28 && present {
        bail!("HANDOFF_SCHEMA_DOWNGRADE");
    }
    if version < crate::db::SCHEMA_VERSION && !present {
        return Ok(Vec::new());
    }
    drop(probe);
    let journal = Journal::open(path, true)?;
    // Query every unfinished operation, even if the directory was copied and
    // now has a different native profile identity.
    let mut statement = journal.conn.prepare(
        "SELECT id FROM owner_handoffs WHERE phase NOT IN ('ready','cancelled') LIMIT 2",
    )?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        journal.transfer(id)?;
    }
    if !ids.is_empty() {
        bail!("HANDOFF_RECOVERY_REQUIRED");
    }
    let owners = journal.active_owners()?;
    for owner in &owners {
        if profile != Some(owner.profile.as_str()) {
            bail!("HANDOFF_PROFILE_MISMATCH");
        }
        prove_owner(&journal, owner, proof)?;
    }
    Ok(owners.into_iter().map(|owner| owner.epoch).collect())
}

pub(super) fn prove_owner(
    journal: &Journal,
    owner: &Owner,
    proof: &mut impl NativeProof,
) -> Result<()> {
    proof.owner_ended(owner)?;
    let mut cursor = 0;
    loop {
        let generations = journal.generations(&owner.epoch, cursor)?;
        if generations.is_empty() {
            break;
        }
        for (sequence, generation) in generations {
            if generation.profile != owner.profile
                || generation
                    .root
                    .as_ref()
                    .is_some_and(|root| root.sid != owner.host.sid)
            {
                bail!("HANDOFF_PROFILE_MISMATCH");
            }
            proof.generation_ended(&generation)?;
            cursor = sequence;
        }
    }
    Ok(())
}

pub fn inspect_directory(directory: &Path) -> Result<Inspection> {
    let path = directory.join("pi.sqlite");
    #[cfg(windows)]
    let (profile, mut proof) = (
        Some(crate::owner_control::profile_id(directory)?),
        super::native::Proof,
    );
    #[cfg(not(windows))]
    let (profile, mut proof) = (None::<String>, UnsupportedProof);
    let epochs = inspect(&path, profile.as_deref(), &mut proof)?;
    Ok(Inspection { path, epochs })
}

pub struct Inspection {
    path: std::path::PathBuf,
    epochs: Vec<String>,
}
impl Inspection {
    /// Commit only after native endpoint acquisition succeeds, still under the
    /// directory lock. A failed startup preflight must not retire an owner.
    pub fn commit(self) -> Result<()> {
        if !self.epochs.is_empty() {
            let mut journal = Journal::open(&self.path, false)?;
            for epoch in self.epochs {
                journal.retire_owner(&epoch)?;
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
struct UnsupportedProof;
#[cfg(not(windows))]
impl NativeProof for UnsupportedProof {
    fn owner_ended(&mut self, _: &Owner) -> Result<()> {
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
    fn generation_ended(&mut self, _: &Generation) -> Result<()> {
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}
