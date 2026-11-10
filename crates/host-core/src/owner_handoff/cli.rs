//! Explicit current-user, private-stdio recovery mode. Never opens AppState.
use super::model::{self, Build, Owner, VERSION};
use super::native::{record, Proof};
use super::service::{self, Command, ContextIdentity};
use crate::data_directory_owner::DataDirectoryOwner;
use crate::execution_fence::native::{exited, Coordinator};
use crate::owner_control::identity::Identity;
use anyhow::{bail, Result};
use std::os::windows::io::AsRawHandle;
use std::path::Path;

pub(super) async fn run(
    directory: &Path,
    data_owner: &mut Option<DataDirectoryOwner>,
) -> Result<()> {
    // The mode accepts only existing profiles; no migration, creation or repair.
    if !directory.join("pi.sqlite").is_file() {
        bail!("HANDOFF_DATABASE_MISSING");
    }
    *data_owner = Some(DataDirectoryOwner::acquire(directory)?);
    let identity = Identity::current()?;
    let coordinator = Coordinator::capture(&identity)?;
    let context = ContextIdentity {
        owner: Owner {
            version: VERSION,
            epoch: uuid::Uuid::new_v4().to_string(),
            profile: crate::owner_control::profile_id(directory)?,
            host: record(std::process::id(), &identity),
            coordinator: record(coordinator.pid, &coordinator.identity),
        },
        build: Build::current()?,
    };
    let path = directory.join("pi.sqlite");
    loop {
        let Some(input_frame) = super::stdio::receive(&coordinator).await? else {
            return Ok(());
        };
        if exited(coordinator.handle.as_raw_handle())? {
            bail!("HANDOFF_COORDINATOR_EXITED");
        }
        let result = serde_json::from_slice::<Command>(&input_frame)
            .map_err(|_| anyhow::anyhow!("HANDOFF_INVALID_REQUEST"))
            .and_then(|command| service::execute(&path, &context, &command, &mut Proof));
        let reply = match result {
            Ok(record) => serde_json::json!({"version": VERSION, "record": record}),
            Err(error) => {
                serde_json::json!({"version": VERSION, "error": {"code": error_code(&error)}})
            }
        };
        let encoded = model::encode(&reply)?;
        super::stdio::send(&coordinator, encoded.into_bytes()).await?;
    }
}
fn error_code(error: &anyhow::Error) -> String {
    let message = error.to_string();
    if message.starts_with("HANDOFF_")
        && message.len() <= 128
        && message
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        message
    } else if error.downcast_ref::<rusqlite::Error>().is_some() {
        "HANDOFF_STORAGE_ERROR".into()
    } else if error.downcast_ref::<serde_json::Error>().is_some() {
        "HANDOFF_INVALID_METADATA".into()
    } else if error.downcast_ref::<uuid::Error>().is_some() {
        "HANDOFF_INVALID_IDENTITY".into()
    } else {
        "HANDOFF_REFUSED".into()
    }
}
