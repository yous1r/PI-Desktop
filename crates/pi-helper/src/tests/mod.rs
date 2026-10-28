//! Protocol and data-plane tests.
//!
//! Uploads and downloads are driven over a real loopback `TcpStream` so a
//! framing bug cannot hide behind a direct function call.

mod contain;

use std::{
    fs,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

use crate::contain::Roots;
use crate::frame::{
    payload_stream_id, read_frame, write_data_frame, write_end_frame, write_frame, CONTROL_FRAME,
    DATA_FRAME, END_FRAME, MAX_FILE_BYTES, MAX_FRAME_BYTES,
};
use crate::fs_ops::MAX_BATCH_PATHS;
use crate::{
    classify, dispatch, prepare_root, read_or_create_token, serve_connection, valid_token,
    validate_config, HelperConfig, HelperError, HelperResult, Op, State, CAPABILITIES,
};

struct Env {
    _temp: TempDir,
    state: State,
    helper: PathBuf,
    project: PathBuf,
    token: Vec<u8>,
}

fn test_env() -> Env {
    let temp = tempfile::tempdir().unwrap();
    let helper = temp.path().join(".pi-desktop-helper");
    prepare_root(&helper).unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let helper = fs::canonicalize(&helper).unwrap();
    let project = fs::canonicalize(&project).unwrap();
    let token = read_or_create_token(&helper).unwrap();
    let state = State {
        token: Arc::new(token.clone()),
        roots: Arc::new(Roots::new(helper.clone(), vec![project.clone()])),
    };
    Env {
        _temp: temp,
        state,
        helper,
        project,
        token,
    }
}

/// A project root that contains the helper directory would turn the token and
/// the installed binary into ordinary project paths, so the configuration is
/// refused before the listener exists.
#[test]
fn overlapping_helper_and_project_roots_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    let helper = temp.path().join(".pi-desktop-helper");
    prepare_root(&helper).unwrap();
    let helper = fs::canonicalize(&helper).unwrap();
    // `validate`-time inputs are canonical on both sides, exactly as `run` builds them.
    let project = fs::canonicalize(temp.path()).unwrap();

    let enclosing = Roots::new(helper.clone(), vec![project]);
    assert!(matches!(
        enclosing.validate(),
        Err(HelperError::InvalidConfig)
    ));

    let nested = Roots::new(helper.clone(), vec![helper.join("venvs")]);
    assert!(matches!(nested.validate(), Err(HelperError::InvalidConfig)));

    let sibling = temp.path().join("project");
    fs::create_dir_all(&sibling).unwrap();
    let disjoint = Roots::new(helper, vec![fs::canonicalize(&sibling).unwrap()]);
    assert!(disjoint.validate().is_ok());
}

/// Even inside a legitimate project root, a path that resolves into the helper
/// directory is refused, so a symlink cannot re-open the private state.
#[cfg(unix)]
#[test]
fn project_symlink_cannot_reach_the_helper_directory() {
    let env = test_env();
    fs::create_dir_all(env.helper.join("logs")).unwrap();
    fs::write(env.helper.join("logs/helper.log"), b"line\n").unwrap();
    std::os::unix::fs::symlink(env.helper.join("logs"), env.project.join("logs")).unwrap();

    assert!(matches!(
        env.state.roots.resolve_read("logs/helper.log"),
        Err(HelperError::PathForbidden | HelperError::PathEscape)
    ));
}

/// The staging file is private and the target keeps its mode, so an executable
/// script survives an upload instead of silently becoming 0644.
#[cfg(unix)]
#[tokio::test]
async fn fs_put_preserves_the_target_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let env = test_env();
    let script = env.project.join("run.sh");
    fs::write(&script, b"old\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

    let bytes = b"new\n";
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    send_request(
        &mut client,
        "perm",
        "fs.put.begin",
        json!({
            "path": "run.sh",
            "streamId": 41,
            "size": bytes.len(),
            "sha256": digest(bytes),
        }),
    )
    .await;
    write_data_frame(&mut client, 41, bytes).await.unwrap();
    write_end_frame(&mut client, 41).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], true, "{response}");
    drop(client);
    server.await.unwrap().unwrap();

    assert_eq!(fs::read(&script).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&script).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

/// A batch whose reply would not fit one control frame is refused instead of
/// dropping the connection after the directories were already created.
#[test]
fn fs_mkdirs_refuses_a_batch_that_cannot_fit_one_control_frame() {
    let env = test_env();
    let paths: Vec<String> = (0..MAX_BATCH_PATHS)
        .map(|index| format!("bulk/{}/{index}", "d".repeat(200)))
        .collect();
    let result = dispatch(
        &env.state,
        Op::Mkdirs,
        &object(json!({ "paths": paths.clone() })),
    );
    assert!(matches!(result, Err(HelperError::InvalidArgument)));
    assert!(
        !env.project.join("bulk").exists(),
        "the batch must be refused before any directory is created"
    );
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("params must be an object: {other}"),
    }
}

/// Every operation the protocol names, implemented by this build or not.
const PROTOCOL_OPS: &[&str] = &[
    "auth",
    "version",
    "health",
    "env.verify",
    "fs.stat",
    "fs.hash",
    "fs.mkdirs",
    "fs.put.begin",
    "fs.put.chunk",
    "fs.put.end",
    "fs.get.begin",
    "fs.get.chunk",
    "fs.get.end",
    "watch.start",
    "watch.stop",
    "adapter.install",
    "adapter.probe",
    "adapter.start",
    "adapter.stop",
    "adapter.list",
];

/// Finds any leftover `<name>.<streamId>.pi-part` sibling.
fn partial_files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".pi-part"))
            {
                found.push(path.display().to_string());
            }
        }
    }
    found
}

async fn spawn(state: State) -> (SocketAddr, JoinHandle<HelperResult<()>>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        serve_connection(stream, state).await
    });
    (address, server)
}

async fn connect(address: SocketAddr, token: &[u8]) -> TcpStream {
    let mut client = TcpStream::connect(address).await.unwrap();
    let auth = json!({
        "id": "auth",
        "op": "auth",
        "token": String::from_utf8(token.to_vec()).unwrap(),
    });
    write_frame(
        &mut client,
        CONTROL_FRAME,
        &serde_json::to_vec(&auth).unwrap(),
    )
    .await
    .unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], true);
    client
}

async fn send_request(client: &mut TcpStream, id: &str, op: &str, params: Value) {
    let mut body = Map::new();
    body.insert("id".to_owned(), json!(id));
    body.insert("op".to_owned(), json!(op));
    if let Value::Object(params) = params {
        for (key, value) in params {
            body.insert(key, value);
        }
    }
    let payload = serde_json::to_vec(&Value::Object(body)).unwrap();
    write_frame(client, CONTROL_FRAME, &payload).await.unwrap();
}

async fn read_response(client: &mut TcpStream) -> Value {
    let (kind, payload) = read_frame(client).await.unwrap();
    assert_eq!(kind, CONTROL_FRAME);
    serde_json::from_slice(&payload).unwrap()
}

async fn call(client: &mut TcpStream, id: &str, op: &str, params: Value) -> Value {
    send_request(client, id, op, params).await;
    read_response(client).await
}

#[test]
fn config_requires_fixed_private_root_and_absolute_project_roots() {
    let temp = tempfile::tempdir().unwrap();
    let valid = HelperConfig {
        port: 0,
        root: temp.path().join(".pi-desktop-helper"),
        project_roots: vec![temp.path().join("project")],
    };
    assert!(validate_config(&valid).is_ok());
    assert!(matches!(
        validate_config(&HelperConfig {
            root: PathBuf::from("relative/.pi-desktop-helper"),
            ..valid.clone()
        }),
        Err(HelperError::InvalidConfig)
    ));
    assert!(matches!(
        validate_config(&HelperConfig {
            root: PathBuf::from("/tmp/helper"),
            ..valid
        }),
        Err(HelperError::InvalidConfig)
    ));
}

#[test]
fn prepare_root_creates_private_helper_layout_and_refuses_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".pi-desktop-helper");
    prepare_root(&root).unwrap();
    for relative in [
        "bin",
        "bin/gobin",
        "adapters",
        "venvs",
        "receipts",
        "pids",
        "logs",
    ] {
        let directory = root.join(relative);
        assert!(directory.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
    #[cfg(unix)]
    {
        let target = temp.path().join("outside");
        fs::create_dir(&target).unwrap();
        let link = temp.path().join("linked").join(".pi-desktop-helper");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(prepare_root(&link).is_err());
    }
}

#[test]
fn token_file_is_ascii_hex_and_owner_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".pi-desktop-helper");
    fs::create_dir_all(&root).unwrap();
    let token = read_or_create_token(&root).unwrap();
    assert_eq!(token.len(), 64);
    assert!(token.iter().all(u8::is_ascii_hexdigit));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(root.join("token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(read_or_create_token(&root).unwrap(), token);
}

#[test]
fn authentication_comparison_is_exact_and_fails_closed() {
    let token = b"0123456789abcdef";
    assert!(valid_token(
        token,
        Some(&Value::String("0123456789abcdef".into()))
    ));
    assert!(!valid_token(
        token,
        Some(&Value::String("0123456789abcdeg".into()))
    ));
    assert!(!valid_token(token, None));
}

#[tokio::test]
async fn frame_round_trip_preserves_binary_and_bounds_lengths() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_frame(&mut stream).await.unwrap()
    });
    let mut client = TcpStream::connect(address).await.unwrap();
    let payload = [0, 255, 0x80, 0x42];
    write_frame(&mut client, DATA_FRAME, &payload)
        .await
        .unwrap();
    let (kind, received) = server.await.unwrap();
    assert_eq!(kind, DATA_FRAME);
    assert_eq!(received, payload);
    assert!(
        write_frame(&mut client, DATA_FRAME, &vec![0; MAX_FRAME_BYTES + 1])
            .await
            .is_err()
    );
    assert_eq!(MAX_FILE_BYTES, 50 * 1024 * 1024);
}

#[tokio::test]
async fn authenticated_loopback_client_gets_version_health_and_safe_unavailable_reply() {
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;

    let version = call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["id"], "v");
    assert_eq!(version["ok"], true);
    assert_eq!(version["result"]["protocol"], 1);

    let health = call(&mut client, "h", "health", json!({})).await;
    assert_eq!(health["ok"], true);
    assert_eq!(health["result"]["ready"], true);
    assert_eq!(health["result"]["projectRootCount"], 1);

    let unavailable = call(&mut client, "w", "watch.start", json!({})).await;
    assert_eq!(unavailable["ok"], false);
    assert_eq!(unavailable["error"]["code"], "HELPER_OPERATION_UNAVAILABLE");

    let duplicate_auth = json!({
        "id": "auth-again",
        "op": "auth",
        "token": String::from_utf8(env.token.clone()).unwrap(),
    });
    write_frame(
        &mut client,
        CONTROL_FRAME,
        &serde_json::to_vec(&duplicate_auth).unwrap(),
    )
    .await
    .unwrap();
    assert!(matches!(
        read_frame(&mut client).await,
        Err(HelperError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
    ));
    drop(client);
    assert!(matches!(
        server.await.unwrap(),
        Err(HelperError::Unauthorized)
    ));
}

#[tokio::test]
async fn capability_list_matches_dispatch_exactly() {
    let env = test_env();
    let version = dispatch(&env.state, Op::Version, &Map::new()).unwrap();
    let health = dispatch(&env.state, Op::Health, &Map::new()).unwrap();
    let advertised: Vec<Value> = CAPABILITIES.iter().map(|op| json!(op)).collect();
    assert_eq!(version["capabilities"], Value::Array(advertised.clone()));
    assert_eq!(health["capabilities"], Value::Array(advertised));

    for op in PROTOCOL_OPS {
        assert_eq!(
            CAPABILITIES.contains(op),
            classify(op) != Op::Unsupported,
            "{op} must be advertised exactly when it is implemented"
        );
    }

    // Every advertised operation answers over the wire, and nothing else does.
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    for op in CAPABILITIES.iter().copied().filter(|op| *op != "auth") {
        let response = call(&mut client, op, op, json!({})).await;
        assert_ne!(
            response["error"]["code"], "HELPER_OPERATION_UNAVAILABLE",
            "{op} is advertised but not dispatched"
        );
    }
    for op in PROTOCOL_OPS
        .iter()
        .copied()
        .filter(|op| !CAPABILITIES.contains(op))
    {
        let response = call(&mut client, op, op, json!({})).await;
        assert_eq!(
            response["error"]["code"], "HELPER_OPERATION_UNAVAILABLE",
            "{op} is not implemented"
        );
    }
    drop(client);
    server.await.unwrap().unwrap();
}

#[test]
fn fs_stat_reports_kinds_and_fs_hash_matches_a_known_digest() {
    let env = test_env();
    fs::write(env.project.join("hello.txt"), b"abc").unwrap();
    fs::create_dir_all(env.project.join("src/nested")).unwrap();
    fs::write(env.project.join("src/nested/main.rs"), b"fn main() {}\n").unwrap();

    let stat = dispatch(
        &env.state,
        Op::Stat,
        &object(json!({
            "paths": ["hello.txt", "src", "src/nested/main.rs", "missing.txt"],
        })),
    )
    .unwrap();
    let entries = stat["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["path"], "hello.txt");
    assert_eq!(entries[0]["kind"], "file");
    assert_eq!(entries[0]["size"], 3);
    assert!(entries[0]["mtimeMs"].as_u64().unwrap() > 0);
    assert_eq!(entries[1]["kind"], "directory");
    assert_eq!(entries[2]["kind"], "file");
    assert_eq!(entries[3]["kind"], "missing");
    assert!(entries[3].get("size").is_none());

    let hash = dispatch(
        &env.state,
        Op::Hash,
        &object(json!({ "path": "hello.txt" })),
    )
    .unwrap();
    assert_eq!(
        hash["sha256"],
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(hash["size"], 3);

    // Helper-directory subdirectories are reachable, the private files are not.
    fs::write(env.helper.join("logs/helper.log"), b"log line\n").unwrap();
    let log = dispatch(
        &env.state,
        Op::Hash,
        &object(json!({ "path": "logs/helper.log" })),
    )
    .unwrap();
    assert_eq!(log["sha256"], digest(b"log line\n"));

    // One non-contained path fails the whole batch instead of being reported.
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Stat,
            &object(json!({ "paths": ["hello.txt", "../escape"] }))
        ),
        Err(HelperError::PathEscape)
    ));
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Hash,
            &object(json!({ "path": "missing.txt" }))
        ),
        Err(HelperError::PathNotFound)
    ));
    assert!(matches!(
        dispatch(&env.state, Op::Hash, &object(json!({ "path": "src" }))),
        Err(HelperError::InvalidArgument)
    ));
}

#[test]
fn fs_mkdirs_creates_nested_directories_and_caps_the_batch() {
    let env = test_env();
    let result = dispatch(
        &env.state,
        Op::Mkdirs,
        &object(json!({ "paths": ["a/b/c", "a/b/c", "d"] })),
    )
    .unwrap();
    assert_eq!(result["paths"].as_array().unwrap().len(), 3);
    assert!(env.project.join("a/b/c").is_dir());
    assert!(env.project.join("d").is_dir());

    fs::write(env.project.join("file.txt"), b"x").unwrap();
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Mkdirs,
            &object(json!({ "paths": ["file.txt"] }))
        ),
        Err(HelperError::InvalidArgument)
    ));

    let oversized: Vec<String> = (0..=MAX_BATCH_PATHS)
        .map(|index| format!("bulk/{index}"))
        .collect();
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Mkdirs,
            &object(json!({ "paths": oversized }))
        ),
        Err(HelperError::InvalidArgument)
    ));
}

#[tokio::test]
async fn fs_put_streams_bytes_verbatim_and_replaces_the_target_atomically() {
    let env = test_env();
    let target = env.project.join("data/blob.bin");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"previous content").unwrap();

    let content: Vec<u8> = (0..=255u8).cycle().take(200_000).collect();
    let expected = digest(&content);
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    send_request(
        &mut client,
        "put",
        "fs.put.begin",
        json!({
            "path": "data/blob.bin",
            "streamId": 7,
            "size": content.len() as u64,
            "sha256": expected,
        }),
    )
    .await;
    for chunk in content.chunks(48 * 1024) {
        write_data_frame(&mut client, 7, chunk).await.unwrap();
    }
    write_end_frame(&mut client, 7).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["path"], "data/blob.bin");
    assert_eq!(response["result"]["size"], content.len() as u64);
    assert_eq!(response["result"]["sha256"], expected);
    assert_eq!(fs::read(&target).unwrap(), content);
    assert!(
        partial_files(&env.project).is_empty(),
        "temporary file left behind"
    );

    let version = call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["ok"], true);
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn fs_put_rejects_short_long_and_mismatched_streams_without_leaving_a_target() {
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;

    // Fewer bytes than declared.
    send_request(
        &mut client,
        "short",
        "fs.put.begin",
        json!({ "path": "short.txt", "streamId": 1, "size": 5, "sha256": digest(b"abc") }),
    )
    .await;
    write_data_frame(&mut client, 1, b"abc").await.unwrap();
    write_end_frame(&mut client, 1).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "REMOTE_TRANSFER_FAILED");
    assert!(!env.project.join("short.txt").exists());

    // More bytes than declared.
    send_request(
        &mut client,
        "long",
        "fs.put.begin",
        json!({ "path": "long.txt", "streamId": 2, "size": 2, "sha256": digest(b"abc") }),
    )
    .await;
    write_data_frame(&mut client, 2, b"abc").await.unwrap();
    write_end_frame(&mut client, 2).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["error"]["code"], "REMOTE_TRANSFER_FAILED");
    assert!(!env.project.join("long.txt").exists());

    // Declared digest does not match the bytes.
    send_request(
        &mut client,
        "digest",
        "fs.put.begin",
        json!({ "path": "digest.txt", "streamId": 3, "size": 3, "sha256": digest(b"abd") }),
    )
    .await;
    write_data_frame(&mut client, 3, b"abc").await.unwrap();
    write_end_frame(&mut client, 3).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["error"]["code"], "REMOTE_TRANSFER_FAILED");
    assert!(!env.project.join("digest.txt").exists());
    assert!(partial_files(&env.project).is_empty());

    // Framing survived every failure.
    let version = call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["ok"], true);
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn fs_put_refuses_a_declared_size_above_the_ceiling_before_accepting_bytes() {
    let env = test_env();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    send_request(
        &mut client,
        "huge",
        "fs.put.begin",
        json!({
            "path": "huge.bin",
            "streamId": 11,
            "size": MAX_FILE_BYTES + 1,
            "sha256": digest(b""),
        }),
    )
    .await;
    // No data frame is sent: the refusal arrives on its own.
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "MIRROR_FILE_TOO_LARGE");
    assert!(!env.project.join("huge.bin").exists());
    assert!(partial_files(&env.project).is_empty());

    let version = call(&mut client, "v", "version", json!({})).await;
    assert_eq!(version["ok"], true);
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn fs_get_streams_binary_content_back_over_loopback() {
    let env = test_env();
    let content: Vec<u8> = (0..=255u8).cycle().take(200_000).collect();
    fs::write(env.project.join("binary.bin"), &content).unwrap();
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;
    send_request(
        &mut client,
        "get",
        "fs.get.begin",
        json!({ "path": "binary.bin", "streamId": 9 }),
    )
    .await;
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["streamId"], 9);
    assert_eq!(response["result"]["size"], content.len() as u64);

    let mut received = Vec::new();
    loop {
        let (kind, payload) = read_frame(&mut client).await.unwrap();
        match kind {
            DATA_FRAME => {
                assert_eq!(payload_stream_id(&payload).unwrap(), 9);
                received.extend_from_slice(&payload[4..]);
            }
            END_FRAME => {
                assert_eq!(payload_stream_id(&payload).unwrap(), 9);
                break;
            }
            other => panic!("unexpected frame type {other}"),
        }
    }
    assert_eq!(received, content);
    assert!(received.contains(&0x00) && received.contains(&0xFF));

    // A missing path and a directory are refused before any data frame.
    let missing = call(
        &mut client,
        "m",
        "fs.get.begin",
        json!({ "path": "nope.bin", "streamId": 10 }),
    )
    .await;
    assert_eq!(missing["error"]["code"], "REMOTE_PATH_NOT_FOUND");
    let directory = call(
        &mut client,
        "d",
        "fs.get.begin",
        json!({ "path": "logs", "streamId": 10 }),
    )
    .await;
    assert_eq!(directory["error"]["code"], "INVALID_ARGUMENT");
    drop(client);
    server.await.unwrap().unwrap();
}
