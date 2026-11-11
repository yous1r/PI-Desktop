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
#[cfg(windows)]
mod windows;

pub(crate) use bootstrap::TargetBootstrap;
pub(crate) use preparation::{PreparedGeneration, RegisteredGeneration};
pub(crate) use protocol::BootstrapRequest;
pub(crate) use ready::{EventStream, ReadyOutcome, ReadyPublication, ReadyResources, ReadyTarget};
#[cfg(windows)]
pub(crate) use windows::{receive, NativeTarget};

use anyhow::{bail, Result};
use std::ffi::OsString;
use std::path::Path;

pub(crate) const FLAG: &str = "--owner-target";

/// Documented refusal for the reachable tail of this mode in this build. The
/// claim is committed and its framed result is sent, but there is no supervisor
/// that adopts the captured owner/coordinator and no original-resource
/// [`ReadyResources`] owner that could publish Ready. Keeping the process alive
/// anyway would fake readiness, so it stops instead. The durable claim stays
/// recoverable through the explicit Recover command; admission never opens and
/// no AppState, migration, scheduler or recovery replay is started.
///
/// Process contract observed by the Node supervisor: after the framed claim
/// receipt is written, the target process ends with this classified code on
/// stderr (non-zero exit). The supervisor treats any such exit as terminal,
/// never as Ready, and must dispose the original child. This code is stable and
/// distinct from transport, claim and Ready refusals; do not replace it with a
/// permissive tail or a second serving process.
pub(crate) const ADOPTION_UNAVAILABLE: &str = "HANDOFF_TARGET_ADOPTION_UNAVAILABLE";

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
/// This build cannot return `Ok(())` from the target mode: after a successful
/// claim there is no supervisor adoption or Ready publication, so the reachable
/// part ends in [`ADOPTION_UNAVAILABLE`] instead of falling through to ordinary
/// startup. A later build may replace only this tail with the Ready path and
/// restricted serving loop.
pub(crate) async fn run(directory: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        dispatch(directory.to_path_buf(), |directory| async move {
            windows::receive(&directory).await
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}

/// Testable split between the process entry and the native private transport.
/// The claimed value (directory lock, captured owner and coordinator) is
/// retained until the refusal is decided and only then dropped. Nothing here
/// opens AppState, migrates, schedules, replays recovery, or publishes Ready.
#[cfg(any(windows, test))]
async fn dispatch<T, F, Fut>(directory: std::path::PathBuf, receive: F) -> Result<()>
where
    F: FnOnce(std::path::PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let claimed = receive(directory).await?;
    // Deliberately not adopted into any registry: doing that without the
    // supervisor side would advertise ownership this process cannot publish.
    let _retained = &claimed;
    bail!("{ADOPTION_UNAVAILABLE}")
}

#[cfg(test)]
mod tests;
