import { parseOwnerHandoffReady, parseOwnerHandoffResponse, RacpSessionSnapshotSchema, type OwnerHandoffRecord, type RacpEventEnvelope, type RacpSessionSnapshot } from "@pi-desktop/shared";
import * as Value from "typebox/value";
import { OwnerAttachmentStream } from "./attachment/stream.js";
import { attachmentError, validCursor, type OwnerAttachmentOptions, type OwnerAttachmentState, type OwnerAttachmentTransport, type OwnerAttachmentView } from "./attachment/ports.js";
export type { OwnerAttachmentOptions, OwnerAttachmentTransport, OwnerAttachmentReadMethod, OwnerAttachmentIdentity,
  OwnerAttachmentTarget, OwnerAttachmentState, OwnerAttachmentView, OwnerAttachmentProjection } from "./attachment/ports.js";

type Cycle = { generation: number; abort: AbortController; streams: OwnerAttachmentStream[];
  transport?: OwnerAttachmentTransport; view?: OwnerAttachmentView; attached: boolean; retired: boolean };

/** Observation lifetime only: no owner launcher, execution admission, transcript
 * store, mutation retry, or connection retry policy lives here. */
export class OwnerHandoffAttachment {
  private readonly target;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private generation = 0;
  private current?: Cycle;
  private original?: Promise<void>;
  private cleanup = Promise.resolve();
  private offReconnect?: () => void;
  private offUnavailable?: () => void;
  private lastRecord?: OwnerHandoffRecord;
  private selected?: string;
  private disposed = false;
  private disposing?: Promise<void>;
  private stateValue: OwnerAttachmentState = "detached";
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly options: OwnerAttachmentOptions) {
    this.target = Object.freeze({ ...options.target });
    this.maxEvents = options.maxPendingEvents ?? 512;
    this.maxBytes = options.maxPendingBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > 4096 ||
        !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 8 * 1024 * 1024) {
      throw new RangeError("Invalid owner attachment buffer limits");
    }
  }

  get state(): OwnerAttachmentState { return this.stateValue; }

  private publish(state: OwnerAttachmentState): void {
    this.stateValue = state;
    this.options.onState(state);
  }

  private check(cycle: Cycle): void {
    if (this.disposed) throw attachmentError("HANDOFF_ATTACHMENT_DISPOSED");
    if (this.current !== cycle || cycle.abort.signal.aborted) throw attachmentError("HANDOFF_ATTACHMENT_SUPERSEDED");
    cycle.transport?.assertCurrent();
  }

  private originalDetached(): Promise<void> {
    // Reserve before invoking the original owner's callback, including reentry.
    this.original ??= Promise.resolve().then(() => this.options.detachOriginal());
    return this.original;
  }

  private unwatch(): void {
    this.offReconnect?.(); this.offReconnect = undefined;
    this.offUnavailable?.(); this.offUnavailable = undefined;
  }

  private retire(cycle: Cycle | undefined): void {
    if (!cycle || cycle.retired) return;
    cycle.retired = true; cycle.attached = false; cycle.abort.abort();
    const closes = cycle.streams.map(stream => stream.close());
    if (closes.length === 0) return;
    this.cleanup = Promise.allSettled([this.cleanup, ...closes]).then(results => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "HANDOFF_ATTACHMENT_CLEANUP_UNCONFIRMED");
    });
    void this.cleanup.catch(error => this.options.onError(error));
  }

  private fault(cycle: Cycle, error: unknown): void {
    this.options.onError(error);
    if (this.current !== cycle || cycle.retired || this.disposed) return;
    this.retire(cycle);
    this.publish("resync-required");
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }

  /** Explicitly select an observation; drafts, focus and reading position stay
   * with the caller. Reconnect calls resync() without choosing a different view. */
  reconcile(sessionId: string): Promise<void> {
    if (this.disposed) return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_DISPOSED"));
    if (!sessionId || sessionId.length > 1024) return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_INVALID_SESSION"));
    if (this.operations.size >= 8) return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_BUSY"));
    this.selected = sessionId;
    this.unwatch(); this.retire(this.current);
    const cycle: Cycle = { generation: ++this.generation, abort: new AbortController(), streams: [], attached: false, retired: false };
    this.current = cycle;
    // Defer callbacks until the current cycle is fully installed.
    return this.track(Promise.resolve().then(async () => {
      try {
        this.check(cycle); this.publish("reconciling"); this.check(cycle);
        await Promise.all([this.originalDetached(), this.cleanup]); this.check(cycle);
        const status = await this.options.readStatus(this.target, cycle.abort.signal); this.check(cycle);
        const response = parseOwnerHandoffResponse(status.response);
        if ("error" in response) throw attachmentError(response.error.code);
        const record = response.record;
        if (record.id !== this.target.transferId || record.profile !== this.target.profileId || record.sourceEpoch !== this.target.sourceEpoch ||
            (this.lastRecord && (record.revision < this.lastRecord.revision ||
              (record.revision === this.lastRecord.revision && (record.targetEpoch !== this.lastRecord.targetEpoch || record.phase !== this.lastRecord.phase))))) {
          throw attachmentError("HANDOFF_ATTACHMENT_STATUS_MISMATCH");
        }
        this.lastRecord = structuredClone(record);
        if (record.phase !== "ready") {
          if (status.ready !== undefined) throw attachmentError("HANDOFF_INVALID_READY");
          this.publish("waiting"); return;
        }
        const ready = Object.freeze({ ...parseOwnerHandoffReady(status.ready, record) });
        const transport = await this.options.resolveTransport(ready, cycle.abort.signal); this.check(cycle);
        transport.assertCurrent();
        const identity = transport.identity;
        if (identity.profileId !== ready.profileId || identity.ownerEpoch !== ready.ownerEpoch || identity.protocolVersion !== ready.protocolVersion) {
          throw attachmentError("HANDOFF_ATTACHMENT_AUTH_MISMATCH");
        }
        cycle.transport = transport;
        const view = Object.freeze({ generation: cycle.generation, ready, sessionId }); cycle.view = view;
        this.offReconnect = transport.subscribeReconnect(() =>
          this.current === cycle && !this.disposed ? this.resync() : Promise.resolve());
        this.offUnavailable = transport.subscribeUnavailable(() => this.fault(cycle, attachmentError("HANDOFF_ATTACHMENT_DISCONNECTED")));
        this.check(cycle);
        const streamOptions = { transport, maxEvents: this.maxEvents, maxBytes: this.maxBytes,
          check: () => this.check(cycle), fault: (error: unknown) => this.fault(cycle, error) };
        // RACP allocates different epochs for host and session streams. Ready
        // names the host stream; session replay is bound to its own snapshot.
        const hostStream = new OwnerAttachmentStream({ ...streamOptions, expectedEpoch: ready.eventEpoch,
          event: event => { this.check(cycle); this.options.onEvent(view, event); } });
        cycle.streams.push(hostStream);
        await hostStream.open(); this.check(cycle);
        const result = await transport.request<{ snapshot?: RacpSessionSnapshot; role?: string }>("session/attach", {
          sessionId, role: "viewer", includeSnapshot: true,
        });
        this.check(cycle);
        const snapshot = result?.snapshot;
        if (result?.role !== "viewer" || !Value.Check(RacpSessionSnapshotSchema, snapshot) ||
            snapshot.session.id !== sessionId || !validCursor(snapshot.cursor)) {
          throw attachmentError("HANDOFF_ATTACHMENT_INVALID_SNAPSHOT");
        }
        const sessionStream = new OwnerAttachmentStream({ ...streamOptions, sessionId, after: snapshot.cursor,
          event: event => { this.check(cycle); this.options.onEvent(view, event); } });
        cycle.streams.push(sessionStream);
        await sessionStream.open(); this.check(cycle);
        let hostEvents: readonly RacpEventEnvelope[] = [];
        hostStream.commit(events => { hostEvents = events; });
        sessionStream.commit((events, cursor) => this.options.onSnapshot({ view, snapshot, events, hostEvents, cursor }));
        this.check(cycle); cycle.attached = true; this.publish("attached");
      } catch (error) {
        if (this.current === cycle && !cycle.retired && !this.disposed) {
          this.retire(cycle); this.options.onError(error); this.publish("error");
        }
        throw error;
      }
    }));
  }

  /** One fresh status/snapshot attempt. Gaps are visible, never a hidden retry loop. */
  resync(): Promise<void> {
    if (!this.selected) return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_NOT_READY"));
    return this.reconcile(this.selected);
  }

  /** Apply history only to the same view/owner/connection that requested it. */
  readHistory(params: { beforeItemId?: string; limit?: number }, apply: (view: OwnerAttachmentView, result: unknown) => void): Promise<void> {
    const cycle = this.current;
    if (!cycle?.attached || !cycle.view || !cycle.transport) return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_NOT_READY"));
    if (this.operations.size >= 8) return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_BUSY"));
    const limit = params.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (params.beforeItemId !== undefined && (typeof params.beforeItemId !== "string" || params.beforeItemId.length > 4096))) {
      return Promise.reject(attachmentError("HANDOFF_ATTACHMENT_INVALID_HISTORY"));
    }
    const { view, transport } = cycle;
    return this.track(Promise.resolve().then(async () => {
      this.check(cycle);
      const result = await transport.request("session/history", { sessionId: view.sessionId, limit,
        ...(params.beforeItemId === undefined ? {} : { beforeItemId: params.beforeItemId }) });
      this.check(cycle); apply(view, result);
    }));
  }

  detach(): Promise<void> {
    this.selected = undefined; this.unwatch(); this.retire(this.current); this.current = undefined;
    if (!this.disposed) this.publish("detached");
    return Promise.all([this.originalDetached(), this.cleanup]).then(() => undefined);
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    const detached = this.detach();
    this.disposing = Promise.allSettled([detached, ...this.operations]).then(results => {
      // Superseded observation promises reject to their callers. Teardown failures
      // are independently returned by detached, including a late unsubscribe.
      const result = results[0];
      if (result?.status === "rejected") throw result.reason;
    });
    this.publish("disposed");
    return this.disposing;
  }
}
