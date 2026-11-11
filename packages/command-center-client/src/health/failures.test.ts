import { describe, expect, it, vi } from "vitest";
import {
  bindCommandCenterObservationOwner, createCommandCenterObservationContext, invalidateCommandCenterObservationContext,
} from "../context.js";
import {
  createCommandCenterConnectionHealth,
  type CommandCenterConnectionHealth,
  type CommandCenterConnectionHealthOptions,
  type CommandCenterConnectionHealthState,
} from "./index.js";

const reply = { ok: true, serverTime: "2026-11-11T00:00:00.000Z" };

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, { hostId: "health", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(ping?: CommandCenterConnectionHealthOptions["ping"]) {
  const pending = deferred<unknown>();
  const time = { now: 0 };
  const timers = new Map<object, { callback: () => void; delay: number }>();
  let signal: AbortSignal | undefined;
  const loader = vi.fn(ping ?? ((incoming: AbortSignal) => { signal = incoming; return pending.promise; }));
  const health = createCommandCenterConnectionHealth(context(), {
    clock: { now: () => time.now },
    scheduler: {
      schedule(delay, callback) {
        const id = {};
        timers.set(id, { callback, delay });
        return () => { timers.delete(id); };
      },
    },
    ping: loader,
  });
  return { health, pending, loader, time, timers, signal: () => signal };
}

describe("health boundary validation and safe failure", () => {
  it.each([
    null,
    [],
    { ok: true },
    { ok: false, serverTime: reply.serverTime },
    { ok: "true", serverTime: reply.serverTime },
    { ...reply, principal: "owner" },
    { ...reply, serverTime: 1 },
    { ...reply, serverTime: "invalid" },
    { ...reply, serverTime: "2026-02-30T00:00:00.000Z" },
    { ...reply, serverTime: "2026-11-11T00:00:00Z" },
    { ...reply, serverTime: "2026-11-11T00:00:00.000+00:00" },
    { ...reply, serverTime: "x".repeat(100_000) },
  ])("rejects malformed ping replies without becoming fresh (%#)", async (value) => {
    const item = harness();
    item.health.completeResync(item.health.connect());
    item.pending.resolve(value);
    await item.pending.promise;
    expect(item.health.getState()).toMatchObject({ freshness: "stale", lastReplyAtMs: null, failure: "invalid_reply" });
    expect(item.timers.size).toBe(1);
    item.health.dispose();
  });

  it("reports a throwing reply accessor as invalid boundary data", async () => {
    const item = harness();
    item.health.connect();
    item.pending.resolve({ get ok() { throw new Error("private detail"); }, serverTime: reply.serverTime });
    await item.pending.promise;
    expect(item.health.getState().failure).toBe("invalid_reply");
    expect(JSON.stringify(item.health.getState())).not.toContain("private detail");
    item.health.dispose();
  });

  it("rechecks scope after validation accessors revoke the context", async () => {
    const scope = context();
    const pending = deferred<unknown>();
    const timers = new Set<() => void>();
    const health = createCommandCenterConnectionHealth(scope, {
      clock: { now: () => 0 },
      scheduler: { schedule(_delay, callback) { timers.add(callback); return () => { timers.delete(callback); }; } },
      ping: () => pending.promise,
    });
    health.connect();
    pending.resolve({ get ok() { invalidateCommandCenterObservationContext(scope); return true; }, serverTime: reply.serverTime });
    await pending.promise;
    expect(health.getState()).toMatchObject({ status: "invalidated", freshness: "stale", lastReplyAtMs: null });
    expect(timers.size).toBe(0);
  });

  it("keeps a new generation's timer when a reply accessor reconnects", async () => {
    let health: CommandCenterConnectionHealth;
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let calls = 0;
    const item = harness(() => (++calls === 1 ? first.promise : second.promise));
    health = item.health;
    const old = health.connect();
    first.resolve({ get ok() { health.connect(); return true; }, serverTime: reply.serverTime });
    await first.promise;
    expect(health.completeResync(old)).toBe(false);
    expect(health.getState()).toMatchObject({ freshness: "stale", lastReplyAtMs: null });
    expect(calls).toBe(2);
    expect(item.timers.size).toBe(1);
    health.dispose();
    second.resolve(reply);
    await second.promise;
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("fails safely on invalid initial clock %s", (now) => {
    const item = harness();
    item.time.now = now;
    const token = item.health.connect();
    expect(item.health.getState()).toMatchObject({ freshness: "stale", failure: "clock_invalid" });
    expect(item.health.completeResync(token)).toBe(false);
    expect(item.loader).not.toHaveBeenCalled();
    expect(item.timers.size).toBe(0);
    item.health.dispose();
  });

  it.each([NaN, Infinity, -1, 99])("halts a previously fresh cycle for invalid/backwards clock %s", async (now) => {
    const item = harness();
    item.time.now = 100;
    const token = item.health.connect();
    item.health.completeResync(token);
    item.pending.resolve(reply);
    await item.pending.promise;
    expect(item.health.getState().freshness).toBe("fresh");
    item.time.now = now;
    expect(item.health.getState()).toMatchObject({ freshness: "stale", failure: "clock_invalid", resynchronized: false });
    expect(item.health.completeResync(token)).toBe(false);
    expect(item.timers.size).toBe(0);
    item.health.dispose();
  });

  it("exposes clock exceptions and requires a new explicit cycle to recover", async () => {
    let broken = true;
    let now = 0;
    const load = deferred<unknown>();
    const health = createCommandCenterConnectionHealth(context(), {
      clock: { now() { if (broken) throw new Error("clock detail"); return now; } },
      scheduler: { schedule: () => () => {} },
      ping: () => load.promise,
    });
    const failed = health.connect();
    expect(health.getState()).toMatchObject({ freshness: "stale", failure: "clock_invalid" });
    broken = false;
    now = 0.125;
    expect(health.completeResync(failed)).toBe(false);
    const recovered = health.connect();
    health.completeResync(recovered);
    load.resolve(reply);
    await load.promise;
    expect(health.getState()).toMatchObject({ freshness: "fresh", lastReplyAtMs: 0.125, failure: null });
    health.dispose();
  });

  it("reports failed probes without leaking error text or retrying immediately", async () => {
    const item = harness();
    item.health.connect();
    item.pending.reject(new Error("secret transport detail"));
    await item.pending.promise.catch(() => undefined);
    expect(item.health.getState()).toMatchObject({ freshness: "stale", failure: "ping_failed" });
    expect(item.loader).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(item.health.getState())).not.toContain("secret transport detail");
    expect(item.timers.size).toBe(1);
    item.health.dispose();
  });

  it("reports synchronous ping throws using the same safe category", () => {
    const item = harness(() => { throw new Error("private"); });
    item.health.connect();
    expect(item.health.getState()).toMatchObject({ freshness: "stale", failure: "ping_failed" });
    expect(item.loader).toHaveBeenCalledTimes(1);
    item.health.dispose();
  });

  it.each(["throws", "synchronous"])("halts and aborts the cycle for a scheduler that %s", (mode) => {
    let signal: AbortSignal | undefined;
    const load = deferred<unknown>();
    const health = createCommandCenterConnectionHealth(context(), {
      clock: { now: () => 0 },
      scheduler: {
        schedule(_delay, callback) {
          if (mode === "throws") throw new Error("private scheduler detail");
          callback();
          return () => {};
        },
      },
      ping(incoming) { signal = incoming; return load.promise; },
    });
    const token = health.connect();
    expect(health.getState()).toMatchObject({ freshness: "stale", failure: "scheduler_failed" });
    expect(signal?.aborted).toBe(true);
    expect(health.completeResync(token)).toBe(false);
    health.dispose();
  });

  it("makes timer cancellation failure observable and fences an uncancelled old callback", () => {
    let callback: (() => void) | undefined;
    const health = createCommandCenterConnectionHealth(context(), {
      clock: { now: () => 0 },
      scheduler: { schedule(_delay, incoming) { callback = incoming; return () => { throw new Error("cannot cancel"); }; } },
      ping: () => new Promise(() => {}),
    });
    health.connect();
    health.suspend();
    const stopped = health.getState();
    expect(stopped).toMatchObject({ status: "suspended", freshness: "stale", failure: "scheduler_failed" });
    callback?.();
    expect(health.getState()).toBe(stopped);
    health.dispose();
  });

  it("ignores a queued callback after disposal and never repaints", async () => {
    let callback: (() => void) | undefined;
    const states: CommandCenterConnectionHealthState[] = [];
    const pending = deferred<unknown>();
    const health = createCommandCenterConnectionHealth(context(), {
      clock: { now: () => 7000 },
      scheduler: { schedule(_delay, incoming) { callback = incoming; return () => {}; } },
      ping: () => pending.promise,
      onState: (state) => { states.push(state); },
    });
    health.connect();
    health.dispose();
    const count = states.length;
    callback?.();
    pending.resolve(reply);
    await pending.promise;
    expect(states).toHaveLength(count);
    expect(health.getState().status).toBe("disposed");
  });

  it.each([0, -1, 1.5, 3, NaN, Infinity])("rejects invalid pending ceiling %s", (maxPendingPings) => {
    expect(() => createCommandCenterConnectionHealth(context(), {
      clock: { now: () => 0 }, scheduler: { schedule: () => () => {} }, ping: async () => reply, maxPendingPings,
    })).toThrow("COMMAND_CENTER_CLIENT_INVALID_HEALTH_OPTIONS");
  });

  it("requires a bound active context before any ping or timer can start", () => {
    const ping = vi.fn(async () => reply);
    const schedule = vi.fn(() => () => {});
    const unbound = createCommandCenterObservationContext();
    const options = { clock: { now: () => 0 }, scheduler: { schedule }, ping };
    expect(() => createCommandCenterConnectionHealth(unbound, options)).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_REQUIRED");
    const revoked = context();
    invalidateCommandCenterObservationContext(revoked);
    expect(() => createCommandCenterConnectionHealth(revoked, options)).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    expect(ping).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});
