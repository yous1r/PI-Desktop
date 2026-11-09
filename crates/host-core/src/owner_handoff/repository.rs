//! Restricted journal connection: never invokes database maintenance or turn recovery.
use super::model::{self, Generation, Owner, Transfer};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;

pub struct Journal {
    pub(super) conn: Connection,
}
impl Journal {
    pub fn open(path: &Path, readonly: bool) -> Result<Self> {
        let flags = if readonly {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        let conn = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        if !readonly {
            conn.execute_batch("PRAGMA synchronous=FULL;")?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != crate::db::SCHEMA_VERSION
            && !(readonly && (28..crate::db::SCHEMA_VERSION).contains(&version))
        {
            bail!("HANDOFF_UNSUPPORTED_SCHEMA");
        }
        crate::db::owner_handoff_migration::validate(&conn)?;
        Ok(Self { conn })
    }
    pub(super) fn transaction<T>(
        &mut self,
        action: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let value = action(&tx)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn register_owner(&mut self, owner: &Owner) -> Result<()> {
        owner.validate()?;
        self.transaction(|conn| {
            conn.execute(
                "INSERT INTO execution_owners(epoch, profile, record_json) VALUES(?1,?2,?3)",
                params![owner.epoch, owner.profile, model::encode(owner)?],
            )?;
            Ok(())
        })
    }
    pub fn register_generation(&mut self, generation: &Generation) -> Result<()> {
        generation.validate()?;
        if generation.root.is_some() {
            bail!("HANDOFF_INVALID_REGISTRATION");
        }
        self.transaction(|conn| {
            let owner = read_owner(conn, &generation.owner_epoch)?;
            if owner.profile != generation.profile {
                bail!("HANDOFF_PROFILE_MISMATCH");
            }
            require_admission(conn, &owner)?;
            conn.execute(
                "INSERT INTO execution_generations(id, owner_epoch, record_json) VALUES(?1,?2,?3)",
                params![
                    generation.id,
                    generation.owner_epoch,
                    model::encode(generation)?
                ],
            )?;
            Ok(())
        })
    }
    pub fn bind_root(&mut self, generation: &str, root: &model::ProcessIdentity) -> Result<()> {
        root.validate()?;
        self.transaction(|conn| {
            let mut record = read_generation(conn, generation)?;
            let owner = read_owner(conn, &record.owner_epoch)?;
            require_admission(conn, &owner)?;
            if record.root.is_some() || root.sid != owner.host.sid {
                bail!("HANDOFF_INVALID_REGISTRATION");
            }
            record.root = Some(root.clone());
            if conn.execute(
                "UPDATE execution_generations SET record_json=?1 WHERE id=?2 AND closed=0",
                params![model::encode(&record)?, generation],
            )? != 1
            {
                bail!("HANDOFF_GENERATION_CLOSED");
            }
            Ok(())
        })
    }
    /// Called only after original handles and the owned job have confirmed closure.
    pub fn close_generation(&mut self, generation: &str) -> Result<()> {
        self.transaction(|conn| {
            if conn.execute(
                "UPDATE execution_generations SET closed=1 WHERE id=?1",
                [generation],
            )? != 1
            {
                bail!("HANDOFF_GENERATION_MISSING");
            }
            Ok(())
        })
    }
    pub fn owner(&self, epoch: &str) -> Result<Option<Owner>> {
        let present: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_owners WHERE epoch=?1)",
            [epoch],
            |row| row.get(0),
        )?;
        present.then(|| read_owner(&self.conn, epoch)).transpose()
    }
    pub fn transfer(&self, id: &str) -> Result<Transfer> {
        read_transfer(&self.conn, id)
    }
    pub fn active_transfer(&self, profile: &str) -> Result<Option<Transfer>> {
        let id: Option<String> = self.conn.query_row("SELECT id FROM owner_handoffs WHERE profile=?1 AND phase NOT IN ('ready','cancelled')", [profile], |row| row.get(0)).optional()?;
        id.map(|id| self.transfer(&id)).transpose()
    }
    pub fn active_owners(&self) -> Result<Vec<Owner>> {
        let mut statement = self
            .conn
            .prepare("SELECT epoch FROM execution_owners WHERE retired=0 LIMIT 2")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if ids.len() > 1 {
            bail!("HANDOFF_MULTIPLE_PROFILE_OWNERS");
        }
        ids.iter().map(|id| read_owner(&self.conn, id)).collect()
    }
    pub fn generations(&self, owner: &str, after: i64) -> Result<Vec<(i64, Generation)>> {
        let mut statement = self.conn.prepare("SELECT sequence,id FROM execution_generations WHERE owner_epoch=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let ids = statement
            .query_map(params![owner, after, model::PAGE_SIZE as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|(sequence, id)| Ok((sequence, read_generation(&self.conn, &id)?)))
            .collect()
    }
    pub fn retire_owner(&mut self, epoch: &str) -> Result<()> {
        self.transaction(|conn| {
            if conn.execute(
                "UPDATE execution_owners SET retired=1 WHERE epoch=?1 AND retired=0",
                [epoch],
            )? != 1
            {
                bail!("HANDOFF_OWNER_CHANGED");
            }
            Ok(())
        })
    }
}

pub(super) fn read_owner(conn: &Connection, epoch: &str) -> Result<Owner> {
    let (profile, raw): (String, String) = conn.query_row(
        "SELECT profile,record_json FROM execution_owners WHERE epoch=?1",
        [epoch],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let owner: Owner = model::decode(&raw)?;
    owner.validate()?;
    if owner.epoch != epoch || owner.profile != profile {
        bail!("HANDOFF_CORRUPT_OWNER");
    }
    Ok(owner)
}
pub(super) fn read_generation(conn: &Connection, id: &str) -> Result<Generation> {
    let (epoch, raw): (String, String) = conn.query_row(
        "SELECT owner_epoch,record_json FROM execution_generations WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let generation: Generation = model::decode(&raw)?;
    generation.validate()?;
    if generation.id != id || generation.owner_epoch != epoch {
        bail!("HANDOFF_CORRUPT_GENERATION");
    }
    Ok(generation)
}
pub(super) fn read_transfer(conn: &Connection, id: &str) -> Result<Transfer> {
    let (profile, source, target, revision, phase, raw): (String,String,String,i64,String,String) = conn.query_row(
        "SELECT profile,source_epoch,target_epoch,revision,phase,record_json FROM owner_handoffs WHERE id=?1", [id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
        .context("HANDOFF_TRANSFER_MISSING")?;
    let record: Transfer = model::decode(&raw)?;
    record.validate()?;
    if record.id != id
        || record.profile != profile
        || record.source_epoch != source
        || record.target_epoch != target
        || record.revision != revision
        || record.phase.as_str() != phase
    {
        bail!("HANDOFF_CORRUPT_TRANSFER");
    }
    Ok(record)
}

fn require_admission(conn: &Connection, owner: &Owner) -> Result<()> {
    let retired: bool = conn.query_row(
        "SELECT retired FROM execution_owners WHERE epoch=?1",
        [&owner.epoch],
        |row| row.get(0),
    )?;
    let transfer: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM owner_handoffs WHERE profile=?1 AND phase NOT IN ('ready','cancelled'))", [&owner.profile], |row| row.get(0))?;
    if retired || transfer {
        bail!("HANDOFF_ADMISSION_CLOSED");
    }
    Ok(())
}
