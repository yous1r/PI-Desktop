import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryError, record, scopeKey, text, type Scope } from '../contracts.js';
import type { CaptureEvent } from '../capture/policy.js';
import { replaceSnapshot } from './atomic-file.js';

export type DeliveryState = 'queued' | 'sending' | 'remote-queued' | 'delivered' | 'delivery-uncertain' | 'auth-required' | 'quarantined' | 'retention-expired' | 'discarded';
export interface OutboxEvent {
  schemaVersion: 1; id: string; sourceId: string; scope: Scope; sessionId: string; runtimeId: string; turnId?: string;
  sequence: number; occurredAt: number; adapterVersion: 'v3/1'; digest: string;
  event: CaptureEvent; state: DeliveryState; attempts: number; nextAttempt: number; error?: string; receipt?: string;
  recovery?: unknown;
  acceptedAt?: number;
  cwd?: string;
}
export interface SessionRecord {
  id: string; desktopId: string; scope: Scope; sequence: number; started: boolean; runtimeId: string;
  parentId?: string; state: 'active' | 'retired' | 'interrupted' | 'closed'; updatedAt: number;
}
export interface MutationRecord {
  id: string; sessionId: string; scope: Scope; operation: string; digest: string;
  state: 'pending' | 'completed' | 'delivery-uncertain' | 'rejected'; at: number;
  handoffId?: string; result?: unknown; error?: string;
}
export interface State {
  schemaVersion: 1; installationId: string; events: OutboxEvent[]; sessions: SessionRecord[]; mutations: MutationRecord[];
}
export interface Limits { events: number; bytes: number; sessions: number; mutations: number; retentionMs: number }
export const DEFAULT_LIMITS: Limits = { events: 2000, bytes: 16 * 1024 * 1024, sessions: 2000, mutations: 500, retentionMs: 7 * 86400_000 };
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function remoteSessionId(installationId: string, desktopId: string, scope: Scope): string {
  return `pi-${digest([installationId, desktopId, scope.connectionId, scope.workspace, scope.project]).slice(0, 40)}`;
}
function validState(value: unknown): State {
  const state = record(value);
  if (state.schemaVersion !== 1) throw new MemoryError('STATE_VERSION_UNSUPPORTED');
  text(state.installationId, 100);
  if (!Array.isArray(state.events) || !Array.isArray(state.sessions) || !Array.isArray(state.mutations)) throw new MemoryError('STATE_CORRUPT');
  for (const entry of state.events) {
    const event = record(entry);
    if (event.schemaVersion !== 1 || event.adapterVersion !== 'v3/1' || !['queued', 'sending', 'remote-queued', 'delivered', 'delivery-uncertain', 'auth-required', 'quarantined', 'retention-expired', 'discarded'].includes(String(event.state))) throw new MemoryError('STATE_CORRUPT');
    text(event.id); text(event.sessionId); text(event.sourceId); text(event.digest);
    if (!Number.isSafeInteger(event.sequence) || typeof event.occurredAt !== 'number' || typeof event.nextAttempt !== 'number' || typeof event.attempts !== 'number') throw new MemoryError('STATE_CORRUPT');
    validateScope(event.scope); record(event.event);
  }
  for (const entry of state.sessions) {
    const session = record(entry);
    text(session.id); text(session.desktopId); text(session.runtimeId); validateScope(session.scope);
    if (!Number.isSafeInteger(session.sequence) || typeof session.started !== 'boolean' || !['active', 'retired', 'interrupted', 'closed'].includes(String(session.state))) throw new MemoryError('STATE_CORRUPT');
  }
  for (const entry of state.mutations) {
    const mutation = record(entry);
    text(mutation.id); text(mutation.sessionId); text(mutation.digest); validateScope(mutation.scope);
    if (!['pending', 'completed', 'delivery-uncertain', 'rejected'].includes(String(mutation.state))) throw new MemoryError('STATE_CORRUPT');
  }
  return state as unknown as State;
}
function validateScope(value: unknown): void {
  const scope = record(value);
  text(scope.connectionId); text(scope.workspace); text(scope.project);
  if (!Number.isSafeInteger(scope.connectionRevision) || Number(scope.connectionRevision) < 1) throw new MemoryError('STATE_CORRUPT');
}
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

/** One plugin process owns this journal. Mutations publish only after fsync + atomic rename. */
export class Journal {
  private state!: State;
  private chain: Promise<unknown> = Promise.resolve();
  private lockOwned = false;
  private closed = false;
  readonly file: string;
  constructor(readonly directory: string, readonly limits: Limits = DEFAULT_LIMITS) { this.file = join(directory, 'state-v1.json'); }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, '.writer-lock');
    try {
      const handle = await open(lock, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); await handle.sync(); } finally { await handle.close(); }
      this.lockOwned = true;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw new MemoryError('STATE_UNWRITABLE');
      const pid = Number(await readFile(lock, 'utf8'));
      let alive = true;
      try { if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0); } catch (check) {
        alive = !(check && typeof check === 'object' && 'code' in check && check.code === 'ESRCH');
      }
      if (alive) throw new MemoryError('STATE_LOCKED');
      await unlink(lock);
      return this.initialize();
    }
    try {
      try {
        if ((await stat(this.file)).size > this.limits.bytes) throw new MemoryError('STATE_TOO_LARGE');
        this.state = validState(JSON.parse(await readFile(this.file, 'utf8')));
      } catch (error) {
        if (!isMissing(error)) throw error instanceof MemoryError ? error : new MemoryError('STATE_CORRUPT');
        this.state = { schemaVersion: 1, installationId: randomUUID(), events: [], sessions: [], mutations: [] };
      }
      // Orphan snapshots were never acknowledged; only the canonical file is authoritative.
      for (const file of await readdir(this.directory)) if (/^\.state-[0-9a-f-]{36}\.tmp$/.test(file)) await unlink(join(this.directory, file));
      await this.update(state => {
        for (const event of state.events) if (event.state === 'sending') { event.state = 'delivery-uncertain'; event.error = 'PROCESS_INTERRUPTED'; }
        for (const mutation of state.mutations) if (mutation.state === 'pending') { mutation.state = 'delivery-uncertain'; mutation.error = 'PROCESS_INTERRUPTED'; }
        for (const session of state.sessions) if (session.state === 'active') session.state = 'interrupted';
      });
    } catch (error) { await this.close(); throw error; }
  }
  snapshot(): State { return structuredClone(this.state); }
  update<T>(change: (state: State) => T): Promise<T> {
    const work = this.chain.then(async () => {
      if (this.closed) throw new MemoryError('STATE_CLOSED');
      const next = structuredClone(this.state);
      const result = change(next);
      if (next.events.length > this.limits.events || next.sessions.length > this.limits.sessions || next.mutations.length > this.limits.mutations) throw new MemoryError('QUEUE_FULL');
      const content = JSON.stringify(next);
      if (Buffer.byteLength(content) > this.limits.bytes) throw new MemoryError('QUEUE_FULL');
      const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      try { await replaceSnapshot(temporary, this.file); } catch (error) { await unlink(temporary); throw error; }
      this.state = next;
      return result;
    });
    this.chain = work.catch(() => undefined);
    return work;
  }
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    if (this.lockOwned) { await unlink(join(this.directory, '.writer-lock')); this.lockOwned = false; }
  }
  diagnostics(now = Date.now(), desktopSessionId?: string) {
    const sessions = this.state.sessions.filter(item => desktopSessionId === undefined || item.desktopId === desktopSessionId);
    const ids = new Set(sessions.map(item => item.id));
    const events = this.state.events.filter(item => desktopSessionId === undefined || ids.has(item.sessionId));
    const mutations = this.state.mutations.filter(item => desktopSessionId === undefined || ids.has(item.sessionId));
    const pending = events.filter(item => !['delivered', 'discarded'].includes(item.state));
    return {
      schemaVersion: 1, count: pending.length, oldestAgeMs: pending.length ? Math.max(0, now - Math.min(...pending.map(item => item.occurredAt))) : 0,
      counts: Object.fromEntries([...new Set(events.map(item => item.state))].map(status => [status, events.filter(item => item.state === status).length])),
      interruptedSessions: sessions.filter(item => item.state === 'interrupted').length,
      events: pending.slice(0, 100).map(({ id, state, error, attempts, occurredAt, digest: hash, recovery }) => ({ id, state, error, attempts, occurredAt, digest: hash, hasRecovery: recovery !== undefined })),
      mutations: mutations.slice(-100).map(({ id, operation, state, at, error }) => ({ id, operation, state, at, error })),
      truncated: pending.length > 100 || mutations.length > 100,
    };
  }
}
export function sameScope(a: Scope, b: Scope): boolean { return scopeKey(a) === scopeKey(b); }
