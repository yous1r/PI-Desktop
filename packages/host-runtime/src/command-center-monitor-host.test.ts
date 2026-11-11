import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HostRpcPort } from "@pi-desktop/agent-host";
import { createCommandCenterMonitorProvider, type CommandCenterMonitorProviderPorts } from "./command-center-monitor.js";

const fixture = JSON.parse(await readFile(
  new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8",
));
const control = JSON.parse(await readFile(
  new URL("../../../packages/shared/test/fixtures/command-center-control.json", import.meta.url), "utf8",
));

const WORKSPACES = fixture.workspaces.workspaces;
const ROWS = fixture.snapshot.rows;
const HOST_ID = "host-monitor-rpc-1";
const HOST_EPOCH = "33333333-3333-4333-8333-333333333333";

type Handler = (params: Record<string, unknown>) => unknown;

class FakeHostRpcPort implements HostRpcPort {
  readonly calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  readonly handlers = new Map<string, Handler>();

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`NO_FAKE_HOST_METHOD:${method}`);
    return handler(params ?? {}) as T;
  }
}

function receiptEntry(receipt: unknown, sequence: number, hostId = HOST_ID, hostEpoch = HOST_EPOCH) {
  return {
    receipt,
    hostId,
    hostEpoch,
    commandWorkspaceId: WORKSPACES[0].id,
    membershipRevision: 1,
    sequence,
  };
}

function healthyTransport(): FakeHostRpcPort {
  const transport = new FakeHostRpcPort();
  transport.on("commandCenter.workspace.list", () => ({ workspaces: structuredClone(WORKSPACES) }));
  transport.on("commandCenter.receipt.list", (params) => {
    const input = params.input as Record<string, unknown> | undefined;
    if (input?.afterSequence === 0) {
      return {
        entries: [
          receiptEntry(control.receipts.accepted, 1),
          receiptEntry(control.receipts.completed, 2),
        ],
        nextAfterSequence: 2,
      };
    }
    return { entries: [receiptEntry(control.receipts.conflicted, 3)], nextAfterSequence: null };
  });
  return transport;
}

function ports(overrides: Partial<CommandCenterMonitorProviderPorts> = {}): CommandCenterMonitorProviderPorts {
  const base: CommandCenterMonitorProviderPorts = {
    transport: healthyTransport(),
    hostIdentity: () => ({ hostId: HOST_ID, hostEpoch: HOST_EPOCH }),
    authorization: () => ({ subject: "owner", roles: ["owner"], sessionIds: [], workspaceIds: [] }),
    source: { cut: async () => ({ sequence: 42, rows: ROWS }) },
    scopeKey: "lease:principal-1/filter:all",
    clock: { now: () => Date.parse("2026-01-01T00:00:00Z") },
    tokens: (() => {
      let token = 0;
      return { next: () => `provider-token-${++token}` };
    })(),
    snapshotLimits: { pageRows: 1 },
    ...overrides,
  };
  return base;
}

describe("createCommandCenterMonitorProvider", () => {
  it("publishes a bounded cut over the real repository adapter and pages the snapshot", async () => {
    const transport = healthyTransport();
    const provider = createCommandCenterMonitorProvider(ports({ transport }));
    const result = await provider.refresh();
    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(result.state.health.status).toBe("connected");
    expect(result.state.snapshot?.rows).toHaveLength(1);
    expect(result.state.snapshot?.nextPage).toBeTruthy();
    expect(result.state.workspaces).toHaveLength(4);
    expect(result.state.receipts).toHaveLength(3);
    expect(result.state.sequence).toBe(42);

    const methods = new Set(transport.calls.map((call) => call.method));
    expect(methods).toEqual(new Set(["commandCenter.workspace.list", "commandCenter.receipt.list"]));
    const first = transport.calls[0].params;
    expect(first?.binding).toEqual({ hostId: HOST_ID, hostEpoch: HOST_EPOCH });
    expect(first?.auth).toMatchObject({ subject: "owner", roles: ["owner"] });
    expect(first?.input).toEqual({ version: 1, hostId: HOST_ID });

    const second = provider.page({
      scopeKey: "lease:principal-1/filter:all",
      epoch: HOST_EPOCH,
      token: result.state.snapshot.nextPage!,
    });
    expect(second.status).toBe("page");
    if (second.status !== "page") return;
    expect(second.snapshot.cursor.sequence).toBe(42);
    provider.dispose();
  });

  it("stays explicitly offline when the port is unavailable and recovers on the next refresh", async () => {
    const transport = healthyTransport();
    transport.on("commandCenter.workspace.list", () => { throw new Error("HOST_UNAVAILABLE"); });
    const provider = createCommandCenterMonitorProvider(ports({ transport }));

    const unavailable = await provider.refresh();
    expect(unavailable).toEqual({ kind: "refused", reason: "repository" });
    const offline = provider.getState();
    expect(offline.health.status).toBe("offline");
    expect(offline.health.failure).toBe("repository");
    expect(offline.snapshot).toBeNull();
    expect(offline.rows).toBe(0);
    expect(offline.workspaces).toEqual([]);
    expect(offline.receipts).toEqual([]);

    transport.on("commandCenter.workspace.list", () => ({ workspaces: structuredClone(WORKSPACES) }));
    const recovered = await provider.refresh();
    expect(recovered.kind).toBe("published");
    expect(provider.getState().health.status).toBe("connected");
    provider.dispose();
  });

  it("refuses a binding change across the cut and discards the old page generation", async () => {
    const transport = healthyTransport();
    const value = ports({ transport });
    let identity = { hostId: HOST_ID, hostEpoch: HOST_EPOCH };
    value.hostIdentity = () => ({ ...identity });
    value.source = {
      cut: async () => {
        // The trusted owner is replaced while the authorized cut is in flight.
        identity = { hostId: "host-monitor-rpc-2", hostEpoch: "44444444-4444-4444-8444-444444444444" };
        return { sequence: 1, rows: ROWS.slice(0, 1) };
      },
    };
    const provider = createCommandCenterMonitorProvider(value);
    const result = await provider.refresh();
    expect(result).toEqual({ kind: "refused", reason: "owner_changed" });
    const state = provider.getState();
    expect(state.health.status).toBe("offline");
    expect(state.health.failure).toBe("owner_changed");
    expect(state.snapshot).toBeNull();
    expect(state.epoch).toBe("44444444-4444-4444-8444-444444444444");
    provider.dispose();
  });

  it("bounds source rows before any publication", async () => {
    const provider = createCommandCenterMonitorProvider(ports({ maxRows: 2 }));
    const result = await provider.refresh();
    expect(result).toEqual({ kind: "refused", reason: "row_limit" });
    expect(provider.getState().rows).toBe(0);
    expect(provider.getState().snapshot).toBeNull();
    provider.dispose();
  });

  it("fails closed after disposal", async () => {
    const provider = createCommandCenterMonitorProvider(ports());
    expect((await provider.refresh()).kind).toBe("published");
    provider.dispose();
    expect(await provider.refresh()).toEqual({ kind: "failed", reason: "disposed" });
    expect(provider.page({ scopeKey: "lease:principal-1/filter:all", epoch: HOST_EPOCH, token: "a".repeat(64) }))
      .toEqual({ status: "resync", reason: "disposed" });
  });

  it("validates required ports before creating a provider", () => {
    expect(() => createCommandCenterMonitorProvider(undefined as never)).toThrow(/PORTS/);
    expect(() => createCommandCenterMonitorProvider(ports({ transport: undefined as never }))).toThrow(/TRANSPORT/);
    expect(() => createCommandCenterMonitorProvider(ports({ hostIdentity: undefined as never }))).toThrow(/HOST_IDENTITY/);
    expect(() => createCommandCenterMonitorProvider(ports({ authorization: undefined as never }))).toThrow(/AUTHORIZATION/);
    expect(() => createCommandCenterMonitorProvider(ports({ source: undefined as never }))).toThrow(/SOURCE/);
    expect(() => createCommandCenterMonitorProvider(ports({ scopeKey: "" }))).toThrow(/SCOPE/);
  });
});
