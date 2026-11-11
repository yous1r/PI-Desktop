import { describe, expect, it } from "vitest";
import {
  bindCommandCenterObservationOwner, createCommandCenterObservationContext, invalidateCommandCenterObservationContext,
} from "../context.js";
import {
  createCommandCenterConnectionHealth,
  type CommandCenterConnectionHealth,
  type CommandCenterConnectionHealthState,
  type CommandCenterHealthSyncToken,
} from "./index.js";

const validReply = { ok: true, serverTime: "2026-11-11T00:00:00.000Z" };

function scope() {
  const context = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(context, {
    hostId: "host-health", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
  });
  return context;
}

class Time {
  nowMs = 0;
  timers = new Map<object, { at: number; callback: () => void }>();
  now = () => this.nowMs;
  schedule = (delay: number, callback: () => void) => {
    const id = {};
    this.timers.set(id, { at: this.nowMs + delay, callback });
    return () => { this.timers.delete(id); };
  };
  advance(to: number) {
    for (let count = 0; count < 100; count += 1) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) { this.nowMs = to; return; }
      this.nowMs = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    throw new Error("Timer loop");
  }
  delayedTick(to: number) {
    const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) throw new Error("No timer");
    this.nowMs = to;
    this.timers.delete(next[0]);
    next[1].callback();
  }
}

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(onState?: (state: CommandCenterConnectionHealthState) => void, maxPendingPings = 2) {
  const context = scope();
  const time = new Time();
  const requests: { signal: AbortSignal; result: ReturnType<typeof pending<unknown>> }[] = [];
  const health = createCommandCenterConnectionHealth(context, {
    clock: time,
    scheduler: time,
    maxPendingPings,
    onState,
    ping(signal) {
      const result = pending<unknown>();
      requests.push({ signal, result });
      return result.promise;
    },
  });
  return {
    context, time, requests, health,
    async reply(index: number, value: unknown = validReply) {
      requests[index].result.resolve(value);
      await requests[index].result.promise;
    },
  };
}

describe("public connection health lifecycle", () => {
  it("starts disconnected and becomes fresh only after current resync and a valid ping", async () => {
    const item = fixture();
    expect(item.health.getState()).toEqual({
      status: "disconnected", freshness: "stale", resynchronized: false,
      lastReplyAtMs: null, failure: null, observerFailed: false,
    });
    expect(item.health.getState()).toBe(item.health.getState());
    expect(item.requests).toHaveLength(0);
    const token = item.health.connect();
    expect(Object.isFrozen(token)).toBe(true);
    expect(item.requests).toHaveLength(1);
    expect(item.time.timers.size).toBe(1);
    expect(item.health.completeResync(token)).toBe(true);
    expect(item.health.getState().freshness).toBe("stale");
    item.time.nowMs = 12.5;
    await item.reply(0);
    const fresh = item.health.getState();
    expect(fresh).toMatchObject({ freshness: "fresh", lastReplyAtMs: 12.5, resynchronized: true });
    expect(Object.isFrozen(fresh)).toBe(true);
    expect(Reflect.set(fresh, "freshness", "stale")).toBe(false);
    expect(item.health.completeResync(token)).toBe(true);
    expect(item.health.getState()).toBe(fresh);
    item.health.dispose();
  });

  it("probes once every two seconds and maintains one timer", async () => {
    const item = fixture();
    item.health.completeResync(item.health.connect());
    await item.reply(0);
    for (let index = 1; index <= 5; index += 1) {
      item.time.advance(index * 2000 - 1);
      expect(item.requests).toHaveLength(index);
      item.time.advance(index * 2000);
      expect(item.requests).toHaveLength(index + 1);
      expect(item.time.timers.size).toBe(1);
      await item.reply(index);
      expect(item.health.getState().freshness).toBe("fresh");
      expect(item.time.timers.size).toBe(1);
    }
    item.health.dispose();
    expect(item.time.timers.size).toBe(0);
  });

  it("notifies stale at the six-second receive deadline without polling", async () => {
    const observed: CommandCenterConnectionHealthState[] = [];
    const item = fixture((state) => { observed.push(state); });
    item.health.completeResync(item.health.connect());
    item.time.nowMs = 500.25;
    await item.reply(0);
    expect(observed.at(-1)?.freshness).toBe("fresh");
    item.time.advance(6500.24);
    expect(observed.at(-1)?.freshness).toBe("fresh");
    item.time.advance(6500.25);
    expect(observed.at(-1)?.freshness).toBe("stale");
    expect(observed.at(-1)?.lastReplyAtMs).toBe(500.25);
    expect(item.time.timers.size).toBe(1);
    item.health.dispose();
  });

  it("keeps no-reply connections stale and bounds original pending probes without queues", async () => {
    const item = fixture();
    item.health.completeResync(item.health.connect());
    item.time.advance(20_000);
    expect(item.requests).toHaveLength(2);
    expect(item.health.getState()).toMatchObject({ freshness: "stale", lastReplyAtMs: null, failure: "pending_limit" });
    await item.reply(0);
    expect(item.requests).toHaveLength(2);
    expect(item.health.getState().freshness).toBe("fresh");
    item.time.advance(22_000);
    expect(item.requests).toHaveLength(3);
    item.health.dispose();
  });

  it("checks actual elapsed time on delayed callbacks and never sends catch-up bursts", async () => {
    const item = fixture();
    item.health.completeResync(item.health.connect());
    await item.reply(0);
    item.time.delayedTick(15_000);
    expect(item.health.getState()).toMatchObject({ freshness: "stale", failure: "reply_timeout" });
    expect(item.requests).toHaveLength(2);
    expect([...item.time.timers.values()][0].at).toBe(17_000);
    item.health.dispose();
  });

  it("also checks elapsed on state access if the host has not delivered a timer", async () => {
    const item = fixture();
    item.health.completeResync(item.health.connect());
    await item.reply(0);
    item.time.nowMs = 6000;
    expect(item.health.getState()).toMatchObject({ freshness: "stale", failure: "reply_timeout" });
    expect(item.requests).toHaveLength(1);
    item.health.dispose();
  });

  it("suspends without timers and requires a new resync token and fresh ping after resume", async () => {
    const item = fixture();
    const original = item.health.connect();
    item.health.completeResync(original);
    await item.reply(0);
    item.time.advance(2000);
    item.health.suspend();
    expect(item.health.getState()).toMatchObject({ status: "suspended", freshness: "stale", lastReplyAtMs: null });
    expect(item.requests[1].signal.aborted).toBe(true);
    expect(item.time.timers.size).toBe(0);
    item.time.advance(20_000);
    expect(item.requests).toHaveLength(2);
    const current = item.health.resume();
    expect(current).not.toBe(original);
    expect(item.health.completeResync(original)).toBe(false);
    await item.reply(1);
    expect(item.health.getState().lastReplyAtMs).toBeNull();
    await item.reply(2);
    expect(item.health.getState()).toMatchObject({ freshness: "stale", resynchronized: false, lastReplyAtMs: 20_000 });
    expect(item.health.completeResync(current)).toBe(true);
    expect(item.health.getState().freshness).toBe("fresh");
    item.health.dispose();
  });

  it("makes explicit connection loss immediately observable and rejects old sync completions", async () => {
    const observed: CommandCenterConnectionHealthState[] = [];
    const item = fixture((state) => { observed.push(state); });
    const token = item.health.connect();
    item.health.completeResync(token);
    await item.reply(0);
    item.health.disconnect();
    expect(observed.at(-1)).toMatchObject({ status: "disconnected", freshness: "stale", lastReplyAtMs: null });
    expect(item.time.timers.size).toBe(0);
    const current = item.health.connect();
    expect(item.health.completeResync(token)).toBe(false);
    expect(item.health.completeResync({} as CommandCenterHealthSyncToken)).toBe(false);
    item.health.completeResync(current);
    expect(item.health.getState().freshness).toBe("stale");
    await item.reply(1);
    expect(item.health.getState().freshness).toBe("fresh");
    item.health.dispose();
  });

  it("counts aborted noncooperative probes across rapid connection cycles", async () => {
    const item = fixture(undefined, 1);
    const original = item.health.connect();
    for (let count = 0; count < 20; count += 1) item.health.connect();
    expect(item.requests).toHaveLength(1);
    expect(item.requests[0].signal.aborted).toBe(true);
    expect(item.health.completeResync(original)).toBe(false);
    expect(item.health.getState().failure).toBe("pending_limit");
    await item.reply(0);
    expect(item.health.getState().lastReplyAtMs).toBeNull();
    expect(item.requests).toHaveLength(1);
    item.time.advance(2000);
    expect(item.requests).toHaveLength(2);
    item.health.dispose();
  });

  it("accepts out-of-order current-cycle replies as liveness at their local receive time", async () => {
    const item = fixture();
    item.health.completeResync(item.health.connect());
    item.time.advance(2000);
    item.time.nowMs = 2500;
    await item.reply(1, { ok: true, serverTime: "1900-01-01T00:00:00.000Z" });
    item.time.nowMs = 3000;
    await item.reply(0, { ok: true, serverTime: "9999-12-31T23:59:59.999Z" });
    expect(item.health.getState()).toMatchObject({ freshness: "fresh", lastReplyAtMs: 3000 });
    item.health.dispose();
  });

  it.each(["revoke", "dispose"])("removes timers, aborts probes and stops notification on %s", async (action) => {
    const observed: CommandCenterConnectionHealthState[] = [];
    const item = fixture((state) => { observed.push(state); });
    const token = item.health.connect();
    if (action === "revoke") invalidateCommandCenterObservationContext(item.context);
    else item.health.dispose();
    expect(item.requests[0].signal.aborted).toBe(true);
    expect(item.time.timers.size).toBe(0);
    const final = observed.at(-1);
    expect(final?.status).toBe(action === "revoke" ? "invalidated" : "disposed");
    expect(final?.freshness).toBe("stale");
    const length = observed.length;
    await item.reply(0);
    item.health.dispose();
    expect(item.health.completeResync(token)).toBe(false);
    expect(() => item.health.connect()).toThrow();
    expect(observed).toHaveLength(length);
    expect(item.health.getState()).toBe(final);
  });

  it("detaches a throwing observer and preserves a sticky safe diagnostic", async () => {
    let calls = 0;
    const item = fixture(() => { calls += 1; throw new Error("private callback detail"); });
    item.health.completeResync(item.health.connect());
    await item.reply(0);
    expect(item.health.getState()).toMatchObject({ freshness: "fresh", observerFailed: true });
    expect(JSON.stringify(item.health.getState())).not.toContain("private callback detail");
    item.time.advance(2000);
    await item.reply(1);
    expect(item.health.getState().observerFailed).toBe(true);
    item.health.dispose();
    expect(calls).toBe(1);
  });

  it("allows an observer to suspend during connect without sending an obsolete ping", () => {
    let health: CommandCenterConnectionHealth;
    const item = fixture((state) => {
      if (state.status === "foreground") health.suspend();
    });
    health = item.health;
    health.connect();
    expect(health.getState().status).toBe("suspended");
    expect(item.requests).toHaveLength(0);
    expect(item.time.timers.size).toBe(0);
    health.dispose();
  });

  it("preserves a reconnect started by the suspend observer, including its timer and probe", async () => {
    let health: CommandCenterConnectionHealth;
    let current: CommandCenterHealthSyncToken | undefined;
    const item = fixture((state) => {
      if (state.status === "suspended") current = health.connect();
    });
    health = item.health;
    health.connect();
    health.suspend();
    expect(item.requests).toHaveLength(2);
    expect(item.requests[0].signal.aborted).toBe(true);
    expect(item.requests[1].signal.aborted).toBe(false);
    expect(item.time.timers.size).toBe(1);
    expect(health.completeResync(current!)).toBe(true);
    await item.reply(1);
    expect(health.getState().freshness).toBe("fresh");
    health.dispose();
    await item.reply(0);
  });

  it("cannot let a valid old reply rearm or clear the timer of an observer-started new cycle", async () => {
    let health: CommandCenterConnectionHealth;
    let replaced = false;
    const item = fixture((state) => {
      if (state.freshness === "fresh" && !replaced) { replaced = true; health.connect(); }
    });
    health = item.health;
    health.completeResync(health.connect());
    await item.reply(0);
    expect(health.getState()).toMatchObject({ freshness: "stale", lastReplyAtMs: null, resynchronized: false });
    expect(item.requests).toHaveLength(2);
    expect(item.time.timers.size).toBe(1);
    item.time.advance(2000);
    expect(item.requests).toHaveLength(3);
    health.dispose();
  });

  it("allows disposal within observer notification and emits the final state only once", () => {
    let health: CommandCenterConnectionHealth;
    const observed: string[] = [];
    const item = fixture((state) => {
      observed.push(state.status);
      if (state.status === "foreground") health.dispose();
    });
    health = item.health;
    health.connect();
    expect(observed).toEqual(["foreground", "disposed"]);
    expect(item.requests).toHaveLength(0);
    expect(item.time.timers.size).toBe(0);
    health.dispose();
    expect(observed).toEqual(["foreground", "disposed"]);
  });
});
