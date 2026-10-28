//! Wire framing for the helper protocol (spec 23 §3.3).
//!
//! Every frame is one type byte, a four-byte unsigned big-endian payload
//! length, and exactly that many payload bytes. Control frames carry a JSON
//! object, data frames carry a stream id followed by raw file bytes, and the
//! end-of-stream frame carries only the stream id.

use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

use crate::{HelperError, HelperResult};

pub(crate) const CONTROL_FRAME: u8 = 0x01;
pub(crate) const DATA_FRAME: u8 = 0x02;
pub(crate) const END_FRAME: u8 = 0x03;

/// Largest payload a data or end-of-stream frame may carry.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// Largest payload a control frame may carry.
pub const MAX_CONTROL_BYTES: usize = 64 * 1024;
/// Per-file transfer ceiling, enforced in both directions (spec 23 §6.3).
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// File content carried by one data frame.
pub(crate) const DATA_CHUNK_BYTES: usize = 64 * 1024;
/// Deadline for one frame read or write; a stalled peer never blocks a
/// connection indefinitely.
pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) async fn read_frame(stream: &mut TcpStream) -> HelperResult<(u8, Vec<u8>)> {
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

/// Reads one frame under the per-frame deadline.
pub(crate) async fn read_frame_timeout(stream: &mut TcpStream) -> HelperResult<(u8, Vec<u8>)> {
    timeout(IO_TIMEOUT, read_frame(stream))
        .await
        .map_err(|_| HelperError::Frame)?
}
async fn write_all(stream: &mut TcpStream, bytes: &[u8]) -> HelperResult<()> {
    timeout(IO_TIMEOUT, stream.write_all(bytes))
        .await
        .map_err(|_| HelperError::Frame)??;
    Ok(())
}

pub(crate) async fn write_frame(
    stream: &mut TcpStream,
    kind: u8,
    payload: &[u8],
) -> HelperResult<()> {
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
    write_all(stream, &header).await?;
    write_all(stream, payload).await
}

/// Reads the stream id carried by a data or end-of-stream payload.
pub(crate) fn payload_stream_id(payload: &[u8]) -> HelperResult<u32> {
    let bytes: [u8; 4] = payload
        .get(..4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(HelperError::Frame)?;
    Ok(u32::from_be_bytes(bytes))
}

pub(crate) async fn write_data_frame(
    stream: &mut TcpStream,
    stream_id: u32,
    bytes: &[u8],
) -> HelperResult<()> {
    let mut payload = Vec::with_capacity(4 + bytes.len());
    payload.extend_from_slice(&stream_id.to_be_bytes());
    payload.extend_from_slice(bytes);
    write_frame(stream, DATA_FRAME, &payload).await
}

pub(crate) async fn write_end_frame(stream: &mut TcpStream, stream_id: u32) -> HelperResult<()> {
    write_frame(stream, END_FRAME, &stream_id.to_be_bytes()).await
}
