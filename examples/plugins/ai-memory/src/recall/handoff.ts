import { assertActive, errorCode, MemoryError, record, text, type Mutation, type OwnerContext, type Scope } from '../contracts.js';
import { excluded, redactText, sanitize } from '../capture/policy.js';
import { digest, Journal, remoteSessionId, sameScope } from '../storage/journal.js';
import { wikiPath, type V3Adapter } from '../upstream/adapters/v3.js';

export function mutationArgs(operation: Mutation, input: Record<string, unknown>): Record<string, unknown> {
  const confirmation = record(input.confirmation);
  if (confirmation.confirmed !== true || confirmation.intent !== operation) throw new MemoryError('CONFIRMATION_REQUIRED');
  const args: Record<string, unknown> = {};
  if (operation === 'writePage' || operation === 'maintenance') {
    args.path = wikiPath(input.path);
    if (operation === 'writePage') {
      const body = text(input.body, 24000);
      if (redactText(body) !== body || excluded(body, [])) throw new MemoryError('SENSITIVE_CONTENT');
      args.body = body;
    }
    if (input.createOnly === true && operation === 'writePage') {
      if (input.expectedPageId !== undefined) throw new MemoryError('INVALID_PRECONDITION');
      args.create_only = true;
    } else args.expected_page_id = text(input.expectedPageId, 200);
    if (operation === 'maintenance' && input.action !== 'deletePage') throw new MemoryError('MAINTENANCE_ACTION_UNSUPPORTED');
  } else if (operation === 'beginHandoff') {
    const summary = text(input.summary, 8000);
    if (redactText(summary) !== summary || excluded(summary, [])) throw new MemoryError('SENSITIVE_CONTENT');
    args.summary = summary;
    args.shared = input.shared === true;
    if (args.shared && confirmation.shared !== true) throw new MemoryError('SHARED_CONFIRMATION_REQUIRED');
  } else args.handoff_id = text(input.handoffId, 200);
  // any_owner, arbitrary scope, URLs, and remote tool names are never forwarded.
  if (input.anyOwner || input.workspace || input.project || input.scope) throw new MemoryError('SCOPE_OVERRIDE_FORBIDDEN');
  return args;
}
export class Mutations {
  constructor(private journal: Journal) {}
  async execute(operation: Mutation, input: Record<string, unknown>, context: OwnerContext, scope: Scope, adapter: V3Adapter): Promise<unknown> {
    if (context.mode !== 'agent') throw new MemoryError('AGENT_MODE_REQUIRED');
    const args = mutationArgs(operation, input);
    if (!adapter.report?.writes || !adapter.report.tools[operation]?.available) throw new MemoryError('WRITES_NOT_VERIFIED');
    if (context.parentSessionId && operation === 'acceptHandoff') throw new MemoryError('SUBAGENT_CLAIM_FORBIDDEN');
    assertActive(context.signal);
    const requestId = text(input.requestId, 200);
    const sessionId = remoteSessionId(this.journal.snapshot().installationId, context.sessionId, scope);
    const hash = digest([operation, args]);
    const decision = await this.journal.update(state => {
      assertActive(context.signal);
      const previous = state.mutations.find(item => sameScope(item.scope, scope) && (item.id === requestId || (operation === 'acceptHandoff' && item.operation === operation && item.handoffId === args.handoff_id)));
      if (previous) {
        if (previous.sessionId !== sessionId || previous.digest !== hash) throw new MemoryError('MUTATION_ID_CONFLICT');
        if (previous.state === 'completed') return { done: true, result: previous.result };
        throw new MemoryError('RECONCILIATION_REQUIRED');
      }
      state.mutations.push({ id: requestId, operation, sessionId, scope: structuredClone(scope), digest: hash, state: 'pending', at: Date.now(), handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined });
      return { done: false, result: undefined };
    });
    if (decision.done) return decision.result;
    try {
      assertActive(context.signal);
      const result = await adapter.call(operation, args, context.signal);
      if (operation === 'writePage' && (typeof result.page_id !== 'string' || result.path !== args.path)) throw new MemoryError('WRITE_RECEIPT_MALFORMED');
      if (operation === 'beginHandoff' && typeof result.handoff_id !== 'string') throw new MemoryError('HANDOFF_RESULT_MALFORMED');
      if (operation === 'cancelHandoff' && (typeof result.cancelled !== 'boolean' || result.handoff_id !== args.handoff_id)) throw new MemoryError('HANDOFF_RESULT_MALFORMED');
      if (operation === 'maintenance' && result.deleted !== true) throw new MemoryError('WRITE_RECEIPT_MALFORMED');
      if (operation === 'acceptHandoff') {
        if (!['claimed', 'none_pending', 'consumed_by_hook'].includes(String(result.status))) throw new MemoryError('HANDOFF_STATUS_UNSUPPORTED');
        if (result.status === 'consumed_by_hook') throw new MemoryError('HANDOFF_PREVIOUSLY_CONSUMED');
        if (result.status === 'claimed' && record(result.handoff).id !== args.handoff_id) throw new MemoryError('HANDOFF_ID_MISMATCH');
      }
      const safe = sanitize(result, 16000);
      // Durable recovery result precedes acknowledgement; cancellation cannot imply rollback.
      await this.journal.update(state => {
        const entry = state.mutations.find(item => item.id === requestId && sameScope(item.scope, scope));
        if (!entry) throw new MemoryError('MUTATION_MISSING');
        entry.state = 'completed'; entry.result = safe;
      });
      assertActive(context.signal);
      return safe;
    } catch (error) {
      const code = errorCode(error);
      await this.journal.update(state => {
        const entry = state.mutations.find(item => item.id === requestId && sameScope(item.scope, scope));
        if (!entry || entry.state === 'completed') return;
        entry.state = ['AUTH_REQUIRED', 'RATE_LIMITED', 'PAGE_CONFLICT', 'ENDPOINT_UNSUPPORTED'].includes(code) ? 'rejected' : 'delivery-uncertain'; entry.error = code;
      });
      throw new MemoryError(code);
    }
  }
  recovered(context: OwnerContext, scope: Scope): unknown[] {
    const state = this.journal.snapshot();
    const sessionId = remoteSessionId(state.installationId, context.sessionId, scope);
    return state.mutations.filter(item => item.sessionId === sessionId && sameScope(item.scope, scope) && item.operation === 'acceptHandoff' && item.state === 'completed').slice(-3).map(item => ({ handoffId: item.handoffId, acceptedAt: item.at, result: item.result }));
  }
}
