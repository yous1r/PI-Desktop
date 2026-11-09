//! Bounded original-owner journal reads. No admission or transfer mutation.
use super::{
    model::{self, Owner, Transfer},
    repository::{read_owner, read_transfer, Journal},
};
use anyhow::{bail, Result};

impl Journal {
    pub fn inspect_source(
        &self,
        owner: &Owner,
        transfer_id: Option<&str>,
    ) -> Result<Option<Transfer>> {
        owner.validate()?;
        if let Some(id) = transfer_id {
            model::uuid(id)?;
        }
        super::read_budget::bounded_read(&self.conn, || {
            // Both identities must come from one read snapshot. A writer may
            // advance immediately afterwards; callers still need phase CAS.
            let tx = self.conn.unchecked_transaction()?;
            let stored = read_owner(&tx, &owner.epoch)?;
            let retired: bool = tx.query_row(
                "SELECT retired FROM execution_owners WHERE epoch=?1",
                [&owner.epoch],
                |row| row.get(0),
            )?;
            if stored != *owner || retired {
                bail!("HANDOFF_OWNER_CHANGED");
            }
            let record = transfer_id.map(|id| read_transfer(&tx, id)).transpose()?;
            if let Some(record) = &record {
                if record.source_epoch != owner.epoch
                    || record.profile != owner.profile
                    || record.requester.sid != owner.host.sid
                {
                    bail!("HANDOFF_OWNER_CHANGED");
                }
            }
            tx.commit()?;
            Ok(record)
        })
    }
}
