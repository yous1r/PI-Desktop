//! Request deadlines and durability keep their original wire semantics. A
//! deadline releases RPC capacity, but never certifies native work as closed.
use super::JsonRpcError;
use crate::owner_handoff::activity::Activity;
use serde_json::{json, Value};
use std::future::Future;
use std::time::Duration;

pub(super) async fn execute<F>(
    activity: &Activity,
    budget: Option<u64>,
    future: F,
) -> (Result<Value, JsonRpcError>, anyhow::Result<()>)
where
    F: Future<Output = Result<Value, JsonRpcError>>,
{
    let result = activity
        .scope(crate::transcripts::commit_writes_of(with_request_budget(
            budget, future,
        )))
        .await;
    if result.1.is_err() {
        activity.mark_uncertain();
    }
    result
}

/// The budget interrupts only at an await point. Blocking/native work can
/// survive dropping its waiter, so timeout is sticky handoff uncertainty.
pub(super) async fn with_request_budget<F>(
    budget: Option<u64>,
    future: F,
) -> Result<Value, JsonRpcError>
where
    F: Future<Output = Result<Value, JsonRpcError>>,
{
    let Some(budget) = budget else {
        return future.await;
    };
    match tokio::time::timeout(Duration::from_millis(budget), future).await {
        Ok(result) => result,
        Err(_) => {
            if let Some(activity) = Activity::current() {
                activity.mark_uncertain();
            }
            tracing::warn!(
                budget_ms = budget,
                "rpc request exceeded its wall-clock budget; slot released"
            );
            Err(JsonRpcError {
                code: -32030,
                message: format!("host rpc budget of {budget}ms exceeded"),
                data: Some(json!({ "errorCode": "HOST_RPC_TIMEOUT" })),
            })
        }
    }
}

#[cfg(test)]
mod tests;
