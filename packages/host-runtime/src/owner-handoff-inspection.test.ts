import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectOwnerHandoff, type OwnerInspectionBinding } from "./owner-handoff-inspection.js";

const epoch = "22222222-2222-4222-8222-222222222222";
const generation = "33333333-3333-4333-8333-333333333333";
function report(request: unknown) {
  return { ...(request as object), activity: { requests: 0, backgroundTasks: 0, writes: 0, uncertain: false },
    durable: { turns: false, queuedTurns: false, plans: false, approvals: false, scheduledRuns: false, modeClaims: false, modeWaits: false, worktrees: false },
    runtime: { tools: false, backgroundProcesses: false, remoteExecutions: false, pluginExecutions: false, permissions: false, configSync: false },
    nativeCoverage: "execution_generation_only", native: { generation, state: "running", activeProcesses: 1, rootExited: false, confirmed: false } };
}
function fixture() {
  const pending = Promise.withResolvers<unknown>();
  let request: unknown;
  const call = vi.fn(async <T>(_method: string, params: unknown, _timeout?: number): Promise<T> => {
    request = params;
    return await pending.promise as T;
  });
  let hostGeneration = "host-original";
  let available = true;
  const host = { call, get generation() { return hostGeneration; }, isAvailable: () => available };
  let binding: OwnerInspectionBinding | null = { sourceEpoch: epoch, profileId: "a".repeat(64), generation, host };
  return { current: () => binding, call, host, pending, reply: () => report(request),
    replace: () => { binding = binding && { ...binding, host: { ...host } }; },
    remove: () => { binding = null; },
    changeIdentity: (key: "sourceEpoch" | "profileId" | "generation") => { if (binding) binding[key] = "changed"; },
    changeHostGeneration: () => { hostGeneration = "host-replacement"; },
    exit: () => { available = false; } };
}
afterEach(() => vi.useRealTimers());

describe("original Rust owner inspection", () => {
  it("uses bounded original stdio and retains the incomplete native coverage marker", async () => {
    const f = fixture();
    const result = inspectOwnerHandoff(f.current);
    expect(f.call.mock.calls[0]?.[0]).toBe("ownerHandoff.inspect");
    expect(f.call.mock.calls[0]?.[2]).toBe(2000);
    f.pending.resolve(f.reply());
    expect((await result).nativeCoverage).toBe("execution_generation_only");
  });
  it.each(["replace", "remove", "changeHostGeneration", "exit"] as const)("rejects stale success after %s", async action => {
    const f = fixture();
    const result = inspectOwnerHandoff(f.current);
    f[action]();
    f.pending.resolve(f.reply());
    await expect(result).rejects.toThrow("HANDOFF_OWNER_CHANGED");
  });
  it.each(["sourceEpoch", "profileId", "generation"] as const)("captures %s before await", async key => {
    const f = fixture();
    const result = inspectOwnerHandoff(f.current);
    f.changeIdentity(key);
    f.pending.resolve(f.reply());
    await expect(result).rejects.toThrow("HANDOFF_OWNER_CHANGED");
  });
  it("also checks original ownership when the original request rejects", async () => {
    const f = fixture();
    const result = inspectOwnerHandoff(f.current);
    f.replace();
    f.pending.reject(new Error("old owner failed"));
    await expect(result).rejects.toThrow("HANDOFF_OWNER_CHANGED");
  });
  it("preserves a current owner's refusal and rejects malformed responses", async () => {
    const f = fixture();
    const result = inspectOwnerHandoff(f.current);
    f.pending.reject(new Error("HANDOFF_UNAVAILABLE"));
    await expect(result).rejects.toThrow("HANDOFF_UNAVAILABLE");
    const invalid = fixture();
    const malformed = inspectOwnerHandoff(invalid.current);
    invalid.pending.resolve({});
    await expect(malformed).rejects.toThrow("HANDOFF_INVALID_INSPECTION");
  });
  it("bounds overload retries and observes a rejected late response", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = inspectOwnerHandoff(f.current);
    const rejected = expect(result).rejects.toThrow("HANDOFF_INSPECTION_TIMEOUT");
    await vi.advanceTimersByTimeAsync(2500);
    await rejected;
    f.pending.reject(new Error("late original result"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses missing or unavailable owners before requesting status", async () => {
    await expect(inspectOwnerHandoff(() => null)).rejects.toThrow("HANDOFF_OWNER_UNAVAILABLE");
    const f = fixture();
    f.exit();
    await expect(inspectOwnerHandoff(f.current)).rejects.toThrow("HANDOFF_OWNER_CHANGED");
    expect(f.call).not.toHaveBeenCalled();
  });
});
