import { describe, expect, it } from "vitest";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterObservationContext,
  createCommandCenterConnectionHealth,
  invalidateCommandCenterObservationContext,
  type CommandCenterConnectionHealth,
} from "../index.js";

/**
 * Seeded timing simulation over the real health controller. A controlled clock
 * and single-shot scheduler stand in for wall time; replies resolve through
 * deferred promises exactly as an injected transport would. The assertion is an
 * invariant against an independent model, never a hard-coded sequence.
 */

const owner = { hostId: "timing-host", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" };
const probeInterval = 2_000;
const staleAfter = 6_000;

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function controlledScheduler() {
  let now = 0;
  let serial = 0;
  const tasks = new Map<number, { at: number; run: () => void }>();
  return {
    clock: { now: () => now },
    scheduler: {
      schedule(delay: number, run: () => void) {
        const id = ++serial;
        tasks.set(id, { at: now + delay, run });
        return () => { tasks.delete(id); };
      },
    },
    pending: () => tasks.size,
    /** Fire due tasks in time order, including tasks scheduled during firing. */
    advance(target: number) {
      for (let guard = 0; guard < 10_000; guard += 1) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
      }
      now = Math.max(now, target);
    },
  };
}

function pingQueue() {
  const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void; signal: AbortSignal }[] = [];
  return {
    pending,
    ping(signal: AbortSignal) {
      return new Promise<unknown>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      });
    },
  };
}

const validReply = { ok: true, serverTime: "2026-11-11T00:00:00.000Z" };

async function simulate(seed: number, steps: number) {
  const next = seeded(seed);
  const time = controlledScheduler();
  const pings = pingQueue();
  const context = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(context, owner);
  const health = createCommandCenterConnectionHealth(context, {
    ...time,
    ping: pings.ping,
  });
  const token = health.connect();
  health.completeResync(token);

  let lastValidReplyAt: number | null = null;
  for (let step = 0; step < steps; step += 1) {
    time.advance(time.clock.now() + Math.floor(next() * 1_500));
    const outstanding = pings.pending.length;
    if (outstanding > 0 && next() < 0.75) {
      const choice = next();
      const reply = pings.pending.shift();
      if (choice < 0.15) {
        reply?.reject(new Error("transport failed"));
      } else if (choice < 0.3) {
        reply?.resolve({ ok: true, serverTime: "not-a-time" });
      } else {
        reply?.resolve(validReply);
        lastValidReplyAt = time.clock.now();
      }
    }
    await flush();

    const state = health.getState();
    const now = time.clock.now();
    const expectedFresh = lastValidReplyAt !== null && now - lastValidReplyAt < staleAfter;
    expect(state.status).toBe("foreground");
    expect(state.resynchronized).toBe(true);
    expect(state.freshness).toBe(expectedFresh ? "fresh" : "stale");
    if (expectedFresh) {
      expect(state.lastReplyAtMs).not.toBeNull();
      expect(now - (state.lastReplyAtMs ?? now)).toBeLessThan(staleAfter);
    }
    // The deadliest bug this model catches: a controller that never probes.
    expect(pings.pending.length).toBeLessThanOrEqual(2);
    expect(time.pending()).toBeLessThanOrEqual(1);
    expect(now).toBeGreaterThanOrEqual(0);
  }

  invalidateCommandCenterObservationContext(context);
  expect(health.getState()).toMatchObject({ freshness: "stale", resynchronized: false });
  expect(time.pending()).toBe(0);
  health.dispose();
}

describe("connection health seeded timing invariants", () => {
  it.each([0, 5, 17])("matches the freshness model under random probes and replies (seed %i)", async (seed) => {
    await simulate(seed, 80);
  });

  it("is never fresh without any valid reply, however the clock advances", async () => {
    const time = controlledScheduler();
    const pings = pingQueue();
    const context = createCommandCenterObservationContext();
    bindCommandCenterObservationOwner(context, owner);
    const health: CommandCenterConnectionHealth = createCommandCenterConnectionHealth(context, {
      ...time,
      ping: pings.ping,
    });
    health.completeResync(health.connect());
    for (let step = 0; step < 30; step += 1) {
      time.advance(time.clock.now() + 500);
      const reply = pings.pending.shift();
      reply?.resolve({ ok: false, serverTime: "2026-11-11T00:00:00.000Z" });
      await flush();
      expect(health.getState().freshness).toBe("stale");
    }
    invalidateCommandCenterObservationContext(context);
    health.dispose();
    expect(time.pending()).toBe(0);
  });

  it("probes at the documented cadence while capacity remains", async () => {
    const time = controlledScheduler();
    const pings = pingQueue();
    const context = createCommandCenterObservationContext();
    bindCommandCenterObservationOwner(context, owner);
    const health = createCommandCenterConnectionHealth(context, { ...time, ping: pings.ping });
    health.connect();
    time.advance(probeInterval - 1);
    expect(pings.pending.length).toBe(1);
    time.advance(probeInterval);
    // The default budget permits two original unsettled calls.
    expect(pings.pending.length).toBe(2);
    time.advance(probeInterval * 2);
    // A full budget stops new probes and reports the bound instead of queuing.
    expect(pings.pending.length).toBe(2);
    expect(health.getState().failure).toBe("pending_limit");
    // Releasing one original call restores probe capacity at the next interval.
    pings.pending.shift()?.resolve(validReply);
    await flush();
    time.advance(probeInterval * 2);
    expect(pings.pending.length).toBeGreaterThanOrEqual(1);
    invalidateCommandCenterObservationContext(context);
    health.dispose();
  });
});
