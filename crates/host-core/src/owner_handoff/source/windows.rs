//! One bounded native exchange at a time, with a retained replacement listener.
use super::{
    protocol::{Reply, Request},
    service::Service,
};
use crate::{
    execution_fence::native::exited,
    owner_control::{
        identity::{authenticate_with_access, Identity, Peer, SecurityDescriptor},
        protocol::{read_frame, write_frame},
    },
    owner_handoff::model,
};
use anyhow::{bail, Context, Result};
use std::{os::windows::io::AsRawHandle, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
};
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;

const BUDGET: Duration = Duration::from_secs(2);
fn address(profile: &str) -> String {
    format!(r"\\.\pipe\pi-desktop-transfer-v1-{profile}")
}
fn listener(name: &str, identity: &Identity, first: bool) -> Result<NamedPipeServer> {
    let security = SecurityDescriptor::for_user(&identity.sid)?;
    let mut attributes = security.attributes();
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(4)
            .in_buffer_size(model::MAX_RECORD_BYTES as u32)
            .out_buffer_size(model::MAX_RECORD_BYTES as u32)
            .create_with_security_attributes_raw(name, std::ptr::from_mut(&mut attributes).cast())
    }
    .context("HANDOFF_SOURCE_UNAVAILABLE")
}
fn live(peer: &Peer) -> Result<()> {
    if exited(peer.handle.as_raw_handle())? {
        bail!("HANDOFF_OWNER_CHANGED");
    }
    Ok(())
}
pub(super) struct Endpoint {
    identity: Identity,
    profile: String,
    name: String,
    first: NamedPipeServer,
}
impl Endpoint {
    pub fn claim(directory: &Path) -> Result<Self> {
        let identity = Identity::current()?;
        let profile = crate::owner_control::profile_id(directory)?;
        let name = address(&profile);
        let first = listener(&name, &identity, true)?;
        Ok(Self {
            identity,
            profile,
            name,
            first,
        })
    }
    pub fn bind(self, service: Service) -> Result<Source> {
        let Self {
            identity,
            profile,
            name,
            first,
        } = self;
        if service.profile != profile {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let task = tokio::spawn(async move {
            let mut next = first;
            loop {
                next.connect().await?;
                let mut connected = next;
                next = listener(&name, &identity, false)?;
                let exchange = async {
                    let peer = authenticate_with_access(
                        connected.as_raw_handle(),
                        true,
                        &identity,
                        PROCESS_SYNCHRONIZE,
                    )?;
                    live(&peer)?;
                    connected.write_u8(1).await?;
                    let request = Request::parse(&read_frame(&mut connected).await?)?;
                    live(&peer)?;
                    let reply = service.execute(&request);
                    reply.validate(&request, &profile)?;
                    live(&peer)?;
                    write_frame(&mut connected, model::encode(&reply)?.as_bytes()).await?;
                    if connected.read_u8().await? != 0 {
                        bail!("HANDOFF_INVALID_ACK");
                    }
                    live(&peer)
                };
                if !matches!(tokio::time::timeout(BUDGET, exchange).await, Ok(Ok(()))) {
                    tracing::debug!("owner-transfer query refused or timed out");
                }
                connected.disconnect()?;
            }
        });
        Ok(Source { task })
    }
}
pub(super) struct Source {
    pub task: tokio::task::JoinHandle<Result<()>>,
}
impl Source {
    pub async fn close(&mut self) {
        if !self.task.is_finished() {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn connect(name: &str, identity: &Identity) -> Result<(NamedPipeClient, Peer)> {
    loop {
        match ClientOptions::new().open(name) {
            Ok(mut client) => {
                let peer = authenticate_with_access(
                    client.as_raw_handle(),
                    false,
                    identity,
                    PROCESS_SYNCHRONIZE,
                )?;
                live(&peer)?;
                match client.read_u8().await {
                    Ok(1) => {
                        live(&peer)?;
                        return Ok((client, peer));
                    }
                    Ok(_) => bail!("HANDOFF_INVALID_GREETING"),
                    Err(error) if matches!(error.raw_os_error(), Some(109 | 232 | 233)) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) if matches!(error.raw_os_error(), Some(231..=233)) => {}
            Err(error) => return Err(error.into()),
        }
        // No application request has been sent. Never reconnect after a write.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
pub(super) async fn query(directory: &Path, request: &Request) -> Result<Reply> {
    request.validate()?;
    let identity = Identity::current()?;
    let profile = crate::owner_control::profile_id(directory)?;
    tokio::time::timeout(BUDGET, async {
        let (mut pipe, peer) = connect(&address(&profile), &identity).await?;
        live(&peer)?;
        write_frame(&mut pipe, model::encode(request)?.as_bytes()).await?;
        let bytes = read_frame(&mut pipe).await?;
        live(&peer)?;
        let reply: Reply = serde_json::from_slice(&bytes)?;
        reply.validate(request, &profile)?;
        pipe.write_u8(0).await?;
        live(&peer)?;
        Ok(reply)
    })
    .await
    .context("HANDOFF_SOURCE_TIMEOUT")?
}
#[cfg(test)]
mod tests;
