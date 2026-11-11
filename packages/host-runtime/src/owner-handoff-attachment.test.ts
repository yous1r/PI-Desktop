import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerHandoffAttachment, type OwnerAttachmentOptions, type OwnerAttachmentProjection, type OwnerAttachmentTransport } from "./owner-handoff-attachment.js";
import type { OwnerHandoffRecord, RacpEventEnvelope } from "@pi-desktop/shared";

const uuid = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, "0")}`;
const record: OwnerHandoffRecord = { version: 1, id: uuid(1), profile: "a".repeat(64), sourceEpoch: uuid(2), targetEpoch: uuid(3),
  sourceBuild: { sha256: "b".repeat(64), schema: 30, protocol: 1 }, targetBuild: { sha256: "b".repeat(64), schema: 30, protocol: 1 },
  requester: { pid: 123, createdAt: "1", sid: "S-1-5-21", image: "fixture.exe" }, capabilityHash: "c".repeat(64),
  revision: 6, phase: "ready", recoveryAttempt: 0, lastFailure: null };
const ready = { version: 1, transferId: record.id, profileId: record.profile, ownerEpoch: record.targetEpoch,
  recordRevision: record.revision, eventEpoch: "host-epoch", protocolVersion: 11, snapshotRequired: true };
const snapshot = (id: string, sequence = 0) => ({ session: { id, title: id, mode: "agent", status: "idle", planningState: "inactive",
  permissionMode: "ask", queuedTurnIds: [], revision: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  items: [], activeItems: [], queuedTurns: [], pendingApprovals: [], pendingInputs: [], hasMoreHistory: false,
  revision: 1, generatedAt: "2026-10-01T00:00:00Z", cursor: { epoch: `session-${id}`, sequence } });
const event = (sequence: number, epoch = "session-s1"): RacpEventEnvelope => ({
  eventId: `e${sequence}`, scope: "session", sessionId: "s1", epoch, sequence, revision: sequence,
  kind: "session.changed", occurredAt: "2026-10-01T00:00:00Z", payload: {},
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });

function fixture(overrides: Partial<OwnerAttachmentOptions> = {}) {
  const events = new Set<(event: RacpEventEnvelope) => void>();
  const closed = new Set<(id: string) => void>();
  const reconnect = new Set<() => Promise<void>>();
  const unavailable = new Set<() => void>();
  const resources = new Set<string>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const frames: OwnerAttachmentProjection[] = [];
  const painted: RacpEventEnvelope[] = [];
  const errors: unknown[] = [];
  const state = { closed: false, authorized: true, sequence: 0, subscription: 0,
    status: { response: { version: 1, record: structuredClone(record) }, ready: structuredClone(ready) } as { response: unknown; ready?: unknown },
    reply: async (_method: string, _params: Record<string, unknown>, value: unknown): Promise<unknown> => value };
  const transport: OwnerAttachmentTransport = {
    identity: { profileId: record.profile, ownerEpoch: record.targetEpoch, protocolVersion: 11 },
    assertCurrent() { if (state.closed || !state.authorized) throw new Error("AUTH_CHANGED"); }, isClosed: () => state.closed,
    async request<T>(method: string, input: unknown): Promise<T> {
      const params = input as Record<string, unknown>; calls.push({ method, params });
      let result: unknown = {};
      if (method === "session/attach") result = { role: "viewer", snapshot: snapshot(String(params.sessionId), state.sequence) };
      if (method === "events/subscribe") {
        const id = `sub-${++state.subscription}`; resources.add(id);
        result = { subscriptionId: id, starting: { epoch: params.scope === "host" ? "host-epoch" : `session-${params.sessionId}`, sequence: state.sequence + 1 }, replayComplete: true };
      }
      if (method === "events/unsubscribe") resources.delete(String(params.subscriptionId));
      if (method === "session/history") result = { items: [], hasMore: false };
      return await state.reply(method, params, result) as T;
    },
    subscribe(fn) { events.add(fn); return () => { events.delete(fn); }; },
    subscribeClosed(fn) { closed.add(fn); return () => { closed.delete(fn); }; },
    subscribeReconnect(fn) { reconnect.add(fn); return () => { reconnect.delete(fn); }; },
    subscribeUnavailable(fn) { unavailable.add(fn); return () => { unavailable.delete(fn); }; },
  };
  const detachOriginal = vi.fn(async () => {});
  const readStatus = vi.fn(async (_target: OwnerAttachmentOptions["target"], _signal: AbortSignal) => state.status);
  const attachment = new OwnerHandoffAttachment({ target: { transferId: record.id, profileId: record.profile, sourceEpoch: record.sourceEpoch },
    detachOriginal, readStatus, resolveTransport: async () => transport, onSnapshot: frame => frames.push(frame),
    onEvent: (_view, value) => painted.push(value), onError: value => errors.push(value), onState: () => {}, ...overrides });
  cleanups.push(async () => { state.closed = true; await attachment.dispose().catch(() => {}); });
  return { attachment, transport, state, calls, frames, painted, errors, resources, detachOriginal, readStatus, events, reconnect, unavailable, closed,
    emit: (value: RacpEventEnvelope) => { for (const listener of [...events]) listener(value); } };
}

function hold(f: ReturnType<typeof fixture>, method: string, scope?: string) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.state.reply = async (name, params, value) => {
    if (name === method && (scope === undefined || params.scope === scope)) {
      f.state.reply = async (_name, _params, result) => result;
      entered.resolve(); await release.promise;
    }
    return value;
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

const observed = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ error, value: undefined }));

describe("owner handoff attachment", () => {
  it("detaches the original, reconciles, snapshots, then reads history without execution methods", async () => {
    const f = fixture(); await f.attachment.reconcile("s1");
    expect(f.attachment.state).toBe("attached"); expect(f.detachOriginal).toHaveBeenCalledTimes(1);
    expect(f.calls.find(call => call.method === "session/attach")?.params).toEqual({ sessionId: "s1", role: "viewer", includeSnapshot: true });
    const page = vi.fn(); await f.attachment.readHistory({ beforeItemId: "older" }, page);
    expect(page).toHaveBeenCalledTimes(1);
    expect(f.calls.find(call => call.method === "session/history")?.params).toEqual({ sessionId: "s1", beforeItemId: "older", limit: 100 });
    await f.attachment.detach(); expect(f.resources.size).toBe(0); expect(f.events.size).toBe(0);
    expect(f.calls.every(call => ["session/attach", "session/history", "events/subscribe", "events/ack", "events/unsubscribe"].includes(call.method))).toBe(true);
  });

  it.each([undefined, {}, { ...ready, ownerEpoch: uuid(9) }, { ...ready, recordRevision: 5 }, { ...ready, snapshotRequired: false }, { ...ready, roles: ["owner"] }])("rejects absent or malformed Ready %j before opening a stream", async value => {
    const f = fixture(); f.state.status.ready = value;
    await expect(f.attachment.reconcile("s1")).rejects.toThrow("HANDOFF_INVALID_READY");
    expect(f.calls).toEqual([]); expect(f.frames).toEqual([]);
  });

  it("waits for durable ready and reconciles lost replies using the same transfer", async () => {
    const f = fixture(); f.state.status = { response: { version: 1, record: { ...record, phase: "target_claimed", revision: 5 } } };
    await f.attachment.reconcile("s1"); expect(f.attachment.state).toBe("waiting");
    f.state.status = { response: { version: 1, record }, ready };
    await f.attachment.resync(); expect(f.frames).toHaveLength(1); expect(f.detachOriginal).toHaveBeenCalledTimes(1);
    expect(f.readStatus.mock.calls.every(call => call.length === 2)).toBe(true);
  });

  it("refuses wrong authenticated owner and wrong host event epoch", async () => {
    const f = fixture(); Object.assign(f.transport.identity, { ownerEpoch: uuid(9) });
    await expect(f.attachment.reconcile("s1")).rejects.toThrow("HANDOFF_ATTACHMENT_AUTH_MISMATCH"); expect(f.calls).toEqual([]);
    const g = fixture(); g.state.status.ready = { ...ready, eventEpoch: "old-host" };
    await expect(g.attachment.reconcile("s1")).rejects.toThrow("HANDOFF_ATTACHMENT_EVENT_EPOCH");
    await g.attachment.detach(); expect(g.resources.size).toBe(0); expect(g.frames).toEqual([]);
  });

  it("discards delayed snapshots and history across selection and owner replacement", async () => {
    const f = fixture(); const gate = hold(f, "session/attach");
    const old = observed(f.attachment.reconcile("s1")); await gate.entered;
    await f.attachment.reconcile("s2"); gate.release(); expect((await old).error.message).toMatch(/SUPERSEDED/);
    expect(f.frames.map(frame => frame.view.sessionId)).toEqual(["s2"]);
    const history = hold(f, "session/history"), apply = vi.fn();
    const pending = observed(f.attachment.readHistory({}, apply)); await history.entered;
    await f.attachment.reconcile("s1"); history.release(); expect((await pending).error.message).toMatch(/SUPERSEDED/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("same epoch resubscription releases both original IDs before taking another snapshot", async () => {
    const f = fixture(); f.state.sequence = 1; await f.attachment.reconcile("s1"); await f.attachment.resync();
    expect(f.resources.size).toBe(2); expect(f.frames).toHaveLength(2);
    const reads = f.calls.filter(call => call.method === "events/unsubscribe");
    expect(reads.map(call => call.params.subscriptionId)).toEqual(["sub-1", "sub-2"]);
    f.emit(event(1)); expect(f.painted).toEqual([]); expect(f.attachment.state).toBe("attached");
  });

  it("holds disposal until a pending subscribe returns its ID and unsubscribe completes", async () => {
    const f = fixture(), gate = hold(f, "events/subscribe", "session");
    const opening = observed(f.attachment.reconcile("s1")); await gate.entered;
    let disposed = false; const closing = f.attachment.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false); expect(f.events.size).toBe(0);
    gate.release(); await opening; await closing;
    expect(f.resources.size).toBe(0); expect(f.frames).toEqual([]);
  });

  it("commits snapshot plus replay sent before subscribe reply without duplication", async () => {
    const f = fixture(); f.state.reply = async (method, params, value) => {
      if (method === "events/subscribe" && params.scope === "session") {
        f.emit(event(1)); f.emit(event(1)); f.emit(event(2));
        return { ...value as object, starting: { epoch: "session-s1", sequence: 3 } };
      }
      return value;
    };
    await f.attachment.reconcile("s1"); expect(f.frames[0]?.events.map(value => value.sequence)).toEqual([1, 2]);
    expect(f.frames[0]?.cursor.sequence).toBe(2); f.emit(event(2)); f.emit(event(3)); expect(f.painted.map(value => value.sequence)).toEqual([3]);
  });

  it.each(["count", "bytes", "gap", "wrong-epoch"])("refuses %s during snapshot race and explicitly requires resync", async kind => {
    const f = fixture({ maxPendingEvents: 2, maxPendingBytes: 800 }); const gate = hold(f, "events/subscribe", "session");
    const pending = observed(f.attachment.reconcile("s1")); await gate.entered;
    if (kind === "count") { f.emit(event(1)); f.emit(event(2)); f.emit(event(3)); }
    if (kind === "bytes") f.emit({ ...event(1), payload: "x".repeat(1000) });
    if (kind === "gap") f.emit(event(2));
    if (kind === "wrong-epoch") f.emit(event(1, "old-epoch"));
    gate.release(); expect((await pending).error).toBeDefined(); expect(f.frames).toEqual([]);
    expect(["error", "resync-required"]).toContain(f.attachment.state);
    await f.attachment.resync(); expect(f.attachment.state).toBe("attached"); expect(f.resources.size).toBe(2);
  });

  it("an observed gap freezes delivery, then existing reconnect hooks take a fresh snapshot", async () => {
    const f = fixture(); await f.attachment.reconcile("s1"); f.emit(event(2));
    expect(f.attachment.state).toBe("resync-required"); f.emit(event(1)); expect(f.painted).toEqual([]);
    f.state.sequence = 3;
    await Promise.all([...f.reconnect].map(callback => callback()));
    expect(f.frames.at(-1)?.cursor.sequence).toBe(3); expect(f.frames).toHaveLength(2);
  });

  it("rejects history after authorization changes and reports unsubscribe failure", async () => {
    const f = fixture(); await f.attachment.reconcile("s1");
    const gate = hold(f, "session/history"), apply = vi.fn(), pending = observed(f.attachment.readHistory({}, apply));
    await gate.entered; f.state.authorized = false; gate.release();
    expect((await pending).error.message).toBe("AUTH_CHANGED"); expect(apply).not.toHaveBeenCalled();
    await expect(f.attachment.detach()).rejects.toThrow("CLEANUP_UNCONFIRMED");
    expect(f.errors.some(error => error instanceof AggregateError)).toBe(true);
  });

  it("invalidates old callbacks synchronously when detached and never repaints on reentry", async () => {
    const f = fixture(); await f.attachment.reconcile("s1"); const old = [...f.events];
    const detached = f.attachment.detach(); for (const callback of old) callback(event(1)); await detached;
    expect(f.painted).toEqual([]); expect(f.reconnect.size).toBe(0);
  });

  it("lost status is not retried; explicit resync keeps the same transfer identity", async () => {
    const f = fixture(); f.readStatus.mockRejectedValueOnce(new Error("LOST_REPLY"));
    await expect(f.attachment.reconcile("s1")).rejects.toThrow("LOST_REPLY");
    expect(f.readStatus).toHaveBeenCalledTimes(1); expect(f.calls).toEqual([]);
    await f.attachment.resync();
    expect(f.readStatus.mock.calls.map(call => call[0])).toEqual([
      { transferId: record.id, profileId: record.profile, sourceEpoch: record.sourceEpoch },
      { transferId: record.id, profileId: record.profile, sourceEpoch: record.sourceEpoch },
    ]);
  });

  it("disposal cancels status observation and reentrant disposal shares completion", async () => {
    const entered = Promise.withResolvers<void>(); let nested: Promise<void> | undefined;
    const f = fixture({ readStatus: async (_target, signal) => {
      entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("CANCELLED")), { once: true }));
    }, onState: state => { if (state === "disposed") nested = f.attachment.dispose(); } });
    const opening = observed(f.attachment.reconcile("s1")); await entered.promise;
    const disposing = f.attachment.dispose(); expect(nested).toBe(disposing); await disposing;
    expect((await opening).error.message).toBe("CANCELLED"); expect(f.frames).toEqual([]);
  });

  it("a replaced reconnect callback cannot detach the new view", async () => {
    const f = fixture(); await f.attachment.reconcile("s1"); const original = [...f.reconnect];
    await f.attachment.reconcile("s2"); const generation = f.frames.at(-1)?.view.generation;
    await Promise.all(original.map(callback => callback()));
    expect(f.frames).toHaveLength(2); expect(f.frames.at(-1)?.view.generation).toBe(generation);
  });

  it("rejects a subscription closed before its response and releases the late ID", async () => {
    const f = fixture(), gate = hold(f, "events/subscribe", "session");
    const opening = observed(f.attachment.reconcile("s1")); await gate.entered;
    for (const callback of f.closed) callback("sub-2"); gate.release();
    expect((await opening).error.message).toContain("SUBSCRIPTION_CLOSED");
    await f.attachment.detach(); expect(f.resources.size).toBe(0); expect(f.frames).toEqual([]);
  });

  it("ack failure stays observable and requires resync without painting later deltas", async () => {
    const failed = Promise.withResolvers<void>();
    const f = fixture({ onState: state => { if (state === "resync-required") failed.resolve(); } });
    f.state.reply = async (method, _params, value) => { if (method === "events/ack") throw new Error("ACK_FAILED"); return value; };
    await observed(f.attachment.reconcile("s1")); await failed.promise;
    expect(f.attachment.state).toBe("resync-required"); f.emit(event(1)); expect(f.painted).toEqual([]);
    expect(f.errors.some(error => error instanceof Error && error.message === "ACK_FAILED")).toBe(true);
  });

  it("old-epoch events and pre-snapshot ephemeral deltas cannot repaint the attached view", async () => {
    const f = fixture(); f.state.sequence = 1; await f.attachment.reconcile("s1");
    const { sequence: _sequence, ...base } = event(1);
    f.emit({ ...base, kind: "item.delta", afterSequence: 0 }); expect(f.painted).toEqual([]);
    f.emit(event(2, "old-session")); expect(f.attachment.state).toBe("resync-required"); expect(f.painted).toEqual([]);
  });

  it("unsubscribe failure blocks replacement and is returned from disposal", async () => {
    const f = fixture(); await f.attachment.reconcile("s1");
    f.state.reply = async (method, _params, value) => { if (method === "events/unsubscribe") throw new Error("UNSUBSCRIBE_FAILED"); return value; };
    await expect(f.attachment.resync()).rejects.toThrow("CLEANUP_UNCONFIRMED");
    await expect(f.attachment.dispose()).rejects.toThrow("CLEANUP_UNCONFIRMED"); expect(f.frames).toHaveLength(1);
  });

  it("malformed snapshots fail schema validation before replay or presentation", async () => {
    const f = fixture();
    f.state.reply = async (method, _params, value) => method === "session/attach"
      ? { role: "viewer", snapshot: { ...snapshot("s1"), pendingApprovals: [{}] } } : value;
    await expect(f.attachment.reconcile("s1")).rejects.toThrow("INVALID_SNAPSHOT");
    expect(f.frames).toEqual([]); await f.attachment.detach(); expect(f.resources.size).toBe(0);
  });

  it("live ephemeral output after the snapshot cut is delivered once without a new durable event", async () => {
    const f = fixture(); f.state.sequence = 1; await f.attachment.reconcile("s1");
    const { sequence: _sequence, ...base } = event(1);
    const delta: RacpEventEnvelope = { ...base, kind: "item.delta", afterSequence: 1 };
    f.emit(delta); f.emit(delta); expect(f.painted).toEqual([delta]);
  });
});
