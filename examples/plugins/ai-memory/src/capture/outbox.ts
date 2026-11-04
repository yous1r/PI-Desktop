import { assertActive, errorCode, MemoryError, scopeKey } from '../contracts.js';
import { Journal, type OutboxEvent } from '../storage/journal.js';
import type { V3Adapter } from '../upstream/adapters/v3.js';
import { UnexpectedHandoffError } from '../upstream/errors.js';

export type DeliveryAdapter = Pick<V3Adapter, 'deliver' | 'verifyDelivery' | 'report'>;
export class Outbox {
  private running?: Promise<void>;
  private reviewing = false;
  constructor(private journal: Journal, private adapter: (event: OutboxEvent, signal: AbortSignal) => Promise<DeliveryAdapter>, private now: () => number = Date.now) {}
  drain(signal: AbortSignal): Promise<void> {
    if (this.reviewing) return Promise.resolve();
    if (this.running) return this.running;
    const pending = this.run(signal).finally(() => { this.running = undefined; });
    this.running = pending;
    return pending;
  }
  private async acknowledge(event: OutboxEvent, adapter: DeliveryAdapter, signal: AbortSignal): Promise<boolean> {
    try {
      const receipt = await adapter.verifyDelivery(event, signal);
      if (receipt) { await this.delivered(event.id, receipt); return true; }
      await this.change(event.id, item => {
        if (this.now() - (item.acceptedAt ?? this.now()) > 60_000) { item.state = 'delivery-uncertain'; item.error = 'REMOTE_RECEIPT_UNCONFIRMED'; }
        else item.nextAttempt = this.now() + 1000;
      });
    } catch (error) {
      await this.change(event.id, item => {
        item.error = errorCode(error); item.nextAttempt = this.now() + 5000;
        if (this.now() - (item.acceptedAt ?? this.now()) > 60_000) item.state = 'delivery-uncertain';
      });
    }
    return false;
  }
  private async run(signal: AbortSignal): Promise<void> {
    const blocked = new Set<string>();
    for (const event of this.journal.snapshot().events) {
      assertActive(signal);
      if (['delivered', 'discarded'].includes(event.state)) continue;
      const key = `${scopeKey(event.scope)}:${event.sessionId}`;
      if (blocked.has(key)) continue;
      blocked.add(key);
      if (!['queued', 'remote-queued'].includes(event.state) || event.nextAttempt > this.now()) continue;
      if (this.now() - event.occurredAt > this.journal.limits.retentionMs) {
        await this.change(event.id, item => { item.state = 'retention-expired'; item.error = 'RETENTION_REVIEW_REQUIRED'; }); continue;
      }
      let adapter: DeliveryAdapter;
      try { adapter = await this.adapter(event, signal); }
      catch (error) {
        const code = errorCode(error);
        await this.change(event.id, item => {
          item.error = code;
          // Already accepted writes retain their reconciliation state, never become replayable.
          if (item.state === 'remote-queued') { item.nextAttempt = this.now() + 5000; return; }
          if (code === 'AUTH_REQUIRED') item.state = 'auth-required';
          else if (['CONNECTION_CHANGED', 'CAPTURE_NOT_VERIFIED', 'SESSION_START_CONSUMED_HANDOFF', 'PROJECT_UNBOUND', 'BINDING_CONFLICT', 'PERMISSION_DENIED'].includes(code)) item.state = 'quarantined';
          else item.nextAttempt = this.now() + 30_000;
        });
        continue;
      }
      assertActive(signal);
      if (event.state === 'remote-queued') { if (await this.acknowledge(event, adapter, signal)) blocked.delete(key); continue; }
      await this.change(event.id, item => { item.state = 'sending'; item.attempts++; });
      try {
        const receipt = await adapter.deliver(event, signal);
        if (receipt.startsWith('queued:')) {
          await this.change(event.id, item => { item.state = 'remote-queued'; item.receipt = receipt; item.acceptedAt = this.now(); });
          if (await this.acknowledge(event, adapter, signal)) blocked.delete(key);
        } else { await this.delivered(event.id, receipt); blocked.delete(key); }
      } catch (error) {
        const code = errorCode(error);
        await this.change(event.id, item => {
          if (error instanceof UnexpectedHandoffError) item.recovery = error.recovery;
          item.error = code;
          if (code === 'AUTH_REQUIRED') item.state = 'auth-required';
          else if (code === 'ENDPOINT_UNSUPPORTED' || code === 'CAPTURE_NOT_VERIFIED') item.state = 'quarantined';
          else if (code === 'RATE_LIMITED' || (adapter.report?.hookIdempotent && ['TRANSPORT_FAILURE', 'HTTP_FAILURE', 'CANCELLED', 'REQUEST_TIMEOUT'].includes(code))) {
            item.state = 'queued';
            item.nextAttempt = this.now() + Math.max(error instanceof MemoryError ? error.retryAfterMs ?? 0 : 0, Math.min(300_000, 1000 * 2 ** Math.min(item.attempts, 8)));
          } else item.state = 'delivery-uncertain';
        });
      }
    }
  }
  private delivered(id: string, receipt: string): Promise<void> {
    return this.change(id, item => { item.state = 'delivered'; item.receipt = receipt; delete item.error; item.event.data = {}; });
  }
  private change(id: string, mutate: (event: OutboxEvent) => void): Promise<void> {
    return this.journal.update(state => { const event = state.events.find(item => item.id === id); if (!event) throw new MemoryError('EVENT_MISSING'); mutate(event); });
  }
  private async review<T>(action: () => Promise<T>): Promise<T> {
    if (this.running || this.reviewing) throw new MemoryError('DELIVERY_IN_PROGRESS');
    this.reviewing = true;
    try { return await action(); } finally { this.reviewing = false; }
  }
  reconcile(id: string, signal: AbortSignal): Promise<boolean> {
    return this.review(async () => {
      const event = this.journal.snapshot().events.find(item => item.id === id);
      if (!event || !['remote-queued', 'delivery-uncertain', 'retention-expired'].includes(event.state)) throw new MemoryError('RECONCILIATION_REQUIRED');
      return this.acknowledge(event, await this.adapter(event, signal), signal);
    });
  }
  retry(id: string): Promise<void> {
    return this.review(() => this.change(id, item => {
      if (!['queued', 'auth-required', 'quarantined'].includes(item.state)) throw new MemoryError('RECONCILIATION_REQUIRED');
      item.state = 'queued'; item.nextAttempt = 0; delete item.error;
    }));
  }
  resolve(id: string, decision: 'confirmed-delivered' | 'discard', confirmed: boolean): Promise<void> {
    return this.review(async () => {
      if (!confirmed) throw new MemoryError('CONFIRMATION_REQUIRED');
      await this.change(id, item => {
        if (item.state === 'sending') throw new MemoryError('DELIVERY_IN_PROGRESS');
        item.state = decision === 'confirmed-delivered' ? 'delivered' : 'discarded';
        item.receipt = decision === 'confirmed-delivered' ? 'operator-reconciled' : 'operator-discarded';
        item.event.data = {};
        if (decision === 'discard') delete item.recovery;
      });
    });
  }
  async pruneReceipts(): Promise<void> {
    const cutoff = this.now() - this.journal.limits.retentionMs;
    await this.journal.update(state => {
      state.events = state.events.filter(item => !(['delivered', 'discarded'].includes(item.state) && item.occurredAt < cutoff));
      state.mutations = state.mutations.filter(item => item.at >= cutoff || !['completed', 'rejected'].includes(item.state));
      const activeIds = new Set([...state.events.map(item => item.sessionId), ...state.mutations.map(item => item.sessionId)]);
      state.sessions = state.sessions.filter(item => item.updatedAt >= cutoff || item.state === 'active' || activeIds.has(item.id));
    });
  }
}
