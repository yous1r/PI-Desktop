import { describe, expect, it, vi } from "vitest";
import { parseCommandCenterTaskSummary, type CommandCenterMonitorSnapshot } from "@pi-desktop/shared";
import control from "../../../shared/test/fixtures/command-center-control.json";
import summary from "../../../shared/test/fixtures/command-center-summary.json";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterObservationContext,
  invalidateCommandCenterObservationContext,
} from "../context.js";
import { createCommandCenterMonitorReader, type CommandCenterMonitorReader } from "./index.js";

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, {
    hostId: control.request.hostId, expectedHostEpoch: control.request.expectedHostEpoch,
  });
  return value;
}

function page(ids = ["session-1"], nextPage?: string, sequence = 42): CommandCenterMonitorSnapshot {
  return {
    version: 1,
    cursor: { epoch: "monitor-epoch-0001", sequence },
    generatedAt: "2026-01-01T00:00:00.000Z",
    rows: ids.map((sessionId) => parseCommandCenterTaskSummary({
      ...structuredClone(summary.snapshot.rows[0]),
      target: { kind: "session", sessionId },
      execution: { kind: "session", sessionId, turnId: `turn-${sessionId}` },
    })),
    ...(nextPage === undefined ? {} : { nextPage }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("public monitor reader", () => {
  it("publishes all pages atomically as a distinct complete projection with more than 100 rows", async () => {
    const next = deferred<unknown>();
    const reachedNext = deferred<void>();
    const first = page(Array.from({ length: 100 }, (_, index) => `task-${index}`), "second");
    const second = page(["last-task"]);
    const calls: (string | undefined)[] = [];
    const reader = createCommandCenterMonitorReader(context(), async (token, signal) => {
      calls.push(token);
      expect(signal.aborted).toBe(false);
      if (token === undefined) return first;
      expect(token).toBe("second");
      reachedNext.resolve();
      return next.promise;
    });
    expect(reader.getState()).toEqual({ status: "idle", projection: null });
    const refresh = reader.refresh();
    await reachedNext.promise;
    expect(reader.getState()).toEqual({ status: "loading", projection: null });
    first.rows[0].label = "External mutation after page read";
    next.resolve(second);
    const result = await refresh;
    expect(result.kind).toBe("published");
    const projection = reader.getState().projection;
    expect(projection?.rows).toHaveLength(101);
    expect(projection?.rows[0].label).toBe(summary.snapshot.rows[0].label);
    expect(projection).not.toHaveProperty("version");
    expect(projection).not.toHaveProperty("nextPage");
    expect(projection).toMatchObject({ cursor: first.cursor, generatedAt: first.generatedAt });
    expect(calls).toEqual([undefined, "second"]);
    expect(Object.isFrozen(result)).toBe(true);
    reader.dispose();
  });

  it("accepts an empty complete projection and uses explicit refresh only", async () => {
    const loader = vi.fn(async () => page([]));
    const reader = createCommandCenterMonitorReader(context(), loader);
    expect(loader).not.toHaveBeenCalled();
    expect(await reader.refresh()).toMatchObject({ kind: "published", projection: { rows: [] } });
    expect(reader.getState().status).toBe("ready");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(reader.cancel()).toBe(false);
    reader.dispose();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("retains the last complete projection during refresh and on partial loader failure", async () => {
    const secondPage = deferred<unknown>();
    const reachedSecond = deferred<void>();
    const oldPage = page(["old"], undefined, 1);
    const partial = page(["new"], "next", 2);
    const loader = vi.fn()
      .mockResolvedValueOnce(oldPage)
      .mockResolvedValueOnce(partial)
      .mockImplementationOnce(() => { reachedSecond.resolve(); return secondPage.promise; });
    const reader = createCommandCenterMonitorReader(context(), loader);
    await reader.refresh();
    const prior = reader.getState().projection;
    const refresh = reader.refresh();
    await reachedSecond.promise;
    expect(reader.getState()).toEqual({ status: "loading", projection: prior });
    secondPage.reject(new Error("private transport detail"));
    expect(await refresh).toEqual({ kind: "failed", reason: "load_failed" });
    expect(reader.getState()).toEqual({ status: "error", projection: prior, reason: "load_failed" });
    expect(reader.getState().projection).toBe(prior);
    expect(JSON.stringify(reader.getState())).not.toContain("private transport detail");
    expect(loader).toHaveBeenCalledTimes(3);
    reader.dispose();
  });

  it.each([
    { cursor: { epoch: "replacement", sequence: 42 } },
    { cursor: { epoch: "monitor-epoch-0001", sequence: 43 } },
    { generatedAt: "2026-01-01T00:01:00.000Z" },
  ])("requires explicit resync for inconsistent page generation: %j", async (change) => {
    const loader = vi.fn().mockResolvedValueOnce(page(["one"], "next"))
      .mockResolvedValueOnce({ ...page(["two"]), ...change });
    const reader = createCommandCenterMonitorReader(context(), loader);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "inconsistent_generation" });
    expect(reader.getState()).toEqual({ status: "resync_required", projection: null, reason: "inconsistent_generation" });
    expect(loader).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("ignores a superseded noncooperative loader and resolves its caller promptly", async () => {
    const old = deferred<unknown>();
    let oldSignal: AbortSignal | undefined;
    const loader = vi.fn().mockImplementationOnce((_token, signal: AbortSignal) => {
      oldSignal = signal;
      return old.promise;
    }).mockResolvedValueOnce(page(["new"], undefined, 2));
    const reader = createCommandCenterMonitorReader(context(), loader);
    const first = reader.refresh();
    const second = reader.refresh();
    expect(await first).toEqual({ kind: "cancelled", reason: "superseded" });
    expect(oldSignal?.aborted).toBe(true);
    expect(await second).toMatchObject({ kind: "published", projection: { cursor: { sequence: 2 } } });
    const state = reader.getState();
    old.resolve(page(["old"], "never-follow-this", 1));
    await old.promise;
    expect(reader.getState()).toBe(state);
    expect(loader).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("keeps original pending I/O bounded across repeated refresh and cancel calls", async () => {
    const firstLoad = deferred<unknown>();
    const secondLoad = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const loader = vi.fn().mockImplementationOnce((_token, signal: AbortSignal) => {
      signals.push(signal);
      return firstLoad.promise;
    }).mockImplementationOnce((_token, signal: AbortSignal) => {
      signals.push(signal);
      return secondLoad.promise;
    }).mockResolvedValueOnce(page(["recovered"]));
    const reader = createCommandCenterMonitorReader(context(), loader);
    const first = reader.refresh();
    const second = reader.refresh();
    expect(await first).toEqual({ kind: "cancelled", reason: "superseded" });
    for (let index = 0; index < 30; index += 1) {
      expect(await reader.refresh()).toEqual({ kind: "failed", reason: "busy" });
      reader.cancel();
    }
    expect(await second).toEqual({ kind: "cancelled", reason: "superseded" });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
    firstLoad.resolve(page(["obsolete"]));
    await firstLoad.promise;
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await reader.refresh()).toMatchObject({ kind: "published" });
    secondLoad.reject(new Error("late rejection"));
    await secondLoad.promise.catch(() => undefined);
    expect(reader.getState().projection?.rows[0].target).toEqual({ kind: "session", sessionId: "recovered" });
    expect(loader).toHaveBeenCalledTimes(3);
    reader.dispose();
  });

  it("supports explicit cancellation even when the loader waits forever and never retries", async () => {
    const pending = deferred<unknown>();
    let signal: AbortSignal | undefined;
    const loader = vi.fn((_token, incoming: AbortSignal) => { signal = incoming; return pending.promise; });
    const reader = createCommandCenterMonitorReader(context(), loader, { maxPendingLoads: 1 });
    const refresh = reader.refresh();
    expect(reader.cancel()).toBe(true);
    expect(await refresh).toEqual({ kind: "cancelled", reason: "cancelled" });
    expect(reader.getState()).toEqual({ status: "cancelled", projection: null, reason: "cancelled" });
    expect(signal?.aborted).toBe(true);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "busy" });
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve(page());
    await pending.promise;
    expect(reader.getState()).toMatchObject({ status: "error", projection: null });
    reader.dispose();
  });

  it("handles cooperative loader abort without publishing an error over cancellation", async () => {
    const reader = createCommandCenterMonitorReader(context(), (_token, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const refresh = reader.refresh();
    reader.cancel();
    expect(await refresh).toEqual({ kind: "cancelled", reason: "cancelled" });
    expect(reader.getState()).toEqual({ status: "cancelled", projection: null, reason: "cancelled" });
    reader.dispose();
  });

  it.each(["revoke", "dispose"])("clears the completed projection and drops late I/O on %s", async (action) => {
    const scope = context();
    const late = deferred<unknown>();
    let signal: AbortSignal | undefined;
    const loader = vi.fn().mockResolvedValueOnce(page()).mockImplementationOnce((_token, incoming: AbortSignal) => {
      signal = incoming;
      return late.promise;
    });
    const reader = createCommandCenterMonitorReader(scope, loader);
    await reader.refresh();
    const pending = reader.refresh();
    if (action === "revoke") invalidateCommandCenterObservationContext(scope);
    else reader.dispose();
    const reason = action === "revoke" ? "context_invalidated" : "disposed";
    const status = action === "revoke" ? "invalidated" : "disposed";
    expect(await pending).toEqual({ kind: "cancelled", reason });
    expect(signal?.aborted).toBe(true);
    expect(reader.getState()).toEqual({ status, projection: null });
    late.resolve(page(["secret-late-result"]));
    await late.promise;
    expect(reader.getState()).toEqual({ status, projection: null });
    expect(await reader.refresh()).toEqual({ kind: "cancelled", reason });
    expect(loader).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("binds the reader to an existing owner context and refuses unbound/revoked contexts", () => {
    const loader = vi.fn(async () => page());
    const unbound = createCommandCenterObservationContext();
    expect(() => createCommandCenterMonitorReader(unbound, loader)).toThrow();
    const scope = context();
    expect(() => bindCommandCenterObservationOwner(scope, {
      hostId: control.request.hostId, expectedHostEpoch: control.stopRequest.requestId,
    })).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_MISMATCH");
    invalidateCommandCenterObservationContext(scope);
    expect(() => createCommandCenterMonitorReader(scope, loader)).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    expect(loader).not.toHaveBeenCalled();
  });

  it("does not bind a context revoked by an external owner accessor", () => {
    const scope = createCommandCenterObservationContext();
    expect(() => bindCommandCenterObservationOwner(scope, {
      get hostId() {
        invalidateCommandCenterObservationContext(scope);
        return control.request.hostId;
      },
      expectedHostEpoch: control.request.expectedHostEpoch,
    })).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    expect(() => createCommandCenterMonitorReader(scope, async () => page()))
      .toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
  });

  it("detaches disposal from context and keeps other readers isolated", async () => {
    const scope = context();
    const first = createCommandCenterMonitorReader(scope, async () => page(["one"]));
    const second = createCommandCenterMonitorReader(context(), async () => page(["two"]));
    first.dispose();
    invalidateCommandCenterObservationContext(scope);
    expect(first.getState()).toEqual({ status: "disposed", projection: null });
    expect(await second.refresh()).toMatchObject({ kind: "published" });
    second.dispose();
  });

  it("rechecks context after untrusted page accessors run", async () => {
    const scope = context();
    const incoming = page();
    const reader = createCommandCenterMonitorReader(scope, async () => ({
      ...incoming,
      get rows() {
        invalidateCommandCenterObservationContext(scope);
        return incoming.rows;
      },
    }));
    expect(await reader.refresh()).toEqual({ kind: "cancelled", reason: "context_invalidated" });
    expect(reader.getState()).toEqual({ status: "invalidated", projection: null });
  });

  it("preserves newer refresh ownership during synchronous abort callbacks", async () => {
    const first = deferred<unknown>();
    const pendingNested = deferred<unknown>();
    let reader: CommandCenterMonitorReader;
    let nested: ReturnType<CommandCenterMonitorReader["refresh"]> | undefined;
    const loader = vi.fn().mockImplementationOnce((_token, signal: AbortSignal) => {
      signal.addEventListener("abort", () => { nested = reader.refresh(); }, { once: true });
      return first.promise;
    }).mockReturnValueOnce(pendingNested.promise);
    reader = createCommandCenterMonitorReader(context(), loader);
    const initial = reader.refresh();
    const outer = reader.refresh();
    expect(await initial).toEqual({ kind: "cancelled", reason: "superseded" });
    expect(await outer).toEqual({ kind: "cancelled", reason: "superseded" });
    pendingNested.resolve(page(["nested"]));
    expect(await nested).toMatchObject({ kind: "published" });
    first.resolve(page(["old"]));
    await first.promise;
    expect(reader.getState().projection?.rows[0].target).toEqual({ kind: "session", sessionId: "nested" });
    reader.dispose();
  });
});
