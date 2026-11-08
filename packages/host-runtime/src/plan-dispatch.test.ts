import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceAdmission, type HandoffBusyState } from "@pi-desktop/agent-host";
import type { PlanExecution } from "@pi-desktop/shared";

import type { LaunchResolver } from "./launch-resolver.js";
import { PlanExecutionDispatcher } from "./plan-dispatch.js";
import { RuntimeService, type RuntimeHostLink, type RuntimeSidecarLink } from "./runtime-service.js";

afterEach(() => vi.useRealTimers());
const idle = (): HandoffBusyState => ({
  clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0,
  admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
  approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0,
});
const execution: PlanExecution = {
  id: "execution-1", proposalId: "proposal-1", sessionId: "session-1", kind: "plan",
  title: "Plan", question: "Proceed?", plan: "Run the approved task", state: "queued",
  targetPermissionMode: "ask", artifact: { relativePath: "plan.md", sha256: "0".repeat(64), sizeBytes: 1 },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const gate = new MaintenanceAdmission();
  const calls: string[] = [];
  let record = { ...execution };
  let beforeResolve: () => Promise<void> = async () => {};
  let beforeBegin: () => Promise<void> = async () => {};
  let failFinish = false;
  const host: RuntimeHostLink = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push(method);
      switch (method) {
        case "plans.claimExecution": record = { ...record, state: "running" }; return { execution: record } as T;
        case "plans.queuedExecutions": return { executions: record.state === "queued" ? [record] : [] } as T;
        case "settings.get": return {} as T;
        case "session.get": return { session: { id: execution.sessionId, mode: "agent", permissionMode: "ask" } } as T;
        case "session.beginTurn": await beforeBegin(); return { turnId: "turn-1" } as T;
        case "session.endTurn": return { ok: true } as T;
        case "plans.finishExecution":
          if (failFinish) throw new Error("Host unavailable");
          record = { ...record, state: params.status === "completed" ? "completed" : "interrupted" };
          return { ok: true } as T;
        default: throw new Error(`unexpected RPC: ${method}`);
      }
    },
    isAvailable: () => true,
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  const sidecar: RuntimeSidecarLink = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method !== "agent.executeApprovedPlan") throw new Error(`unexpected sidecar RPC: ${method}`);
      return { accepted: true } as T;
    },
    onNotification: () => () => {}, onExit: () => () => {},
    setProjectInstructionRoot: () => {}, clearProjectInstructionRoot: () => {}, clearVendorAuthBindings: () => {},
  };
  const launch: LaunchResolver = {
    async resolve() {
      await beforeResolve();
      return {
        providerId: "fixture", modelId: "fixture",
        sidecarParams: {
          sessionId: execution.sessionId, mode: "agent",
          provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] },
        },
      };
    },
  };
  const runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, launch, log: () => {} });
  const plans = new PlanExecutionDispatcher({ getHost: () => host, getSidecar: () => sidecar, runtime, launch, gate, log: () => {} });
  return {
    gate, plans, runtime, calls, record: () => record,
    beforeResolve: (callback: () => Promise<void>) => { beforeResolve = callback; },
    beforeBegin: (callback: () => Promise<void>) => { beforeBegin = callback; },
    failFinish: () => { failFinish = true; },
    dispose: async () => { plans.dispose(); gate.dispose(); await runtime.dispose(); },
  };
}

describe("approved plan handoff admission", () => {
  it("counts a dispatcher waiting on the real runtime session lock before idle inspection", async () => {
    const f = fixture();
    const lock = deferred();
    const occupied = f.runtime.withSessionOperation(execution.sessionId, () => lock.promise);
    const dispatch = f.plans.dispatchApprovedPlan(execution);
    const attempt = f.gate.acquireHandoff("transfer", async () => ({ ...idle(), plans: f.plans.inFlightCount() }));
    try {
      await expect(attempt).rejects.toMatchObject({ code: "HOST_BUSY" });
      expect(f.record().state).toBe("queued");
    } finally {
      lock.resolve();
      await occupied;
      await dispatch;
      await f.dispose();
    }
  });

  it("rechecks closed admission inside the session lock before claiming durable work", async () => {
    const f = fixture();
    const lock = deferred();
    const occupied = f.runtime.withSessionOperation(execution.sessionId, () => lock.promise);
    const dispatch = f.plans.dispatchApprovedPlan(execution);
    const hold = await f.gate.acquireHandoff("transfer", async () => idle());
    lock.resolve();
    await occupied;
    await dispatch;
    expect(f.calls).not.toContain("plans.claimExecution");
    expect(f.record().state).toBe("queued");
    expect(f.plans.inFlightCount()).toBe(0);
    hold.cancel();
    await f.plans.drainApprovedPlanExecutions();
    expect(f.record().state).toBe("running");
    expect(f.calls.filter(method => method === "agent.executeApprovedPlan")).toHaveLength(1);
    await f.dispose();
  });

  it("refuses handoff while claimed work resolves launch, then executes that admitted plan once", async () => {
    const f = fixture();
    const entered = deferred();
    const launch = deferred();
    f.beforeResolve(async () => { entered.resolve(); await launch.promise; });
    const dispatch = f.plans.dispatchApprovedPlan(execution);
    await entered.promise;
    await expect(f.gate.acquireHandoff("transfer", async () => ({ ...idle(), plans: f.plans.inFlightCount() })))
      .rejects.toMatchObject({ code: "HOST_BUSY" });
    launch.resolve();
    await dispatch;
    expect(f.calls.filter(method => method === "agent.executeApprovedPlan")).toHaveLength(1);
    expect(f.plans.inFlightCount()).toBeGreaterThan(0);
    await f.plans.finishApprovedExecution(execution.id, "completed");
    expect(f.plans.inFlightCount()).toBe(0);
    await f.dispose();
  });

  it("retains failed finalization in the busy inventory even if launch never started", async () => {
    const f = fixture();
    f.beforeResolve(async () => { throw new Error("launch unavailable"); });
    f.failFinish();
    await f.plans.dispatchApprovedPlan(execution);
    expect(f.calls).not.toContain("agent.executeApprovedPlan");
    expect(f.record().state).toBe("running");
    expect(f.plans.inFlightCount()).toBeGreaterThan(0);
    await f.dispose();
  });

  it("does not claim a queued plan after disposal while its session lock was pending", async () => {
    const f = fixture();
    const lock = deferred();
    const occupied = f.runtime.withSessionOperation(execution.sessionId, () => lock.promise);
    const dispatch = f.plans.dispatchApprovedPlan(execution);
    f.plans.dispose();
    lock.resolve();
    await occupied;
    await dispatch;
    expect(f.calls).not.toContain("plans.claimExecution");
    expect(f.record().state).toBe("queued");
    await f.dispose();
  });
});

describe("approved plan retry ownership", () => {
  it("counts a deferred retry and clears its timer on disposal without claiming work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.runtime.beginTurn(execution.sessionId, "fixture", "fixture");
    await f.plans.dispatchApprovedPlan(execution);
    expect(f.plans.inFlightCount()).toBe(1);
    await expect(f.gate.acquireHandoff("transfer", async () => ({ ...idle(), plans: f.plans.inFlightCount() })))
      .rejects.toMatchObject({ code: "HOST_BUSY" });
    f.plans.dispose();
    expect(f.plans.inFlightCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.calls).not.toContain("plans.claimExecution");
    await f.dispose();
  });

  it("settles a claimed plan instead of launching it when disposed during launch resolution", async () => {
    const f = fixture();
    const entered = deferred();
    const launch = deferred();
    f.beforeResolve(async () => { entered.resolve(); await launch.promise; });
    const dispatch = f.plans.dispatchApprovedPlan(execution);
    await entered.promise;
    f.plans.dispose();
    launch.resolve();
    await dispatch;
    expect(f.calls).not.toContain("agent.executeApprovedPlan");
    expect(f.calls).toContain("plans.finishExecution");
    expect(f.plans.inFlightCount()).toBe(0);
    await f.dispose();
  });
});

it("settles a new turn when disposal races the beginTurn acknowledgement", async () => {
  const f = fixture();
  const entered = deferred();
  const begin = deferred();
  f.beforeBegin(async () => { entered.resolve(); await begin.promise; });
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  await entered.promise;
  f.plans.dispose();
  begin.resolve();
  await dispatch;
  expect(f.calls).not.toContain("agent.executeApprovedPlan");
  expect(f.calls).toContain("session.endTurn");
  expect(f.record().state).toBe("interrupted");
  expect(f.plans.inFlightCount()).toBe(0);
  await f.dispose();
});
