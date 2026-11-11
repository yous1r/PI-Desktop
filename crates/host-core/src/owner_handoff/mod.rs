//! Rust-owned execution registration and idle handoff journal.
pub(crate) mod activity;
#[cfg(windows)]
mod build;
#[cfg(windows)]
mod cli;
pub(crate) mod exchange;
pub(crate) mod exchange_protocol;
pub(crate) mod inspection;
pub(crate) mod model;
#[cfg(windows)]
pub(crate) mod native;
pub(crate) mod query;
pub(crate) mod read_budget;
pub(crate) mod repository;
#[cfg(any(windows, test))]
mod service;
pub(crate) mod source;
mod source_read;
pub(crate) mod startup;
#[cfg(windows)]
mod stdio;
pub(crate) mod target;
#[cfg(any(windows, test))]
mod transitions;

pub fn validate_cli() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    validate_args(&args)
}

/// Each private mode owns its whole argv surface. `--owner-target` is parsed by
/// the target module and can never be combined with another mode or argument.
fn validate_args(args: &[std::ffi::OsString]) -> anyhow::Result<()> {
    source::validate_cli(args)?;
    if args.iter().any(|arg| arg == "--owner-handoff")
        && (args.len() != 1 || args[0] != "--owner-handoff")
    {
        anyhow::bail!("usage: --owner-handoff (private framed stdin only)");
    }
    target::requested(args)?;
    Ok(())
}

pub async fn run_cli(
    directory: &std::path::Path,
    data_owner: &mut Option<crate::data_directory_owner::DataDirectoryOwner>,
) -> anyhow::Result<bool> {
    if !std::env::args_os().any(|arg| arg == "--owner-handoff") {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        cli::run(directory, data_owner).await?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (directory, data_owner);
        anyhow::bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}

#[cfg(test)]
mod tests;
