import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProcess } from "./host-process.js";
import { HostWriteAdmission } from "./host-write-admission.js";

const spawned = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => spawned.current }));

type Frame = { id: string; method: string; params: unknown };
function fixture() {
  const frames: Frame[] = [];
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, killed: false,
    stdin: new Writable({ write(chunk, _encoding, callback) {
      frames.push(JSON.parse(chunk.toString()));
      callback();
    } }),
    stdout, stderr: new PassThrough(), kill: vi.fn(),
  });
  spawned.current = child;
  const host = new HostProcess({ binaryPath: "fixture", dataDir: "fixture", onStderr: () => undefined });
  const reply = (frame: Frame, error?: object) => stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id: frame.id, ...(error ? { error } : { result: { ok: true } }),
  })}\n`);
  return { host, frames, reply, exit: () => child.emit("exit", 0, null) };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("Host transcript write admission", () => {
  it("bounds concurrent writes across 36 sessions while control RPC bypasses the write queue", async () => {
    const { host, frames, reply, exit } = fixture();
    try {
      const writes = Array.from({ length: 36 }, (_, i) => host.call("session.appendMessage", {
        sessionId: `s${i}`, message: { content: "x".repeat(1024 * 1024) },
      }));
      const all = Promise.all(writes);
      void all.catch(() => undefined);
      await tick();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.length).toBeLessThanOrEqual(8);
      const control = host.call("tools.abort", { sessionId: "s0", toolCallId: "tool" });
      await tick();
      const abort = frames.find(frame => frame.method === "tools.abort");
      expect(abort).toBeDefined();
      reply(abort!);
      await control;
      let replied = 0;
      while (replied < 36) {
        const batch = frames.filter(frame => frame.method === "session.appendMessage").slice(replied);
        expect(batch.length).toBeGreaterThan(0);
        expect(batch.length).toBeLessThanOrEqual(8);
        for (const frame of batch) reply(frame);
        replied += batch.length;
        await tick();
      }
      await all;
    } finally { exit(); }
  });

  it("expires a queued write without sending it and holds timed-out active slots until acknowledgement", async () => {
    vi.useFakeTimers();
    const { host, frames, reply, exit } = fixture();
    try {
      const active = Array.from({ length: 8 }, () => host.call("session.saveInflightMessage", {}, 100).catch(error => error));
      const queued = host.call("session.endTurn", {}, 20).catch(error => error);
      await vi.advanceTimersByTimeAsync(25);
      expect(await queued).toMatchObject({ message: "host RPC timeout: session.endTurn" });
      expect(frames).toHaveLength(8);
      await vi.advanceTimersByTimeAsync(100);
      expect((await Promise.all(active)).every(error => error instanceof Error)).toBe(true);
      const next = host.call("session.recordUsage", {}, 500);
      await tick();
      expect(frames).toHaveLength(8);
      reply(frames[0]!);
      await tick();
      expect(frames).toHaveLength(9);
      reply(frames[8]!);
      await next;
    } finally { exit(); }
  });

  it("rejects queued and active callers on process loss without sending queued writes", async () => {
    const { host, frames, exit } = fixture();
    const results = Array.from({ length: 36 }, () => host.call("session.appendMessage").catch(error => error));
    await tick();
    exit();
    expect((await Promise.all(results)).every(error => error.errorCode === "HOST_UNAVAILABLE")).toBe(true);
    expect(frames).toHaveLength(8);
    await expect(host.call("session.endTurn")).rejects.toMatchObject({ errorCode: "HOST_UNAVAILABLE" });
    await host.dispose();
  });

  it("retries only explicit pre-dispatch overload and reports persistent overload", async () => {
    vi.useFakeTimers();
    const { host, frames, reply, exit } = fixture();
    try {
      const result = host.call("session.appendMessage").catch(error => error);
      await tick();
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(frames).toHaveLength(attempt + 1);
        reply(frames[attempt]!, { code: -32029, message: "host RPC capacity is exhausted", data: { errorCode: "HOST_OVERLOADED" } });
        await vi.runOnlyPendingTimersAsync();
      }
      expect(await result).toMatchObject({ errorCode: "HOST_OVERLOADED" });
    } finally { exit(); }
  });
});

describe("write queue capacity", () => {
  it("bounds admitted request count and closes all waiting requests", async () => {
    const queue = new HostWriteAdmission();
    const active = await Promise.all(Array.from({ length: 8 }, () => queue.acquire(1, "write")));
    const waiting = Array.from({ length: 248 }, () => queue.acquire(1, "write").catch(error => error));
    await expect(queue.acquire(1, "write")).rejects.toMatchObject({ errorCode: "LIMIT_EXCEEDED", data: { scope: "host-write-queue" } });
    queue.close(new Error("closed"));
    expect((await Promise.all(waiting)).every(error => error.message === "closed")).toBe(true);
    for (const release of active) release();
  });

  it("bounds serialized bytes including active writes and releases capacity once", async () => {
    const queue = new HostWriteAdmission();
    const release = await queue.acquire(64 * 1024 * 1024, "write");
    await expect(queue.acquire(1, "write")).rejects.toMatchObject({ errorCode: "LIMIT_EXCEEDED" });
    release(); release();
    const next = await queue.acquire(64 * 1024 * 1024, "write");
    await expect(queue.acquire(1, "write")).rejects.toMatchObject({ errorCode: "LIMIT_EXCEEDED" });
    next();
  });
});
