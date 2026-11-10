//! Native executable identity shared by restricted and running-source modes.
use super::model::{Build, VERSION};
use anyhow::Result;
use sha2::{Digest, Sha256};
use std::io::Read;

impl Build {
    pub fn current() -> Result<Self> {
        let mut file = std::fs::File::open(std::env::current_exe()?)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        Ok(Self {
            sha256: hex::encode(hash.finalize()),
            schema: crate::db::SCHEMA_VERSION as u32,
            protocol: VERSION,
        })
    }
}
