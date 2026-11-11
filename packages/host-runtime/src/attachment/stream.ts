import { eventEnvelopeSequencingIsValid, isDurableEventKind, RacpEventEnvelopeSchema, type RacpCursor, type RacpEventEnvelope } from "@pi-desktop/shared";
import * as Value from "typebox/value";
import { attachmentError, validCursor, type OwnerAttachmentTransport } from "./ports.js";

type SubscriptionResult = { subscriptionId: string; starting: RacpCursor; replayComplete: boolean };

/** One RACP stream, including replay notifications sent before subscribe's reply. */
export class OwnerAttachmentStream {
  private pending: RacpEventEnvelope[] = [];
  private bytes = 0;
  private readonly seen = new Set<string>();
  private seenBytes = 0;
  private cursor?: RacpCursor;
  private cut = 0;
  private id?: string;
  private active = false;
  private stopped = false;
  private failure?: Error;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private off?: () => void;
  private offClosed?: () => void;
  private pendingClosed = new Set<string>();
  private pendingClosedBytes = 0;
  private ack?: number;
  private acknowledging?: Promise<void>;
  private startedRequest = false;

  constructor(private readonly options: {
    transport: OwnerAttachmentTransport;
    sessionId?: string;
    expectedEpoch?: string;
    after?: RacpCursor;
    maxEvents: number;
    maxBytes: number;
    check(): void;
    event(event: RacpEventEnvelope): void;
    fault(error: unknown): void;
  }) {
    this.cursor = options.after && { ...options.after };
    this.cut = this.cursor?.sequence ?? 0;
  }

  private check(): void {
    if (this.failure) throw this.failure;
    if (this.stopped) throw attachmentError("HANDOFF_ATTACHMENT_SUPERSEDED");
    this.options.check();
    this.options.transport.assertCurrent();
  }

  open(): Promise<void> {
    if (this.opening) return this.opening;
    const { transport, sessionId, after } = this.options;
    this.off = transport.subscribe(event => {
      if (this.stopped || this.failure || event.scope !== (sessionId === undefined ? "host" : "session") ||
          (sessionId !== undefined && event.sessionId !== sessionId)) return;
      try {
        this.check();
        if (!Value.Check(RacpEventEnvelopeSchema, event)) throw attachmentError("HANDOFF_ATTACHMENT_INVALID_EVENT");
        const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (bytes > this.options.maxBytes) throw attachmentError("HANDOFF_ATTACHMENT_OVERFLOW");
        if (this.active) this.deliver(event);
        else {
          if (this.pending.length >= this.options.maxEvents || this.bytes + bytes > this.options.maxBytes) {
            throw attachmentError("HANDOFF_ATTACHMENT_OVERFLOW");
          }
          this.pending.push(event); this.bytes += bytes;
        }
      } catch (error) { this.fail(error); }
    });
    this.offClosed = transport.subscribeClosed(id => {
      if (this.stopped) return;
      if (id === this.id) this.fail(attachmentError("HANDOFF_ATTACHMENT_SUBSCRIPTION_CLOSED"));
      else if (!this.id && !this.pendingClosed.has(id)) {
        // Bound both count and retained string storage while the ID is in flight.
        if (this.pendingClosed.size >= this.options.maxEvents || this.pendingClosedBytes + id.length * 2 > this.options.maxBytes) {
          this.fail(attachmentError("HANDOFF_ATTACHMENT_OVERFLOW"));
        } else { this.pendingClosed.add(id); this.pendingClosedBytes += id.length * 2; }
      }
    });
    this.opening = Promise.resolve().then(async () => {
      this.check();
      this.startedRequest = true;
      const result = await transport.request<SubscriptionResult>("events/subscribe", {
        scope: sessionId === undefined ? "host" : "session",
        ...(sessionId === undefined ? {} : { sessionId }), ...(after ? { after } : {}),
      });
      // Retain the original ID even if disposed while awaiting the reply.
      if (typeof result?.subscriptionId === "string" && result.subscriptionId.length > 0) this.id = result.subscriptionId;
      this.check();
      if (!this.id || !validCursor(result.starting) || result.starting.sequence < 1) throw attachmentError("HANDOFF_ATTACHMENT_INVALID_SUBSCRIPTION");
      if (result.replayComplete !== true) throw attachmentError("HANDOFF_ATTACHMENT_REPLAY_GAP");
      if (this.pendingClosed.has(this.id)) throw attachmentError("HANDOFF_ATTACHMENT_SUBSCRIPTION_CLOSED");
      this.pendingClosed.clear(); this.pendingClosedBytes = 0;
      const epoch = this.options.expectedEpoch ?? this.cursor?.epoch;
      if (epoch && result.starting.epoch !== epoch) throw attachmentError("HANDOFF_ATTACHMENT_EVENT_EPOCH");
      this.cursor ??= { epoch: result.starting.epoch, sequence: result.starting.sequence - 1 };
      this.cut = after?.sequence ?? this.cursor.sequence;
      // starting is AFTER all replay delivered by the server, not its first event.
      for (const event of this.pending) this.advance(event);
      if (this.cursor.sequence < result.starting.sequence - 1) throw attachmentError("HANDOFF_ATTACHMENT_REPLAY_GAP");
      // Rewind only the in-memory projection: commit validates and applies replay atomically.
      this.cursor = after ? { ...after } : { epoch: result.starting.epoch, sequence: result.starting.sequence - 1 };
      this.seen.clear(); this.seenBytes = 0;
    });
    return this.opening;
  }

  commit(apply: (events: readonly RacpEventEnvelope[], cursor: RacpCursor) => void): void {
    this.check();
    if (!this.cursor || !this.id) throw attachmentError("HANDOFF_ATTACHMENT_NOT_READY");
    const events: RacpEventEnvelope[] = [];
    for (const event of this.pending) if (this.advance(event)) events.push(event);
    this.pending = []; this.bytes = 0;
    apply(events, { ...this.cursor });
    this.check();
    this.active = true;
    // A synchronous presentation callback may have received another notification.
    const pending = this.pending; this.pending = []; this.bytes = 0;
    for (const event of pending) this.deliver(event);
    this.scheduleAck();
  }

  private advance(event: RacpEventEnvelope): boolean {
    if (!this.cursor || event.epoch !== this.cursor.epoch) throw attachmentError("HANDOFF_ATTACHMENT_EVENT_EPOCH");
    if (event.kind === "resync.required") throw attachmentError("HANDOFF_ATTACHMENT_RESYNC_REQUIRED");
    if (!eventEnvelopeSequencingIsValid(event)) throw attachmentError("HANDOFF_ATTACHMENT_INVALID_EVENT");
    const sequence = event.sequence ?? event.afterSequence!;
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw attachmentError("HANDOFF_ATTACHMENT_INVALID_EVENT");
    if (isDurableEventKind(event.kind)) {
      if (sequence < 1) throw attachmentError("HANDOFF_ATTACHMENT_INVALID_EVENT");
      if (sequence <= this.cursor.sequence) return false;
      if (sequence !== this.cursor.sequence + 1) throw attachmentError("HANDOFF_ATTACHMENT_REPLAY_GAP");
      this.cursor = { epoch: event.epoch, sequence };
      return true;
    }
    if (sequence > this.cursor.sequence) throw attachmentError("HANDOFF_ATTACHMENT_REPLAY_GAP");
    // Suppress ambiguous buffered deltas at the snapshot cut. Once committed,
    // live output may follow that same durable cursor without another durable event.
    if ((!this.active && sequence <= this.cut) || sequence < this.cursor.sequence || this.seen.has(event.eventId)) return false;
    this.seen.add(event.eventId); this.seenBytes += event.eventId.length * 2;
    while (this.seen.size > this.options.maxEvents || this.seenBytes > this.options.maxBytes) {
      const oldest = this.seen.values().next().value!;
      this.seen.delete(oldest); this.seenBytes -= oldest.length * 2;
    }
    return true;
  }

  private deliver(event: RacpEventEnvelope): void {
    this.check();
    if (this.advance(event)) this.options.event(event);
    this.check();
    this.scheduleAck();
  }

  private scheduleAck(): void {
    if (!this.active || !this.cursor || this.stopped) return;
    this.ack = this.cursor.sequence;
    if (this.acknowledging) return;
    this.acknowledging = Promise.resolve().then(async () => {
      while (!this.stopped && !this.failure && this.ack !== undefined) {
        this.check();
        const sequence = this.ack; this.ack = undefined;
        await this.options.transport.request("events/ack", { subscriptionId: this.id, sequence });
      }
    }).catch(error => { if (!this.stopped) this.fail(error); else this.options.fault(error); })
      .finally(() => { this.acknowledging = undefined; });
  }

  private fail(error: unknown): void {
    if (this.failure || this.stopped) return;
    this.failure = error instanceof Error ? error : attachmentError("HANDOFF_ATTACHMENT_STREAM_FAILED");
    this.pending = []; this.bytes = 0;
    this.options.fault(error);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.active = false;
    this.off?.(); this.offClosed?.();
    this.pending = []; this.bytes = 0; this.pendingClosed.clear(); this.seen.clear();
    this.pendingClosedBytes = 0; this.seenBytes = 0;
    this.closing = Promise.resolve().then(async () => {
      await this.opening?.catch(() => undefined); // The initiating caller observes this error.
      await this.acknowledging;
      // A closed original RACP connection has already released its subscriptions.
      // An authorization failure alone is not proof of resource cleanup.
      if (this.options.transport.isClosed()) return;
      this.options.transport.assertCurrent();
      if (this.id) await this.options.transport.request("events/unsubscribe", { subscriptionId: this.id });
      else if (this.startedRequest) throw attachmentError("HANDOFF_ATTACHMENT_SUBSCRIPTION_UNCONFIRMED");
    });
    return this.closing;
  }
}
