import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";
import { HostProcess } from "./host-process.js";

const spawned = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => spawned.current }));

function fixture(kind: "host" | "sidecar") {
  const child = Object.assign(new EventEmitter(), {
    pid: 123 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawned.current = child;
  const process = kind === "host"
    ? new HostProcess({ binaryPath: "fixture", dataDir: "fixture", onStderr: () => undefined })
    : new AgentSidecar({ launch: { command: "fixture", args: [] }, onStderr: () => undefined });
  const exit = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  };
  return { child, process, exit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

for (const kind of ["host", "sidecar"] as const) {
  describe(`${kind} explicit exit confirmation`, () => {
    it("times out without claiming exit or leaving confirmation listeners", async () => {
      const { child, process, exit } = fixture(kind);
      const listeners = child.listenerCount("exit");
      const waiting = process.confirmExit(20);
      await vi.advanceTimersByTimeAsync(20);
      expect(await waiting).toBe(false);
      expect(child.listenerCount("exit")).toBe(listeners);
      expect(child.listenerCount("close")).toBe(0);
      expect(child.kill).not.toHaveBeenCalled();
      exit();
    });

    it("confirms the original child and returns immediately after an observed exit", async () => {
      const { process, exit } = fixture(kind);
      const first = process.confirmExit(20);
      const second = process.confirmExit(40);
      exit();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(await process.confirmExit(0)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not turn a transport error into an exit receipt", async () => {
      const { child, process, exit } = fixture(kind);
      const waiting = process.confirmExit(20);
      child.emit("error", new Error("transport lost while process is alive"));
      await vi.advanceTimersByTimeAsync(20);
      expect(await waiting).toBe(false);
      expect(await process.confirmExit(0)).toBe(false);
      exit();
      expect(await process.confirmExit(0)).toBe(true);
    });

    it("keeps waiting through transport cleanup until the original child closes", async () => {
      const { child, process, exit } = fixture(kind);
      const waiting = process.confirmExit(20);
      child.emit("error", new Error("transport lost"));
      exit();
      expect(await waiting).toBe(true);
      expect(child.listenerCount("close")).toBe(0);
    });

    it("does not certify a spawn failure that never had a process identity", async () => {
      const { child, process } = fixture(kind);
      child.pid = undefined;
      child.exitCode = -4058;
      child.emit("error", new Error("spawn ENOENT"));
      child.emit("close", -4058, null);
      expect(await process.confirmExit(0)).toBe(false);
    });

    it("separates bounded disposal completion from actual exit", async () => {
      const { process, exit } = fixture(kind);
      const confirmation = process.confirmExit(5_000);
      const disposed = process.dispose();
      await vi.advanceTimersByTimeAsync(4_000);
      await disposed;
      expect(await process.confirmExit(0)).toBe(false);
      exit();
      expect(await confirmation).toBe(true);
      expect(await process.confirmExit(0)).toBe(true);
    });

    it("rejects invalid wait budgets without registering a timer", async () => {
      const { process, exit } = fixture(kind);
      for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
        await expect(process.confirmExit(timeout)).rejects.toThrow(RangeError);
      }
      expect(vi.getTimerCount()).toBe(0);
      exit();
    });
  });
}
