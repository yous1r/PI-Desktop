//! Wire validation and error mapping for profile-global personal todo RPCs.

use serde::Deserialize;
use serde_json::Value;

use super::{rpc_err, JsonRpcError};
use crate::db::Database;
use crate::personal_todos::{self, PersonalTodoDocument, PersonalTodoReplace, ReplaceError};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetParams {}

pub fn get_from(db: &Database, params: Value) -> Result<Value, JsonRpcError> {
    let _: GetParams = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let document =
        personal_todos::get(db).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    serialize_document(document)
}

pub fn replace_from(db: &Database, params: Value) -> Result<Value, JsonRpcError> {
    let request: PersonalTodoReplace = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let document = personal_todos::replace(db, &request).map_err(replace_error)?;
    serialize_document(document)
}

fn serialize_document(document: PersonalTodoDocument) -> Result<Value, JsonRpcError> {
    serde_json::to_value(document).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
}

fn replace_error(error: ReplaceError) -> JsonRpcError {
    match error {
        ReplaceError::InvalidArgument(message) => rpc_err(1002, message, "INVALID_ARGUMENT"),
        ReplaceError::LimitExceeded(message) => rpc_err(1002, message, "LIMIT_EXCEEDED"),
        ReplaceError::Conflict => rpc_err(1008, "personal todo revision conflict", "CONFLICT"),
        ReplaceError::IdempotencyConflict => rpc_err(
            1008,
            "mutationId was already used with a different request",
            "IDEMPOTENCY_CONFLICT",
        ),
        ReplaceError::Internal(error) => rpc_err(1000, error.to_string(), "INTERNAL"),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use super::*;
    use crate::rpc::{handle_request, AppState};
    use serde_json::json;
    use tokio::sync::{mpsc, Mutex};

    struct Harness {
        state: Arc<Mutex<AppState>>,
        _data_dir: tempfile::TempDir,
    }

    impl Harness {
        fn new() -> Self {
            let data_dir = tempfile::tempdir().unwrap();
            fs::create_dir_all(data_dir.path().join("project")).unwrap();
            let mut app_state = AppState::open(data_dir.path()).unwrap();
            app_state.handshook = true;
            Self {
                state: Arc::new(Mutex::new(app_state)),
                _data_dir: data_dir,
            }
        }
        async fn call(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
            let (tx, _rx) = mpsc::unbounded_channel();
            handle_request(self.state.clone(), method, params, tx).await
        }
    }

    #[tokio::test]
    async fn raw_document_strict_shapes_cas_and_idempotency_are_exposed() {
        let harness = Harness::new();
        assert_eq!(
            harness.call("personalTodos.get", json!({})).await.unwrap(),
            json!({"schemaVersion":1,"revision":0,"updatedAt":null,"items":[]})
        );
        let wrong_get = harness
            .call("personalTodos.get", json!({"sessionId":"x"}))
            .await
            .unwrap_err();
        assert_eq!(wrong_get.data.unwrap()["errorCode"], "INVALID_PARAMS");
        let saved = harness
            .call(
                "personalTodos.replace",
                json!({
                    "items":[{"id":"one","title":"","note":"note","completed":false}],
                    "expectedRevision":0,"mutationId":"m1"
                }),
            )
            .await
            .unwrap();
        assert_eq!(saved["revision"], 1);
        assert!(saved.get("document").is_none());
        for extra in [
            json!({"items":[],"expectedRevision":1,"mutationId":"m2","extra":true}),
            json!({"items":[{"id":"x","title":"x","note":"","completed":false,"extra":true}],"expectedRevision":1,"mutationId":"m2"}),
        ] {
            assert_eq!(
                harness
                    .call("personalTodos.replace", extra)
                    .await
                    .unwrap_err()
                    .data
                    .unwrap()["errorCode"],
                "INVALID_PARAMS"
            );
        }
        let mismatch = harness
            .call(
                "personalTodos.replace",
                json!({
                    "items":[{"id":"one","title":"changed","note":"note","completed":false}],
                    "expectedRevision":0,"mutationId":"m1"
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(mismatch.data.unwrap()["errorCode"], "IDEMPOTENCY_CONFLICT");
        let stale = harness
            .call(
                "personalTodos.replace",
                json!({"items":[],"expectedRevision":0,"mutationId":"stale"}),
            )
            .await
            .unwrap_err();
        assert_eq!(stale.data.unwrap()["errorCode"], "CONFLICT");
    }

    #[tokio::test]
    async fn rpc_distinguishes_invalid_and_oversized_input_without_mutation() {
        let harness = Harness::new();
        let invalid = harness
            .call(
                "personalTodos.replace",
                json!({
                    "items":[{"id":"","title":"","note":"","completed":false}],
                    "expectedRevision":0,"mutationId":"m1"
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(invalid.data.unwrap()["errorCode"], "INVALID_ARGUMENT");
        let items = (0..201)
            .map(|i| json!({"id":i.to_string(),"title":"","note":"","completed":false}))
            .collect::<Vec<_>>();
        let too_many = harness
            .call(
                "personalTodos.replace",
                json!({"items":items,"expectedRevision":0,"mutationId":"m2"}),
            )
            .await
            .unwrap_err();
        assert_eq!(too_many.data.unwrap()["errorCode"], "LIMIT_EXCEEDED");
        assert_eq!(
            harness.call("personalTodos.get", json!({})).await.unwrap()["revision"],
            0
        );
    }
}
