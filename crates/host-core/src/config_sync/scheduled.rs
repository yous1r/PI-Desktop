//! Reserve before the whole automatic tick: even a local debounce poll can
//! capture domains and persist configuration before it makes a network call.
use super::{coordinator, AppState};
use crate::owner_handoff::activity::{Activity, Ingress};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub(crate) struct ScheduledSync {
    state: Arc<Mutex<AppState>>,
    activity: Activity,
}
impl ScheduledSync {
    pub async fn capture(state: Arc<Mutex<AppState>>) -> Self {
        let activity = state.lock().await.handoff_activity.clone();
        Self { state, activity }
    }

    pub async fn tick(&self, tx: mpsc::UnboundedSender<String>) {
        let Ok(obligation) = self.activity.admit(Ingress::Background) else {
            return;
        };
        let result = self
            .activity
            .scope(coordinator::sync_if_enabled(self.state.clone(), tx))
            .await;
        obligation.finish(result.is_ok());
    }
}

#[cfg(test)]
#[path = "scheduled/tests.rs"]
mod tests;
