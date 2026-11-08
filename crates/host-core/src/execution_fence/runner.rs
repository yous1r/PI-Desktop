//! Stateless trusted launcher: no Node entry or preload runs before admission.
use super::windows::{Ticket, START_TIMEOUT};
use crate::owner_control::identity::{authenticate, Identity};
use crate::owner_control::protocol::{read_frame, write_frame};
use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::os::windows::io::AsRawHandle;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;

pub async fn run(args: &[OsString]) -> Result<i32> {
    if args.len() < 3 || args[1] != "--" {
        bail!("invalid internal execution runner arguments");
    }
    let encoded =
        std::env::var("PI_EXECUTION_TICKET").context("EXECUTION_FENCE_TICKET_REQUIRED")?;
    if encoded.len() > 16 * 1024 {
        bail!("EXECUTION_FENCE_TICKET_INVALID");
    }
    let ticket: Ticket =
        serde_json::from_str(&encoded).context("EXECUTION_FENCE_TICKET_INVALID")?;
    if ticket.version != 1
        || uuid::Uuid::parse_str(&ticket.generation).is_err()
        || uuid::Uuid::parse_str(&ticket.capability).is_err()
        || ticket.address != format!(r"\\.\pipe\pi-execution-v1-{}", ticket.generation)
    {
        bail!("EXECUTION_FENCE_TICKET_INVALID");
    }
    let identity = Identity::current()?;
    tokio::time::timeout(START_TIMEOUT, async {
        let mut pipe = ClientOptions::new()
            .open(&ticket.address)
            .context("EXECUTION_FENCE_UNAVAILABLE")?;
        let owner = authenticate(pipe.as_raw_handle(), false, &identity)?;
        if owner.pid != ticket.owner_pid
            || owner.identity.created_at.to_string() != ticket.owner_created_at
        {
            bail!("EXECUTION_FENCE_OWNER_MISMATCH");
        }
        if pipe.read_u8().await? != 1 {
            bail!("EXECUTION_FENCE_INVALID_GREETING");
        }
        write_frame(&mut pipe, &serde_json::to_vec(&ticket)?).await?;
        if read_frame(&mut pipe).await? != ticket.generation.as_bytes() {
            bail!("EXECUTION_FENCE_INVALID_ADMISSION");
        }
        pipe.write_u8(0).await?;
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("EXECUTION_FENCE_START_TIMEOUT")??;
    let mut child = tokio::process::Command::new(&args[2])
        .args(&args[3..])
        .env_remove("PI_EXECUTION_TICKET")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("EXECUTION_FENCE_RUNTIME_START_FAILED")?;
    Ok(child.wait().await?.code().unwrap_or(1))
}
