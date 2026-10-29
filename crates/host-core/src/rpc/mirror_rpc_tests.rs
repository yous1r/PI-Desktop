//! RPC-level tests for the `mirror.*` methods: the wire shape a caller sees,
//! the parameter refusals, and that the durable rows survive a second call.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::handle_request;
use crate::state::AppState;

async fn fixture() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    (dir, Arc::new(Mutex::new(app)))
}

async fn call(state: &Arc<Mutex<AppState>>, method: &str, params: Value) -> Result<Value, Value> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0)
        .await
        .map_err(|error| {
            json!({
                "code": error.code,
                "errorCode": error.data.as_ref().and_then(|data| data.get("errorCode")).cloned(),
            })
        })
}

fn baseline(rel_path: &str, size: i64, digest: &str) -> Value {
    json!({
        "relPath": rel_path,
        "size": size,
        "mtimeMs": 1_700_000_000_000i64,
        "sha256": digest,
        "syncedAt": 1_700_000_000_000i64,
    })
}

const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn baseline_round_trips_through_the_rpc_surface() {
    let (_dir, state) = fixture().await;
    let project = json!("group-mirror");

    let empty = call(
        &state,
        "mirror.baseline.list",
        json!({ "projectId": project }),
    )
    .await
    .unwrap();
    assert_eq!(empty["entries"].as_array().unwrap().len(), 0);

    let replaced = call(
        &state,
        "mirror.baseline.replace",
        json!({
            "projectId": project,
            "entries": [baseline("src/a.rs", 10, DIGEST), baseline("src/b.rs", 20, DIGEST)],
        }),
    )
    .await
    .unwrap();
    assert_eq!(replaced["count"], 2);

    let listed = call(
        &state,
        "mirror.baseline.list",
        json!({ "projectId": project }),
    )
    .await
    .unwrap();
    let entries = listed["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    // Sorted by relative path, and camelCase on the wire.
    assert_eq!(entries[0]["relPath"], "src/a.rs");
    assert_eq!(entries[0]["mtimeMs"], 1_700_000_000_000i64);

    // Upsert overwrites the same path instead of adding a row.
    let upserted = call(
        &state,
        "mirror.baseline.entry.upsert",
        json!({ "projectId": project, "entry": baseline("src/a.rs", 11, DIGEST) }),
    )
    .await
    .unwrap();
    assert_eq!(upserted["entry"]["size"], 11);
    let listed = call(
        &state,
        "mirror.baseline.list",
        json!({ "projectId": project }),
    )
    .await
    .unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 2);
    assert_eq!(listed["entries"][0]["size"], 11);

    let deleted = call(
        &state,
        "mirror.baseline.entry.delete",
        json!({ "projectId": project, "relPath": "src/a.rs" }),
    )
    .await
    .unwrap();
    assert_eq!(deleted["removed"], true);
    let deleted_again = call(
        &state,
        "mirror.baseline.entry.delete",
        json!({ "projectId": project, "relPath": "src/a.rs" }),
    )
    .await
    .unwrap();
    assert_eq!(deleted_again["removed"], false);

    let cleared = call(
        &state,
        "mirror.baseline.clear",
        json!({ "projectId": project }),
    )
    .await
    .unwrap();
    assert_eq!(cleared["removed"], 1);
}

#[tokio::test]
async fn breakpoints_round_trip_and_upsert_is_idempotent() {
    let (_dir, state) = fixture().await;
    let project = json!("group-mirror");

    let record = json!({
        "relPath": "src/main.rs",
        "line": 12,
        "column": 0,
        "condition": Value::Null,
        "enabled": true,
        "updatedAt": 5,
    });
    call(
        &state,
        "mirror.breakpoint.upsert",
        json!({ "projectId": project, "breakpoint": record }),
    )
    .await
    .unwrap();

    // The same position toggled off must update, not duplicate.
    let mut toggled = record.clone();
    toggled["enabled"] = json!(false);
    call(
        &state,
        "mirror.breakpoint.upsert",
        json!({ "projectId": project, "breakpoint": toggled }),
    )
    .await
    .unwrap();

    let listed = call(
        &state,
        "mirror.breakpoints.list",
        json!({ "projectId": project }),
    )
    .await
    .unwrap();
    let rows = listed["breakpoints"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["enabled"], false);
    assert_eq!(rows[0]["relPath"], "src/main.rs");

    let removed = call(
        &state,
        "mirror.breakpoint.delete",
        json!({ "projectId": project, "relPath": "src/main.rs", "line": 12 }),
    )
    .await
    .unwrap();
    assert_eq!(removed["removed"], true);

    let cleared = call(
        &state,
        "mirror.breakpoints.replace",
        json!({ "projectId": project, "breakpoints": [] }),
    )
    .await
    .unwrap();
    assert_eq!(cleared["count"], 0);
}

#[tokio::test]
async fn malformed_mirror_requests_are_refused_before_anything_is_stored() {
    let (_dir, state) = fixture().await;

    let missing_project = call(&state, "mirror.baseline.list", json!({}))
        .await
        .unwrap_err();
    assert_eq!(missing_project["code"], 1002);
    assert_eq!(missing_project["errorCode"], "INVALID_PARAMS");

    let bad_shape = call(
        &state,
        "mirror.baseline.replace",
        json!({ "projectId": "group-mirror", "entries": [{ "relPath": "a.rs" }] }),
    )
    .await
    .unwrap_err();
    assert_eq!(bad_shape["errorCode"], "INVALID_PARAMS");

    // The repository refuses an escaping path, and the RPC layer surfaces it
    // rather than storing a row the helper would never transfer.
    let escaping = call(
        &state,
        "mirror.baseline.entry.upsert",
        json!({
            "projectId": "group-mirror",
            "entry": baseline("../outside.rs", 1, DIGEST),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(escaping["errorCode"], "INTERNAL");

    let credential = call(
        &state,
        "mirror.baseline.entry.upsert",
        json!({
            "projectId": "group-mirror",
            "entry": baseline(".env.local", 1, DIGEST),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(credential["errorCode"], "INTERNAL");

    let still_empty = call(
        &state,
        "mirror.baseline.list",
        json!({ "projectId": "group-mirror" }),
    )
    .await
    .unwrap();
    assert_eq!(still_empty["entries"].as_array().unwrap().len(), 0);

    let unknown = call(&state, "mirror.nope", json!({})).await.unwrap_err();
    assert_eq!(unknown["errorCode"], "UNSUPPORTED");
}

#[tokio::test]
async fn projects_do_not_share_mirror_state() {
    let (_dir, state) = fixture().await;
    call(
        &state,
        "mirror.baseline.replace",
        json!({ "projectId": "group-a", "entries": [baseline("a.rs", 1, DIGEST)] }),
    )
    .await
    .unwrap();

    let other = call(
        &state,
        "mirror.baseline.list",
        json!({ "projectId": "group-b" }),
    )
    .await
    .unwrap();
    assert_eq!(other["entries"].as_array().unwrap().len(), 0);
}
