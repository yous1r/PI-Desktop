import { describe, expect, it } from "vitest";

import { AgentHost } from "./agent-host.js";
import type { ApprovalPort } from "./approvals.js";
import type { RuntimePort, SessionPort, SessionSummary } from "./ports.js";
import { HOST_MAINTENANCE_LEASE_MS, MaintenanceAdmission, type MaintenanceBusyState } from "./maintenance-admission.js";

const idle = (): MaintenanceBusyState => ({
  clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0,
});
const owner = { subject: "dev_owner", roles: ["owner" as const], pairedDevice: true };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("maintenance admission", () => {
  it("closes synchronously, grants one 120s lease, and is idempotent for its own lease id", async () => {
    const time = clock();
    const gate = new MaintenanceAdmission(time.now);
    expect(gate.isClosed()).toBe(false);
    const lease = await gate.acquire("lease-a", async () => idle());
    expect(gate.isClosed()).toBe(true);
    expect(Date.parse(lease.expiresAt) - time.now()).toBe(HOST_MAINTENANCE_LEASE_MS);
    expect(HOST_MAINTENANCE_LEASE_MS).toBe(120_000);
    expect(await gate.acquire("lease-a", async () => idle())).toEqual(lease);
    await expect(gate.acquire("lease-b", async () => idle())).rejects.toMatchObject({ code: "HOST_BUSY" });
    gate.release("lease-a");
    expect(gate.isClosed()).toBe(false);
  });

  it("refuses a lease while any owner reports live activity and reopens fully", async () => {
    for (const key of ["clients", "turns", "queuedTurns", "plans", "tools", "processes", "terminals", "plugins"] as const) {
      const gate = new MaintenanceAdmission();
      await expect(gate.acquire("lease", async () => ({ ...idle(), [key]: 1 }))).rejects.toMatchObject({ code: "HOST_BUSY" });
      expect(gate.isClosed()).toBe(false);
    }
  });

  it("expires a lease after its term without a release, and refuses the stale lease id", async () => {
    const time = clock();
    const gate = new MaintenanceAdmission(time.now);
    await gate.acquire("lease-a", async () => idle());
    time.advance(HOST_MAINTENANCE_LEASE_MS - 1);
    expect(gate.isClosed()).toBe(true);
    time.advance(1);
    expect(gate.isClosed()).toBe(false);
    expect(() => gate.release("lease-a")).toThrowError(expect.objectContaining({ code: "HOST_AUTH_FAILED" }));
    const next = await gate.acquire("lease-b", async () => idle());
    expect(next.leaseId).toBe("lease-b");
  });

  it("does not release on a mismatched lease id", async () => {
    const gate = new MaintenanceAdmission();
    await gate.acquire("lease-a", async () => idle());
    expect(() => gate.release("lease-b")).toThrowError(expect.objectContaining({ code: "HOST_AUTH_FAILED" }));
    expect(gate.isClosed()).toBe(true);
  });

  it("serializes concurrent acquires so exactly one caller wins", async () => {
    const gate = new MaintenanceAdmission();
    const results = await Promise.allSettled([
      gate.acquire("lease-a", async () => { await Promise.resolve(); return idle(); }),
      gate.acquire("lease-b", async () => idle()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(gate.isClosed()).toBe(true);
  });

  it("disposal fences an inspection that resolves late and clears a held lease", async () => {
    const gate = new MaintenanceAdmission();
    let resolveInspection!: (value: MaintenanceBusyState) => void;
    const inspection = new Promise<MaintenanceBusyState>(resolve => { resolveInspection = resolve; });
    const pending = gate.acquire("lease", () => inspection);
    gate.dispose();
    resolveInspection(idle());
    await expect(pending).rejects.toMatchObject({ code: "HOST_MAINTENANCE_UNAVAILABLE" });
    expect(gate.isClosed()).toBe(true);
    await expect(gate.acquire("later", async () => idle())).rejects.toMatchObject({ code: "HOST_MAINTENANCE_UNAVAILABLE" });
  });
});

class FakeApprovals implements ApprovalPort {
  async resolveTool(): Promise<void> {}
  async resolveContract(): Promise<void> {}
  async listPendingTools() { return []; }
}

function hostFixture(gate: MaintenanceAdmission | undefined) {
  const prompts: string[] = [];
  const runtime: RuntimePort = {
    async prompt(request) { prompts.push(request.sessionId); return { turnId: `rt_${prompts.length}` }; },
    async stop() { return { requested: true }; },
    async abort() {},
    async respondInput() {},
  };
  const sessions = new Map<string, SessionSummary>([["s1", {
    id: "s1", title: "s1", mode: "agent", permissionMode: "ask",
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
  }]]);
  const port: SessionPort = {
    async get(sessionId) { return sessions.get(sessionId) ?? null; },
    async history() { return { items: [], hasMore: false }; },
  };
  const host = new AgentHost({ runtime, sessions: port, approvals: new FakeApprovals(), ...(gate ? { gate } : {}) });
  return { host, prompts };
}

const turn = (host: AgentHost) => ({ sessionId: "s1", input: { text: "hi" }, context: { requestId: "r1" } }) as never;

describe("agent host maintenance gate", () => {
  it("refuses new turns and queued work once the gate closes", async () => {
    const gate = new MaintenanceAdmission();
    const { host, prompts } = hostFixture(gate);
    await host.start();
    await gate.acquire("lease-a", async () => idle());
    await expect(host.startTurn(owner, turn(host))).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(host.enqueueTurn(owner, turn(host))).rejects.toMatchObject({ code: "HOST_BUSY" });
    expect(prompts).toHaveLength(0);
    expect(host.maintenanceBusyCounts()).toEqual({ turns: 0, queuedTurns: 0, admissions: 0 });
  });

  it("reports a running turn and a waiting queue entry so a lease cannot race a start", async () => {
    const { host } = hostFixture(undefined);
    await host.start();
    await host.enqueueTurn(owner, turn(host));
    expect(host.maintenanceBusyCounts().turns).toBe(1);
    await host.enqueueTurn(owner, turn(host));
    const counts = host.maintenanceBusyCounts();
    expect(counts.turns).toBe(1);
    expect(counts.queuedTurns).toBe(1);
    expect(counts.admissions).toBe(0);
  });

  it("keeps a queued turn from starting while the lease is held, and resumes after release", async () => {
    const gate = new MaintenanceAdmission();
    const { host, prompts } = hostFixture(gate);
    await host.start();
    await host.enqueueTurn(owner, turn(host));
    await host.enqueueTurn(owner, turn(host));
    expect(prompts).toHaveLength(1);
    await gate.acquire("lease-a", async () => idle());
    host.ingest({ sessionId: "s1", turnId: "rt_1", ts: 1, event: { type: "agent_end", messageIds: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(prompts).toHaveLength(1);
    expect(host.maintenanceBusyCounts().queuedTurns).toBe(1);
    gate.release("lease-a");
    host.kick("s1");
    await new Promise((resolve) => setImmediate(resolve));
    expect(prompts).toHaveLength(2);
  });
});
