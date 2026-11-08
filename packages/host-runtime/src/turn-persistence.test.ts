import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";

import { TurnPersistence } from "./turn-persistence.js";

function row(id: string): UiMessage {
  return { id, role: "assistant", content: id, createdAt: "2026-09-18T00:00:00.000Z", status: "complete" };
}

describe("TurnPersistence", () => {
  it("writes a session's rows in order and reports nothing pending afterwards", async () => {
    const written: string[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call(_method: string, params: { message: UiMessage }) {
          written.push(params.message.id);
        },
      }),
      log: () => undefined,
    });
    const first = persistence.append({ sessionId: "s", message: row("a") });
    const second = persistence.append({ sessionId: "s", message: row("b") });
    expect(persistence.size()).toBe(2);
    await Promise.all([first, second]);
    expect(written).toEqual(["a", "b"]);
    expect(persistence.size()).toBe(0);
  });

  it("retries while host-core is unavailable and lands the row once it is back", async () => {
    let attempts = 0;
    let available = false;
    const sleeps: number[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        isAvailable: () => available,
        async call() {
          attempts += 1;
        },
      }),
      log: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) available = true;
      },
    });
    await persistence.append({ sessionId: "s", message: row("a") });
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([100, 250, 500]);
  });

  it("treats a duplicate message id as already written and logs other failures", async () => {
    const logs: string[] = [];
    let calls = 0;
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call() {
          calls += 1;
          if (calls === 1) throw new Error("UNIQUE constraint failed: messages.id");
          throw Object.assign(new Error("bad row"), { errorCode: "INVALID_ARGUMENT" });
        },
      }),
      log: (_level, message) => logs.push(message),
    });
    await persistence.append({ sessionId: "s", message: row("dup") });
    await expect(persistence.append({ sessionId: "s", message: row("bad") })).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    expect(calls).toBe(2);
    expect(logs).toEqual(["transcript append failed"]);
  });
});

describe("turn persistence failure barriers", () => {
  it("keeps ordering after a rejected row and does not charge a late old-turn failure to the new turn", async () => {
    const written: string[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({ async call(_method: string, params: { message: UiMessage }) {
        if (params.message.id === "bad") throw new Error("disk full");
        written.push(params.message.id);
      } }), log: () => undefined,
    });
    persistence.beginTurn("s", "t1");
    const bad = persistence.append({ sessionId: "s", turnId: "t1", message: row("bad") });
    const good = persistence.append({ sessionId: "s", turnId: "t1", message: row("good") });
    await expect(bad).rejects.toThrow("disk full");
    await good;
    await expect(persistence.flushTurn("s", "t1")).rejects.toThrow("disk full");
    expect(written).toEqual(["good"]);
    persistence.beginTurn("s", "t2");
    await expect(persistence.append({ sessionId: "s", turnId: "t1", message: row("bad") })).rejects.toThrow("disk full");
    await expect(persistence.flushTurn("s", "t2")).resolves.toBeUndefined();
  });

  it("bounds unavailable-host retries and reports the failure through the turn barrier", async () => {
    const delays: number[] = [];
    const persistence = new TurnPersistence({ getHost: () => null, log: () => undefined,
      sleep: async ms => { delays.push(ms); } });
    persistence.beginTurn("s", "t");
    await expect(persistence.append({ sessionId: "s", turnId: "t", message: row("a") })).rejects.toMatchObject({ errorCode: "HOST_UNAVAILABLE" });
    await expect(persistence.flushTurn("s", "t")).rejects.toMatchObject({ errorCode: "HOST_UNAVAILABLE" });
    expect(delays).toHaveLength(14);
    expect(persistence.size()).toBe(0);
    persistence.dispose();
    await expect(persistence.append({ sessionId: "s", message: row("late") })).rejects.toMatchObject({ errorCode: "HOST_UNAVAILABLE" });
    await persistence.flush();
  });
});
