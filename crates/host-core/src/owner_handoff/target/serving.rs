//! Bounded target-mode RPC transport over the inherited framed channel.
//!
//! Claim and Ready still use their strict single-frame envelopes. After Ready
//! the same private channel may serve ordinary JSON-RPC requests, one bounded
//! NDJSON object per 4-byte length frame, with one framed response per request.
//! The loop is intentionally serial: a restricted successor must not fan out
//! unbounded request tasks before its execution root/sidecar is qualified.
use anyhow::{bail, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) const MAX_RPC_FRAME_BYTES: usize = crate::owner_control::protocol::MAX_FRAME_BYTES;
pub(crate) const SERVING_UNAVAILABLE: &str = "HANDOFF_TARGET_SERVING_UNAVAILABLE";
pub(crate) const INVALID_FRAME: &str = "HANDOFF_TARGET_RPC_INVALID_FRAME";

/// One parsed JSON-RPC request delivered to the caller's dispatcher.
pub(crate) struct RpcRequest {
    pub(crate) id: Value,
    pub(crate) method: String,
    pub(crate) params: Value,
}

/// Read exactly one optional frame. `None` is a clean peer close; a partial or
/// oversized frame is a protocol failure and must not be retried as EOF.
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read(&mut header[..1]).await? {
        0 => return Ok(None),
        1 => {}
        _ => bail!("{INVALID_FRAME}"),
    }
    reader
        .read_exact(&mut header[1..])
        .await
        .map_err(|_| anyhow::anyhow!("{INVALID_FRAME}"))?;
    let length = u32::from_le_bytes(header) as usize;
    if !(1..=MAX_RPC_FRAME_BYTES).contains(&length) {
        bail!("{INVALID_FRAME}");
    }
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| anyhow::anyhow!("{INVALID_FRAME}"))?;
    Ok(Some(body))
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.is_empty() || body.len() > MAX_RPC_FRAME_BYTES {
        bail!("{INVALID_FRAME}");
    }
    writer.write_u32_le(body.len() as u32).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

fn parse_error() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": { "code": -32700, "message": "parse error" },
    })
}

/// Serve bounded framed JSON-RPC until the peer closes the inherited channel.
/// The dispatcher owns admission and response construction; this transport
/// only enforces frame bounds, single-request ordering and clean EOF.
pub(crate) async fn serve_framed<R, W, F, Fut>(
    mut reader: R,
    mut writer: W,
    mut dispatch: F,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(RpcRequest) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    loop {
        let Some(frame) = read_frame(&mut reader).await? else {
            return Ok(());
        };
        let Ok(text) = std::str::from_utf8(&frame) else {
            bail!("{INVALID_FRAME}");
        };
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(_) => {
                write_frame(&mut writer, &parse_error()).await?;
                continue;
            }
        };
        let Some(object) = value.as_object() else {
            write_frame(&mut writer, &parse_error()).await?;
            continue;
        };
        // Notifications have no id and never produce a response.
        let Some(id) = object.get("id").cloned() else {
            continue;
        };
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            write_frame(&mut writer, &parse_error()).await?;
            continue;
        };
        if method.is_empty() || method.len() > 256 {
            write_frame(&mut writer, &parse_error()).await?;
            continue;
        }
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = dispatch(RpcRequest {
            id,
            method: method.to_string(),
            params,
        })
        .await;
        write_frame(&mut writer, &response).await?;
    }
}
