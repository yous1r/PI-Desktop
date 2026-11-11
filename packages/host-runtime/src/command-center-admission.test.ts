import { describe, expect, it } from "vitest";
import type {
  CommandCenterAdmissionAuth,
  CommandCenterBinding,
  CommandCenterExecutionTarget,
  HostRpcPort,
} from "@pi-desktop/agent-host";
import { commandCenterExecutionKey } from "@pi-desktop/shared";
import { COMMAND_CENTER_RESERVATION_METHODS, createRustCommandCenterAdmissionPort } from "./command-center-admission.js";

const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
const sessionId = "sess-main-1";
const turnId = "turn-main-4";
const execution: CommandCenterExecutionTarget = { kind: "session", sessionId, turnId };
const auth: CommandCenterAdmissionAuth = {
  subject: "local:owner",
  roles: ["owner"],
  sessionIds: [sessionId],
  workspaceIds: [workspaceId],
};

function reservationResponse(overrides: Record<string, unknown> = {}) {
  return {
    executionKey: commandCenterExecutionKey(execution),
    workspaceId,
    membershipRevision: 1,
    state: "reserved",
    hostLive: 1,
    workspaceLive: 1,
    ...overrides,
  };
}

function transport(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const port: HostRpcPort = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params: params ?? {} });
      return handler(method, params ?? {}) as T;
    },
  };
  return { port, calls };
}

function port(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const fake = transport(handler);
  const admission = createRustCommandCenterAdmissionPort(fake.port, () => binding);
  return { admission, calls: fake.calls };
}

describe("Rust command-center admission adapter", () => {
  it("encodes reserve as one private C2 call with the exact envelope", async () => {
    const { admission, calls } = port(() => reservationResponse());
    await expect(admission.reserve({
      binding,
      auth,
      workspaceId,
      membershipRevision: 1,
      execution,
    })).resolves.toEqual(reservationResponse());
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(COMMAND_CENTER_RESERVATION_METHODS.reserve);
    expect(calls[0].method).toBe("commandCenter.reservation.reserve");
    expect(calls[0].params).toEqual({
      binding: { hostId: binding.hostId, hostEpoch: binding.hostEpoch },
      auth,
      input: {
        version: 1,
        hostId: binding.hostId,
        expectedHostEpoch: binding.hostEpoch,
        commandWorkspaceId: workspaceId,
        expectedMembershipRevision: 1,
        target: execution,
      },
    });
    expect((calls[0].params.auth as CommandCenterAdmissionAuth).sessionIds).not.toBe(auth.sessionIds);
  });

  it("encodes hold and release without retrying a mutation", async () => {
    const { admission, calls } = port((method) => {
      if (method === COMMAND_CENTER_RESERVATION_METHODS.release) return { released: true };
      return reservationResponse({ state: "stopping" });
    });
    await expect(admission.hold({
      binding,
      auth,
      workspaceId,
      execution,
      from: "reserved",
      to: "stopping",
      evidence: "runtime-stopping",
    })).resolves.toMatchObject({ state: "stopping", executionKey: commandCenterExecutionKey(execution) });
    await expect(admission.release({
      binding,
      auth,
      workspaceId,
      execution,
      to: "completed",
      evidence: "runtime-settled",
    })).resolves.toEqual({ released: true });
    expect(calls.map((call) => call.method)).toEqual([
      "commandCenter.reservation.hold",
      "commandCenter.reservation.release",
    ]);
    expect((calls[0].params.input as Record<string, unknown>).evidence).toBe("runtime-stopping");
    expect((calls[1].params.input as Record<string, unknown>).to).toBe("completed");
  });

  it("validates the capacity snapshot and refuses invalid counts", async () => {
    const good = port(() => ({
      version: 1,
      hostLive: 12,
      maxHostLive: 36,
      maxWorkspaceLive: 12,
      workspaces: [{ workspaceId, live: 12, maxLive: 12 }],
    }));
    await expect(good.admission.snapshot({ binding, auth })).resolves.toMatchObject({ hostLive: 12 });

    const bad = port(() => ({
      version: 1,
      hostLive: 37,
      maxHostLive: 36,
      maxWorkspaceLive: 12,
      workspaces: [],
    }));
    await expect(bad.admission.snapshot({ binding, auth })).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("rejects malformed reservation responses and never invents counts", async () => {
    for (const response of [
      reservationResponse({ workspaceLive: 13 }),
      reservationResponse({ executionKey: "[\"session\",\"other\",\"turn\"]" }),
      reservationResponse({ state: "completed" }),
      { ...reservationResponse(), extra: true },
    ]) {
      const { admission, calls } = port(() => response);
      await expect(admission.reserve({ binding, auth, workspaceId, membershipRevision: 1, execution }))
        .rejects.toMatchObject({ code: "INTERNAL" });
      expect(calls).toHaveLength(1);
    }
  });

  it("maps CC_ quota refusals and propagates unrelated failures unchanged", async () => {
    const quota = port(() => {
      throw new Error("CC_QUOTA_EXCEEDED: Host already holds 36 live executions");
    });
    await expect(quota.admission.reserve({ binding, auth, workspaceId, membershipRevision: 1, execution }))
      .rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    expect(quota.calls).toHaveLength(1);

    const failure = new Error("socket closed");
    const plain = port(() => {
      throw failure;
    });
    await expect(plain.admission.reserve({ binding, auth, workspaceId, membershipRevision: 1, execution }))
      .rejects.toBe(failure);
    expect(plain.calls).toHaveLength(1);
  });

  it("refuses before I/O when the owner epoch already moved", async () => {
    const calls: string[] = [];
    const admission = createRustCommandCenterAdmissionPort({
      async call<T>(method: string): Promise<T> {
        calls.push(method);
        return {} as T;
      },
    }, () => ({ ...binding, hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" }));
    await expect(admission.reserve({ binding, auth, workspaceId, membershipRevision: 1, execution }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toHaveLength(0);
  });

  it("re-checks the owner after the await before publishing a result or an error", async () => {
    let current = binding;
    const success = createRustCommandCenterAdmissionPort({
      async call<T>(): Promise<T> {
        current = { ...binding, hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" };
        return reservationResponse() as T;
      },
    }, () => current);
    await expect(success.reserve({ binding, auth, workspaceId, membershipRevision: 1, execution }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    current = binding;
    const failed = createRustCommandCenterAdmissionPort({
      async call<T>(): Promise<T> {
        current = { ...binding, hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" };
        throw new Error("CC_QUOTA_EXCEEDED: Host already holds 36 live executions");
      },
    }, () => current);
    // The stale owner is the published failure, not the quota family.
    await expect(failed.reserve({ binding, auth, workspaceId, membershipRevision: 1, execution }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails closed when its transport or identity port is missing", () => {
    expect(() => createRustCommandCenterAdmissionPort(undefined as never, () => binding)).toThrow(/HostRpcPort/);
    expect(() => createRustCommandCenterAdmissionPort({ call: async () => null }, undefined as never)).toThrow(/hostIdentity/);
  });
});
