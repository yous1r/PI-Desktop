use super::identity::{authenticate, Identity, SecurityDescriptor};
use super::protocol::{read_frame, respond, write_frame, OwnerStatus, Request, Response, VERSION};
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
};

const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(2);

fn address(directory: &Path, identity: &Identity) -> Result<(String, String)> {
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(directory)
        .context("open owner-control profile identity")?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(directory.as_raw_handle(), &mut info) } == 0 {
        bail!("owner-control profile identity unavailable");
    }
    let mut hash = Sha256::new();
    hash.update(b"pi-owner-control-v1\0");
    hash.update(identity.sid.as_bytes());
    for part in [
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ] {
        hash.update(part.to_le_bytes());
    }
    let profile = hex::encode(hash.finalize());
    Ok((format!(r"\\.\pipe\pi-desktop-owner-v1-{profile}"), profile))
}

fn listener(address: &str, identity: &Identity, first: bool) -> Result<NamedPipeServer> {
    let security = SecurityDescriptor::for_user(&identity.sid)?;
    let mut attributes = security.attributes();
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .max_instances(4)
        .in_buffer_size(16 * 1024)
        .out_buffer_size(16 * 1024);
    // CreateNamedPipe copies the security descriptor before this call returns.
    unsafe {
        options.create_with_security_attributes_raw(
            address,
            std::ptr::from_mut(&mut attributes).cast(),
        )
    }
    .context("OWNER_CONTROL_IN_USE_OR_UNAVAILABLE")
}

pub struct Control {
    pub task: tokio::task::JoinHandle<Result<()>>,
}
impl Control {
    pub fn start(directory: &Path) -> Result<Self> {
        let identity = Identity::current()?;
        let (name, profile_id) = address(directory, &identity)?;
        let first = listener(&name, &identity, true)?;
        let owner = OwnerStatus {
            owner_epoch: uuid::Uuid::new_v4().to_string(),
            profile_id,
            process_id: std::process::id(),
            process_created_at: identity.created_at.to_string(),
            operations: vec!["status".into()],
        };
        let task = tokio::spawn(async move {
            let mut next = first;
            loop {
                next.connect()
                    .await
                    .context("owner-control accept failed")?;
                let mut connected = next;
                // Always retain a listener while the prior object drains/closes.
                // Application code holds at most two instances; kernel completion
                // may briefly retain released handles, within the native cap of four.
                next = listener(&name, &identity, false)?;
                let exchange = async {
                    let _peer = authenticate(connected.as_raw_handle(), true, &identity)?;
                    connected.write_u8(1).await?;
                    let bytes = read_frame(&mut connected).await?;
                    let request: Request = serde_json::from_slice(&bytes)?;
                    let response = serde_json::to_vec(&respond(request, &owner))?;
                    write_frame(&mut connected, &response).await?;
                    if connected.read_u8().await? != 0 {
                        bail!("OWNER_CONTROL_INVALID_ACK");
                    }
                    Ok::<(), anyhow::Error>(())
                };
                match tokio::time::timeout(EXCHANGE_TIMEOUT, exchange).await {
                    Ok(Ok(())) => {}
                    _ => tracing::debug!("owner-control exchange refused or timed out"),
                }
                connected
                    .disconnect()
                    .context("owner-control disconnect failed")?;
            }
        });
        Ok(Self { task })
    }
    pub async fn close(&mut self) {
        if !self.task.is_finished() {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connect(name: &str) -> Result<NamedPipeClient> {
    let identity = Identity::current()?;
    tokio::time::timeout(EXCHANGE_TIMEOUT, async {
        loop {
            match ClientOptions::new().open(name) {
                Ok(mut client) => {
                    let _peer = authenticate(client.as_raw_handle(), false, &identity)?;
                    match client.read_u8().await {
                        Ok(1) => return Ok(client),
                        Ok(_) => bail!("OWNER_CONTROL_INVALID_GREETING"),
                        Err(error) if matches!(error.raw_os_error(), Some(109 | 232 | 233)) => {}
                        Err(error) => return Err(error).context("OWNER_CONTROL_UNAVAILABLE"),
                    }
                }
                Err(error) if matches!(error.raw_os_error(), Some(231..=233)) => {}
                Err(error) => return Err(error).context("OWNER_CONTROL_UNAVAILABLE"),
            }
            // Only retry a connection before any request bytes have been sent.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .context("OWNER_CONTROL_TIMEOUT")?
}

pub async fn query(directory: &Path, expected_epoch: Option<String>) -> Result<Response> {
    let identity = Identity::current()?;
    let (name, profile_id) = address(directory, &identity)?;
    let request = Request::status(expected_epoch);
    tokio::time::timeout(EXCHANGE_TIMEOUT, async {
        let mut client = connect(&name).await?;
        let peer = authenticate(client.as_raw_handle(), false, &identity)?;
        write_frame(&mut client, &serde_json::to_vec(&request)?).await?;
        let response: Response = serde_json::from_slice(&read_frame(&mut client).await?)?;
        if response.version != VERSION
            || response.request_id != request.request_id
            || response.status.is_some() == response.error.is_some()
        {
            bail!("OWNER_CONTROL_INVALID_RESPONSE");
        }
        if let Some(status) = &response.status {
            if status.profile_id != profile_id
                || status.process_id != peer.pid
                || status.process_created_at != peer.identity.created_at.to_string()
                || uuid::Uuid::parse_str(&status.owner_epoch).is_err()
                || request
                    .expected_owner_epoch
                    .as_ref()
                    .is_some_and(|epoch| epoch != &status.owner_epoch)
            {
                bail!("OWNER_CONTROL_INVALID_RESPONSE");
            }
        }
        client.write_u8(0).await?;
        Ok(response)
    })
    .await
    .context("OWNER_CONTROL_TIMEOUT")?
}

#[cfg(test)]
mod tests;
