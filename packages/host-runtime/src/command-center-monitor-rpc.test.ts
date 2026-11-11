import { describe, expect, it } from "vitest";
import type { CommandCenterAccess, HostRpcPort, Principal } from "@pi-desktop/agent-host";
import {
  COMMAND_CENTER_MONITOR_PAGE_BYTES,
  COMMAND_CENTER_MONITOR_PAGE_ROWS,
  createCommandCenterMonitorRpcPort,
  type CommandCenterMonitorRpcPageRequest,
  type CommandCenterMonitorRpcPortOptions,
} from "./command-center-monitor-rpc.js";

const HOST_ID = "host_monitor_rpc_1";
const HOST_EPOCH = "77777777-7777-4777-8777-777777777777";
const EPOCH_2 = "88888888-8888-4888-8888-888888888888";
const WORKSPACE_A = "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50";
const WORKSPACE_B = "2b3c4d5e-6f70-4b81-9ca2-1d2e3f4a5b61";
const NOW = Date.parse("2026-01-01T00:00:00Z");

function row(id: string, workspaceId: string, sessionId: string, label = `Task ${id}`) {
  return {
    target: { kind: "session" as const, sessionId },
    execution: { kind: "session" as const, sessionId, turnId: `turn-${id}` },
    commandWorkspaceId: workspaceId,
    label,
    status: "running" as const,
    activity: "Working",
    desiredGoalRevision: 2,
    effectiveGoalRevision: 1,
    pendingApprovals: 0,
    pendingInputs: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function cut(rows: unknown[], sequence = 12, epoch = "rust-epoch-1") {
  return { version: 1, cursor: { epoch, sequence }, generatedAt: "2026-01-01T00:00:00.000Z", rows };
}

class FakeTransport implements HostRpcPort {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  response: unknown = cut([]);
  failure?: Error;
  afterCall?: () => void;

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params: params ?? {} });
    this.afterCall?.();
    if (this.failure !== undefined) throw this.failure;
    return structuredClone(this.response) as T;
  }
}

function setup(overrides: Partial<CommandCenterMonitorRpcPortOptions> = {}) {
  const transport = new FakeTransport();
  let now = NOW;
  let identity = { hostId: HOST_ID, hostEpoch: HOST_EPOCH };
  const accessCalls: { principal: Principal; access: CommandCenterAccess }[] = [];
  let allow: (principal: Principal, access: CommandCenterAccess) => boolean = () => true;
  const port = createCommandCenterMonitorRpcPort({
    transport,
    hostIdentity: () => ({ ...identity }),
    authorize: async (principal, access) => {
      accessCalls.push({ principal, access });
      return allow(principal, access);
    },
    clock: { now: () => now },
    tokens: (() => {
      let token = 0;
      return { next: () => `monitor-token-${++token}` };
    })(),
    ...overrides,
  });
  return {
    transport,
    port,
    accessCalls,
    allow(value: (principal: Principal, access: CommandCenterAccess) => boolean) {
      allow = value;
    },
    setNow(value: number) {
      now = value;
    },
    setIdentity(value: { hostId: string; hostEpoch: string }) {
      identity = value;
    },
  };
}

const viewer: Principal = { subject: "viewer:1", roles: ["viewer"], connectionId: "conn_1" };
const request = (token?: string): CommandCenterMonitorRpcPageRequest =>
  ({ version: 1, hostId: HOST_ID, ...(token === undefined ? {} : { token }) });

describe("createCommandCenterMonitorRpcPort", () => {
  it("reads the private Rust cut once and filters rows by workspace and session read access", async () => {
    const harness = setup();
    const rows = [
      row("a1", WORKSPACE_A, "sess-a1"),
      row("a2", WORKSPACE_A, "sess-a2"),
      row("b1", WORKSPACE_B, "sess-b1"),
    ];
    harness.transport.response = cut(rows);
    harness.allow((_principal, access) =>
      access.id !== WORKSPACE_B && access.id !== "sess-a2");

    await expect(harness.port.page(request(), {
      principal: { subject: "viewer:1", roles: ["viewer"] },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const page = await harness.port.page(request(), { principal: viewer });
    expect(page.rows.map((entry) => entry.label)).toEqual(["Task a1"]);
    expect(page.version).toBe(1);
    expect(page.cursor).toEqual({ epoch: "rust-epoch-1", sequence: 12 });

    expect(harness.transport.calls).toHaveLength(1);
    expect(harness.transport.calls[0].method).toBe("commandCenter.monitor.cut");
    expect(harness.transport.calls[0].params).toMatchObject({
      binding: { hostId: HOST_ID, hostEpoch: HOST_EPOCH },
      auth: { subject: "viewer:1", roles: ["viewer"], sessionIds: [], workspaceIds: [] },
      input: { version: 1, hostId: HOST_ID },
    });
    // Only workspace/session read checks; no transcript or history call exists.
    expect(new Set(harness.accessCalls.map((call) => `${call.access.kind}:${call.access.permission}`))).toEqual(
      new Set(["workspace:read", "session:read"]),
    );
    harness.port.dispose();
  });

  it("serves bounded continuation pages and binds the token to principal, connection and roles", async () => {
    const harness = setup({ pageRows: 1 });
    harness.transport.response = cut([
      row("a1", WORKSPACE_A, "sess-a1"), row("a2", WORKSPACE_A, "sess-a2"), row("a3", WORKSPACE_A, "sess-a3"),
    ]);
    const first = await harness.port.page(request(), { principal: viewer });
    expect(first.rows).toHaveLength(1);
    expect(first.nextPage).toBeDefined();
    const token = first.nextPage!;

    const second = await harness.port.page(request(token), { principal: viewer });
    expect(second.rows).toHaveLength(1);
    expect(second.cursor).toEqual(first.cursor);
    const liveToken = second.nextPage!;

    for (const foreign of [
      { ...viewer, subject: "viewer:2" },
      { ...viewer, connectionId: "conn_2" },
      { ...viewer, roles: ["viewer", "controller"] },
    ]) {
      await expect(harness.port.page(request(liveToken), { principal: foreign }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    harness.port.dispose();
  });

  it("rejects the previous page when the Host epoch changes or access is revoked", async () => {
    const harness = setup({ pageRows: 1 });
    harness.transport.response = cut([row("a1", WORKSPACE_A, "sess-a1"), row("a2", WORKSPACE_A, "sess-a2")]);
    const first = await harness.port.page(request(), { principal: viewer });
    const token = first.nextPage!;

    harness.setIdentity({ hostId: HOST_ID, hostEpoch: EPOCH_2 });
    await expect(harness.port.page(request(token), { principal: viewer })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.port.page(request(token), { principal: viewer })).rejects.toMatchObject({ code: "NOT_FOUND" });

    harness.setIdentity({ hostId: HOST_ID, hostEpoch: HOST_EPOCH });
    harness.transport.response = cut([row("a1", WORKSPACE_A, "sess-a1"), row("a2", WORKSPACE_A, "sess-a2")]);
    const live = await harness.port.page(request(), { principal: viewer });
    const liveToken = live.nextPage!;
    harness.allow((_principal, access) => access.id !== "sess-a2");
    await expect(harness.port.page(request(liveToken), { principal: viewer })).rejects.toMatchObject({ code: "FORBIDDEN" });
    harness.port.dispose();
  });

  it("expires pages without extending their lifetime", async () => {
    const harness = setup({ pageRows: 1, pageTtlMs: 5 });
    harness.transport.response = cut([row("a1", WORKSPACE_A, "sess-a1"), row("a2", WORKSPACE_A, "sess-a2")]);
    const first = await harness.port.page(request(), { principal: viewer });
    const token = first.nextPage!;
    harness.setNow(NOW + 5);
    await expect(harness.port.page(request(token), { principal: viewer })).rejects.toMatchObject({ code: "NOT_FOUND" });
    harness.port.dispose();
  });

  it("fails closed on malformed cuts, oversized rows and private RPC errors", async () => {
    const malformed = setup();
    malformed.transport.response = { version: 2, rows: [] };
    await expect(malformed.port.page(request(), { principal: viewer })).rejects.toMatchObject({ code: "INTERNAL" });

    const tooMany = setup();
    tooMany.transport.response = cut(Array.from({ length: 101 }, (_, index) => row(`r${index}`, WORKSPACE_A, `s${index}`)));
    await expect(tooMany.port.page(request(), { principal: viewer })).rejects.toMatchObject({ code: "INTERNAL" });

    const rpcFailure = setup();
    rpcFailure.transport.failure = new Error("host-core unavailable");
    await expect(rpcFailure.port.page(request(), { principal: viewer })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });

    const ownerChange = setup();
    ownerChange.transport.response = cut([row("a1", WORKSPACE_A, "sess-a1")]);
    ownerChange.transport.afterCall = () => ownerChange.setIdentity({ hostId: HOST_ID, hostEpoch: EPOCH_2 });
    await expect(ownerChange.port.page(request(), { principal: viewer })).rejects.toMatchObject({ code: "CONFLICT" });
    for (const harness of [malformed, tooMany, rpcFailure, ownerChange]) harness.port.dispose();
  });

  it("keeps each page within the 100-row/64 KiB budget", async () => {
    const harness = setup();
    const rows = Array.from({ length: COMMAND_CENTER_MONITOR_PAGE_ROWS }, (_, index) =>
      row(
        `r${index}`, WORKSPACE_A, `s${index}`,
        `Task ${"x".repeat(240)}`,
      ));
    harness.transport.response = cut(rows);
    const page = await harness.port.page(request(), { principal: viewer });
    expect(page.rows.length).toBeLessThanOrEqual(COMMAND_CENTER_MONITOR_PAGE_ROWS);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(COMMAND_CENTER_MONITOR_PAGE_BYTES);
    harness.port.dispose();
  });

  it("bounds cached cuts and clears everything on dispose", async () => {
    const harness = setup({ maxEntries: 1, pageRows: 1 });
    harness.transport.response = cut([row("a1", WORKSPACE_A, "sess-a1"), row("a2", WORKSPACE_A, "sess-a2")], 12);
    const first = await harness.port.page(request(), { principal: viewer });
    const firstToken = first.nextPage!;
    harness.transport.response = cut([row("b1", WORKSPACE_A, "sess-b1"), row("b2", WORKSPACE_A, "sess-b2")], 13);
    const second = await harness.port.page(request(), { principal: viewer });
    const secondToken = second.nextPage!;
    // The maximum one cached cut evicts the oldest generation and its token.
    await expect(harness.port.page(request(firstToken), { principal: viewer })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(harness.port.page(request(secondToken), { principal: viewer })).resolves.toMatchObject({ cursor: { sequence: 13 } });
    harness.port.dispose();
    await expect(harness.port.page(request(), { principal: viewer })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    await expect(harness.port.page(request(secondToken), { principal: viewer })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});
