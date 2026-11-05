import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustedExtensionSpec } from "@pi-desktop/shared";
import { ExtensionOwnerRuntime } from "./owner-runtime.js";
import { RuntimeShutdown } from "./runtime-shutdown.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const spec: TrustedExtensionSpec = { id: "extension", entry: "/extension.ts", root: "/", label: "fixture", source: "plugin",
  ownerPluginId: "demo.owner", ownerOperations: [{ name: "recall", readOnly: true }] };
const identity = () => ({ sessionId: "session", mode: "agent" as const, projectPath: "/project", workspaceRoot: "/worktree" });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("owner runtime lifetime", () => {
  it("cancelled registration cannot later dispatch the owner operation", async () => {
    const registration = deferred<unknown>(); const calls: string[] = [];
    const owner = new ExtensionOwnerRuntime({ call: async <T>(method: string) => {
      calls.push(method); return (method.endsWith("registerRuntime") ? await registration.promise : {}) as T;
    } }, [spec], identity);
    const controller = new AbortController();
    const pending = expect(owner.call(spec, "recall", {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await pending; registration.resolve({ ok: true });
    await Promise.resolve();
    expect(calls).toEqual(["extensions.owner.registerRuntime"]);
  });
  it("bounds an uncooperative host, sends cancellation and ignores late completion", async () => {
    vi.useFakeTimers(); const entered = deferred<void>(); const result = deferred<unknown>(); const calls: string[] = [];
    const owner = new ExtensionOwnerRuntime({ call: async <T>(method: string) => {
      calls.push(method);
      if (method === "extensions.owner.call") { entered.resolve(); return await result.promise as T; }
      return {} as T;
    } }, [spec], identity);
    const pending = expect(owner.call(spec, "recall", {}, new AbortController().signal)).rejects.toMatchObject({ name: "TimeoutError" });
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000); await pending;
    expect(calls).toContain("extensions.owner.cancel"); result.resolve("late");
  });
  it("still disposes the runner when the plugin was unloaded before retirement", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const owner = new ExtensionOwnerRuntime({ call: async () => { throw new Error("unloaded"); } }, [spec], identity);
    const runner = { cancelPending: vi.fn(), dispose: vi.fn(async () => {}) };
    await owner.close(runner, "reconfigure");
    expect(warning).toHaveBeenCalledWith("[extensions] owner retirement unavailable", "Error");
    expect(runner.dispose).toHaveBeenCalledWith("reconfigure", 2_000);
    await expect(owner.call(spec, "recall", {}, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("retries a rejected registration on a later invocation after host authorization recovers", async () => {
    let available = false;
    const owner = new ExtensionOwnerRuntime({ call: async <T>(method: string) => {
      if (method.endsWith("registerRuntime") && !available) throw new Error("temporarily unavailable");
      return { text: "recalled" } as T;
    } }, [spec], identity);
    await expect(owner.call(spec, "recall", {}, new AbortController().signal)).rejects.toThrow(/unavailable/);
    available = true;
    await expect(owner.call(spec, "recall", {}, new AbortController().signal)).resolves.toEqual({ text: "recalled" });
  });
});

describe("sidecar normal shutdown", () => {
  it("fences new work immediately, retires all runtimes once and awaits their cleanup", async () => {
    const pending = deferred<void>(); const reasons: string[] = [];
    const runtimes = new Map([["one", { dispose: async (reason?: string) => { reasons.push(reason!); await pending.promise; } }]]);
    const shutdown = new RuntimeShutdown(); const native = vi.fn();
    const first = shutdown.shutdown(runtimes, native);
    expect(shutdown.shutdown(runtimes, native)).toBe(first);
    expect(() => shutdown.assertOpen()).toThrow(/shutting down/);
    await Promise.resolve(); await Promise.resolve();
    expect(reasons).toEqual(["app-quit"]); expect(runtimes.size).toBe(0);
    pending.resolve(); expect(await first).toEqual({ ok: true }); expect(native).toHaveBeenCalledOnce();
  });
  it("a failed native cleanup does not skip desktop runtime retirement", async () => {
    const dispose = vi.fn(async () => {}); const shutdown = new RuntimeShutdown();
    await expect(shutdown.shutdown(new Map([["one", { dispose }]]), () => { throw new Error("native cleanup failed"); }))
      .rejects.toThrow(/Runtime shutdown failed/);
    expect(dispose).toHaveBeenCalledWith("app-quit");
  });
});
