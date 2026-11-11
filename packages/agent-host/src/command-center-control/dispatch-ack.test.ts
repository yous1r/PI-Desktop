import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CommandCenterControl,
  type CommandCenterAccess,
  type CommandCenterBinding,
  type CommandCenterRepository,
  type CommandCenterRepositoryContext,
  type CommandCenterRuntimeAcknowledgement,
} from "../command-center-control.js";
import { RacpError } from "../errors.js";
import type { Principal } from "../ports.js";

/** C4: one durable dispatch claim per (requestId, fingerprint), single ACK
 * transition, lost-reply reconciliation and stale-owner denial. */

const fixture = JSON.parse(
  readFileSync(new URL("../../../shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const owner: Principal = { subject: "local:owner", roles: ["owner"] };
const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
const request = fixture.request as { requestId: string };

type RepositoryCall = { method: string; input: Record<string, unknown>; context: CommandCenterRepositoryContext };

function entry(receipt: unknown, overrides: Record<string, unknown> = {}) {
  return {
    receipt,
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceId,
    membershipRevision: 7,
    sequence: 1,
    ...overrides,
  };
}

const recordedEntry = () => entry(fixture.receipt);
const acceptedEntry = () => entry(fixture.receipts.accepted);
const outcomeUnknownEntry = () =>
  entry({
    ...fixture.receipt,
    revision: 2,
    status: "outcome_unknown",
    error: { code: "AGENT_UNAVAILABLE", message: "dispatch outcome is unknown" },
  });
const rejectedEntry = () =>
  entry({
    ...fixture.receipt,
    revision: 2,
    status: "rejected",
    error: { code: "FORBIDDEN", message: "runtime refused the intervention" },
  });
const consumedEntry = () => entry(fixture.receipts.consumed);

function consumptionRequest(expectedRevision: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    hostId: binding.hostId,
    expectedHostEpoch: binding.hostEpoch,
    requestId: fixture.request.requestId,
    expectedRevision,
    consumption: {
      version: 1,
      requestId: fixture.request.requestId,
      target: fixture.targets.execution,
      consumedRevision: 5,
      boundary: "model_step",
    },
    ...overrides,
  };
}

function setup(options: {
  handlers?: Partial<Record<string, (input: Record<string, unknown>, callIndex: number) => unknown>>;
  authorize?: (principal: Principal, access: CommandCenterAccess) => Promise<boolean>;
  identity?: () => CommandCenterBinding;
  dispatch?: (binding: CommandCenterBinding, request: unknown, metadata: unknown) => Promise<CommandCenterRuntimeAcknowledgement>;
} = {}) {
  const calls: RepositoryCall[] = [];
  const perMethod = new Map<string, number>();
  const repository = {
    async call(method: string, input: Record<string, unknown>, context: CommandCenterRepositoryContext) {
      const index = perMethod.get(method) ?? 0;
      perMethod.set(method, index + 1);
      calls.push({ method, input, context });
      const handler = options.handlers?.[method];
      if (handler) return handler(input, index);
      if (method === "receipt/get") return null;
      throw new Error(`Unexpected repository call: ${method}`);
    },
  } as unknown as CommandCenterRepository;
  const control = new CommandCenterControl({
    repository,
    hostIdentity: options.identity ?? (() => binding),
    mutationsClosed: () => false,
    authorize: options.authorize ?? (async () => true),
    now: () => 1_000,
    dispatchTimeoutMs: 5_000,
    ...(options.dispatch ? { runtime: { canRecord: () => true, dispatch: options.dispatch } } : {}),
  });
  return { control, calls };
}

describe("command-center C4 dispatch claim and acknowledgement", () => {
  it("records one claim, dispatches once and persists one accepted acknowledgement", async () => {
    const stored = new Map<string, unknown>();
    const dispatch = vi.fn(async () => ({ status: "accepted" } as const));
    const { control, calls } = setup({
      dispatch,
      handlers: {
        "receipt/get": () => stored.get(request.requestId) ?? null,
        "intervention/record": () => {
          stored.set(request.requestId, recordedEntry());
          return { entry: recordedEntry(), replayed: false };
        },
        "intervention/ack": (input) => {
          expect(input.expectedRevision).toBe(1);
          expect(input.status).toBe("accepted");
          stored.set(request.requestId, acceptedEntry());
          return { entry: acceptedEntry(), replayed: false };
        },
      },
    });
    const result = await control.call("intervention/record", request as never, owner);
    expect(result).toEqual({ receipt: fixture.receipts.accepted, replayed: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual(["receipt/get", "intervention/record", "intervention/ack"]);
    expect(calls[1].context.auth.sessionIds).toContain("sess-parent-1");
    expect(calls[1].context.auth.workspaceIds).toContain(workspaceId);
  });

  it("returns the original receipt for a duplicate without dispatching again", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" } as const));
    const { control, calls } = setup({
      dispatch,
      handlers: { "receipt/get": () => acceptedEntry() },
    });
    const result = await control.call("intervention/record", request as never, owner);
    expect(result).toEqual({ receipt: fixture.receipts.accepted, replayed: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["receipt/get"]);
  });

  it("conflicts when the same request ID names a changed payload", async () => {
    const changed = entry({
      ...fixture.receipt,
      fingerprint: "0".repeat(64),
    });
    const dispatch = vi.fn();
    const { control, calls } = setup({ dispatch, handlers: { "receipt/get": () => changed } });
    await expect(control.call("intervention/record", request as never, owner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["receipt/get"]);
  });

  it("reconciles a lost record reply into the committed receipt without dispatch", async () => {
    const stored = new Map<string, unknown>();
    const dispatch = vi.fn();
    const { control, calls } = setup({
      dispatch,
      handlers: {
        "receipt/get": (_input, index) => (index === 0 ? null : stored.get(request.requestId) ?? null),
        "intervention/record": () => {
          stored.set(request.requestId, recordedEntry());
          throw new Error("socket closed after commit");
        },
      },
    });
    const result = await control.call("intervention/record", request as never, owner);
    expect(result).toEqual({ receipt: fixture.receipt, replayed: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["receipt/get", "intervention/record", "receipt/get"]);
  });

  it("reconciles a lost ACK reply without a second transition", async () => {
    const stored = new Map<string, unknown>();
    const dispatch = vi.fn(async () => ({ status: "accepted" } as const));
    const { control, calls } = setup({
      dispatch,
      handlers: {
        "receipt/get": () => stored.get(request.requestId) ?? null,
        "intervention/record": () => {
          stored.set(request.requestId, recordedEntry());
          return { entry: recordedEntry(), replayed: false };
        },
        "intervention/ack": () => {
          stored.set(request.requestId, acceptedEntry());
          throw new Error("reply lost");
        },
      },
    });
    const result = await control.call("intervention/record", request as never, owner);
    expect(result).toEqual({ receipt: fixture.receipts.accepted, replayed: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "intervention/ack")).toHaveLength(1);
  });

  it("persists outcome_unknown once when the dispatch result is unknown", async () => {
    const stored = new Map<string, unknown>();
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch transport closed");
    });
    const { control, calls } = setup({
      dispatch,
      handlers: {
        "receipt/get": () => stored.get(request.requestId) ?? null,
        "intervention/record": () => {
          stored.set(request.requestId, recordedEntry());
          return { entry: recordedEntry(), replayed: false };
        },
        "intervention/ack": (input) => {
          expect(input.status).toBe("outcome_unknown");
          stored.set(request.requestId, outcomeUnknownEntry());
          return { entry: outcomeUnknownEntry(), replayed: false };
        },
      },
    });
    const first = await control.call("intervention/record", request as never, owner);
    expect(first.receipt.status).toBe("outcome_unknown");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const second = await control.call("intervention/record", request as never, owner);
    expect(second).toEqual({ receipt: first.receipt, replayed: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "intervention/ack")).toHaveLength(1);
  });

  it("maps an explicit runtime refusal to a rejected receipt", async () => {
    const stored = new Map<string, unknown>();
    const dispatch = vi.fn(async () => {
      throw new RacpError("FORBIDDEN", "runtime refused the intervention");
    });
    const { control } = setup({
      dispatch,
      handlers: {
        "receipt/get": () => stored.get(request.requestId) ?? null,
        "intervention/record": () => {
          stored.set(request.requestId, recordedEntry());
          return { entry: recordedEntry(), replayed: false };
        },
        "intervention/ack": (input) => {
          expect(input.status).toBe("rejected");
          expect(input.error).toEqual({ code: "FORBIDDEN", message: "runtime refused the intervention" });
          stored.set(request.requestId, rejectedEntry());
          return { entry: rejectedEntry(), replayed: false };
        },
      },
    });
    const result = await control.call("intervention/record", request as never, owner);
    expect(result.receipt.status).toBe("rejected");
  });

  it("denies a stale owner epoch observed during dispatch without writing an ACK", async () => {
    let current = binding;
    const dispatch = vi.fn(async () => {
      current = { ...binding, hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" };
      return { status: "accepted" } as const;
    });
    const { control, calls } = setup({
      dispatch,
      identity: () => current,
      handlers: {
        "receipt/get": () => null,
        "intervention/record": () => ({ entry: recordedEntry(), replayed: false }),
      },
    });
    await expect(control.call("intervention/record", request as never, owner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual(["receipt/get", "intervention/record"]);
  });

  it("denies a role-less principal before any repository or runtime call", async () => {
    const dispatch = vi.fn();
    const { control, calls } = setup({ dispatch });
    await expect(
      control.call("intervention/record", request as never, { subject: "local:viewer", roles: ["viewer"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("persists a consumed acknowledgement with the exact execution boundary evidence", async () => {
    const stored = new Map<string, unknown>();
    stored.set(request.requestId, acceptedEntry());
    const { control, calls } = setup({
      handlers: {
        "receipt/get": () => stored.get(request.requestId) ?? null,
        "intervention/ack": (input) => {
          expect(input.status).toBe("consumed");
          expect(input.expectedRevision).toBe(2);
          expect(input.effectiveGoalRevision).toBe(5);
          expect(input.consumption).toEqual({
            version: 1,
            requestId: fixture.request.requestId,
            target: fixture.targets.execution,
            consumedRevision: 5,
            boundary: "model_step",
          });
          stored.set(request.requestId, consumedEntry());
          return { entry: consumedEntry(), replayed: false };
        },
      },
    });
    const result = await control.acknowledgeConsumption(owner, consumptionRequest(2));
    expect(result.receipt.status).toBe("consumed");
    expect(result.receipt.effectiveGoalRevision).toBe(5);
    expect(result.replayed).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["receipt/get", "intervention/ack"]);
  });

  it("refuses consumed without matching target, revision or boundary evidence", async () => {
    const stored = new Map<string, unknown>();
    stored.set(request.requestId, acceptedEntry());
    const { control, calls } = setup({
      handlers: { "receipt/get": () => stored.get(request.requestId) ?? null },
    });
    await expect(control.acknowledgeConsumption(owner, consumptionRequest(1))).rejects.toMatchObject({ code: "CONFLICT" });
    const wrongTarget = consumptionRequest(2, {
      consumption: {
        version: 1, requestId: fixture.request.requestId, target: fixture.targets.replacementExecution,
        consumedRevision: 5, boundary: "model_step",
      },
    });
    await expect(control.acknowledgeConsumption(owner, wrongTarget)).rejects.toMatchObject({ code: "CONFLICT" });
    const wrongRevision = consumptionRequest(2, {
      consumption: {
        version: 1, requestId: fixture.request.requestId, target: fixture.targets.execution,
        consumedRevision: 4, boundary: "model_step",
      },
    });
    await expect(control.acknowledgeConsumption(owner, wrongRevision)).rejects.toMatchObject({ code: "CONFLICT" });
    const badBoundary = consumptionRequest(2, {
      consumption: {
        version: 1, requestId: fixture.request.requestId, target: fixture.targets.execution,
        consumedRevision: 5, boundary: "Invalid Boundary",
      },
    });
    await expect(control.acknowledgeConsumption(owner, badBoundary)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls.filter((call) => call.method === "intervention/ack")).toHaveLength(0);
  });

  it("refuses a dispatch that tries to claim consumption without boundary evidence", async () => {
    const stored = new Map<string, unknown>();
    const dispatch = vi.fn(async () => ({ status: "consumed" }));
    const { control } = setup({
      dispatch: dispatch as never,
      handlers: {
        "receipt/get": () => stored.get(request.requestId) ?? null,
        "intervention/record": () => {
          stored.set(request.requestId, recordedEntry());
          return { entry: recordedEntry(), replayed: false };
        },
        "intervention/ack": (input) => {
          expect(input.status).toBe("outcome_unknown");
          stored.set(request.requestId, outcomeUnknownEntry());
          return { entry: outcomeUnknownEntry(), replayed: false };
        },
      },
    });
    const result = await control.call("intervention/record", request as never, owner);
    expect(result.receipt.status).toBe("outcome_unknown");
  });
});
