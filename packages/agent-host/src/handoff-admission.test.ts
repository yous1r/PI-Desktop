import { afterEach, describe, expect, it, vi } from "vitest";

import { MaintenanceAdmission, HOST_MAINTENANCE_LEASE_MS, type HandoffBusyState } from "./maintenance-admission.js";

const idle = (): HandoffBusyState => ({
  clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0,
  admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
  approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("handoff admission", () => {
  it("holds admission beyond maintenance expiry until an explicit source cancellation", async () => {
    vi.useFakeTimers();
    const gate = new MaintenanceAdmission();
    const hold = await gate.acquireHandoff("transfer-a", async () => idle());
    expect(gate.isClosed()).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * HOST_MAINTENANCE_LEASE_MS);
    expect(gate.isClosed()).toBe(true);
    expect(await gate.acquireHandoff("transfer-a", async () => { throw new Error("must not reinspect"); })).toBe(hold);
    expect(() => gate.release("transfer-a")).toThrowError(expect.objectContaining({ code: "HOST_AUTH_FAILED" }));
    await expect(gate.acquire("lease", async () => idle())).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(gate.acquireHandoff("transfer-b", async () => idle())).rejects.toMatchObject({ code: "HOST_BUSY" });
    hold.cancel();
    expect(gate.isClosed()).toBe(false);
  });

  it("closes before async inventory and refuses competing maintenance or transfer", async () => {
    const gate = new MaintenanceAdmission();
    const inspection = deferred<HandoffBusyState>();
    const pending = gate.acquireHandoff("transfer", () => inspection.promise);
    expect(gate.isClosed()).toBe(true);
    await expect(gate.acquireHandoff("transfer", async () => idle())).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(gate.acquire("lease", async () => idle())).rejects.toMatchObject({ code: "HOST_BUSY" });
    inspection.resolve(idle());
    (await pending).cancel();
    expect(gate.isClosed()).toBe(false);
  });

  it("cannot be released once native fencing begins, even after a long disconnect", async () => {
    vi.useFakeTimers();
    const gate = new MaintenanceAdmission();
    const hold = await gate.acquireHandoff("transfer", async () => idle());
    hold.beginFencing();
    hold.beginFencing();
    expect(() => hold.cancel()).toThrowError(expect.objectContaining({ code: "HOST_BUSY" }));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(gate.isClosed()).toBe(true);
    expect(() => gate.release("transfer")).toThrowError(expect.objectContaining({ code: "HOST_AUTH_FAILED" }));
    gate.dispose();
    expect(gate.isClosed()).toBe(true);
    expect(() => hold.cancel()).toThrowError(expect.objectContaining({ code: "HOST_MAINTENANCE_UNAVAILABLE" }));
  });

  it("keeps stale cancellation handles from reopening a later transfer with the same id", async () => {
    const gate = new MaintenanceAdmission();
    const first = await gate.acquireHandoff("transfer", async () => idle());
    first.cancel();
    const second = await gate.acquireHandoff("transfer", async () => idle());
    expect(() => first.cancel()).toThrowError(expect.objectContaining({ code: "HOST_AUTH_FAILED" }));
    expect(() => first.beginFencing()).toThrowError(expect.objectContaining({ code: "HOST_AUTH_FAILED" }));
    expect(gate.isClosed()).toBe(true);
    second.cancel();
  });

  it("refuses busy owners and restores admission before a hold is granted", async () => {
    for (const key of Object.keys(idle()) as (keyof HandoffBusyState)[]) {
      const gate = new MaintenanceAdmission();
      await expect(gate.acquireHandoff("transfer", async () => ({ ...idle(), [key]: 1 }))).rejects.toMatchObject({ code: "HOST_BUSY" });
      expect(gate.isClosed()).toBe(false);
    }
  });

  it("does not treat incomplete, negative or non-finite inventory as idle", async () => {
    for (const key of Object.keys(idle()) as (keyof HandoffBusyState)[]) {
      for (const value of [undefined, -1, Number.NaN, Infinity, 0.5]) {
        const gate = new MaintenanceAdmission();
        const invalid = { ...idle(), [key]: value } as HandoffBusyState;
        await expect(gate.acquireHandoff("transfer", async () => invalid)).rejects.toMatchObject({ code: "HOST_MAINTENANCE_UNAVAILABLE" });
        expect(gate.isClosed()).toBe(false);
      }
    }
  });

  it("preserves ordinary maintenance expiry and does not let its old timer release a handoff", async () => {
    vi.useFakeTimers();
    const gate = new MaintenanceAdmission();
    await gate.acquire("lease", async () => idle());
    await expect(gate.acquireHandoff("transfer", async () => idle())).rejects.toMatchObject({ code: "HOST_BUSY" });
    await vi.advanceTimersByTimeAsync(HOST_MAINTENANCE_LEASE_MS);
    expect(gate.isClosed()).toBe(false);
    await gate.acquireHandoff("transfer", async () => idle());
    await vi.advanceTimersByTimeAsync(2 * HOST_MAINTENANCE_LEASE_MS);
    expect(gate.isClosed()).toBe(true);
  });

  it("does not grant or reopen after disposal during inspection", async () => {
    const gate = new MaintenanceAdmission();
    const inspection = deferred<HandoffBusyState>();
    const pending = gate.acquireHandoff("transfer", () => inspection.promise);
    gate.dispose();
    inspection.resolve(idle());
    await expect(pending).rejects.toMatchObject({ code: "HOST_MAINTENANCE_UNAVAILABLE" });
    expect(gate.isClosed()).toBe(true);
    await expect(gate.acquireHandoff("next", async () => idle())).rejects.toMatchObject({ code: "HOST_MAINTENANCE_UNAVAILABLE" });
  });

  it("preserves an inspection error without leaving a granted hold", async () => {
    const gate = new MaintenanceAdmission();
    const unavailable = new Error("owner disconnected");
    await expect(gate.acquireHandoff("transfer", async () => { throw unavailable; })).rejects.toBe(unavailable);
    expect(gate.isClosed()).toBe(false);
    (await gate.acquireHandoff("next", async () => idle())).cancel();
  });
});
