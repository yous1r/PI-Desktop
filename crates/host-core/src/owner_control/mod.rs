//! Opt-in owner discovery. This is not an execution-transfer or arbitrary RPC channel.
#[cfg(windows)]
pub(crate) mod identity;
#[cfg(any(windows, test))]
pub(crate) mod protocol;
#[cfg(windows)]
mod windows;

use anyhow::{bail, Result};
use std::path::Path;

#[cfg(windows)]
pub(crate) fn profile_id(directory: &Path) -> Result<String> {
    Ok(windows::address(directory, &identity::Identity::current()?)?.1)
}

pub fn validate_cli() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--owner-status") {
        if args.first().map(String::as_str) != Some("--owner-status")
            || args.len() > 2
            || args.get(1).is_some_and(|arg| arg.starts_with("--"))
        {
            bail!("usage: --owner-status [expected-owner-epoch]");
        }
    } else if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--owner-control" | "--execution-fence"))
    {
        let valid = args
            .iter()
            .all(|arg| matches!(arg.as_str(), "--owner-control" | "--execution-fence"));
        let unique = args.iter().collect::<std::collections::HashSet<_>>().len() == args.len();
        if !valid || !unique {
            bail!("owner modes cannot be combined with other modes");
        }
    }
    Ok(())
}

pub async fn query_cli(directory: &Path) -> Result<bool> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--owner-status") {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        let result = windows::query(directory, args.get(1).cloned()).await?;
        println!("{}", serde_json::to_string(&result)?);
        if result.error.is_some() {
            bail!("OWNER_CONTROL_REQUEST_REFUSED");
        }
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        bail!("OWNER_CONTROL_UNSUPPORTED");
    }
}

pub struct Control {
    #[cfg(windows)]
    native: Option<windows::Control>,
}
impl Control {
    /// Claim the discovery endpoint after the data lock, before AppState/recovery.
    pub fn start(directory: &Path, epoch: Option<&str>) -> Result<Self> {
        let enabled = std::env::args().any(|arg| arg == "--owner-control");
        #[cfg(windows)]
        {
            Ok(Self {
                native: enabled
                    .then(|| {
                        windows::Control::start_with_epoch(
                            directory,
                            epoch
                                .map(str::to_owned)
                                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                        )
                    })
                    .transpose()?,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (directory, epoch);
            if enabled {
                bail!("OWNER_CONTROL_UNSUPPORTED");
            }
            Ok(Self {})
        }
    }
    pub async fn serve<F>(self, serving: F) -> Result<()>
    where
        F: std::future::Future<Output = Result<()>>,
    {
        #[cfg(windows)]
        {
            let mut native = self.native;
            let Some(control) = native.as_mut() else {
                return serving.await;
            };
            let result = tokio::select! {
                result = serving => result,
                result = &mut control.task => match result {
                    Ok(result) => result,
                    Err(error) => Err(error.into()),
                },
            };
            control.close().await;
            result
        }
        #[cfg(not(windows))]
        {
            serving.await
        }
    }
}
