//! Debug adapter lifecycle tests.
//!
//! Installs are driven over a real loopback connection so the control frame,
//! the DATA stream and the containment checks are exercised together, exactly
//! as the desktop client speaks them.

use std::{fs, path::Path};

use serde_json::{json, Value};
use tokio::net::TcpStream;

use super::{connect, object, read_response, send_request, spawn, test_env};
use crate::frame::{write_data_frame, write_end_frame};
use crate::{dispatch, HelperError, Op};

const KIND: &str = "python-debugpy";
const VERSION: &str = "1.8.5";
const STREAM_ID: u32 = 5;

async fn install_bundle(client: &mut TcpStream, version: &str, bytes: &[u8]) -> Value {
    send_request(
        client,
        "install",
        "adapter.install",
        json!({
            "kind": KIND,
            "version": version,
            "sha256": super::digest(bytes),
            "path": format!("adapters/{KIND}/{version}"),
            "streamId": STREAM_ID,
        }),
    )
    .await;
    write_data_frame(client, STREAM_ID, bytes).await.unwrap();
    write_end_frame(client, STREAM_ID).await.unwrap();
    read_response(client).await
}

fn partial_files(root: &Path) -> Vec<String> {
    super::partial_files(root)
}

fn installed_directory(helper: &Path, version: &str) -> std::path::PathBuf {
    helper.join("adapters").join(KIND).join(version)
}

#[tokio::test]
async fn adapter_install_verifies_the_digest_and_probe_reports_the_version() {
    let env = test_env();
    let bytes = b"debugpy payload";
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;

    let response = install_bundle(&mut client, VERSION, bytes).await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["kind"], KIND);
    assert_eq!(response["result"]["version"], VERSION);
    assert_eq!(response["result"]["sha256"], super::digest(bytes));
    assert_eq!(response["result"]["size"], bytes.len() as u64);
    assert_eq!(
        response["result"]["bundlePath"],
        format!("adapters/{KIND}/{VERSION}/{}", bundle_name())
    );

    let directory = installed_directory(&env.helper, VERSION);
    assert_eq!(fs::read(directory.join(bundle_name())).unwrap(), bytes);
    let receipt: Value =
        serde_json::from_slice(&fs::read(directory.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(receipt["kind"], KIND);
    assert_eq!(receipt["version"], VERSION);
    assert_eq!(receipt["sha256"], super::digest(bytes));

    let probe = dispatch(
        &env.state,
        Op::AdapterProbe,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(probe["installed"], true);
    assert_eq!(probe["version"], VERSION);
    assert_eq!(probe["sha256"], super::digest(bytes));

    // A pinned version that the host does not carry is a mismatch, not a miss.
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterProbe,
            &object(json!({ "kind": KIND, "version": "1.8.6" }))
        ),
        Err(HelperError::AdapterVersionMismatch)
    ));
    let pinned = dispatch(
        &env.state,
        Op::AdapterProbe,
        &object(json!({ "kind": KIND, "version": VERSION })),
    )
    .unwrap();
    assert_eq!(pinned["version"], VERSION);

    // The connection survived the stream and the helper is still usable.
    let version = super::call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["ok"], true);
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn adapter_install_refuses_a_payload_that_does_not_match_the_pinned_digest() {
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;

    let bytes = b"tampered payload";
    send_request(
        &mut client,
        "install",
        "adapter.install",
        json!({
            "kind": KIND,
            "version": VERSION,
            "sha256": super::digest(b"expected payload"),
            "path": format!("adapters/{KIND}/{VERSION}"),
            "streamId": STREAM_ID,
        }),
    )
    .await;
    write_data_frame(&mut client, STREAM_ID, bytes)
        .await
        .unwrap();
    write_end_frame(&mut client, STREAM_ID).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "DEBUG_ADAPTER_INSTALL_FAILED");

    let directory = installed_directory(&env.helper, VERSION);
    assert!(!directory.join(bundle_name()).exists());
    assert!(
        !directory.join("receipt.json").exists(),
        "a rejected payload must not leave an install receipt"
    );
    assert!(
        partial_files(&env.helper.join("adapters")).is_empty(),
        "a rejected payload must not leave staging files"
    );
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterProbe,
            &object(json!({ "kind": KIND }))
        ),
        Ok(value) if value["installed"] == false
    ));

    // An empty payload is not an install either.
    let empty = install_bundle(&mut client, VERSION, b"").await;
    assert_eq!(empty["error"]["code"], "DEBUG_ADAPTER_INSTALL_FAILED");

    let version = super::call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["ok"], true);
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn adapter_install_rejects_unknown_kinds_bad_versions_and_foreign_paths() {
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    let digest = super::digest(b"payload");

    let unknown = super::call(
        &mut client,
        "kind",
        "adapter.install",
        json!({
            "kind": "go-dlv",
            "version": VERSION,
            "sha256": digest,
            "path": format!("adapters/go-dlv/{VERSION}"),
            "streamId": 1,
        }),
    )
    .await;
    assert_eq!(unknown["error"]["code"], "INVALID_ARGUMENT");

    let bad_version = super::call(
        &mut client,
        "version",
        "adapter.install",
        json!({
            "kind": KIND,
            "version": "..",
            "sha256": digest,
            "path": format!("adapters/{KIND}/.."),
            "streamId": 2,
        }),
    )
    .await;
    assert_eq!(bad_version["error"]["code"], "INVALID_ARGUMENT");

    // A path the helper would install outside its own adapters tree is refused
    // before anything is created.
    let escaping = super::call(
        &mut client,
        "escape",
        "adapter.install",
        json!({
            "kind": KIND,
            "version": VERSION,
            "sha256": digest,
            "path": format!("../../{VERSION}"),
            "streamId": 3,
        }),
    )
    .await;
    assert_eq!(escaping["error"]["code"], "INVALID_ARGUMENT");

    // A project root that holds its own `adapters/` tree cannot divert the
    // payload: helper-scoped resolution never consults a project root.
    fs::create_dir_all(env.project.join("adapters").join(KIND).join(VERSION)).unwrap();
    let installed = install_bundle(&mut client, VERSION, b"payload").await;
    assert_eq!(installed["ok"], true, "{installed}");
    assert_eq!(
        fs::read(installed_directory(&env.helper, VERSION).join(bundle_name())).unwrap(),
        b"payload"
    );
    assert!(!env
        .project
        .join("adapters")
        .join(KIND)
        .join(VERSION)
        .join(bundle_name())
        .exists());

    let version = super::call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["ok"], true);
    drop(client);
    server.await.unwrap().unwrap();
}

#[test]
fn adapter_start_and_probe_refuse_an_absent_adapter() {
    let env = test_env();
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterProbe,
            &object(json!({ "kind": KIND, "version": VERSION }))
        ),
        Err(HelperError::AdapterVersionMismatch)
    ));
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterStart,
            &object(json!({ "kind": KIND }))
        ),
        Err(HelperError::AdapterVersionMismatch)
    ));
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterStart,
            &object(json!({ "kind": "go-dlv" }))
        ),
        Err(HelperError::InvalidArgument)
    ));
    // Stopping something that never started is not an error.
    let stopped = dispatch(
        &env.state,
        Op::AdapterStop,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(stopped["stopped"], false);
}

#[cfg(unix)]
#[tokio::test]
async fn adapter_start_binds_loopback_once_and_stop_is_idempotent() {
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    let script = b"#!/bin/sh\nexec sleep 60\n";
    let response = install_bundle(&mut client, VERSION, script).await;
    assert_eq!(response["ok"], true, "{response}");

    let started = dispatch(
        &env.state,
        Op::AdapterStart,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(started["kind"], KIND);
    assert_eq!(started["version"], VERSION);
    let port = started["port"].as_u64().unwrap();
    assert!(port > 0 && port < 65_536, "port {port} is not ephemeral");
    let pid = started["pid"].as_u64().unwrap() as u32;
    assert!(pid > 0);
    assert!(is_running(pid), "the adapter child must be alive");

    // One adapter per kind: a second start must not spawn another child.
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterStart,
            &object(json!({ "kind": KIND, "version": VERSION }))
        ),
        Err(HelperError::InvalidArgument)
    ));
    assert!(matches!(
        dispatch(
            &env.state,
            Op::AdapterStart,
            &object(json!({ "kind": KIND, "version": "1.8.6" }))
        ),
        Err(HelperError::AdapterVersionMismatch)
    ));

    let stopped = dispatch(
        &env.state,
        Op::AdapterStop,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(stopped["stopped"], true);
    assert!(!is_running(pid), "stop must terminate the adapter");
    let again = dispatch(
        &env.state,
        Op::AdapterStop,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(again["stopped"], false);

    // A stopped adapter can be started again, and helper shutdown reaps it.
    let restarted = dispatch(
        &env.state,
        Op::AdapterStart,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    let restarted_pid = restarted["pid"].as_u64().unwrap() as u32;
    assert!(is_running(restarted_pid));
    crate::adapters::shutdown();
    assert!(!is_running(restarted_pid), "shutdown must reap adapters");

    drop(client);
    server.await.unwrap().unwrap();
}

#[cfg(unix)]
fn is_running(pid: u32) -> bool {
    use std::process::Command;

    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .is_ok_and(|status| status.success())
}

/// Windows keeps the same supervision contract; only the payload differs,
/// because a raw script is not spawnable there. A system utility stands in for
/// the adapter so the spawn and stop paths are still exercised. The stand-in
/// exits immediately, so the busy-kind refusal stays in the unix test where a
/// long-lived child can prove it.
#[cfg(windows)]
#[tokio::test]
async fn adapter_start_spawns_and_stops_on_windows() {
    let Ok(system_root) = std::env::var("SystemRoot") else {
        return;
    };
    let Ok(payload) = fs::read(Path::new(&system_root).join("System32").join("whoami.exe")) else {
        return;
    };
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    let response = install_bundle(&mut client, VERSION, &payload).await;
    assert_eq!(response["ok"], true, "{response}");

    let started = dispatch(
        &env.state,
        Op::AdapterStart,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(started["version"], VERSION);
    assert!(started["port"].as_u64().unwrap() > 0);
    assert!(started["pid"].as_u64().unwrap() > 0);

    let stopped = dispatch(
        &env.state,
        Op::AdapterStop,
        &object(json!({ "kind": KIND })),
    )
    .unwrap();
    assert_eq!(stopped["stopped"], true);

    drop(client);
    server.await.unwrap().unwrap();
}

fn bundle_name() -> &'static str {
    if cfg!(windows) {
        "bundle.exe"
    } else {
        "bundle"
    }
}
