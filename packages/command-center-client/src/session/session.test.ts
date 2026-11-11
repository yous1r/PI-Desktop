import { describe, expect, it } from "vitest";
import { parseCommandCenterTaskSummary, type CommandCenterMonitorSnapshot } from "@pi-desktop/shared";
import golden from "../../../shared/test/fixtures/command-center-summary.json";
import { bindCommandCenterObservationOwner, createCommandCenterObservationContext, invalidateCommandCenterObservationContext } from "../context.js";
import { createCommandCenterMonitorSession, type CommandCenterMonitorSessionOptions } from "./index.js";

const reply = { ok: true, serverTime: "2026-11-11T00:00:00.000Z" };

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, { hostId: "session-host", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
  return value;
}

function page(ids = ["main"], nextPage?: string, sequence = 42): CommandCenterMonitorSnapshot {
  return {
    version: 1, cursor: { epoch: "monitor", sequence }, generatedAt: golden.snapshot.generatedAt,
    rows: ids.map((sessionId) => parseCommandCenterTaskSummary({
      ...structuredClone(golden.snapshot.rows[0]), target: { kind: "session", sessionId },
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

class Time {
  value = 0;
  timers = new Map<object, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (delay: number, callback: () => void) => {
    const id = {};
    this.timers.set(id, { at: this.value + delay, callback });
    return () => { this.timers.delete(id); };
  };
  advance(to: number) {
    for (let index = 0; index < 100; index += 1) {
      const earliest = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!earliest || earliest[1].at > to) { this.value = to; return; }
      this.value = earliest[1].at;
      this.timers.delete(earliest[0]);
      earliest[1].callback();
    }
    throw new Error("Timer loop");
  }
}

function fixture(limits?: CommandCenterMonitorSessionOptions["limits"]) {
  const scope = context();
  const time = new Time();
  const pages: { token: string | undefined; signal: AbortSignal; pending: ReturnType<typeof deferred<unknown>> }[] = [];
  const pings: { signal: AbortSignal; pending: ReturnType<typeof deferred<unknown>> }[] = [];
  const session = createCommandCenterMonitorSession(scope, {
    limits, clock: time, scheduler: time,
    loadPage(token, signal) {
      const pending = deferred<unknown>();
      pages.push({ token, signal, pending });
      return pending.promise;
    },
    ping(signal) {
      const pending = deferred<unknown>();
      pings.push({ signal, pending });
      return pending.promise;
    },
  });
  return {
    scope, time, pages, pings, session,
    async ping(index = 0) { pings[index].pending.resolve(reply); await pings[index].pending.promise; },
    async refresh(snapshot: unknown = page()) {
      const result = session.refresh();
      pages.at(-1)!.pending.resolve(snapshot);
      return result;
    },
  };
}

describe("public monitor session composition", () => {
  it("starts without a summary and becomes fresh only after snapshot publication and ping", async () => {
    const item = fixture();
    const initial = item.session.getState();
    expect(initial).toMatchObject({ status: "active", summary: null, snapshotReady: false, summaryReady: false, fresh: false, stale: true });
    expect(item.session.getState()).toBe(initial);
    expect(item.session.apply({ invalid: true })).toEqual({ rejected: "not_ready" });
    item.session.connect();
    expect(item.pings).toHaveLength(1);
    expect(item.pages).toHaveLength(0);
    expect(await item.refresh()).toMatchObject({ kind: "published" });
    expect(item.session.getState()).toMatchObject({ snapshotReady: true, summaryReady: true, fresh: false, stale: true });
    await item.ping();
    const fresh = item.session.getState();
    expect(fresh).toMatchObject({ snapshotReady: true, summaryReady: true, fresh: true, stale: false });
    expect(Object.isFrozen(fresh)).toBe(true);
    expect(item.session.getState()).toBe(fresh);
    expect(Reflect.set(fresh, "fresh", false)).toBe(false);
    item.session.dispose();
  });

  it("does not treat a valid ping alone as snapshot synchronization", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    expect(item.session.getState()).toMatchObject({ fresh: false, snapshotReady: false, summaryReady: false, health: { resynchronized: false } });
    await item.refresh();
    expect(item.session.getState()).toMatchObject({ fresh: true, health: { resynchronized: true } });
    item.session.dispose();
  });

  it("reads all pages before constructing a live summary and completing synchronization", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    const refresh = item.session.refresh();
    item.pages[0].pending.resolve(page(Array.from({ length: 100 }, (_, index) => `task-${index}`), "next"));
    await item.pages[0].pending.promise;
    expect(item.pages[1].token).toBe("next");
    expect(item.session.getState()).toMatchObject({ monitor: { status: "loading", projection: null }, summary: null, fresh: false });
    item.pages[1].pending.resolve(page(["last"]));
    expect(await refresh).toMatchObject({ kind: "published" });
    expect(item.session.getState().summary?.projection?.rows).toHaveLength(101);
    expect(item.session.getState().fresh).toBe(true);
    item.session.dispose();
  });

  it("applies live changes to the current summary and recovers a sequence gap through a new snapshot", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    await item.refresh();
    const changed = page().rows[0];
    changed.status = "waiting_human";
    changed.pendingInputs = 1;
    expect(item.session.apply({ version: 1, epoch: "monitor", sequence: 43, type: "upsert", row: changed })).toBe("applied");
    expect(item.session.getState().summary?.projection?.rows[0]).toMatchObject({ status: "waiting_human", pendingInputs: 1 });
    expect(item.session.getState().monitor.projection?.cursor.sequence).toBe(42);
    expect(item.session.getState().summary?.projection?.cursor.sequence).toBe(43);
    expect(item.session.getState().fresh).toBe(true);
    expect(item.session.apply({ version: 1, epoch: "monitor", sequence: 45, type: "remove", target: changed.target })).toEqual({ resync: "sequence_gap" });
    expect(item.session.getState()).toMatchObject({ fresh: false, stale: true, summaryReady: false, summary: { status: "resync_required" } });
    const oldSummary = item.session.getState().summary;
    await item.refresh(page(["replacement"], undefined, 50));
    expect(item.session.getState().summary).not.toBe(oldSummary);
    expect(item.session.getState().summary?.projection?.cursor.sequence).toBe(50);
    expect(item.session.getState().fresh).toBe(true);
    item.session.dispose();
  });

  it("retains rows but marks summary resync when a new reader generation fails consistency", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    await item.refresh();
    const prior = item.session.getState().summary?.projection;
    const refresh = item.session.refresh();
    item.pages[1].pending.resolve(page(["partial"], "next", 43));
    await item.pages[1].pending.promise;
    item.pages[2].pending.resolve(page(["inconsistent"], undefined, 44));
    expect(await refresh).toEqual({ kind: "failed", reason: "inconsistent_generation" });
    expect(item.session.getState()).toMatchObject({
      monitor: { status: "resync_required" }, summary: { status: "resync_required", reason: "requested" },
      snapshotReady: false, summaryReady: false, fresh: false,
    });
    expect(item.session.getState().summary?.projection).toBe(prior);
    item.session.dispose();
  });

  it("marks the summary resync on load failure without silently replaying or retrying", async () => {
    const item = fixture();
    await item.refresh();
    const refresh = item.session.refresh();
    item.pages[1].pending.reject(new Error("private detail"));
    expect(await refresh).toEqual({ kind: "failed", reason: "load_failed" });
    expect(item.session.getState()).toMatchObject({ monitor: { status: "error" }, summary: { status: "resync_required" }, fresh: false });
    expect(item.pages).toHaveLength(2);
    item.session.dispose();
  });

  it("suspends health only and requires a post-resume snapshot plus a valid current ping", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    await item.refresh();
    item.time.advance(2000);
    const summary = item.session.getState().summary;
    const monitor = item.session.getState().monitor;
    item.session.suspend();
    expect(item.session.getState()).toMatchObject({ health: { status: "suspended", freshness: "stale" }, fresh: false, stale: true });
    expect(item.session.getState().summary).toBe(summary);
    expect(item.session.getState().monitor).toBe(monitor);
    expect(item.time.timers.size).toBe(0);
    expect(item.pings[1].signal.aborted).toBe(true);
    const oldCycle = item.session.resume();
    expect(Object.isFrozen(oldCycle)).toBe(true);
    await item.ping(2);
    expect(item.session.getState()).toMatchObject({ health: { resynchronized: false }, fresh: false });
    await item.refresh();
    expect(item.session.getState().fresh).toBe(true);
    item.session.dispose();
    await item.ping(1);
  });

  it("does not let a refresh started before resume complete the new connection cycle", async () => {
    const item = fixture();
    item.session.connect();
    const oldRead = item.session.refresh();
    item.session.suspend();
    item.session.resume();
    await item.ping(1);
    item.pages[0].pending.resolve(page());
    expect(await oldRead).toMatchObject({ kind: "published" });
    expect(item.session.getState()).toMatchObject({ snapshotReady: true, summaryReady: true, fresh: false, health: { resynchronized: false } });
    await item.refresh();
    expect(item.session.getState().fresh).toBe(true);
    item.session.dispose();
    await item.ping(0);
  });

  it("does not use a disconnected snapshot to satisfy a later connect", async () => {
    const item = fixture();
    const beforeConnect = item.session.refresh();
    item.session.connect();
    await item.ping();
    item.pages[0].pending.resolve(page());
    await beforeConnect;
    expect(item.session.getState()).toMatchObject({ fresh: false, health: { resynchronized: false } });
    await item.refresh();
    expect(item.session.getState().fresh).toBe(true);
    item.session.disconnect();
    expect(item.session.getState()).toMatchObject({ fresh: false, health: { status: "disconnected", freshness: "stale" } });
    item.session.dispose();
  });

  it("keeps a suspended refresh observable without completing an obsolete synchronization token", async () => {
    const item = fixture();
    item.session.connect();
    const refresh = item.session.refresh();
    item.session.suspend();
    item.pages[0].pending.resolve(page());
    await refresh;
    expect(item.session.getState()).toMatchObject({ health: { status: "suspended", resynchronized: false }, snapshotReady: true, summaryReady: true, fresh: false });
    item.session.dispose();
    await item.ping();
  });

  it("fences old refresh completions when a newer read owns publication", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    const first = item.session.refresh();
    const second = item.session.refresh();
    expect(await first).toEqual({ kind: "cancelled", reason: "superseded" });
    expect(item.pages[0].signal.aborted).toBe(true);
    item.pages[1].pending.resolve(page(["new"], undefined, 100));
    await second;
    const current = item.session.getState();
    item.pages[0].pending.resolve(page(["old"], undefined, 1));
    await item.pages[0].pending.promise;
    expect(item.session.getState()).toBe(current);
    expect(current.summary?.projection?.cursor.sequence).toBe(100);
    expect(current.fresh).toBe(true);
    item.session.dispose();
  });

  it("does not temporarily combine an old summary with a newly published reader cut", async () => {
    const item = fixture();
    item.session.connect();
    await item.ping();
    await item.refresh();
    const refresh = item.session.refresh();
    item.pages[1].pending.resolve(page(["new"], undefined, 100));
    await item.pages[1].pending.promise;
    const intermediate = item.session.getState();
    expect(intermediate.monitor.status).toBe("ready");
    expect(intermediate.summary?.projection?.cursor.sequence).toBe(42);
    expect(intermediate.fresh).toBe(false);
    await refresh;
    expect(item.session.getState().fresh).toBe(true);
    expect(item.session.getState().summary?.projection?.cursor.sequence).toBe(100);
    item.session.dispose();
  });

  it("clears children, aborts original loads and prevents late publication when the context is revoked", async () => {
    const item = fixture();
    item.session.connect();
    await item.refresh();
    const refresh = item.session.refresh();
    invalidateCommandCenterObservationContext(item.scope);
    const final = item.session.getState();
    expect(final).toMatchObject({ status: "invalidated", health: { status: "invalidated" }, monitor: { status: "invalidated", projection: null },
      summary: { status: "invalidated", projection: null }, fresh: false, snapshotReady: false, summaryReady: false });
    expect(item.pages[1].signal.aborted).toBe(true);
    expect(item.pings[0].signal.aborted).toBe(true);
    expect(item.time.timers.size).toBe(0);
    expect(await refresh).toEqual({ kind: "cancelled", reason: "context_invalidated" });
    await item.ping();
    item.pages[1].pending.resolve(page(["late"]));
    await item.pages[1].pending.promise;
    expect(item.session.getState()).toBe(final);
    expect(item.session.apply({})).toEqual({ rejected: "context_invalidated" });
    expect(await item.session.refresh()).toEqual({ kind: "cancelled", reason: "context_invalidated" });
    expect(() => item.session.connect()).toThrow("COMMAND_CENTER_CLIENT_SESSION_INVALIDATED");
    item.session.dispose();
    expect(item.session.getState()).toBe(final);
  });

  it("disposes idempotently without changing the observation scope or starting real timers", async () => {
    const item = fixture();
    item.session.connect();
    const refresh = item.session.refresh();
    item.session.dispose();
    expect(await refresh).toEqual({ kind: "cancelled", reason: "disposed" });
    const state = item.session.getState();
    expect(state).toMatchObject({ status: "disposed", health: { status: "disposed" }, monitor: { status: "disposed", projection: null }, summary: { status: "disposed", projection: null } });
    expect(item.time.timers.size).toBe(0);
    expect(item.pages[0].signal.aborted).toBe(true);
    item.session.dispose();
    item.session.suspend();
    item.session.disconnect();
    expect(item.session.getState()).toBe(state);
    expect(item.session.apply({})).toEqual({ rejected: "disposed" });
    expect(() => item.session.resume()).toThrow("COMMAND_CENTER_CLIENT_SESSION_DISPOSED");
    bindCommandCenterObservationOwner(item.scope, { hostId: "session-host", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
    await item.ping();
    item.pages[0].pending.resolve(page());
    await item.pages[0].pending.promise;
    expect(item.session.getState()).toBe(state);
  });

  it("reports a lower summary budget rejecting a valid reader projection safely", async () => {
    const item = fixture({ summary: { maxRows: 1 } });
    item.session.connect();
    await item.ping();
    await item.refresh();
    const prior = item.session.getState().summary?.projection;
    expect(await item.refresh(page(["main", "other"]))).toEqual({ kind: "failed", reason: "summary_rejected" });
    expect(item.session.getState()).toMatchObject({ snapshotReady: true, summaryReady: false, fresh: false, summary: { status: "resync_required" } });
    expect(item.session.getState().summary?.projection).toBe(prior);
    item.session.dispose();
  });

  it("inherits original-loader and ping bounds without queued reconnect retries", async () => {
    const item = fixture({ reader: { maxPendingLoads: 1 }, maxPendingPings: 1 });
    item.session.connect();
    const original = item.session.refresh();
    item.session.resume();
    expect(item.pings).toHaveLength(1);
    expect(item.pings[0].signal.aborted).toBe(true);
    expect(await item.session.refresh()).toEqual({ kind: "failed", reason: "busy" });
    expect(await original).toEqual({ kind: "cancelled", reason: "superseded" });
    expect(item.pages).toHaveLength(1);
    item.pages[0].pending.resolve(page());
    await item.pages[0].pending.promise;
    await item.ping();
    expect(item.pages).toHaveLength(1);
    expect(item.pings).toHaveLength(1);
    item.time.advance(2000);
    expect(item.pings).toHaveLength(2);
    await item.ping(1);
    await item.refresh();
    expect(item.session.getState().fresh).toBe(true);
    item.session.dispose();
  });
});
