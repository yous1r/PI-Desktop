//! Immutable production ports for the original Rust/stdio/native owner.
use super::{controller::Ports, release::Release};
use crate::{
    execution_fence::SourceOwner,
    owner_handoff::{
        activity::Activity,
        exchange::Exchange,
        exchange_protocol::{Outcome, Request},
        inspection,
        model::Owner,
        repository::Journal,
    },
    state::AppState,
};
use anyhow::{anyhow, bail, Result};
use std::sync::{Arc, Mutex as JournalMutex};
use tokio::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) struct Native {
    state: Arc<Mutex<AppState>>,
    original: SourceOwner,
    exchange: Arc<Exchange>,
    activity: Activity,
    release: Release,
}
impl Native {
    pub fn capture(state: Arc<Mutex<AppState>>, epoch: &str, profile: &str) -> Result<Self> {
        let guard = state.try_lock().map_err(|_| anyhow!("HANDOFF_BUSY"))?;
        if guard.shutting_down {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let original = guard
            .execution_fence
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_OWNER_CHANGED"))?
            .capture_source()?;
        if original.owner().epoch != epoch || original.owner().profile != profile {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let exchange = guard
            .handoff_exchange
            .clone()
            .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?;
        let activity = guard.handoff_activity.clone();
        let release = guard.handoff_release.clone();
        drop(guard);
        Ok(Self {
            state,
            original,
            exchange,
            activity,
            release,
        })
    }
    fn current(&self, guard: &AppState) -> Result<()> {
        if guard.shutting_down
            || guard
                .handoff_exchange
                .as_ref()
                .is_none_or(|exchange| !Arc::ptr_eq(exchange, &self.exchange))
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        guard
            .execution_fence
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_OWNER_CHANGED"))?
            .matches_source(&self.original)
    }
}
impl Ports for Native {
    fn owner(&self) -> &Owner {
        self.original.owner()
    }
    fn generation(&self) -> &str {
        self.original.generation()
    }
    fn activity(&self) -> &Activity {
        &self.activity
    }
    fn journal(&self) -> Arc<JournalMutex<Journal>> {
        self.original.journal()
    }
    async fn check(&self) -> Result<()> {
        let guard = self.state.try_lock().map_err(|_| anyhow!("HANDOFF_BUSY"))?;
        self.current(&guard)
    }
    async fn idle(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let result = match self.state.try_lock() {
                Ok(guard) => self
                    .current(&guard)
                    .and_then(|_| inspection::require_idle(&guard)),
                Err(_) => Err(anyhow!("HANDOFF_BUSY")),
            };
            match result {
                Ok(()) => return Ok(()),
                Err(error) if error.to_string() == "HANDOFF_BUSY" && Instant::now() < deadline => {}
                Err(error) => return Err(error),
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    async fn exchange(&self, request: Request) -> Result<Outcome> {
        self.exchange
            .request(&self.original.owner().profile, request)
            .await
    }
    async fn stop(&self) -> Result<()> {
        self.check().await?;
        self.original.stop(2_000).await?;
        self.check().await
    }
    async fn release(&self) -> Result<()> {
        self.check().await?;
        self.release.request();
        Ok(())
    }
}
