import { randomUUID } from 'node:crypto';
import { assertActive, MemoryError, type OwnerContext, type Scope } from '../contracts.js';
import type { CaptureEvent } from '../capture/policy.js';
import { digest, Journal, remoteSessionId, sameScope, type OutboxEvent, type SessionRecord } from '../storage/journal.js';

export class SessionCoordinator {
  constructor(private journal: Journal, private now: () => number = Date.now) {}
  async receive(event: CaptureEvent, scope: Scope, context: OwnerContext): Promise<{ accepted: true; eventId: string; state: string }> {
    assertActive(context.signal);
    return this.journal.update(state => {
      assertActive(context.signal);
      const sessionId = remoteSessionId(state.installationId, context.sessionId, scope);
      const duplicate = state.events.find(item => item.sourceId === event.eventId && item.sessionId === sessionId && sameScope(item.scope, scope));
      if (duplicate) return { accepted: true, eventId: duplicate.id, state: duplicate.state };
      let session = state.sessions.find(item => item.id === sessionId && sameScope(item.scope, scope));
      if (!session) {
        session = { id: sessionId, desktopId: context.sessionId, scope, sequence: 0, started: false, runtimeId: context.runtimeId, parentId: context.parentSessionId ? remoteSessionId(state.installationId, context.parentSessionId, scope) : undefined, state: 'active', updatedAt: this.now() };
        state.sessions.push(session);
      }
      if (session.state === 'closed') throw new MemoryError('SESSION_CLOSED');
      session.state = 'active'; session.runtimeId = context.runtimeId; session.updatedAt = this.now();
      const append = (input: CaptureEvent): OutboxEvent => {
        const data = { ...input.data, ...(session.parentId ? { parentSessionId: session.parentId } : {}) };
        const entry: OutboxEvent = {
          schemaVersion: 1, id: randomUUID(), sourceId: input.eventId, scope: structuredClone(scope), sessionId,
          runtimeId: context.runtimeId, turnId: context.turnId, cwd: context.workspaceRoot ?? undefined, sequence: ++session.sequence, occurredAt: this.now(),
          adapterVersion: 'v3/1', digest: digest(data), event: { ...input, data }, state: 'queued', attempts: 0, nextAttempt: 0,
        };
        state.events.push(entry); return entry;
      };
      if (!session.started && event.type !== 'session_start') append({ eventId: `start:${sessionId}`, type: 'session_start', data: {} });
      if (session.started && event.type === 'session_start') return { accepted: true, eventId: `start:${sessionId}`, state: 'already-received' };
      session.started = true;
      const entry = append(event);
      return { accepted: true, eventId: entry.id, state: entry.state };
    });
  }
  async retire(context: OwnerContext, captureScope: (scope: Scope) => boolean = () => true): Promise<void> {
    assertActive(context.signal);
    await this.journal.update(state => {
      assertActive(context.signal);
      for (const session of state.sessions) {
        if (session.desktopId !== context.sessionId || session.runtimeId !== context.runtimeId) continue;
        if (session.state !== 'active') continue;
        if (captureScope(session.scope)) {
        const id = randomUUID();
        const data = { reason: context.retirementReason ?? 'reconfigure', ...(session.parentId ? { parentSessionId: session.parentId } : {}) };
        state.events.push({ schemaVersion: 1, id, sourceId: `retire:${context.runtimeId}`, scope: structuredClone(session.scope), sessionId: session.id, runtimeId: context.runtimeId, turnId: context.turnId, cwd: context.workspaceRoot ?? undefined, sequence: ++session.sequence, occurredAt: this.now(), adapterVersion: 'v3/1', digest: digest(data), event: { type: 'retire', eventId: id, data }, state: 'queued', attempts: 0, nextAttempt: 0 });
        }
        session.state = context.retirementReason === 'session-close' ? 'closed' : 'retired';
        session.updatedAt = this.now();
      }
      // Retirement persists identity, never sends session-end or creates a handoff.
    });
  }
  current(context: OwnerContext, scope: Scope): SessionRecord | undefined {
    return this.journal.snapshot().sessions.find(item => item.desktopId === context.sessionId && sameScope(item.scope, scope));
  }
}
