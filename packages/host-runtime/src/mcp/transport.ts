/** MCP revision we advertise during the handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * Both transports are reduced to "send a message, receive messages", which lets
 * the client speak the same JSON-RPC dialect over a pipe or over HTTP.
 */
export type McpTransport = {
  send: (message: JsonRpcMessage, timeoutMs?: number, signal?: AbortSignal) => Promise<void>;
  close: () => void;
};

export type McpTransportHandlers = {
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (reason: string) => void;
};

export type McpError = Error & { code?: string };

export function mcpError(code: string, message: string): McpError {
  const error = new Error(message) as McpError;
  error.code = code;
  return error;
}
