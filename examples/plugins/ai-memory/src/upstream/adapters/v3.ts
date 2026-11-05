import { assertActive, MemoryError, record, text, type Scope } from '../../contracts.js';
import { inspectCapabilities, TOOL_CONTRACTS, type CapabilityReport, type CompatibilityCatalog, type ToolOperation } from '../capabilities.js';
import { McpTransport } from '../transport.js';
import { digest, sameScope, type OutboxEvent } from '../../storage/journal.js';
import { UnexpectedHandoffError } from '../errors.js';
import { HOOK_EXTENSION, hookParts, observationMatches } from '../hook.js';

export interface Page { path: string; body: string; pageId: string | null; updatedAt?: string; workspace: string; project: string; truncated?: boolean }
export function wikiPath(value: unknown): string {
  const path = text(value, 512);
  if (path.startsWith('/') || /[\\\x00-\x1f:]/.test(path) || path.split('/').some(part => part === '..' || part === '.' || !part)) throw new MemoryError('INVALID_PAGE_PATH');
  return path;
}
function scopeResult(result: Record<string, unknown>, scope: Scope): void {
  const returned = result.scope && typeof result.scope === 'object' ? record(result.scope) : result;
  if ((returned.workspace !== undefined && returned.workspace !== scope.workspace) || (returned.project !== undefined && returned.project !== scope.project)) throw new MemoryError('RESPONSE_SCOPE_MISMATCH');
}
export function normalizePage(value: unknown, scope: Scope): Page {
  const result = record(value);
  scopeResult(result, scope);
  const path = wikiPath(result.path);
  if (typeof result.body !== 'string') throw new MemoryError('PAGE_RESULT_MALFORMED');
  if (result.page_id !== null && result.page_id !== undefined && typeof result.page_id !== 'string') throw new MemoryError('PAGE_RESULT_MALFORMED');
  return { path, body: result.body, pageId: typeof result.page_id === 'string' ? result.page_id : null, updatedAt: typeof result.updated_at === 'string' ? result.updated_at : undefined, workspace: scope.workspace, project: scope.project, truncated: result.truncated === true };
}
export class V3Adapter {
  report?: CapabilityReport;
  private reconnecting?: Promise<CapabilityReport>;
  constructor(readonly transport: McpTransport, private catalog?: CompatibilityCatalog) {}
  async discover(signal: AbortSignal): Promise<CapabilityReport> {
    this.transport.resetSession();
    const init = await this.transport.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pi-desktop-ai-memory', version: '0.1.0' } }, signal);
    // Validate version before sending further protocol messages.
    inspectCapabilities(init, [], this.catalog);
    await this.transport.initialized(signal);
    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await this.transport.rpc('tools/list', cursor ? { cursor } : {}, signal);
      if (!Array.isArray(listed.tools) || tools.length + listed.tools.length > 500) throw new MemoryError('TOOLS_LIST_MALFORMED');
      tools.push(...listed.tools);
      cursor = typeof listed.nextCursor === 'string' ? listed.nextCursor : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 8)) throw new MemoryError('TOOLS_PAGINATION_INVALID');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    assertActive(signal);
    this.report = inspectCapabilities(init, tools, this.catalog);
    return this.report;
  }
  async call(operation: ToolOperation, args: Record<string, unknown>, signal: AbortSignal, recovered = false): Promise<Record<string, unknown>> {
    const capability = this.report?.tools[operation];
    if (!capability?.available) throw new MemoryError(capability?.reason ?? 'CAPABILITY_UNAVAILABLE');
    if (['writePage', 'acceptHandoff', 'beginHandoff', 'cancelHandoff', 'maintenance'].includes(operation) && !this.report?.writes) throw new MemoryError('WRITES_NOT_VERIFIED');
    const scope = this.transport.scope;
    let result: Record<string, unknown>;
    try { result = record(await this.transport.tool(TOOL_CONTRACTS[operation].name, { ...args, workspace: scope.workspace, project: scope.project }, signal)); }
    catch (error) {
      const readOnly = ['query', 'readPage', 'briefing', 'listHandoffs', 'observations'].includes(operation);
      if (!recovered && readOnly && error instanceof MemoryError && error.code === 'MCP_SESSION_EXPIRED') {
        if (this.reconnecting) await this.reconnecting;
        else if (this.transport.sessionExpired) {
          const pending = this.discover(signal); this.reconnecting = pending;
          try { await pending; } finally { if (this.reconnecting === pending) this.reconnecting = undefined; }
        }
        assertActive(signal);
        return this.call(operation, args, signal, true);
      }
      throw error;
    }
    scopeResult(result, scope);
    if (result.reason === 'precondition_failed') throw new MemoryError('PAGE_CONFLICT');
    if (result.error !== undefined || result.ok === false) throw new MemoryError('UPSTREAM_REJECTED');
    return result;
  }
  async query(query: string, signal: AbortSignal): Promise<Array<{ path: string; pageId?: string }>> {
    const result = await this.call('query', { query, limit: 5, answer: false }, signal);
    if (!Array.isArray(result.hits)) throw new MemoryError('QUERY_RESULT_MALFORMED');
    return result.hits.slice(0, 5).map(value => {
      const hit = record(value); scopeResult(hit, this.transport.scope);
      return { path: wikiPath(hit.path), pageId: typeof hit.page_id === 'string' ? hit.page_id : typeof hit.id === 'string' ? hit.id : undefined };
    });
  }
  async readPage(path: string, signal: AbortSignal): Promise<Page> {
    const result = normalizePage(await this.call('readPage', { path: wikiPath(path) }, signal), this.transport.scope);
    if (result.path !== path) throw new MemoryError('PAGE_PATH_MISMATCH');
    return result;
  }
  async listHandoffs(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const result = await this.call('listHandoffs', { limit: 10 }, signal);
    if (!Array.isArray(result.handoffs)) throw new MemoryError('HANDOFF_RESULT_MALFORMED');
    return result.handoffs.slice(0, 10).map(value => {
      const handoff = record(value); text(handoff.id, 200); scopeResult(handoff, this.transport.scope); return handoff;
    });
  }
  async deliver(event: OutboxEvent, signal: AbortSignal): Promise<string> {
    if (!this.report?.capture || !this.report.hookIdempotent) throw new MemoryError('CAPTURE_NOT_VERIFIED');
    if (!sameScope(event.scope, this.transport.scope)) throw new MemoryError('RESPONSE_SCOPE_MISMATCH');
    for (const part of hookParts(event)) {
      const query = new URLSearchParams({ event: part.kind, agent: 'pi', workspace: event.scope.workspace, project: event.scope.project,
        extension: HOOK_EXTENSION, source_event: part.source, ingest_key: digest([event.id, part.source]) });
      const response = await this.transport.post(`/hook?${query}`, part.body, signal);
      if (response.status === 202 && response.bodyText.trim() === 'queued') continue;
      let result: Record<string, unknown>;
      try { result = record(JSON.parse(response.bodyText)); } catch { throw new MemoryError('HOOK_RECEIPT_MALFORMED'); }
      if (result.handoff || result.context || result.handoff_claimed || result.status === 'consumed_by_hook') throw new UnexpectedHandoffError(result);
      throw new MemoryError('HOOK_RECEIPT_MALFORMED');
    }
    return `queued:${event.id}`;
  }
  async verifyDelivery(event: OutboxEvent, signal: AbortSignal): Promise<string | null> {
    if (!sameScope(event.scope, this.transport.scope)) throw new MemoryError('RESPONSE_SCOPE_MISMATCH');
    const pending = new Map(hookParts(event).map(part => [part.source, part]));
    const receipts: string[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const result = await this.call('observations', { session_id: event.sessionId, limit: 100, offset, body_max_chars: 2000, order: 'desc' }, signal);
      if (!Array.isArray(result.observations)) throw new MemoryError('OBSERVATIONS_MALFORMED');
      for (const item of result.observations) {
        for (const [source, part] of pending) if (observationMatches(item, event, part)) {
          receipts.push(text(record(item).id, 200)); pending.delete(source);
        }
      }
      if (!pending.size) return `observations:${receipts.sort().join(',')}`;
      if (result.observations.length < 100) return null;
    }
    return null;
  }
}
