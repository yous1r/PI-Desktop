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

#[cfg(test)]
mod tests;
