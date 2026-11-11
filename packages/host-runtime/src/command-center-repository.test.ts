import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  CommandCenterBinding,
  CommandCenterRepositoryContext,
  HostRpcPort,
} from "@pi-desktop/agent-host";
import type { CommandCenterInterventionRequest } from "@pi-desktop/shared";
import { RustCommandCenterRepository } from "./command-center-repository.js";

/** C3 private Rust transport adapter: payload shape, no retry, owner fencing. */

const fixture = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
const context: CommandCenterRepositoryContext = {
  binding,
  auth: { subject: "local:owner", roles: ["owner"], sessionIds: ["sess-parent-1"], workspaceIds: [workspaceId] },
};
const request = fixture.request as CommandCenterInterventionRequest;

function transport(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const port: HostRpcPort = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params: params as Record<string, unknown> });
      return handler(method, params as Record<string, unknown>) as T;
    },
  };
  return { port, calls };
}

function receiptEntry(overrides: Record<string, unknown> = {}) {
  return {
    receipt: fixture.receipt,
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceId,
    membershipRevision: request.expectedMembershipRevision,
    sequence: 1,
    ...overrides,
  };
}

describe("Rust command-center repository adapter", () => {
  it("sends binding, copied auth and input over one private stdio call", async () => {
    const { port, calls } = transport(() => ({ workspaces: [] }));
    const repository = new RustCommandCenterRepository(port, () => binding);
    const input = { version: 1 as const, hostId: binding.hostId };
    const page = context.auth.sessionIds;
    const result = await repository.call("workspace/list", input, context);
    expect(result).toEqual({ workspaces: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("commandCenter.workspace.list");
    const params = calls[0].params;
    expect(params.binding).toEqual(binding);
    expect(params.auth).toEqual(context.auth);
    expect(params.auth).not.toBe(context.auth);
    expect((params.auth as { sessionIds: string[] }).sessionIds).not.toBe(page);
    expect(params.input).toEqual(input);
  });

  it("maps CC_ error families to bounded Racp errors without leaking diagnostics", async () => {
    const { port } = transport(() => {
      throw new Error("CC_QUOTA_EXCEEDED: at most 3 enabled command workspaces; SELECT * FROM cc_workspaces");
    });
    const repository = new RustCommandCenterRepository(port, () => binding);
    await expect(
      repository.call("workspace/create", { version: 1, hostId: binding.hostId, expectedHostEpoch: binding.hostEpoch, commandWorkspaceId: workspaceId, name: "Work", enabled: true }, context),
    ).rejects.toMatchObject({
      code: "RESOURCE_EXHAUSTED",
      retriable: false,
      message: "command-center repository refused the operation",
    });

    const conflict = transport(() => {
      throw new Error("CC_TRANSITION_CONFLICT: receipt 1 is at revision 2");
    });
    await expect(
      new RustCommandCenterRepository(conflict.port, () => binding).call("workspace/delete", {
        version: 1, hostId: binding.hostId, expectedHostEpoch: binding.hostEpoch,
        commandWorkspaceId: workspaceId, expectedRevision: 1,
      }, context),
    ).rejects.toMatchObject({ code: "CONFLICT", retriable: false });
  });

  it("propagates an unrelated transport failure unchanged and never retries", async () => {
    const failure = new Error("socket closed");
    const { port, calls } = transport(() => {
      throw failure;
    });
    const repository = new RustCommandCenterRepository(port, () => binding);
    await expect(
      repository.call("membership/get", { version: 1, hostId: binding.hostId, sessionId: "sess-parent-1" }, context),
    ).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it("conflicts before I/O when the owner already moved", async () => {
    const { port, calls } = transport(() => ({ workspaces: [] }));
    const repository = new RustCommandCenterRepository(port, () => ({
      ...binding,
      hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28",
    }));
    await expect(
      repository.call("workspace/list", { version: 1, hostId: binding.hostId }, context),
    ).rejects.toMatchObject({ code: "CONFLICT", retriable: false });
    expect(calls).toHaveLength(0);
  });

  it("detects an owner change across the transport await and does not reuse the response", async () => {
    let epoch = binding.hostEpoch;
    const { port } = transport(() => {
      epoch = "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28";
      return { workspaces: [] };
    });
    const repository = new RustCommandCenterRepository(port, () => ({ ...binding, hostEpoch: epoch }));
    await expect(
      repository.call("workspace/list", { version: 1, hostId: binding.hostId }, context),
    ).rejects.toMatchObject({ code: "CONFLICT", retriable: false });
  });

  it("rejects malformed responses instead of reporting success", async () => {
    const { port } = transport(() => ({ workspaces: [{ id: "not-a-uuid", name: "", enabled: true, revision: 0 }] }));
    const repository = new RustCommandCenterRepository(port, () => binding);
    await expect(
      repository.call("workspace/list", { version: 1, hostId: binding.hostId }, context),
    ).rejects.toMatchObject({ code: "INTERNAL", retriable: false });
  });

  it("binds an intervention receipt to the exact request, host and membership revision", async () => {
    const record = transport(() => ({ entry: receiptEntry(), replayed: false }));
    const repository = new RustCommandCenterRepository(record.port, () => binding);
    await expect(repository.call("intervention/record", request, context)).resolves.toEqual({
      entry: receiptEntry(),
      replayed: false,
    });

    const unrelated = transport(() => ({ entry: receiptEntry(), replayed: false }));
    const other = new RustCommandCenterRepository(unrelated.port, () => binding);
    const intent = request.intent as { kind: "reviseGoal"; objective: string; constraints: string[] };
    const changed = {
      ...request,
      intent: { ...intent, objective: "A different objective entirely." },
    } as CommandCenterInterventionRequest;
    await expect(other.call("intervention/record", changed, context)).rejects.toMatchObject({
      code: "INTERNAL",
      retriable: false,
    });
  });
});
