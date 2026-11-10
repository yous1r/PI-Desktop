//! One bounded reverse exchange on the original normal Host stdio channel.
//! This is transport lifetime, not admission or journal authority.
use super::{
    exchange_protocol::{self as protocol, Completion, Notification, Outcome, Request},
    model,
};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Duration, Instant},
};

struct Pending {
    notification: Notification,
    deadline: Instant,
    answer: Option<oneshot::Sender<Outcome>>,
}
#[derive(Default)]
struct State {
    pending: Option<Pending>,
    closed: bool,
    output: Option<mpsc::UnboundedSender<String>>,
}
impl State {
    fn close(&mut self) {
        self.closed = true;
        self.pending = None;
        self.output = None;
    }
}
pub struct Exchange {
    state: Mutex<State>,
}
pub struct Lifetime(Arc<Exchange>);
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.0.close();
    }
}
struct Reservation<'a> {
    exchange: &'a Exchange,
    consumed: bool,
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if self.consumed {
            if let Ok(mut state) = self.exchange.state.lock() {
                state.pending = None;
            }
        } else {
            self.exchange.close();
        }
    }
}
impl Exchange {
    pub fn new(output: mpsc::UnboundedSender<String>) -> Self {
        Self {
            state: Mutex::new(State {
                output: Some(output),
                ..State::default()
            }),
        }
    }
    pub fn lifetime(self: &Arc<Self>) -> Lifetime {
        Lifetime(self.clone())
    }
    pub fn close(&self) {
        // Poisoned state cannot be used again; still release the original waiter.
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.close();
    }
    /// The authenticated source service supplies its validated original owner.
    /// No caller-selected exchange ID or arbitrary RPC initiates this operation.
    pub async fn request(&self, profile: &str, mut request: Request) -> Result<Outcome> {
        request.exchange_id = uuid::Uuid::new_v4().to_string();
        self.wait(
            Notification {
                version: model::VERSION,
                profile_id: profile.into(),
                request,
            },
            Instant::now() + Duration::from_millis(protocol::TIMEOUT_MS),
        )
        .await
    }
    async fn wait(&self, notification: Notification, deadline: Instant) -> Result<Outcome> {
        notification.validate()?;
        let raw = model::encode(
            &json!({"jsonrpc":"2.0","method":protocol::NOTIFY,"params":notification}),
        )?;
        let (answer, result) = oneshot::channel();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
            if state.closed {
                bail!("HANDOFF_EXCHANGE_UNAVAILABLE");
            }
            if state.pending.is_some() {
                bail!("HANDOFF_BUSY");
            }
            state.pending = Some(Pending {
                notification,
                deadline,
                answer: Some(answer),
            });
        }
        let mut reservation = Reservation {
            exchange: self,
            consumed: false,
        };
        {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
            state
                .output
                .as_ref()
                .ok_or_else(|| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?
                .send(format!("{raw}\n"))
                .map_err(|_| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
        }
        let outcome = tokio::time::timeout_at(deadline, result)
            .await
            .map_err(|_| anyhow!("HANDOFF_EXCHANGE_TIMEOUT"))?
            .map_err(|_| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
        {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
            if state.closed || Instant::now() >= deadline {
                bail!("HANDOFF_EXCHANGE_UNAVAILABLE");
            }
        }
        reservation.consumed = true;
        Ok(outcome)
    }
    pub fn complete(&self, value: Value, epoch: &str, profile: &str) -> Result<Value> {
        model::encode(&value)?;
        let completion: Completion = serde_json::from_value(value)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
        if state.closed {
            bail!("HANDOFF_EXCHANGE_UNAVAILABLE");
        }
        let pending = state
            .pending
            .as_mut()
            .ok_or_else(|| anyhow!("HANDOFF_EXCHANGE_UNKNOWN"))?;
        completion.validate(&pending.notification)?;
        if pending.notification.request.source_epoch != epoch
            || pending.notification.profile_id != profile
        {
            state.close();
            bail!("HANDOFF_OWNER_CHANGED");
        }
        if Instant::now() >= pending.deadline {
            state.close();
            bail!("HANDOFF_EXCHANGE_TIMEOUT");
        }
        let answer = pending
            .answer
            .take()
            .ok_or_else(|| anyhow!("HANDOFF_EXCHANGE_DUPLICATE"))?;
        if answer.send(completion.outcome).is_err() {
            state.close();
            bail!("HANDOFF_EXCHANGE_UNAVAILABLE");
        }
        Ok(
            json!({"version":model::VERSION,"exchangeId":completion.request.exchange_id,"accepted":true}),
        )
    }
}

pub async fn complete(
    state: Arc<tokio::sync::Mutex<crate::state::AppState>>,
    value: Value,
) -> Result<Value> {
    #[cfg(windows)]
    {
        let state = state.try_lock().map_err(|_| anyhow!("HANDOFF_BUSY"))?;
        let channel = state
            .handoff_exchange
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_EXCHANGE_UNAVAILABLE"))?;
        let identity = state
            .execution_fence
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_OWNER_UNAVAILABLE"))
            .and_then(|registry| registry.read_source(None));
        match identity {
            Ok((epoch, profile, _)) => channel.complete(value, &epoch, &profile),
            Err(error) => {
                channel.close();
                Err(error)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (state, value);
        bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
    }
}
#[cfg(test)]
mod tests;
