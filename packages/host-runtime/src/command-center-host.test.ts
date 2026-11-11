import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CommandCenterControl, CommandCenterBinding, Principal } from "@pi-desktop/agent-host";
import {
  createCommandCenterHost,
  type CommandCenterDispatchFactory,
  type CommandCenterDispatchPort,
  type CommandCenterHostPorts,
} from "./command-center-host.js";

/** C4 host composition: explicit ports in, repository -> control -> dispatch out. */

const fixture = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const owner: Principal = { subject: "local:owner", roles: ["owner"] };
const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";

function receiptEntry(receipt: unknown) {
  return {
    receipt,
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceId,
    membershipRevision: 7,
    sequence: 1,
  };
}

function fakeTransport() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    port: {
      async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ method, params: params ?? {} });
        if (method === "commandCenter.workspace.list") return { workspaces: [] } as T;
        throw new Error(`Unexpected transport call: ${method}`);
      },
    },
  };
}

function fakeDispatchFactory() {
  const seen: CommandCenterControl[] = [];
  const disposed: number[] = [];
  const factory: CommandCenterDispatchFactory = (control) => {
    seen.push(control);
    const id = seen.length;
    return {
      methods: [],
      disposed: false,
      async dispatch(operation: string, params: unknown, context: { principal: Principal }) {
        const method = operation.startsWith("commandCenter/") ? operation.slice("commandCenter/".length) : "";
        return control.call(method as never, params, context.principal);
      },
      async dispose() {
        disposed.push(id);
      },
    } satisfies CommandCenterDispatchPort;
  };
  return { factory, seen, disposed };
}

function ports(overrides: Partial<CommandCenterHostPorts> = {}): CommandCenterHostPorts {
  return {
    transport: fakeTransport().port,
    hostIdentity: () => binding,
    authorizer: async () => true,
    mutationsClosed: () => false,
    clock: { now: () => 1_000 },
    createDispatch: fakeDispatchFactory().factory,
    ...overrides,
  };
}

describe("command-center host composition", () => {
  it("fails closed when a required port is missing", () => {
    expect(() => createCommandCenterHost(undefined as never)).toThrow(/ports object/);
    expect(() => createCommandCenterHost(ports({ transport: undefined as never }))).toThrow(/transport/);
    expect(() => createCommandCenterHost(ports({ hostIdentity: undefined as never }))).toThrow(/hostIdentity/);
    expect(() => createCommandCenterHost(ports({ authorizer: undefined as never }))).toThrow(/authorizer/);
    expect(() => createCommandCenterHost(ports({ mutationsClosed: undefined as never }))).toThrow(/mutationsClosed/);
    expect(() => createCommandCenterHost(ports({ clock: undefined as never }))).toThrow(/clock/);
    expect(() => createCommandCenterHost(ports({ createDispatch: undefined as never }))).toThrow(/createDispatch/);
  });

  it("wires RustCommandCenterRepository through CommandCenterControl to the dispatcher", async () => {
    const transport = fakeTransport();
    const dispatch = fakeDispatchFactory();
    const host = createCommandCenterHost(ports({ transport: transport.port, createDispatch: dispatch.factory }));
    const request = { version: 1 as const, hostId: binding.hostId };

    await expect(host.control.call("workspace/list", request, owner)).resolves.toEqual({ workspaces: [] });
    await expect(host.dispatch.dispatch("commandCenter/workspace/list", request, { principal: owner }))
      .resolves.toEqual({ workspaces: [] });

    expect(host.repository).toBeInstanceOf(Object);
    expect(dispatch.seen[0]).toBe(host.control);
    expect(transport.calls.map((call) => call.method)).toEqual([
      "commandCenter.workspace.list",
      "commandCenter.workspace.list",
    ]);
  });

  it("creates connection dispatchers on demand and disposes every one exactly once", async () => {
    const dispatch = fakeDispatchFactory();
    const host = createCommandCenterHost(ports({ createDispatch: dispatch.factory }));
    const extra = host.createDispatch({ onDispose: () => undefined });
    expect(dispatch.seen).toHaveLength(2);
    expect(extra).not.toBe(host.dispatch);
    await host.dispose();
    await host.dispose();
    expect(dispatch.disposed).toEqual([1, 2]);
  });

  it("rejects a dispatch factory result that cannot dispatch or dispose", () => {
    expect(() => createCommandCenterHost(ports({
      createDispatch: (() => ({ methods: [], disposed: false })) as unknown as CommandCenterDispatchFactory,
    }))).toThrow(/invalid dispatch factory result/);
  });

  it("fails closed when dispatch is required and no exact-target consumer was injected", () => {
    expect(() => createCommandCenterHost(ports({ runtimeMode: "required" }))).toThrow(/runtime dispatch consumer/);
    expect(() => createCommandCenterHost(ports({
      runtimeMode: "required",
      runtime: { canRecord: () => true },
    }))).toThrow(/runtime dispatch consumer/);
    expect(() => createCommandCenterHost(ports({
      runtimeMode: "unknown" as never,
    }))).toThrow(/unknown runtime mode/);
    const recordOnly = createCommandCenterHost(ports());
    expect(recordOnly.runtimeMode).toBe("record-only");
  });

  it("routes an injected exact-target dispatch through the composed control service", async () => {
    const request = fixture.request as { requestId: string };
    const recorded = receiptEntry(fixture.receipt);
    const accepted = receiptEntry(fixture.receipts.accepted);
    const stored = new Map<string, unknown>();
    const transport = {
      async call<T = unknown>(method: string): Promise<T> {
        switch (method) {
          case "commandCenter.receipt.get":
            return (stored.get(request.requestId) ?? null) as T;
          case "commandCenter.intervention.record":
            stored.set(request.requestId, recorded);
            return { entry: recorded, replayed: false } as T;
          case "commandCenter.intervention.ack":
            stored.set(request.requestId, accepted);
            return { entry: accepted, replayed: false } as T;
          default:
            throw new Error(`Unexpected transport call: ${method}`);
        }
      },
    };
    const dispatch = vi.fn(async () => ({ status: "accepted" as const }));
    const host = createCommandCenterHost(ports({
      transport,
      runtimeMode: "required",
      runtime: { canRecord: () => true, dispatch },
    }));
    const result = await host.control.call("intervention/record", fixture.request as never, owner);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.receipt.status).toBe("accepted");
    expect(result.replayed).toBe(false);
  });
});
