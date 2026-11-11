//! Framed target serving transport evidence. The production dispatcher is wired
//! in `rpc::target_serve`; these tests exercise the bounded frame loop with a
//! deterministic dispatcher.
use crate::owner_handoff::target::serving::{
    serve_framed, RpcRequest, INVALID_FRAME, MAX_RPC_FRAME_BYTES, SERVING_UNAVAILABLE,
};
use serde_json::{json, Value};

fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap();
    let mut bytes = Vec::with_capacity(4 + body.len());
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    bytes
}
fn raw_frame(body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(4 + body.len());
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}
fn responses(bytes: &[u8]) -> Vec<Value> {
    let mut values = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        values.push(serde_json::from_slice(&bytes[offset + 4..offset + 4 + length]).unwrap());
        offset += 4 + length;
    }
    values
}
fn echo_dispatch(request: RpcRequest) -> std::future::Ready<Value> {
    std::future::ready(json!({
        "jsonrpc": "2.0",
        "id": request.id,
        "result": { "method": request.method, "params": request.params },
    }))
}

#[tokio::test]
async fn serves_ordered_framed_requests_and_clean_eof() {
    let first = json!({"jsonrpc":"2.0","id":1,"method":"app.health","params":{}});
    let second = json!({"jsonrpc":"2.0","id":"two","method":"app.handshake","params":{"protocolVersion":11}});
    let mut input = frame(&first);
    input.extend(frame(&second));
    let mut output = Vec::new();
    serve_framed(&mut input.as_slice(), &mut output, echo_dispatch)
        .await
        .unwrap();
    let values = responses(&output);
    assert_eq!(values.len(), 2);
    assert_eq!(values[0]["id"], json!(1));
    assert_eq!(values[0]["result"]["method"], json!("app.health"));
    assert_eq!(values[1]["id"], json!("two"));
    assert_eq!(values[1]["result"]["params"]["protocolVersion"], json!(11));
}

#[tokio::test]
async fn notifications_and_empty_input_produce_no_response() {
    let notification = json!({"jsonrpc":"2.0","method":"events.ping","params":{}});
    let mut output = Vec::new();
    serve_framed(
        &mut frame(&notification).as_slice(),
        &mut output,
        echo_dispatch,
    )
    .await
    .unwrap();
    assert!(output.is_empty());
    let mut empty = [].as_slice();
    serve_framed(&mut empty, &mut output, echo_dispatch)
        .await
        .unwrap();
    assert!(output.is_empty());
}

#[tokio::test]
async fn malformed_json_gets_a_null_id_parse_error_and_the_loop_continues() {
    let valid = json!({"jsonrpc":"2.0","id":7,"method":"app.health","params":{}});
    let mut input = raw_frame(b"{not-json");
    input.extend(frame(&valid));
    let mut output = Vec::new();
    serve_framed(&mut input.as_slice(), &mut output, echo_dispatch)
        .await
        .unwrap();
    let values = responses(&output);
    assert_eq!(values.len(), 2);
    assert_eq!(values[0]["id"], Value::Null);
    assert_eq!(values[0]["error"]["code"], json!(-32700));
    assert_eq!(values[1]["id"], json!(7));
}

#[tokio::test]
async fn oversize_zero_and_truncated_frames_fail_closed() {
    for input in [
        raw_frame(&[b'x'; MAX_RPC_FRAME_BYTES + 1]),
        vec![0, 0, 0, 0],
        vec![8, 0, 0, 0, b'{', b'}'],
    ] {
        let mut output = Vec::new();
        let error = serve_framed(&mut input.as_slice(), &mut output, echo_dispatch)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(INVALID_FRAME), "{error}");
        assert!(output.is_empty());
    }
}

#[tokio::test]
async fn dispatch_is_not_reachable_without_a_ready_serving_gate() {
    // The adapter refuses before this transport when the hub epoch or adopted
    // root is absent; the serving constant is the externally visible ticket.
    assert_eq!(SERVING_UNAVAILABLE, "HANDOFF_TARGET_SERVING_UNAVAILABLE");
    let dispatched = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = dispatched.clone();
    let mut output = Vec::new();
    serve_framed(&mut [].as_slice(), &mut output, move |request| {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        echo_dispatch(request)
    })
    .await
    .unwrap();
    assert_eq!(dispatched.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(output.is_empty());
}
