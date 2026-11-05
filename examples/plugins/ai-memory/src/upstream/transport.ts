import { randomUUID } from 'node:crypto';
import { assertActive, errorCode, MemoryError, record, type Connections, type ConnectionResponse, type Scope } from '../contracts.js';

export function header(headers: Record<string, string>, key: string): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}
export function retryAfter(value: string | undefined, now = Date.now()): number {
  const numeric = Number(value);
  const delay = value && Number.isFinite(numeric) ? numeric * 1000 : value ? Date.parse(value) - now : 1000;
  return Math.max(1000, Math.min(Number.isFinite(delay) ? delay : 1000, 86400_000));
}
export function decodeRpc(response: ConnectionResponse, id: string): Record<string, unknown> {
  if (Buffer.byteLength(response.bodyText) > 1024 * 1024) throw new MemoryError('RESPONSE_TOO_LARGE');
  const type = header(response.headers, 'content-type')?.split(';')[0].trim();
  let packets: unknown[];
  try {
    if (type === 'text/event-stream') {
      packets = response.bodyText.replace(/\r\n/g, '\n').split(/\n\n+/).flatMap(event => {
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        return data ? [JSON.parse(data)] : [];
      });
    } else if (type === 'application/json' || type === 'application/json-rpc') packets = [JSON.parse(response.bodyText)];
    else throw new MemoryError('CONTENT_TYPE_UNSUPPORTED');
  } catch (error) { throw error instanceof MemoryError ? error : new MemoryError('RPC_MALFORMED'); }
  const matching = packets.filter(packet => packet && typeof packet === 'object' && 'id' in packet && packet.id === id);
  if (matching.length !== 1) throw new MemoryError('RPC_ID_MISMATCH');
  const rpc = record(matching[0]);
  if (rpc.jsonrpc !== '2.0') throw new MemoryError('RPC_MALFORMED');
  if (rpc.error !== undefined) {
    const error = record(rpc.error);
    if (error.data && typeof error.data === 'object' && record(error.data).reason === 'precondition_failed') throw new MemoryError('PAGE_CONFLICT');
    throw new MemoryError('RPC_ERROR');
  }
  if (!('result' in rpc)) throw new MemoryError('RPC_MALFORMED');
  return record(rpc.result);
}
export function unwrapTool(result: Record<string, unknown>): unknown {
  if (result.isError === true) throw new MemoryError('UPSTREAM_TOOL_ERROR');
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) throw new MemoryError('TOOL_RESULT_MALFORMED');
  const parts = result.content.filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string');
  if (parts.length !== 1) throw new MemoryError('TOOL_RESULT_MALFORMED');
  try { return JSON.parse(parts[0].text); } catch { throw new MemoryError('TOOL_RESULT_MALFORMED'); }
}
export class McpTransport {
  private sessionId?: string;
  private protocol?: string;
  sessionExpired = false;
  resetSession(): void { this.sessionId = undefined; this.protocol = undefined; this.sessionExpired = false; }
  constructor(private connections: Connections, readonly scope: Scope) {}
  async post(path: string, body: unknown, signal: AbortSignal, timeoutMs = 8000): Promise<ConnectionResponse> {
    assertActive(signal);
    const requestId = randomUUID();
    const admittedSession = path === '/mcp' ? this.sessionId : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (path === '/mcp' && this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (path === '/mcp' && this.protocol) headers['MCP-Protocol-Version'] = this.protocol;
    let cancelled: Promise<void> | undefined;
    const cancel = () => { cancelled = this.connections.cancel(requestId).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await this.connections.request({ connectionId: this.scope.connectionId, expectedRevision: this.scope.connectionRevision, requestId, path, method: 'POST', headers, body: JSON.stringify(body), timeoutMs });
      assertActive(signal);
      if (result.connectionRevision !== this.scope.connectionRevision) throw new MemoryError('CONNECTION_CHANGED');
      if ([401, 403].includes(result.status)) throw new MemoryError('AUTH_REQUIRED');
      if (result.status === 429) throw new MemoryError('RATE_LIMITED', retryAfter(header(result.headers, 'retry-after')));
      if (result.status === 404 && admittedSession) {
        if (this.sessionId === admittedSession) { this.sessionId = undefined; this.sessionExpired = true; }
        throw new MemoryError('MCP_SESSION_EXPIRED');
      }
      if ([404, 410].includes(result.status)) throw new MemoryError('ENDPOINT_UNSUPPORTED');
      if (result.status < 200 || result.status >= 300) throw new MemoryError('HTTP_FAILURE');
      if (Buffer.byteLength(result.bodyText) > 1024 * 1024) throw new MemoryError('RESPONSE_TOO_LARGE');
      return result;
    } catch (error) {
      const source = errorCode(error);
      const code = ({ ABORTED: 'CANCELLED', TIMEOUT: 'REQUEST_TIMEOUT', CONNECTION_FAILED: 'TRANSPORT_FAILURE' } as Record<string, string>)[source] ?? source;
      throw error instanceof MemoryError ? error : new MemoryError(signal.aborted ? 'CANCELLED' : code === 'UNEXPECTED_FAILURE' ? 'TRANSPORT_FAILURE' : code);
    }
    finally { signal.removeEventListener('abort', cancel); if (cancelled) await cancelled; }
  }
  async rpc(method: string, params: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const response = await this.post('/mcp', { jsonrpc: '2.0', id, method, params }, signal);
    const result = decodeRpc(response, id);
    if (method === 'initialize') {
      const session = header(response.headers, 'mcp-session-id');
      if (session && (session.length > 256 || /[^\x21-\x7e]/.test(session))) throw new MemoryError('MCP_SESSION_INVALID');
      this.sessionId = session;
      this.protocol = typeof result.protocolVersion === 'string' ? result.protocolVersion : undefined;
    }
    return result;
  }
  async initialized(signal: AbortSignal): Promise<void> { await this.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, signal); }
  async tool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return unwrapTool(await this.rpc('tools/call', { name, arguments: args }, signal));
  }
}
