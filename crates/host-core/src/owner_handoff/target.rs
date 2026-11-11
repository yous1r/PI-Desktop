//! Restricted successor bootstrap and readiness. No scheduler, recovery replay,
//! admission reopening, or generic phase-advance entry point lives here.
//!
//! Integration must retain the directory lock outside the Tokio runtime, adopt
//! the captured owner/coordinator in the execution registry, and keep both Rust
//! and Node admission closed until an original-resource readiness commit. The
//! same Rust process that claims must continue serving. A historical receipt is
//! not permission to admit work.
mod bootstrap;
mod journal;
mod preparation;
mod protocol;
mod ready;
mod ready_resources;
#[cfg(windows)]
pub(crate) mod serving;
#[cfg(windows)]
mod windows;

pub(crate) use bootstrap::TargetBootstrap;
pub(crate) use preparation::{PreparedGeneration, RegisteredGeneration};
pub(crate) use protocol::{BootstrapRequest, ReadyRequest};
pub(crate) use ready::{EventStream, ReadyOutcome, ReadyPublication, ReadyResources, ReadyTarget};
#[cfg(windows)]
pub(crate) use windows::{receive, NativeTarget};

use anyhow::{bail, Result};
use std::ffi::OsString;
use std::path::Path;

pub(crate) const FLAG: &str = "--owner-target";

/// The mode flag is the entire argv surface. Capability and identities belong
/// exclusively to the inherited framed channel, not argv or environment.
pub(crate) fn requested(args: &[OsString]) -> Result<bool> {
    let present = args.iter().any(|arg| arg == FLAG);
    if present && (args.len() != 1 || args[0] != FLAG) {
        bail!("usage: --owner-target (private framed stdin only)");
    }
    Ok(present)
}

/// Entry for the restricted successor bootstrap. `main` calls this only after
/// argv was validated as the exclusive `--owner-target` mode and before it
/// creates the data directory, acquires the directory lock, opens AppState, or
/// runs startup inspection/recovery/migration.
///
/// This build claims the transfer, performs restricted target initialization
/// (one unrooted durable generation), commits `ReadyTarget` and sends the
/// bounded ReadyOutcome frame. It then stays the same process until the
/// supervisor closes the private channel; ordinary startup/RPC serving is not
/// reachable from this mode.
pub(crate) async fn run(directory: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let native = windows::receive(directory).await?;
        windows::publish_ready(native).await?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}

/// Testable split between the process entry and the native private transport.
/// The closure stands in for `windows::receive`, so entry tests can prove that
/// every transport failure is propagated and never reaches ordinary startup.
#[cfg(test)]
async fn dispatch<T, F, Fut>(directory: std::path::PathBuf, receive: F) -> Result<T>
where
    F: FnOnce(std::path::PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    receive(directory).await
}

#[cfg(test)]
mod tests;
