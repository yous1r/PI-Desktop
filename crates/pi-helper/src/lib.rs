use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use rand::{rng, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};

const READY_PREFIX: &str = "PI_HELPER_READY ";
const CONTROL_FRAME: u8 = 0x01;
const DATA_FRAME: u8 = 0x02;
const END_FRAME: u8 = 0x03;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_CONTROL_BYTES: usize = 64 * 1024;
/// Maximum future per-file sync size; M0 exposes no file transfer operations.
///
/// Maximum per-file transfer size enforced by the file-operation phase.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const HELPER_DIRECTORY_NAME: &str = ".pi-desktop-helper";

#[derive(Debug, Error)]
pub enum HelperError {
    #[error("invalid helper configuration")]
    InvalidConfig,
    #[error("helper could not initialize its private directory")]
    Directory,
    #[error("helper token is unavailable")]
    Token,
    #[error("invalid protocol frame")]
    Frame,
    #[error("helper request is not authorized")]
    Unauthorized,
    #[error("requested helper operation is not implemented in this build")]
    OperationUnavailable,
    #[error("helper I/O failed")]
    Io(#[from] io::Error),
}

type HelperResult<T> = Result<T, HelperError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelperConfig {
    pub port: u16,
    pub root: PathBuf,
    pub project_roots: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct Request {
    id: String,
    op: String,
    #[serde(flatten)]
    params: Map<String, Value>,
}

#[derive(Debug, Serialize)]
struct Response<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ResponseError>,
}

#[derive(Debug, Serialize)]
struct ResponseError {
    code: &'static str,
}

#[derive(Clone)]
struct State {
    token: Arc<Vec<u8>>,
    root: Arc<PathBuf>,
    project_roots: Arc<Vec<PathBuf>>,
}

pub async fn run(config: HelperConfig) -> HelperResult<()> {
    validate_config(&config)?;
    prepare_root(&config.root)?;
    let root = fs::canonicalize(&config.root).map_err(|_| HelperError::Directory)?;
    let project_roots = canonical_project_roots(&config.project_roots)?;
    let token = read_or_create_token(&root)?;
    let listener = TcpListener::bind(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        config.port,
    ))
    .await?;
    let address = listener.local_addr()?;
    println!(
        "{READY_PREFIX}{}",
        serde_json::json!({
            "port": address.port(),
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1,
            "capabilities": ["auth", "version", "health", "env.verify"],
        })
    );
    println!("PI_HELPER_TOKEN {}", String::from_utf8_lossy(&token));
    io::stdout().flush()?;

    let state = State {
        token: Arc::new(token),
        root: Arc::new(root),
        project_roots: Arc::new(project_roots),
    };
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            drop(stream);
            continue;
        }
        let permit = match connections.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                drop(stream);
                continue;
            }
        };
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = serve_connection(stream, state).await {
                eprintln!("PI_HELPER_CONNECTION_CLOSED {}", error_code(&error));
            }
        });
    }
}

fn validate_config(config: &HelperConfig) -> HelperResult<()> {
    if !config.root.is_absolute()
        || config.root.file_name().and_then(|name| name.to_str()) != Some(HELPER_DIRECTORY_NAME)
        || config.project_roots.iter().any(|root| !root.is_absolute())
    {
        return Err(HelperError::InvalidConfig);
    }
    Ok(())
}

fn prepare_root(root: &Path) -> HelperResult<()> {
    fs::create_dir_all(root).map_err(|_| HelperError::Directory)?;
    let metadata = fs::symlink_metadata(root).map_err(|_| HelperError::Directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(HelperError::Directory);
    }
    set_private_directory_permissions(root)?;
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
        fs::create_dir_all(&directory).map_err(|_| HelperError::Directory)?;
        let metadata = fs::symlink_metadata(&directory).map_err(|_| HelperError::Directory)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(HelperError::Directory);
        }
        set_private_directory_permissions(&directory)?;
    }
    Ok(())
}

fn set_private_directory_permissions(_path: &Path) -> HelperResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o700))
            .map_err(|_| HelperError::Directory)?;
    }
    Ok(())
}

fn canonical_project_roots(roots: &[PathBuf]) -> HelperResult<Vec<PathBuf>> {
    roots
        .iter()
        .map(|root| {
            let canonical = fs::canonicalize(root).map_err(|_| HelperError::InvalidConfig)?;
            if !canonical.is_dir() {
                return Err(HelperError::InvalidConfig);
            }
            Ok(canonical)
        })
        .collect()
}

fn read_or_create_token(root: &Path) -> HelperResult<Vec<u8>> {
    let path = root.join("token");
    if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| HelperError::Token)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(HelperError::Token);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o777 != 0o600 {
                return Err(HelperError::Token);
            }
        }
        let token = fs::read(path).map_err(|_| HelperError::Token)?;
        if token.len() != 64 || !token.iter().all(u8::is_ascii_hexdigit) {
            return Err(HelperError::Token);
        }
        return Ok(token);
    }

    let mut random = [0u8; 32];
    rng().fill_bytes(&mut random);
    let token = hex::encode(random).into_bytes();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| HelperError::Token)?;
    file.write_all(&token).map_err(|_| HelperError::Token)?;
    file.sync_all().map_err(|_| HelperError::Token)?;
    Ok(token)
}

async fn serve_connection(mut stream: TcpStream, state: State) -> HelperResult<()> {
    let (kind, payload) = timeout(IO_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| HelperError::Frame)??;
    if kind != CONTROL_FRAME {
        return Err(HelperError::Unauthorized);
    }
    let auth: Request = serde_json::from_slice(&payload).map_err(|_| HelperError::Frame)?;
    if auth.id.is_empty() || auth.id.len() > 128 {
        return Err(HelperError::Frame);
    }
    if auth.op != "auth" || !valid_token(&state.token, auth.params.get("token")) {
        return Err(HelperError::Unauthorized);
    }
    write_control(
        &mut stream,
        &Response {
            id: &auth.id,
            ok: true,
            result: Some(serde_json::json!({ "authenticated": true })),
            error: None,
        },
    )
    .await?;

    loop {
        let (kind, payload) = match timeout(IO_TIMEOUT, read_frame(&mut stream)).await {
            Ok(Ok(frame)) => frame,
            Ok(Err(HelperError::Io(error))) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Ok(())
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(HelperError::Frame),
        };
        if kind != CONTROL_FRAME {
            return Err(HelperError::Frame);
        }
        let request: Request = serde_json::from_slice(&payload).map_err(|_| HelperError::Frame)?;
        if request.id.is_empty() || request.id.len() > 128 {
            return Err(HelperError::Frame);
        }
        if request.op == "auth" {
            return Err(HelperError::Unauthorized);
        }
        let result = dispatch(&state, &request);
        let (result, error) = match result {
            Ok(result) => (Some(result), None),
            Err(error) => (
                None,
                Some(ResponseError {
                    code: error_code(&error),
                }),
            ),
        };
        write_control(
            &mut stream,
            &Response {
                id: &request.id,
                ok: error.is_none(),
                result,
                error,
            },
        )
        .await?;
    }
}

fn dispatch(state: &State, request: &Request) -> HelperResult<Value> {
    match request.op.as_str() {
        "version" => Ok(serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1,
            "capabilities": ["auth", "version", "health", "env.verify"],
        })),
        "health" | "env.verify" => Ok(serde_json::json!({
            "ready": true,
            "protocol": 1,
            "root": state.root.as_ref(),
            "projectRootCount": state.project_roots.len(),
            "capabilities": ["auth", "version", "health", "env.verify"],
        })),
        _ => Err(HelperError::OperationUnavailable),
    }
}

fn valid_token(expected: &[u8], actual: Option<&Value>) -> bool {
    let Some(Value::String(actual)) = actual else {
        return false;
    };
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual.as_bytes()))
}

fn error_code(error: &HelperError) -> &'static str {
    match error {
        HelperError::InvalidConfig => "INVALID_ARGUMENT",
        HelperError::Directory => "HELPER_DIR_UNWRITABLE",
        HelperError::Token | HelperError::Unauthorized => "HELPER_AUTH_FAILED",
        HelperError::Frame => "HELPER_PROTOCOL_ERROR",
        HelperError::OperationUnavailable => "HELPER_OPERATION_UNAVAILABLE",
        HelperError::Io(_) => "HELPER_INTERNAL_ERROR",
    }
}

async fn read_frame(stream: &mut TcpStream) -> HelperResult<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    stream.read_exact(&mut header).await?;
    let kind = header[0];
    if !matches!(kind, CONTROL_FRAME | DATA_FRAME | END_FRAME) {
        return Err(HelperError::Frame);
    }
    let size =
        u32::from_be_bytes(header[1..5].try_into().map_err(|_| HelperError::Frame)?) as usize;
    let limit = if kind == CONTROL_FRAME {
        MAX_CONTROL_BYTES
    } else {
        MAX_FRAME_BYTES
    };
    if size > limit || (kind == DATA_FRAME && size < 4) || (kind == END_FRAME && size != 4) {
        return Err(HelperError::Frame);
    }
    let mut payload = vec![0; size];
    stream.read_exact(&mut payload).await?;
    Ok((kind, payload))
}

async fn write_frame(stream: &mut TcpStream, kind: u8, payload: &[u8]) -> HelperResult<()> {
    let limit = if kind == CONTROL_FRAME {
        MAX_CONTROL_BYTES
    } else {
        MAX_FRAME_BYTES
    };
    if !matches!(kind, CONTROL_FRAME | DATA_FRAME | END_FRAME)
        || payload.len() > limit
        || (kind == DATA_FRAME && payload.len() < 4)
        || (kind == END_FRAME && payload.len() != 4)
    {
        return Err(HelperError::Frame);
    }
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    stream.write_all(&header).await?;
    stream.write_all(payload).await?;
    Ok(())
}

async fn write_control<T: Serialize>(stream: &mut TcpStream, value: &T) -> HelperResult<()> {
    let payload = serde_json::to_vec(value).map_err(|_| HelperError::Frame)?;
    write_frame(stream, CONTROL_FRAME, &payload).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request(id: &str, op: &str, params: Map<String, Value>) -> Request {
        Request {
            id: id.to_owned(),
            op: op.to_owned(),
            params,
        }
    }

    #[test]
    fn config_requires_fixed_private_root_and_absolute_project_roots() {
        let temp = tempdir().unwrap();
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
        let temp = tempdir().unwrap();
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
    fn dispatch_exposes_only_health_and_version_in_skeleton() {
        let state = State {
            token: Arc::new(b"a".repeat(64)),
            root: Arc::new(PathBuf::from("/home/user/.pi-desktop-helper")),
            project_roots: Arc::new(vec![]),
        };
        assert!(dispatch(&state, &request("1", "health", Map::new())).is_ok());
        assert!(dispatch(&state, &request("2", "version", Map::new())).is_ok());
        assert!(matches!(
            dispatch(&state, &request("3", "fs.put.begin", Map::new())),
            Err(HelperError::OperationUnavailable)
        ));
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
    async fn authenticated_loopback_client_gets_version_health_and_safe_unavailable_reply() {
        let token = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_vec();
        let state = State {
            token: Arc::new(token.clone()),
            root: Arc::new(PathBuf::from("/home/user/.pi-desktop-helper")),
            project_roots: Arc::new(vec![]),
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_connection(stream, state).await
        });
        let mut client = TcpStream::connect(address).await.unwrap();

        let auth = serde_json::json!({ "id": "auth", "op": "auth", "token": String::from_utf8(token.clone()).unwrap() });
        write_frame(
            &mut client,
            CONTROL_FRAME,
            &serde_json::to_vec(&auth).unwrap(),
        )
        .await
        .unwrap();
        let (_, payload) = read_frame(&mut client).await.unwrap();
        let response: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(response["id"], "auth");
        assert_eq!(response["ok"], true);

        for (id, op) in [("v", "version"), ("h", "health"), ("f", "fs.put.begin")] {
            let request = serde_json::json!({ "id": id, "op": op });
            write_frame(
                &mut client,
                CONTROL_FRAME,
                &serde_json::to_vec(&request).unwrap(),
            )
            .await
            .unwrap();
            let (_, payload) = read_frame(&mut client).await.unwrap();
            let response: Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(response["id"], id);
            if op == "fs.put.begin" {
                assert_eq!(response["ok"], false);
                assert_eq!(response["error"]["code"], "HELPER_OPERATION_UNAVAILABLE");
            } else {
                assert_eq!(response["ok"], true);
            }
        }

        let duplicate_auth = serde_json::json!({
            "id": "auth-again",
            "op": "auth",
            "token": String::from_utf8(token).unwrap(),
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
            Err(HelperError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof
        ));
        drop(client);
        assert!(matches!(
            server.await.unwrap(),
            Err(HelperError::Unauthorized)
        ));
    }
}
