//! Authenticated running-source reads. The source retains its data-directory
//! lock; the query client never opens AppState, SQLite or an execution runtime.
#[cfg(any(windows, test))]
mod protocol;
#[cfg(windows)]
mod service;
#[cfg(windows)]
mod windows;
use crate::state::AppState;
use anyhow::Result;
use std::{path::Path, sync::Arc};
use tokio::sync::Mutex;

pub fn validate_cli(args: &[std::ffi::OsString]) -> Result<()> {
    if args.iter().any(|arg| arg == "--owner-source")
        && (args.len() != 1 || args[0] != "--owner-source")
    {
        anyhow::bail!("usage: --owner-source (private framed stdin only)");
    }
    Ok(())
}
pub async fn query_cli(directory: &Path) -> Result<bool> {
    if !std::env::args_os().any(|arg| arg == "--owner-source") {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use crate::{execution_fence::native::Coordinator, owner_control::identity::Identity};
        let coordinator = Coordinator::capture(&Identity::current()?)?;
        let bytes = super::stdio::receive(&coordinator)
            .await?
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_INVALID_REQUEST"))?;
        let request = protocol::Request::parse(&bytes)?;
        let reply = windows::query(directory, &request).await?;
        super::stdio::send(&coordinator, super::model::encode(&reply)?.into_bytes()).await?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        anyhow::bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}

pub struct Endpoint {
    #[cfg(windows)]
    native: Option<windows::Endpoint>,
}
impl Endpoint {
    pub fn claim(directory: &Path, enabled: bool) -> Result<Self> {
        #[cfg(windows)]
        {
            Ok(Self {
                native: enabled
                    .then(|| windows::Endpoint::claim(directory))
                    .transpose()?,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = directory;
            if enabled {
                anyhow::bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED");
            }
            Ok(Self {})
        }
    }
    pub fn bind(self, state: Arc<Mutex<AppState>>) -> Result<Source> {
        #[cfg(windows)]
        {
            let native = self
                .native
                .map(|endpoint| {
                    let service = service::Service::capture(state)?
                        .ok_or_else(|| anyhow::anyhow!("HANDOFF_OWNER_CHANGED"))?;
                    endpoint.bind(service)
                })
                .transpose()?;
            Ok(Source { native })
        }
        #[cfg(not(windows))]
        {
            let _ = state;
            Ok(Source {})
        }
    }
}
pub struct Source {
    #[cfg(windows)]
    native: Option<windows::Source>,
}
impl Source {
    pub async fn serve<F>(mut self, serving: F) -> Result<()>
    where
        F: std::future::Future<Output = Result<()>>,
    {
        #[cfg(windows)]
        {
            let Some(source) = self.native.as_mut() else {
                return serving.await;
            };
            let result = tokio::select! {
                result = serving => result,
                result = &mut source.task => match result { Ok(result) => result, Err(error) => Err(error.into()) },
            };
            source.close().await;
            result
        }
        #[cfg(not(windows))]
        {
            serving.await
        }
    }
}
#[cfg(test)]
mod tests;
