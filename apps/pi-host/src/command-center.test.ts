import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandCenterExecutionKey, parseCommandCenterInterventionRequest, type CommandCenterExecutionTarget, type CommandCenterInterventionRequest } from "@pi-desktop/shared";
import type { Principal } from "@pi-desktop/agent-host";
import type { RacpHostOperations } from "@pi-desktop/racp";
import {
  RuntimeService,
  type LaunchResolver,
  type RuntimeHostLink,
  type RuntimeSidecarLink,
  type RuntimeTurnAdmissionPort,
} from "@pi-desktop/host-runtime";
import {
  attachPiHostCommandCenter,
  createPiHostRuntimeHandoff,
  type PiHostCommandCenterRuntime,
} from "./command-center.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const workspace = fixture.workspaces.workspaces[0];
const row = fixture.snapshot.rows[0];
const HOST_ID = "host_7c1e0a93b4d2f681";
const EPOCH = "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14";

type Call = { method: string; params: Record<string, unknown> };

/** External host transport double: real composition above, no Rust process. */
function fakeHost(epoch: () => string) {
  const calls: Call[] = [];
  return {
    calls,
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params: params ?? {} });
      if (method === "app.handshake") {
        return { protocolVersion: 1, commandCenter: { version: 1, hostEpoch: epoch() } } as T;
      }
      if (method === "commandCenter.workspace.list") return { workspaces: [workspace] } as T;
      if (method === "commandCenter.receipt.get") return null as T;
      if (method === "commandCenter.reservation.reserve") {
        const input = params?.input as { target: CommandCenterExecutionTarget; commandWorkspaceId: string; expectedMembershipRevision: number };
        return {
          executionKey: commandCenterExecutionKey(input.target), workspaceId: input.commandWorkspaceId,
          membershipRevision: input.expectedMembershipRevision, state: "reserved", hostLive: 1, workspaceLive: 1,
        } as T;
      }
      if (method === "commandCenter.workspace.create") {
        const input = params?.input as { commandWorkspaceId: string; name: string; enabled: boolean };
        return { id: input.commandWorkspaceId, name: input.name, enabled: input.enabled, revision: 1 } as T;
      }
      if (method === "commandCenter.monitor.cut") {
        return {
          version: 1,
          cursor: { epoch: `monitor-${epoch()}`, sequence: 7 },
          generatedAt: fixture.snapshot.generatedAt,
          rows: [row],
        } as T;
      }
      throw new Error(`unexpected host call ${method}`);
    },
  };
}

function runtimeDouble() {
  const active = new Map<string, string | undefined>();
  const steered: string[] = [];
  const aborted: string[] = [];
  let admission: RuntimeTurnAdmissionPort | null = null;
  const runtime: PiHostCommandCenterRuntime = {
    activeTurnId: (sessionId) => active.get(sessionId),
    async steer(request) {
      steered.push(`${request.sessionId}/${request.turnId}:${request.content}`);
      return { accepted: true };
    },
    async abort(sessionId, turnId) {
      aborted.push(`${sessionId}/${turnId ?? ""}`);
      active.delete(sessionId);
    },
    setAdmission(value) {
      admission = value;
    },
  };
  return { runtime, active, steered, aborted, admission: () => admission };
}

function intervention(overrides: Partial<CommandCenterInterventionRequest> & {
  intent: CommandCenterInterventionRequest["intent"];
  target: CommandCenterExecutionTarget;
}): CommandCenterInterventionRequest {
  return {
    version: 1,
    requestId: randomUUID(),
    hostId: HOST_ID,
    expectedHostEpoch: EPOCH,
    commandWorkspaceId: workspace.id,
    expectedMembershipRevision: 4,
    expectedGoalRevision: 1,
    ...overrides,
  } as CommandCenterInterventionRequest;
}

const sessionTarget: CommandCenterExecutionTarget = { kind: "session", sessionId: "sess-1", turnId: "turn-1" };
const delegationTarget: CommandCenterExecutionTarget = {
  kind: "delegation", parentSessionId: "sess-1", parentTurnId: "turn-1", delegationId: "deleg-1", executionGeneration: 1,
};

describe("pi-host command-center runtime consumer", () => {
  it("supports only an active exact session turn and never fakes append/delegation", async () => {
    const { runtime, active, steered, aborted } = runtimeDouble();
    const handoff = createPiHostRuntimeHandoff(runtime);
    const binding = { hostId: HOST_ID, hostEpoch: EPOCH };
    active.set("sess-1", "turn-1");

    expect(handoff.canRecord(binding, sessionTarget, "steer")).toBe(true);
    expect(handoff.canRecord(binding, sessionTarget, "reviseGoal")).toBe(true);
    expect(handoff.canRecord(binding, sessionTarget, "stop")).toBe(true);
    expect(handoff.canRecord(binding, sessionTarget, "append")).toBe(false);
    expect(handoff.canRecord(binding, delegationTarget, "steer")).toBe(false);
    expect(handoff.canRecord(binding, { ...sessionTarget, turnId: "turn-old" } as CommandCenterExecutionTarget, "steer")).toBe(false);

    const appended = await handoff.dispatch!(binding, intervention({ target: sessionTarget, intent: { kind: "append", text: "x" } }), { startedAt: 0, deadlineAt: 1 });
    expect(appended).toMatchObject({ status: "rejected" });
    const delegated = await handoff.dispatch!(binding, intervention({ target: delegationTarget, intent: { kind: "steer", text: "x" } }), { startedAt: 0, deadlineAt: 1 });
    expect(delegated).toMatchObject({ status: "rejected" });

    const steeredAck = await handoff.dispatch!(binding, intervention({ target: sessionTarget, intent: { kind: "steer", text: "keep going" } }), { startedAt: 0, deadlineAt: 1 });
    expect(steeredAck).toEqual({ status: "accepted" });
    expect(steered).toEqual(["sess-1/turn-1:keep going"]);

    const revised = await handoff.dispatch!(binding, intervention({
      target: sessionTarget,
      intent: { kind: "reviseGoal", objective: "Ship it", constraints: ["no replay"] },
    }), { startedAt: 0, deadlineAt: 1 });
    expect(revised).toEqual({ status: "accepted" });
    expect(steered.at(-1)).toContain("Objective: Ship it");
    expect(steered.at(-1)).toContain("- no replay");

    const stopped = await handoff.dispatch!(binding, intervention({ target: sessionTarget, intent: { kind: "stop", scope: "target" } }), { startedAt: 0, deadlineAt: 1 });
    expect(stopped).toEqual({ status: "interrupted" });
    expect(aborted).toEqual(["sess-1/turn-1"]);
  });

  it("reports a conflicting turn and never claims a stop the runtime did not apply", async () => {
    const { runtime, active } = runtimeDouble();
    const handoff = createPiHostRuntimeHandoff(runtime);
    const binding = { hostId: HOST_ID, hostEpoch: EPOCH };
    active.set("sess-1", "turn-1");

    runtime.abort = async () => { /* runtime refused: leave the turn active */ };
    const stop = await handoff.dispatch!(binding, intervention({ target: sessionTarget, intent: { kind: "stop", scope: "target" } }), { startedAt: 0, deadlineAt: 1 });
    expect(stop).toMatchObject({ status: "outcome_unknown" });

    const stale = await handoff.dispatch!(binding, intervention({ target: { ...sessionTarget, turnId: "turn-old" } as CommandCenterExecutionTarget, intent: { kind: "steer", text: "x" } }), { startedAt: 0, deadlineAt: 1 });
    expect(stale).toMatchObject({ status: "conflicted" });
  });
});

describe("pi-host command-center composition", () => {
  it("keeps the catalog untouched when the flag is off", () => {
    const operations = {};
    expect(attachPiHostCommandCenter({
      config: { commandCenter: false }, operations: operations as RacpHostOperations,
      getHost: () => null, hostId: HOST_ID, getHostEpoch: () => null,
      runtime: runtimeDouble().runtime, maintenanceClosed: () => false,
    })).toBeUndefined();
    expect(Object.keys(operations)).toEqual([]);
  });

  it("binds control and monitor ports to the live handshake epoch and denies weaker roles", async () => {
    let epoch = EPOCH;
    const host = fakeHost(() => epoch);
    const operations = {} as RacpHostOperations;
    const commandCenter = attachPiHostCommandCenter({
      config: { commandCenter: true }, operations,
      getHost: () => host, hostId: HOST_ID, getHostEpoch: () => epoch,
      runtime: runtimeDouble().runtime, maintenanceClosed: () => false,
    });
    expect(commandCenter).toBeDefined();
    expect(operations.commandCenter).toBe(commandCenter!.control);
    expect(operations.commandCenterMonitorPage).toBe(commandCenter!.monitorPage);

    const owner: Principal = { subject: "paired-owner", roles: ["owner"] };
    await expect(commandCenter!.control.call("workspace/list", { version: 1, hostId: HOST_ID }, owner))
      .resolves.toMatchObject({ workspaces: [workspace] });
    expect(host.calls.at(-1)).toMatchObject({
      method: "commandCenter.workspace.list",
      params: { binding: { hostId: HOST_ID, hostEpoch: EPOCH }, auth: { subject: "paired-owner", roles: ["owner"] } },
    });

    // Unsupported append/delegation never reaches the mutation transport and
    // therefore cannot leave an accepted/consumed receipt behind.
    await expect(commandCenter!.control.call("intervention/record", intervention({
      target: sessionTarget, intent: { kind: "append", text: "not supported" },
    }), owner)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(commandCenter!.control.call("intervention/record", intervention({
      target: delegationTarget, intent: { kind: "steer", text: "not supported" },
    }), owner)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(host.calls.some((call) => call.method === "commandCenter.intervention.record")).toBe(false);

    await expect(commandCenter!.control.call("workspace/create", {
      version: 1, hostId: HOST_ID, expectedHostEpoch: EPOCH,
      commandWorkspaceId: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50", name: "New", enabled: true,
    }, { subject: "paired-viewer", roles: ["viewer"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(commandCenter!.control.call("workspace/create", {
      version: 1, hostId: HOST_ID, expectedHostEpoch: EPOCH,
      commandWorkspaceId: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50", name: "New", enabled: true,
    }, { subject: "paired-controller", roles: ["controller"] })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Controller role grants workspace-scoped session control, not workspace
    // administration. The owner-only create checks above remain unchanged.
    await expect(commandCenter!.control.admitExecution({ subject: "paired-controller", roles: ["controller"] }, {
      version: 1, hostId: HOST_ID, expectedHostEpoch: EPOCH,
      commandWorkspaceId: workspace.id, expectedMembershipRevision: 1, target: sessionTarget,
    })).resolves.toMatchObject({ state: "reserved" });

    const principal: Principal = { subject: "paired-viewer", roles: ["viewer"], connectionId: "conn-1" };
    const page = await commandCenter!.monitorPage.page({ version: 1, hostId: HOST_ID }, { principal });
    expect(page.rows).toHaveLength(1);
    expect(host.calls.at(-1)?.params).toMatchObject({ binding: { hostId: HOST_ID, hostEpoch: EPOCH } });

    const oldEpoch = epoch;
    epoch = "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28";
    await expect(commandCenter!.control.call("workspace/create", {
      version: 1, hostId: HOST_ID, expectedHostEpoch: oldEpoch,
      commandWorkspaceId: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50", name: "Stale", enabled: true,
    }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(commandCenter!.monitorPage.page({ version: 1, hostId: HOST_ID }, { principal }))
      .resolves.toMatchObject({ rows: [row] });
    expect(host.calls.at(-1)?.params).toMatchObject({ binding: { hostId: HOST_ID, hostEpoch: epoch } });

    await commandCenter!.dispose();
    await expect(commandCenter!.monitorPage.page({ version: 1, hostId: HOST_ID }, { principal }))
      .rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------------------
// RACP turn admission through the real RuntimeService + control service
// ---------------------------------------------------------------------------

type TurnHarnessOptions = {
  quotaFull?: boolean;
  endOk?: boolean;
  membership?: "ok" | "missing";
  workspaceEnabled?: boolean;
};

function turnHarness(options: TurnHarnessOptions = {}) {
  const calls: Call[] = [];
  let turnCounter = 0;
  let endOk = options.endOk ?? true;
  let quotaFull = options.quotaFull ?? false;
  const membershipMode = options.membership ?? "ok";
  const workspaceRecord = { id: workspace.id, name: "Main", enabled: options.workspaceEnabled ?? true, revision: 4 };

  const host: RuntimeHostLink = {
    async call<T = unknown>(method: string, params?: unknown): Promise<T> {
      const input = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: input });
      switch (method) {
        case "settings.get": return {} as T;
        case "session.get": return { session: { id: input.id, mode: "agent", permissionMode: "ask", providerId: "p1", modelId: "m1", messages: [] } } as T;
        case "session.beginTurn": { turnCounter += 1; return { turnId: `turn-${turnCounter}` } as T; }
        case "session.appendMessage": return {} as T;
        case "session.saveInflightMessage": return { ok: true } as T;
        case "session.endTurn": return { ok: endOk } as T;
        case "plans.abort": return {} as T;
        case "commandCenter.membership.get": {
          if (membershipMode === "missing") return null as T;
          const membershipInput = input.input as { sessionId: string };
          return { sessionId: membershipInput.sessionId, commandWorkspaceId: workspaceRecord.id, revision: 4 } as T;
        }
        case "commandCenter.workspace.get": return workspaceRecord as T;
        case "commandCenter.reservation.reserve": {
          if (quotaFull) throw new Error("CC_QUOTA_EXCEEDED: Host already holds 36 live executions");
          const reservationInput = input.input as { target: CommandCenterExecutionTarget; commandWorkspaceId: string; expectedMembershipRevision: number };
          return {
            executionKey: commandCenterExecutionKey(reservationInput.target), workspaceId: reservationInput.commandWorkspaceId,
            membershipRevision: reservationInput.expectedMembershipRevision, state: "reserved", hostLive: 1, workspaceLive: 1,
          } as T;
        }
        case "commandCenter.reservation.hold": {
          const reservationInput = input.input as { target: CommandCenterExecutionTarget; commandWorkspaceId: string; to: string };
          return {
            executionKey: commandCenterExecutionKey(reservationInput.target), workspaceId: reservationInput.commandWorkspaceId,
            membershipRevision: 4, state: reservationInput.to, hostLive: 1, workspaceLive: 1,
          } as T;
        }
        case "commandCenter.reservation.release": return { released: true } as T;
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
    isAvailable: () => true,
    onNotification: () => () => undefined,
    onExit: () => () => undefined,
  };

  const sidecarCalls: Call[] = [];
  let notify: ((method: string, params: unknown) => void) | null = null;
  const sidecar: RuntimeSidecarLink = {
    async call<T = unknown>(method: string, params?: unknown): Promise<T> {
      const input = (params ?? {}) as Record<string, unknown>;
      sidecarCalls.push({ method, params: input });
      switch (method) {
        case "agent.prompt": return { accepted: true, turnId: input.turnId } as T;
        case "agent.abort": return { ok: true } as T;
        case "agent.getStatus": return { status: { sessionId: input.sessionId, isRunning: false, pendingToolConfirmations: 0 } } as T;
        default: return {} as T;
      }
    },
    onNotification(handler) { notify = handler; return () => { notify = null; }; },
    onExit: () => () => undefined,
    setProjectInstructionRoot: () => undefined,
    clearProjectInstructionRoot: () => undefined,
    clearVendorAuthBindings: () => undefined,
  };

  const launch: LaunchResolver = {
    async resolve(sessionId, session) {
      return {
        providerId: String(session.providerId ?? "p1"), modelId: String(session.modelId ?? "m1"),
        projectPath: "/work/project",
        sidecarParams: { sessionId, mode: "agent", provider: { id: "p1", name: "P1", modelId: "m1", supportsReasoning: false, supportedThinkingLevels: ["off"] } },
      };
    },
  };

  const runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, launch, log: () => undefined, now: () => 1 });
  runtime.attachHost(host);
  runtime.attachSidecar(sidecar);
  const operations = {} as RacpHostOperations;
  const commandCenter = attachPiHostCommandCenter({
    config: { commandCenter: true }, operations,
    getHost: () => host, hostId: HOST_ID, getHostEpoch: () => EPOCH,
    runtime, maintenanceClosed: () => false,
  });
  return {
    runtime, commandCenter, host, sidecarCalls,
    terminal(turnId: string) {
      notify?.("agent.event", { sessionId: "s1", turnId, ts: 1, event: { type: "agent_end", messageIds: [] } });
    },
    setQuotaFull(value: boolean) { quotaFull = value; },
    setEndOk(value: boolean) { endOk = value; },
    calls,
  };
}

async function flushTurns(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const turnOwner: Principal = { subject: "command-center", roles: ["owner"] };
const turnRequest = { sessionId: "s1", content: "hello", effectivePermissionMode: "ask" as const, principal: turnOwner };

describe("pi-host RACP turn admission", () => {
  it("refuses a turn at the C2 quota and never prompts the sidecar", async () => {
    const harness = turnHarness({ quotaFull: true });
    await expect(harness.runtime.prompt(turnRequest)).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    expect(harness.sidecarCalls.some((call) => call.method === "agent.prompt")).toBe(false);
    expect(harness.calls.some((call) => call.method === "commandCenter.reservation.reserve")).toBe(true);
    expect(harness.calls.some((call) => call.method === "session.endTurn")).toBe(true);
    await harness.commandCenter!.dispose();
  });

  it("admits before prompting and releases completed exactly once", async () => {
    const harness = turnHarness();
    const { turnId } = await harness.runtime.prompt(turnRequest);
    const reserveIndex = harness.calls.findIndex((call) => call.method === "commandCenter.reservation.reserve");
    expect(reserveIndex).toBeGreaterThanOrEqual(0);
    expect(harness.sidecarCalls.some((call) => call.method === "agent.prompt")).toBe(true);
    harness.terminal(turnId);
    await flushTurns();
    const releases = harness.calls.filter((call) => call.method === "commandCenter.reservation.release");
    expect(releases).toHaveLength(1);
    expect((releases[0].params.input as { to: string }).to).toBe("completed");
    harness.terminal(turnId);
    await flushTurns();
    expect(harness.calls.filter((call) => call.method === "commandCenter.reservation.release")).toHaveLength(1);
    await harness.commandCenter!.dispose();
  });

  it("releases an aborted turn as aborted", async () => {
    const harness = turnHarness();
    await harness.runtime.prompt(turnRequest);
    await harness.runtime.abort("s1");
    await flushTurns();
    const release = harness.calls.find((call) => call.method === "commandCenter.reservation.release");
    expect((release?.params.input as { to?: string } | undefined)?.to).toBe("aborted");
    await harness.commandCenter!.dispose();
  });

  it("keeps an unacknowledged terminal turn as outcome_unknown capacity", async () => {
    const harness = turnHarness({ endOk: false });
    const { turnId } = await harness.runtime.prompt(turnRequest);
    harness.terminal(turnId);
    await flushTurns();
    const holds = harness.calls.filter((call) => call.method === "commandCenter.reservation.hold");
    expect(holds).toHaveLength(2);
    expect((holds[1].params.input as { to: string }).to).toBe("outcome_unknown");
    expect(harness.calls.some((call) => call.method === "commandCenter.reservation.release")).toBe(false);
    await harness.commandCenter!.dispose();
  });

  it("refuses a turn whose session has no command workspace membership", async () => {
    const harness = turnHarness({ membership: "missing" });
    await expect(harness.runtime.prompt(turnRequest)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(harness.sidecarCalls.some((call) => call.method === "agent.prompt")).toBe(false);
    expect(harness.calls.some((call) => call.method === "commandCenter.reservation.reserve")).toBe(false);
    await harness.commandCenter!.dispose();
  });

  it("refuses a turn whose command workspace is disabled", async () => {
    const harness = turnHarness({ workspaceEnabled: false });
    await expect(harness.runtime.prompt(turnRequest)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.sidecarCalls.some((call) => call.method === "agent.prompt")).toBe(false);
    expect(harness.calls.some((call) => call.method === "commandCenter.reservation.reserve")).toBe(false);
    await harness.commandCenter!.dispose();
  });

  it("leaves turn behavior unchanged when the command-center flag is off", async () => {
    const calls: Call[] = [];
    const host: RuntimeHostLink = {
      async call<T = unknown>(method: string, params?: unknown): Promise<T> {
        const input = (params ?? {}) as Record<string, unknown>;
        calls.push({ method, params: input });
        switch (method) {
          case "settings.get": return {} as T;
          case "session.get": return { session: { id: input.id, mode: "agent", permissionMode: "ask", providerId: "p1", modelId: "m1", messages: [] } } as T;
          case "session.beginTurn": return { turnId: "turn-1" } as T;
          case "session.appendMessage": return {} as T;
          case "session.saveInflightMessage": return { ok: true } as T;
          case "session.endTurn": return { ok: true } as T;
          default: throw new Error(`unexpected host call ${method}`);
        }
      },
      isAvailable: () => true, onNotification: () => () => undefined, onExit: () => () => undefined,
    };
    const sidecar: RuntimeSidecarLink = {
      async call<T = unknown>(method: string): Promise<T> {
        if (method === "agent.prompt") return { accepted: true, turnId: "turn-1" } as T;
        return {} as T;
      },
      onNotification: () => () => undefined, onExit: () => () => undefined,
      setProjectInstructionRoot: () => undefined, clearProjectInstructionRoot: () => undefined, clearVendorAuthBindings: () => undefined,
    };
    const launch: LaunchResolver = { async resolve(sessionId) { return { providerId: "p1", modelId: "m1", sidecarParams: { sessionId, mode: "agent", provider: { id: "p1", name: "P1", modelId: "m1", supportsReasoning: false, supportedThinkingLevels: ["off"] } } }; } };
    const runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, launch, log: () => undefined });
    runtime.attachHost(host); runtime.attachSidecar(sidecar);
    const operations = {} as RacpHostOperations;
    expect(attachPiHostCommandCenter({
      config: { commandCenter: false }, operations,
      getHost: () => host, hostId: HOST_ID, getHostEpoch: () => EPOCH,
      runtime, maintenanceClosed: () => false,
    })).toBeUndefined();
    await expect(runtime.prompt(turnRequest)).resolves.toMatchObject({ turnId: "turn-1" });
    expect(calls.some((call) => call.method.startsWith("commandCenter."))).toBe(false);
  });
});
