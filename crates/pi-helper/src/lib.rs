//! Loopback helper service for remote mirror development (spec 23, ADR 0338).
//!
//! The service owns the control plane and the file data plane: framed JSON
//! control requests, per-file `put`/`get` streams, and path containment. A file
//! operation resolves only inside the project root it names, registered at
//! startup or through `root.register`; the helper directory is a separate
//! namespace that only adapter operations reach.

mod adapters;
mod contain;
mod frame;
mod fs_ops;
#[cfg(test)]
mod tests;

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

use rand::{rng, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};

use contain::Roots;
use frame::{
    payload_stream_id, read_frame, write_frame, CONTROL_FRAME, DATA_FRAME, END_FRAME, IO_TIMEOUT,
};

pub use frame::{MAX_CONTROL_BYTES, MAX_FILE_BYTES, MAX_FRAME_BYTES};

const READY_PREFIX: &str = "PI_HELPER_READY ";
const MAX_CONNECTIONS: usize = 32;
const HELPER_DIRECTORY_NAME: &str = ".pi-desktop-helper";

/// Operations this build actually implements, in the order it advertises them.
///
/// `fs.put.begin`, `fs.get.begin` and `adapter.install` own the data frames
/// that follow their control frame; the chunk and end phases of a transfer are
/// `DATA` and `END` frames rather than separate control operations, so they are
/// not listed.
const CAPABILITIES: &[&str] = &[
    "auth",
    "version",
    "health",
    "env.verify",
    "root.register",
    "fs.stat",
    "fs.hash",
    "fs.mkdirs",
    "fs.put.begin",
    "fs.get.begin",
    "adapter.install",
    "adapter.probe",
    "adapter.start",
    "adapter.stop",
];

#[derive(Debug, Error)]
pub enum HelperError {
    #[error("invalid helper configuration")]
    InvalidConfig,
    #[error("the helper directory must not overlap a project root")]
    RootOverlap,
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
    #[error("helper request parameters are invalid")]
    InvalidArgument,
    #[error("requested path is outside the permitted roots")]
    PathEscape,
    #[error("requested path is not permitted")]
    PathForbidden,
    #[error("requested path does not exist")]
    PathNotFound,
    #[error("requested file exceeds the transfer ceiling")]
    FileTooLarge,
    #[error("file transfer failed")]
    TransferFailed,
    #[error("debug adapter installation failed")]
    AdapterInstallFailed,
    #[error("installed debug adapter differs from the pinned manifest")]
    AdapterVersionMismatch,
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
    roots: Arc<Roots>,
}

/// A control operation the protocol names, supported by this build or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Auth,
    Version,
    Health,
    RootRegister,
    Stat,
    Hash,
    Mkdirs,
    PutBegin,
    GetBegin,
    AdapterInstall,
    AdapterProbe,
    AdapterStart,
    AdapterStop,
    Unsupported,
}

fn classify(op: &str) -> Op {
    match op {
        "auth" => Op::Auth,
        "version" => Op::Version,
        "health" | "env.verify" => Op::Health,
        "root.register" => Op::RootRegister,
        "fs.stat" => Op::Stat,
        "fs.hash" => Op::Hash,
        "fs.mkdirs" => Op::Mkdirs,
        "fs.put.begin" => Op::PutBegin,
        "fs.get.begin" => Op::GetBegin,
        "adapter.install" => Op::AdapterInstall,
        "adapter.probe" => Op::AdapterProbe,
        "adapter.start" => Op::AdapterStart,
        "adapter.stop" => Op::AdapterStop,
        _ => Op::Unsupported,
    }
}

pub async fn run(config: HelperConfig) -> HelperResult<()> {
    validate_config(&config)?;
    prepare_root(&config.root)?;
    let root = fs::canonicalize(&config.root).map_err(|_| HelperError::Directory)?;
    let project_roots = canonical_project_roots(&config.project_roots)?;
    let roots = Roots::new(root, project_roots);
    // Refused before the listener exists, so a host that would expose the
    // helper directory through a project root never starts serving.
    roots.validate()?;
    let token = read_or_create_token(roots.helper_root())?;
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
            "capabilities": CAPABILITIES,
        })
    );
    // The token is never printed: stdout is redirected into logs/helper.log by
    // the launch script, and the deploy step reads it from the 0600 file itself.
    io::stdout().flush()?;

    let state = State {
        token: Arc::new(token),
        roots: Arc::new(roots),
    };
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    // The deploy script stops a helper with SIGTERM and the helper runs
    // detached, so a bare accept loop would exit without reaping the adapters
    // it started and leave them listening on the host.
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = &mut shutdown => break,
        };
        let (stream, peer) = match accepted {
            Ok(accepted) => accepted,
            // A transient accept failure (EMFILE under a burst) must not stop a
            // detached service that has no supervisor to restart it.
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };
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
    adapters::shutdown();
    Ok(())
}

/// Resolves when the service is asked to stop.
///
/// SIGTERM is how the deployment script ends a running helper; Ctrl-C is the
/// closest equivalent where it is unavailable.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
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
    for relative in ["bin", "adapters", "receipts", "pids", "logs"] {
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

    // A failed stream may still have data frames in flight. They are discarded
    // until the stream ends, so the next control frame starts on a boundary.
    let mut retired: Option<u32> = None;
    loop {
        let (kind, payload) = match timeout(IO_TIMEOUT, read_frame(&mut stream)).await {
            Ok(Ok(frame)) => frame,
            Ok(Err(HelperError::Io(error))) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Ok(())
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(HelperError::Frame),
        };
        match kind {
            CONTROL_FRAME => {
                retired = None;
                let request: Request =
                    serde_json::from_slice(&payload).map_err(|_| HelperError::Frame)?;
                if request.id.is_empty() || request.id.len() > 128 {
                    return Err(HelperError::Frame);
                }
                match classify(&request.op) {
                    Op::Auth => return Err(HelperError::Unauthorized),
                    Op::PutBegin => {
                        match fs_ops::put_stream(&mut stream, &state.roots, &request.params).await {
                            Ok(result) => {
                                write_result(&mut stream, &request.id, Ok(result)).await?
                            }
                            Err(failure) => {
                                retired = failure.retire;
                                write_result(&mut stream, &request.id, Err(failure.error)).await?;
                            }
                        }
                    }
                    Op::AdapterInstall => {
                        match adapters::install_stream(&mut stream, &state.roots, &request.params)
                            .await
                        {
                            Ok(result) => {
                                write_result(&mut stream, &request.id, Ok(result)).await?
                            }
                            Err(failure) => {
                                retired = failure.retire;
                                write_result(&mut stream, &request.id, Err(failure.error)).await?;
                            }
                        }
                    }
                    Op::GetBegin => match fs_ops::prepare_get(&state.roots, &request.params) {
                        Ok(plan) => {
                            write_control(
                                &mut stream,
                                &Response {
                                    id: &request.id,
                                    ok: true,
                                    result: Some(plan.response()),
                                    error: None,
                                },
                            )
                            .await?;
                            fs_ops::send_get(&mut stream, plan).await?;
                        }
                        Err(error) => write_result(&mut stream, &request.id, Err(error)).await?,
                    },
                    op => {
                        let result = dispatch(&state, op, &request.params);
                        write_result(&mut stream, &request.id, result).await?;
                    }
                }
            }
            DATA_FRAME | END_FRAME => {
                let stream_id = payload_stream_id(&payload)?;
                if retired != Some(stream_id) {
                    return Err(HelperError::Frame);
                }
                if kind == END_FRAME {
                    retired = None;
                }
            }
            _ => return Err(HelperError::Frame),
        }
    }
}

fn dispatch(state: &State, op: Op, params: &Map<String, Value>) -> HelperResult<Value> {
    match op {
        Op::Version => Ok(serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1,
            "capabilities": CAPABILITIES,
        })),
        Op::Health => Ok(serde_json::json!({
            "ready": true,
            "protocol": 1,
            "root": state.roots.helper_root(),
            "projectRootCount": state.roots.project_count(),
            "capabilities": CAPABILITIES,
        })),
        Op::RootRegister => register_root(&state.roots, params),
        Op::Stat => fs_ops::stat_batch(&state.roots, params),
        Op::Hash => fs_ops::hash_file(&state.roots, params),
        Op::Mkdirs => fs_ops::mkdirs(&state.roots, params),
        Op::AdapterProbe => adapters::probe(&state.roots, params),
        Op::AdapterStart => adapters::start(&state.roots, params),
        Op::AdapterStop => adapters::stop(&state.roots, params),
        Op::Auth | Op::PutBegin | Op::GetBegin | Op::AdapterInstall | Op::Unsupported => {
            Err(HelperError::OperationUnavailable)
        }
    }
}

/// Registers one mirror root for the life of this helper process.
///
/// Returns the canonical root every later `fs.*` request must name, so a client
/// never has to guess how the host spells its own path.
fn register_root(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let Some(Value::String(requested)) = params.get("path") else {
        return Err(HelperError::InvalidArgument);
    };
    let canonical = roots.register(requested)?;
    let root = canonical.to_str().ok_or(HelperError::InvalidArgument)?;
    Ok(serde_json::json!({ "root": root }))
}

async fn write_result(
    stream: &mut TcpStream,
    id: &str,
    result: HelperResult<Value>,
) -> HelperResult<()> {
    let (result, error) = match result {
        Ok(value) => (Some(value), None),
        Err(error) => (
            None,
            Some(ResponseError {
                code: error_code(&error),
            }),
        ),
    };
    write_control(
        stream,
        &Response {
            id,
            ok: error.is_none(),
            result,
            error,
        },
    )
    .await
}

fn valid_token(expected: &[u8], actual: Option<&Value>) -> bool {
    let Some(Value::String(actual)) = actual else {
        return false;
    };
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual.as_bytes()))
}

fn error_code(error: &HelperError) -> &'static str {
    match error {
        HelperError::InvalidConfig | HelperError::InvalidArgument => "INVALID_ARGUMENT",
        // Reached over the wire through `root.register`: the chosen mirror root
        // contains the helper directory or lies inside it.
        HelperError::RootOverlap => "REMOTE_PATH_FORBIDDEN",
        HelperError::Directory => "HELPER_DIR_UNWRITABLE",
        HelperError::Token | HelperError::Unauthorized => "HELPER_AUTH_FAILED",
        HelperError::Frame => "HELPER_PROTOCOL_ERROR",
        HelperError::OperationUnavailable => "HELPER_OPERATION_UNAVAILABLE",
        HelperError::PathEscape => "REMOTE_PATH_ESCAPE",
        HelperError::PathForbidden => "REMOTE_PATH_FORBIDDEN",
        HelperError::PathNotFound => "REMOTE_PATH_NOT_FOUND",
        HelperError::FileTooLarge => "MIRROR_FILE_TOO_LARGE",
        HelperError::TransferFailed => "REMOTE_TRANSFER_FAILED",
        HelperError::AdapterInstallFailed => "DEBUG_ADAPTER_INSTALL_FAILED",
        HelperError::AdapterVersionMismatch => "DEBUG_ADAPTER_VERSION_MISMATCH",
        HelperError::Io(_) => "HELPER_INTERNAL_ERROR",
    }
}

async fn write_control<T: Serialize>(stream: &mut TcpStream, value: &T) -> HelperResult<()> {
    let payload = serde_json::to_vec(value).map_err(|_| HelperError::Frame)?;
    write_frame(stream, CONTROL_FRAME, &payload).await
}
