//! Target-mode RPC serving adapter over the inherited private framed channel.
//!
//! Integration contract for the Lead: `rpc/mod.rs` must declare this child
//! module (`mod target_serve;`) and the target entry calls
//! `crate::rpc::target_serve::serve_target(state).await` after the Ready frame.
//! The file is intentionally absent from `rpc/mod.rs` in this lane.
//!
//! The adapter refuses before reading any request unless both a live event
//! epoch and a real adopted execution generation exist. A missing sidecar root
//! or hub epoch is an explicit `HANDOFF_TARGET_SERVING_UNAVAILABLE`; it is never
//! replaced with a generated epoch or a transport-only success.
#[cfg(windows)]
use crate::owner_handoff::target::serving::{serve_framed, RpcRequest, SERVING_UNAVAILABLE};
use crate::state::AppState;
use anyhow::{bail, Result};
#[cfg(windows)]
use serde_json::{json, Value};
use std::sync::Arc;
#[cfg(windows)]
use tokio::sync::mpsc;
use tokio::sync::Mutex;

/// Serve bounded framed JSON-RPC after Ready. Requests run serially and use the
/// ordinary admission, budget, request-lifetime and response mapping.
#[cfg(windows)]
pub(crate) async fn serve_target(state: Arc<Mutex<AppState>>) -> Result<()> {
    {
        let st = state.lock().await;
        if st.event_epoch().is_none() {
            bail!("{SERVING_UNAVAILABLE}");
        }
        let generation = st
            .execution_fence
            .as_ref()
            .and_then(|registry| registry.active_generation());
        if generation.is_none() {
            bail!("{SERVING_UNAVAILABLE}");
        }
    }
    let activity = state.lock().await.handoff_activity.clone();
    // Notifications are not part of this skeleton; dropping the receiver makes
    // handler-side sends harmless while responses keep their ordinary shape.
    let (tx, _rx) = mpsc::unbounded_channel::<String>();
    serve_framed(
        tokio::io::stdin(),
        tokio::io::stdout(),
        move |request: RpcRequest| {
            let state = state.clone();
            let activity = activity.clone();
            let tx = tx.clone();
            async move {
                let obligation = match super::admission::admit(&activity, &request.method) {
                    Ok(obligation) => obligation,
                    Err(error) => {
                        return serde_json::to_value(super::JsonRpcResponse {
                            jsonrpc: "2.0",
                            id: request.id,
                            result: None,
                            error: Some(error),
                        })
                        .unwrap_or(Value::Null)
                    }
                };
                let (handled, committed) = super::request_lifetime::execute(
                    &activity,
                    super::request_budget_ms(&request.method, &request.params),
                    super::handle_request(state, &request.method, request.params, tx),
                )
                .await;
                let response = super::response_for(request.id, handled, committed);
                if let Some(obligation) = obligation {
                    obligation.finish(true);
                }
                serde_json::to_value(response).unwrap_or_else(|_| {
                    json!({"jsonrpc":"2.0","id":Value::Null,
                           "error":{"code":1000,"message":"response encoding failed"}})
                })
            }
        },
    )
    .await
}

#[cfg(not(windows))]
pub(crate) async fn serve_target(_: Arc<Mutex<AppState>>) -> Result<()> {
    bail!("HANDOFF_NATIVE_PROOF_UNSUPPORTED")
}
