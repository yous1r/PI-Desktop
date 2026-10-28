//! File data plane: batch metadata, hashing, directory creation, and the
//! per-file `put`/`get` streams (spec 23 §6).
//!
//! Uploads are atomic: bytes go to a sibling temporary file that is created
//! exclusively, fsynced, digest-verified, and only then renamed over the target.
//! A failed or cancelled transfer removes the sibling it created, so a target is
//! either the previous file or the new one and never a partial write.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use rand::{rng, Rng};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;

use crate::{
    contain::Roots,
    frame::{
        payload_stream_id, read_frame_timeout, write_data_frame, write_end_frame, DATA_CHUNK_BYTES,
        DATA_FRAME, END_FRAME, MAX_CONTROL_BYTES, MAX_FILE_BYTES,
    },
    HelperError, HelperResult,
};

/// Most paths one batch request may carry.
pub(crate) const MAX_BATCH_PATHS: usize = 4096;
/// Most data frames one upload may spend; bounds an empty-frame flood.
const MAX_STREAM_FRAMES: u32 = 65_536;
const TEMP_SUFFIX: &str = "pi-part";
/// Random bytes in a temporary name. A predictable name would let one request
/// truncate, or write through a symlink at, a file it did not create.
const TEMP_NONCE_BYTES: usize = 12;
/// Headroom kept free when a batch reply must fit one control frame.
const CONTROL_REPLY_MARGIN: usize = 512;

/// A failed upload and the stream whose remaining frames must be discarded.
pub(crate) struct PutFailure {
    pub(crate) error: HelperError,
    pub(crate) retire: Option<u32>,
}

impl PutFailure {
    fn new(error: HelperError, retire: Option<u32>) -> Self {
        Self { error, retire }
    }
}

pub(crate) fn stat_batch(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let paths = required_paths(params)?;
    let mut entries = Vec::with_capacity(paths.len());
    let mut reply_bytes = 16usize;
    for relative in paths {
        let entry = stat_entry(roots, relative)?;
        reply_bytes = reply_bytes
            .checked_add(
                serde_json::to_vec(&entry)
                    .map_err(|_| HelperError::InvalidArgument)?
                    .len()
                    + 1,
            )
            .ok_or(HelperError::InvalidArgument)?;
        if reply_bytes > MAX_CONTROL_BYTES - CONTROL_REPLY_MARGIN {
            return Err(HelperError::InvalidArgument);
        }
        entries.push(entry);
    }
    Ok(json!({ "entries": entries }))
}

pub(crate) fn hash_file(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let relative = required_str(params, "path")?;
    let resolved = roots.resolve_read(relative)?;
    let metadata = fs::metadata(&resolved).map_err(|_| HelperError::PathNotFound)?;
    if !metadata.is_file() {
        return Err(HelperError::InvalidArgument);
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(HelperError::FileTooLarge);
    }
    let mut file = File::open(&resolved)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; DATA_CHUNK_BYTES];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > MAX_FILE_BYTES {
            return Err(HelperError::FileTooLarge);
        }
        hasher.update(&buffer[..read]);
    }
    Ok(json!({
        "path": relative,
        "sha256": hex::encode(hasher.finalize()),
        "size": size,
    }))
}

pub(crate) fn mkdirs(roots: &Roots, params: &Map<String, Value>) -> HelperResult<Value> {
    let paths = required_paths(params)?;
    // The reply is one control frame. It is priced before any directory exists,
    // because a frame that cannot be written would drop the connection after
    // the directories were already created and leave the caller unable to tell
    // success from failure.
    let mut reply_bytes = 16usize;
    for relative in &paths {
        let path_bytes = relative.len() * 6 + 2;
        reply_bytes = reply_bytes
            .checked_add(path_bytes + 1)
            .ok_or(HelperError::InvalidArgument)?;
        if reply_bytes > MAX_CONTROL_BYTES - CONTROL_REPLY_MARGIN {
            return Err(HelperError::InvalidArgument);
        }
    }
    let mut created = Vec::with_capacity(paths.len());
    for relative in paths {
        roots.resolve_mkdir(relative)?;
        created.push(relative);
    }
    Ok(json!({ "paths": created }))
}

/// Receives one uploaded file and atomically replaces its target.
pub(crate) async fn put_stream(
    stream: &mut TcpStream,
    roots: &Roots,
    params: &Map<String, Value>,
) -> Result<Value, PutFailure> {
    let stream_id =
        required_u32(params, "streamId").map_err(|error| PutFailure::new(error, None))?;
    let retire = Some(stream_id);
    let relative = required_str(params, "path").map_err(|error| PutFailure::new(error, retire))?;
    let declared_size =
        required_u64(params, "size").map_err(|error| PutFailure::new(error, retire))?;
    let declared_digest =
        required_digest(params, "sha256").map_err(|error| PutFailure::new(error, retire))?;

    // The ceiling is enforced before a single byte is accepted.
    if declared_size > MAX_FILE_BYTES {
        return Err(PutFailure::new(HelperError::FileTooLarge, retire));
    }
    let target = roots
        .resolve_write(relative)
        .map_err(|error| PutFailure::new(error, retire))?;
    // The temporary name is random and created exclusively: a pre-existing file
    // or symlink at that path can neither be truncated nor written through, and
    // a failed request only ever removes the file it created itself.
    let temp = temp_path(&target);
    let file = match create_temp(&temp) {
        Ok(file) => file,
        Err(error) => {
            remove_quietly(&temp);
            return Err(PutFailure::new(error, retire));
        }
    };

    let (received, digest) = match receive(stream, file, stream_id, declared_size).await {
        Ok(result) => result,
        Err(error) => {
            remove_quietly(&temp);
            return Err(PutFailure::new(error, retire));
        }
    };
    if received != declared_size || digest != declared_digest {
        remove_quietly(&temp);
        return Err(PutFailure::new(HelperError::TransferFailed, retire));
    }
    // Preserve the target's permissions: the staging file is private, the
    // protocol carries no mode field, so an executable bit would be lost.
    if let Ok(metadata) = fs::metadata(&target) {
        let _ = fs::set_permissions(&temp, metadata.permissions());
    }
    if let Err(error) = fs::rename(&temp, &target) {
        remove_quietly(&temp);
        return Err(PutFailure::new(HelperError::Io(error), retire));
    }
    Ok(json!({
        "path": relative,
        "size": received,
        "sha256": digest,
    }))
}

/// One prepared download: the open file, its declared size, and its stream id.
pub(crate) struct GetPlan {
    stream_id: u32,
    size: u64,
    file: File,
}

impl GetPlan {
    /// The control result announced before any data frame is written.
    pub(crate) fn response(&self) -> Value {
        json!({ "streamId": self.stream_id, "size": self.size })
    }
}

pub(crate) fn prepare_get(roots: &Roots, params: &Map<String, Value>) -> HelperResult<GetPlan> {
    let stream_id = required_u32(params, "streamId")?;
    let relative = required_str(params, "path")?;
    let resolved = roots.resolve_read(relative)?;
    let metadata = fs::metadata(&resolved).map_err(|_| HelperError::PathNotFound)?;
    if !metadata.is_file() {
        return Err(HelperError::InvalidArgument);
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(HelperError::FileTooLarge);
    }
    let file = File::open(&resolved)?;
    Ok(GetPlan {
        stream_id,
        size: metadata.len(),
        file,
    })
}

/// Streams a prepared download; the caller has already sent the control reply.
pub(crate) async fn send_get(stream: &mut TcpStream, mut plan: GetPlan) -> HelperResult<()> {
    let mut buffer = vec![0u8; DATA_CHUNK_BYTES];
    let mut sent = 0u64;
    loop {
        let read = plan.file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        sent += read as u64;
        if sent > plan.size {
            // The file grew after the reply; the announced size is a contract.
            return Err(HelperError::TransferFailed);
        }
        write_data_frame(stream, plan.stream_id, &buffer[..read]).await?;
    }
    if sent != plan.size {
        // The file shrank; without an end frame the client sees a failed
        // transfer instead of a silently truncated file.
        return Err(HelperError::TransferFailed);
    }
    write_end_frame(stream, plan.stream_id).await
}

/// Consumes the data frames of one upload into `temp`.
///
/// Returns the received byte count and the lowercase hex digest.
async fn receive(
    stream: &mut TcpStream,
    mut file: File,
    stream_id: u32,
    declared_size: u64,
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
            return Err(HelperError::TransferFailed);
        }
        match kind {
            DATA_FRAME => {
                let bytes = payload.get(4..).ok_or(HelperError::Frame)?;
                received += bytes.len() as u64;
                if received > declared_size {
                    return Err(HelperError::TransferFailed);
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

fn stat_entry(roots: &Roots, relative: &str) -> HelperResult<Value> {
    let resolved = match roots.resolve_read(relative) {
        Ok(path) => path,
        Err(HelperError::PathNotFound) => return Ok(kind_entry(relative, "missing", None)),
        Err(error) => return Err(error),
    };
    let metadata = fs::metadata(&resolved).map_err(|_| HelperError::PathNotFound)?;
    if metadata.is_dir() {
        return Ok(kind_entry(relative, "directory", Some(&metadata)));
    }
    if !metadata.is_file() {
        return Ok(kind_entry(relative, "missing", None));
    }
    Ok(kind_entry(relative, "file", Some(&metadata)))
}

fn kind_entry(relative: &str, kind: &str, metadata: Option<&fs::Metadata>) -> Value {
    let mut entry = Map::new();
    entry.insert("path".to_owned(), Value::String(relative.to_owned()));
    entry.insert("kind".to_owned(), Value::String(kind.to_owned()));
    if let Some(metadata) = metadata {
        if metadata.is_file() {
            entry.insert("size".to_owned(), json!(metadata.len()));
        }
        entry.insert("mtimeMs".to_owned(), json!(mtime_ms(metadata)));
        #[cfg(unix)]
        entry.insert("mode".to_owned(), json!(unix_mode(metadata)));
    }
    Value::Object(entry)
}

fn mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(unix)]
fn unix_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}

/// Sibling temporary file used for an atomic replace.
///
/// The name carries a random nonce rather than the client's stream id so two
/// requests, an earlier crash, or a checked-in file can never share a staging
/// path.
fn temp_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(TEMP_SUFFIX);
    let mut nonce = [0u8; TEMP_NONCE_BYTES];
    rng().fill_bytes(&mut nonce);
    target.with_file_name(format!("{name}.{}.{TEMP_SUFFIX}", hex::encode(nonce)))
}

/// Creates the staging file, refusing to reuse any existing path.
///
/// `create_new` also refuses a pre-existing symlink, which is what keeps an
/// upload from being written through to a target outside the root.
fn create_temp(path: &Path) -> HelperResult<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(HelperError::Io)
}

/// Removes a staging file this request created. Never used on a target.
fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

fn required_str<'a>(params: &'a Map<String, Value>, key: &str) -> HelperResult<&'a str> {
    match params.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(HelperError::InvalidArgument),
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

fn required_u64(params: &Map<String, Value>, key: &str) -> HelperResult<u64> {
    match params.get(key) {
        Some(Value::Number(number)) => number.as_u64().ok_or(HelperError::InvalidArgument),
        _ => Err(HelperError::InvalidArgument),
    }
}

fn required_digest(params: &Map<String, Value>, key: &str) -> HelperResult<String> {
    let value = required_str(params, key)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HelperError::InvalidArgument);
    }
    Ok(value.to_ascii_lowercase())
}

fn required_paths(params: &Map<String, Value>) -> HelperResult<Vec<&str>> {
    let Some(Value::Array(items)) = params.get("paths") else {
        return Err(HelperError::InvalidArgument);
    };
    if items.len() > MAX_BATCH_PATHS {
        return Err(HelperError::InvalidArgument);
    }
    let mut paths = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(path) => paths.push(path.as_str()),
            _ => return Err(HelperError::InvalidArgument),
        }
    }
    Ok(paths)
}
