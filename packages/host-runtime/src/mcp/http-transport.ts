import { MCP_PROTOCOL_VERSION, mcpError, type JsonRpcMessage, type McpTransport, type McpTransportHandlers } from "./transport.js";

/** Keep an MCP endpoint from bouncing requests through an unbounded chain. */
const MAX_MCP_REDIRECTS = 5;
/** Guard against a remote MCP server streaming an unbounded response body. */
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

function parseSseMessages(body: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const block of body.split(/\n\n/)) {
    const data = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // A partial event is not actionable; the request times out instead.
    }
  }
  return out;
}


async function readBoundedHttpBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already rejected; cancellation is best effort.
    }
    throw mcpError("LIMIT_EXCEEDED", "mcp server response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw mcpError("LIMIT_EXCEEDED", "mcp server response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Dispatch `text/event-stream` messages as they arrive instead of waiting for
 * the body to end. A streamable-HTTP server is free to hold the response open
 * long after the JSON-RPC reply has been written, and reading the whole stream
 * first turned that server-side schedule into a client-side timeout.
 */
async function streamSseMessages(
  response: Response,
  onMessage: (message: JsonRpcMessage) => void,
): Promise<void> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already rejected; cancellation is best effort.
    }
    throw mcpError("LIMIT_EXCEEDED", "mcp server response is too large");
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const dispatchCompleteEvents = () => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) return;
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      for (const entry of parseSseMessages(event)) onMessage(entry);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw mcpError("LIMIT_EXCEEDED", "mcp server response is too large");
      }
      buffer += decoder.decode(value, { stream: true });
      dispatchCompleteEvents();
    }
    buffer += decoder.decode();
    dispatchCompleteEvents();
    // A body that ends without its closing blank line still owes us that event.
    for (const entry of parseSseMessages(buffer)) onMessage(entry);
  } finally {
    reader.releaseLock();
  }
}

function headersForMcpRequest(
  headers: Record<string, string>,
  initialUrl: string,
  currentUrl: string,
): Record<string, string> {
  if (new URL(initialUrl).origin === new URL(currentUrl).origin) return { ...headers };
  return {};
}

export function createHttpTransport(
  options: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    assertUrlAllowed?: (url: string) => void;
  },
  handlers: McpTransportHandlers,
): McpTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw mcpError("UNSUPPORTED", "fetch is unavailable for remote mcp servers");
  }
  let closed = false;
  let sessionId: string | undefined;
  const activeControllers = new Set<AbortController>();

  return {
    send: async (message, timeoutMs = options.timeoutMs, signal) => {
      if (closed) throw mcpError("UNAVAILABLE", "mcp session is closed");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      activeControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let url = options.url;
      try {
        for (let hop = 0; ; hop += 1) {
          options.assertUrlAllowed?.(url);
          const requestHeaders = headersForMcpRequest(options.headers, options.url, url);
          const currentOrigin = new URL(url).origin;
          const initialOrigin = new URL(options.url).origin;
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              ...requestHeaders,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": MCP_PROTOCOL_VERSION,
              ...(currentOrigin === initialOrigin && sessionId
                ? { "mcp-session-id": sessionId }
                : {}),
            },
            body: JSON.stringify(message),
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status <= 399) {
            const location = response.headers.get("location");
            try {
              await response.body?.cancel();
            } catch {
              // The redirect body is not part of the MCP response.
            }
            if (!location) {
              throw mcpError("HTTP_REDIRECT", "redirect without a location header");
            }
            if (hop >= MAX_MCP_REDIRECTS) {
              throw mcpError("HTTP_REDIRECT", `too many redirects: ${options.url}`);
            }
            let nextUrl: URL;
            try {
              nextUrl = new URL(location, url);
            } catch {
              throw mcpError("HTTP_REDIRECT", `invalid redirect from ${url}`);
            }
            if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
              throw mcpError("HTTP_REDIRECT", `unsupported redirect from ${url}`);
            }
            if (nextUrl.origin !== initialOrigin) sessionId = undefined;
            url = nextUrl.toString();
            continue;
          }
          if (!response.ok) {
            try {
              await response.body?.cancel();
            } catch {
              // The status is sufficient for the structured MCP error.
            }
            throw mcpError("HTTP_ERROR", `mcp server returned ${response.status}`);
          }
          const nextSession = response.headers.get("mcp-session-id");
          if (nextSession && new URL(url).origin === initialOrigin) sessionId = nextSession;
          // Notifications and client responses have no JSON-RPC reply. Some
          // servers include a plain-text "Accepted" body with their HTTP 202.
          if (response.status === 202 && (message.method === undefined || message.id === undefined)) {
            try {
              await response.body?.cancel();
            } catch {
              // The acknowledgement body is not part of the MCP response.
            }
            return;
          }
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("text/event-stream")) {
            // A streamable-HTTP server may hold the SSE stream open long after
            // the JSON-RPC reply is written — keep-alives, or a session it ends
            // on its own schedule (gitmcp.io answers in ~2s and closes ~12s
            // later). Dispatching each event as it lands keeps that wait out of
            // the caller's timeout budget.
            await streamSseMessages(response, handlers.onMessage);
            return;
          }
          const body = await readBoundedHttpBody(response);
          if (!body.trim()) return;
          const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
          for (const entry of Array.isArray(parsed) ? parsed : [parsed]) handlers.onMessage(entry);
          return;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        activeControllers.delete(controller);
      }
    },
    close: () => {
      closed = true;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
      handlers.onClose("mcp session closed");
    },
  };
}
