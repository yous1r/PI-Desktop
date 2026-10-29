//! Debug adapter lifecycle (spec 23 section 5 and section 7.1).
//!
//! The Desktop bundle carries the adapter payload and its pinned manifest, so
//! the helper never downloads, never runs a shell and never accepts an argv or
//! an executable path from the protocol. `adapter.install` accepts exactly one
//! verified payload for one allowlisted kind, `adapter.probe` reports what the
//! helper itself installed, and `adapter.start`/`adapter.stop` supervise one
//! child process per kind on loopback.
//!
//! An install is durable only after the payload digest matches the pinned
//! manifest value: the received bytes go to a private staging sibling and are
//! renamed into place afterwards, and the receipt that `probe` trusts is
//! written last.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{rng, Rng};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;

use crate::{
    contain::Roots,
    frame::{payload_stream_id, read_frame_timeout, DATA_FRAME, END_FRAME, MAX_FILE_BYTES},
    HelperError, HelperResult,
};

/// Installed payload file name. The Windows suffix exists only so the local
/// test suite can spawn a real executable; production hosts are Linux only.
const BUNDLE_FILE: &str = if cfg!(windows) {
    "bundle.exe"
} else {
    "bundle"
};
const RECEIPT_FILE: &str = "receipt.json";
/// Longest adapter version string accepted from the protocol.
const MAX_VERSION_BYTES: usize = 32;
/// Most receipt bytes read for one installed version.
const MAX_RECEIPT_BYTES: u64 = 4096;
/// Versions inspected for one kind; the helper installs one at a time.
const MAX_INSTALLED_VERSIONS: usize = 32;
/// Most data frames one install may spend; bounds an empty-frame flood.
const MAX_STREAM_FRAMES: u32 = 65_536;
const TEMP_SUFFIX: &str = "pi-part";
const TEMP_NONCE_BYTES: usize = 12;

/// Adapter kinds this build can install and launch.
///
/// The list is an allowlist on purpose: it fixes the installed layout, the
/// launch argv and the executable for every entry, so no request can name a
/// program of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum AdapterKind {
    PythonDebugpy,
}

impl AdapterKind {
    fn parse(value: &str) -> HelperResult<Self> {
        match value {
            "python-debugpy" => Ok(Self::PythonDebugpy),
            _ => Err(HelperError::InvalidArgument),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::PythonDebugpy => "python-debugpy",
        }
    }

    /// Arguments passed to the installed payload, bound to loopback only.
    fn argv(self, port: u16) -> [String; 2] {
        match self {
            Self::PythonDebugpy => ["--listen".to_owned(), format!("127.0.0.1:{port}")],
        }
    }
}

/// A failed install and the stream whose remaining frames must be discarded.
pub(crate) struct InstallFailure {
    pub(crate) error: HelperError,
    pub(crate) retire: Option<u32>,
}

impl InstallFailure {
    fn new(error: HelperError, retire: Option<u32>) -> Self {
        Self { error, retire }
    }
}

/// One installed adapter as `probe` reports it.
struct Installed {
    version: String,
    sha256: String,
    installed_at: u64,
    bundle: PathBuf,
}

/// Registry key: one adapter process per kind per helper root.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    helper: PathBuf,
    kind: AdapterKind,
}

struct Running {
    child: Child,
}

impl Drop for Running {
    fn drop(&mut self) {
        // Every exit path that drops the entry kills the child, so a stopped,
        // replaced or failed adapter never survives its own bookkeeping.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The process-wide adapter registry.
///
/// It cannot live in the per-connection `State`: `adapter.start` and
/// `adapter.stop` legitimately arrive on different connections, and a helper
/// process owns exactly one registry.
static REGISTRY: OnceLock<Mutex<HashMap<Key, Running>>> = OnceLock::new();

fn registry() -> MutexGuard<'static, HashMap<Key, Running>> {
    let mutex = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    match mutex.lock() {
        Ok(guard) => guard,
        // The registry is bookkeeping for child processes, not user data: a
        // panic in an unrelated request must not orphan them.
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Receives one adapter payload and installs it under `adapters/<kind>/<version>/`.
pub(crate) async fn install_stream(
    stream: &mut TcpStream,
    roots: &Roots,
    params: &Map<String, Value>,
) -> Result<Value, InstallFailure> {
    let stream_id =
        required_u32(params, "streamId").map_err(|error| InstallFailure::new(error, None))?;
    let retire = Some(stream_id);
    install(stream, roots, params, stream_id)
        .await
        .map_err(|error| InstallFailure::new(error, retire))
}

async fn install(
    stream: &mut TcpStream,
    roots: &Roots,
    params: &Map<String, Value>,
    stream_id: u32,
) -> HelperResult<Value> {
    let kind = AdapterKind::parse(required_str(params, "kind")?)?;
    let version = required_version(params)?;
    let expected = required_digest(params)?;
    let directory = install_directory(roots, kind, &version, required_str(params, "path")?)?;
    let bundle = directory.join(BUNDLE_FILE);
    if let Ok(metadata) = fs::symlink_metadata(&bundle) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(HelperError::PathForbidden);
        }
    }

    let staging = staging_path(&directory);
    let file = create_staging(&staging)?;
    let (received, digest) = match receive(stream, file, stream_id).await {
        Ok(received) => received,
        Err(error) => {
            remove_quietly(&staging);
            return Err(error);
        }
    };
    // The pinned digest is the whole point of the operation: a payload that
    // does not match it is dropped before it can replace an installed bundle.
    if received == 0 || digest != expected {
        remove_quietly(&staging);
        return Err(HelperError::AdapterInstallFailed);
    }
    if let Err(error) = promote(&staging, &bundle) {
        remove_quietly(&staging);
        return Err(error);
    }
    let installed_at = now_ms();
    if let Err(error) = write_receipt(&directory, kind, &version, &digest, received, installed_at) {
        remove_quietly(&bundle);
        return Err(error);
    }
    Ok(json!({
        "kind": kind.id(),
        "version": version,
        "sha256": digest,
        "size": received,
        "bundlePath": format!("adapters/{}/{version}/{BUNDLE_FILE}", kind.id()),
        "installedAt": installed_at,
    }))
}

/// Resolves the one install location the protocol permits for this entry.
///
/// The request names the directory so a mismatched or escaping value is
/// refused instead of resolved, and the containment helpers still own the
/// proof that the directory is inside the helper root.
fn install_directory(
    roots: &Roots,
    kind: AdapterKind,
    version: &str,
    requested: &str,
) -> HelperResult<PathBuf> {
    let relative = format!("adapters/{}/{version}", kind.id());
    if requested != relative {
        return Err(HelperError::InvalidArgument);
    }
    let directory = roots.resolve_mkdir(&relative)?;
    // `adapters/...` also resolves under a project root that happens to hold a
    // matching directory; installing there would put the payload outside the
    // helper's private state.
    if !directory.starts_with(roots.helper_root()) {
        return Err(HelperError::PathForbidden);
    }
    if directory != roots.helper_root().join(&relative) {
        return Err(HelperError::PathForbidden);
    }
    Ok(directory)
}

/// Reports the installed version for one kind, or its absence.
pub(crate) fn probe(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let kind = AdapterKind::parse(required_str(params, "kind")?)?;
    let expected = optional_str(params, "version")?;
    let installed = installed(roots, kind)?;
    if let Some(expected) = expected {
        let matches = installed
            .as_ref()
            .is_some_and(|found| found.version == expected);
        if !matches {
            return Err(HelperError::AdapterVersionMismatch);
        }
    }
    Ok(json!({
        "kind": kind.id(),
        "installed": installed.is_some(),
        "version": installed.as_ref().map(|found| found.version.clone()),
        "sha256": installed.as_ref().map(|found| found.sha256.clone()),
        "installedAt": installed.as_ref().map(|found| found.installed_at),
    }))
}

/// Launches the installed adapter on loopback and reports where it listens.
pub(crate) fn start(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let kind = AdapterKind::parse(required_str(params, "kind")?)?;
    let expected = optional_str(params, "version")?;
    let installed = installed(roots, kind)?.ok_or(HelperError::AdapterVersionMismatch)?;
    if let Some(expected) = expected {
        if expected != installed.version {
            return Err(HelperError::AdapterVersionMismatch);
        }
    }
    let key = Key {
        helper: roots.helper_root().to_path_buf(),
        kind,
    };
    let mut running = registry();
    // An adapter that exited on its own is not running; dropping its stale
    // entry keeps an explicit retry possible without relaunching anything.
    let exited = match running.get_mut(&key) {
        Some(entry) => matches!(entry.child.try_wait(), Ok(Some(_))),
        None => false,
    };
    if exited {
        running.remove(&key);
    }
    if running.contains_key(&key) {
        return Err(HelperError::InvalidArgument);
    }
    let port = ephemeral_port()?;
    let child = Command::new(&installed.bundle)
        .args(kind.argv(port))
        .stdin(Stdio::null())
        // Inherited so adapter diagnostics land in the helper log the deploy
        // script already redirects, instead of being discarded.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(HelperError::Io)?;
    let pid = child.id();
    running.insert(key, Running { child });
    Ok(json!({
        "kind": kind.id(),
        "port": port,
        "pid": pid,
        "version": installed.version,
    }))
}

/// Terminates the adapter for one kind; absent means already stopped.
pub(crate) fn stop(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let kind = AdapterKind::parse(required_str(params, "kind")?)?;
    let key = Key {
        helper: roots.helper_root().to_path_buf(),
        kind,
    };
    let stopped = registry().remove(&key).is_some();
    Ok(json!({ "kind": kind.id(), "stopped": stopped }))
}

/// Kills every adapter this process started; used on helper shutdown.
pub(crate) fn shutdown() {
    registry().clear();
}

/// Reads the newest installed version of `kind`, if any.
fn installed(roots: &Roots, kind: AdapterKind) -> HelperResult<Option<Installed>> {
    let relative = format!("adapters/{}", kind.id());
    let directory = match roots.resolve_read(&relative) {
        Ok(path) => path,
        Err(HelperError::PathNotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !directory.starts_with(roots.helper_root()) {
        return Err(HelperError::PathForbidden);
    }
    let entries = fs::read_dir(&directory)?;
    let mut newest: Option<Installed> = None;
    let mut inspected = 0usize;
    for entry in entries.flatten() {
        inspected += 1;
        if inspected > MAX_INSTALLED_VERSIONS {
            break;
        }
        // `file_type` does not follow links, so a symlinked version directory
        // can never stand in for an installed adapter.
        if !matches!(entry.file_type(), Ok(file_type) if file_type.is_dir()) {
            continue;
        }
        let Some(version) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(candidate) = read_receipt(&entry.path(), kind, &version) else {
            continue;
        };
        let newer = match &newest {
            Some(current) => candidate.installed_at >= current.installed_at,
            None => true,
        };
        if newer {
            newest = Some(candidate);
        }
    }
    Ok(newest)
}

/// Reads and validates one receipt written by a completed install.
fn read_receipt(directory: &Path, kind: AdapterKind, version: &str) -> Option<Installed> {
    let receipt = directory.join(RECEIPT_FILE);
    let metadata = fs::symlink_metadata(&receipt).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RECEIPT_BYTES {
        return None;
    }
    let bytes = fs::read(&receipt).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let sha256 = value.get("sha256")?.as_str()?;
    if !is_digest(sha256) || value.get("kind")?.as_str()? != kind.id() {
        return None;
    }
    if value.get("version")?.as_str()? != version {
        return None;
    }
    let bundle = directory.join(BUNDLE_FILE);
    if !fs::symlink_metadata(&bundle).is_ok_and(|metadata| metadata.is_file()) {
        return None;
    }
    Some(Installed {
        version: version.to_owned(),
        sha256: sha256.to_owned(),
        installed_at: value.get("installedAt")?.as_u64()?,
        bundle,
    })
}

fn write_receipt(
    directory: &Path,
    kind: AdapterKind,
    version: &str,
    sha256: &str,
    size: u64,
    installed_at: u64,
) -> HelperResult<()> {
    let body = serde_json::to_vec(&json!({
        "kind": kind.id(),
        "version": version,
        "sha256": sha256,
        "size": size,
        "installedAt": installed_at,
    }))
    .map_err(|_| HelperError::AdapterInstallFailed)?;
    let target = directory.join(RECEIPT_FILE);
    let staging = staging_path(directory);
    let mut file = create_staging(&staging)?;
    file.write_all(&body)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = promote(&staging, &target) {
        remove_quietly(&staging);
        return Err(error);
    }
    Ok(())
}

/// Consumes the data frames of one install into `staging`.
async fn receive(
    stream: &mut TcpStream,
    mut file: File,
    stream_id: u32,
) -> HelperResult<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut frames = 0u32;
    loop {
        let (kind, payload) = read_frame_timeout(stream).await?;
        if payload_stream_id(&payload)? != stream_id {
            return Err(HelperError::Frame);
        }
        frames += 1;
        if frames > MAX_STREAM_FRAMES {
            return Err(HelperError::AdapterInstallFailed);
        }
        match kind {
            DATA_FRAME => {
                let bytes = payload.get(4..).ok_or(HelperError::Frame)?;
                received += bytes.len() as u64;
                if received > MAX_FILE_BYTES {
                    return Err(HelperError::FileTooLarge);
                }
                file.write_all(bytes)?;
                hasher.update(bytes);
            }
            END_FRAME => break,
            _ => return Err(HelperError::Frame),
        }
    }
    file.sync_all()?;
    Ok((received, hex::encode(hasher.finalize())))
}

/// Moves a verified staging file onto its target.
fn promote(staging: &Path, target: &Path) -> HelperResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(staging, fs::Permissions::from_mode(0o700))
            .map_err(HelperError::AdapterInstallFailed)?;
    }
    fs::rename(staging, target).map_err(|_| HelperError::AdapterInstallFailed)
}

fn staging_path(directory: &Path) -> PathBuf {
    let mut nonce = [0u8; TEMP_NONCE_BYTES];
    rng().fill_bytes(&mut nonce);
    directory.join(format!(".{}.{TEMP_SUFFIX}", hex::encode(nonce)))
}

/// Creates a private staging file, refusing to reuse any existing path.
fn create_staging(path: &Path) -> HelperResult<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| HelperError::AdapterInstallFailed)
}

fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Binds loopback with port zero to learn a free port, then releases it.
///
/// The adapter cannot inherit the socket: it is a separate program that binds
/// the port itself, so a short release window is unavoidable and acceptable
/// for a loopback-only listener behind the desktop's SSH forward.
fn ephemeral_port() -> HelperResult<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VERSION_BYTES
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'))
}

fn required_str<'a>(params: &'a Map<String, Value>, key: &str) -> HelperResult<&'a str> {
    match params.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(HelperError::InvalidArgument),
    }
}

fn optional_str<'a>(params: &'a Map<String, Value>, key: &str) -> HelperResult<Option<&'a str>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(HelperError::InvalidArgument),
    }
}

fn required_u32(params: &Map<String, Value>, key: &str) -> HelperResult<u32> {
    match params.get(key) {
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(HelperError::InvalidArgument),
        _ => Err(HelperError::InvalidArgument),
    }
}

fn required_version(params: &Map<String, Value>) -> HelperResult<String> {
    let value = required_str(params, "version")?;
    if !is_version(value) {
        return Err(HelperError::InvalidArgument);
    }
    Ok(value.to_owned())
}

fn required_digest(params: &Map<String, Value>) -> HelperResult<String> {
    let value = required_str(params, "sha256")?;
    if !is_digest(value) {
        return Err(HelperError::InvalidArgument);
    }
    Ok(value.to_ascii_lowercase())
}
