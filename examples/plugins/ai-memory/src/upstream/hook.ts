import { digest, type OutboxEvent } from '../storage/journal.js';
import { record } from '../contracts.js';

export const HOOK_EXTENSION = 'pi-desktop-memory';
export interface HookPart { kind: string; source: string; body: Record<string, unknown>; expectedBody?: string }
export function hookKind(event: OutboxEvent): string {
  return { session_start: 'session-start', prompt: 'user-prompt', tool_call: 'pre-tool-use', tool_result: 'post-tool-use', agent_end: 'stop', compact: 'pre-compact', retire: 'other' }[event.event.type];
}
export function eventMarker(event: OutboxEvent): string { return `[pi-memory:${digest(event.id)}]`; }
export function hookBody(event: OutboxEvent): Record<string, unknown> {
  const data = event.event.data;
  return {
    sessionID: event.sessionId, cwd: event.cwd, occurred_at: new Date(event.occurredAt).toISOString(),
    tool: data.toolName, callID: data.toolCallId, args: data.args, output: data.output,
    prompt: typeof data.prompt === 'string' ? data.prompt : '[prompt content not collected]',
    isError: data.isError === true || data.cancelled === true,
    parent_session_id: data.parentSessionId,
  };
}
/** Native hooks keep lifecycle/outcome semantics. Explicit extension records retain opted-in
 * content that the native tool/Stop parser omits. Each bounded part has its own immutable key.
 * No retirement is mapped to session-end; compaction is extension-only to avoid paid consolidation. */
export function hookParts(event: OutboxEvent): HookPart[] {
  const hash = digest(event.id);
  const parts: HookPart[] = ['retire', 'compact'].includes(event.event.type) ? [] : [{ kind: hookKind(event), source: `native-${hash}`, body: hookBody(event) }];
  const content = JSON.stringify({ schemaVersion: 1, event: event.event.type, runtimeId: event.runtimeId, turnId: event.turnId, sequence: event.sequence, ...event.event.data });
  // 1,400 UTF-8 bytes leaves room under the server's 2,000-byte extension excerpt cap.
  const chunks: string[] = []; let chunk = ''; let size = 0;
  for (const char of content) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 1400) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += char; size += bytes;
  }
  chunks.push(chunk);
  for (const [index, text] of chunks.entries()) {
    const body = `${eventMarker(event)} part ${index + 1}/${chunks.length}\n${text}\n[/pi-memory]`;
    parts.push({ kind: 'other', source: `detail-${hash}-${index}`, body: { sessionID: event.sessionId, occurred_at: new Date(event.occurredAt).toISOString(), title: `PI Desktop ${event.event.type} ${index + 1}/${chunks.length}`, body }, expectedBody: body });
  }
  return parts;
}
export function observationMatches(value: unknown, event: OutboxEvent, part: HookPart = hookParts(event)[0]): boolean {
  const item = record(value);
  // The session query already binds the plugin-owned session. Do not correlate by title,
  // timestamp, or a model-controlled call ID: those are not unique event identifiers.
  return item.kind === part.kind && item.extension === HOOK_EXTENSION && item.source_event === part.source
    && (part.expectedBody === undefined || item.body === part.expectedBody);
}
