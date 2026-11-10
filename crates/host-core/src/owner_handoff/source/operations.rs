//! One owned operation survives a lost transport waiter; no unbounded queue.
use super::protocol::Body;
use anyhow::{anyhow, bail, Result};
use std::{future::Future, sync::Mutex};
use tokio::{sync::watch, task::JoinHandle};

struct Flight {
    principal: String,
    id: String,
    fingerprint: String,
    result: watch::Receiver<Option<Body>>,
    task: JoinHandle<()>,
}
#[derive(Default)]
struct State {
    closed: bool,
    flight: Option<Flight>,
}
#[derive(Default)]
pub(super) struct Operations(Mutex<State>);
impl Operations {
    pub async fn run<F>(
        &self,
        principal: &str,
        id: &str,
        fingerprint: String,
        work: F,
    ) -> Result<Body>
    where
        F: Future<Output = Body> + Send + 'static,
    {
        let mut receiver = {
            let mut state = self.0.lock().map_err(|_| anyhow!("HANDOFF_UNAVAILABLE"))?;
            if state.closed {
                bail!("HANDOFF_UNAVAILABLE");
            }
            if let Some(flight) = &state.flight {
                if !flight.task.is_finished() {
                    if flight.principal != principal || flight.id != id {
                        bail!("HANDOFF_BUSY");
                    }
                    if flight.fingerprint != fingerprint {
                        bail!("HANDOFF_REQUEST_CONFLICT");
                    }
                    Some(flight.result.clone())
                } else {
                    None
                }
            } else {
                None
            }
            .unwrap_or_else(|| {
                let (sender, receiver) = watch::channel(None);
                let task = tokio::spawn(async move {
                    sender.send_replace(Some(work.await));
                });
                state.flight = Some(Flight {
                    principal: principal.into(),
                    id: id.into(),
                    fingerprint,
                    result: receiver.clone(),
                    task,
                });
                receiver
            })
        };
        let result = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| anyhow!("HANDOFF_UNAVAILABLE"))?
            .clone();
        result.ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))
    }
    pub fn seal(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.closed = true;
    }
    pub async fn close(&self) {
        self.seal();
        let flight = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .flight
            .take();
        if let Some(flight) = flight {
            if let Err(error) = flight.task.await {
                tracing::warn!(%error, "source operation failed during cleanup");
            }
        }
    }
}
impl Drop for Operations {
    fn drop(&mut self) {
        let state = self.0.get_mut().unwrap_or_else(|error| error.into_inner());
        state.closed = true;
        if let Some(flight) = state.flight.take() {
            flight.task.abort();
        }
    }
}

#[cfg(test)]
mod tests;
