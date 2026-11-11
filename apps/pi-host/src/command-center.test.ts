import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandCenterExecutionKey, parseCommandCenterInterventionRequest, type CommandCenterExecutionTarget, type CommandCenterInterventionRequest } from "@pi-desktop/shared";
import type { Principal } from "@pi-desktop/agent-host";
import type { RacpHostOperations } from "@pi-desktop/racp";
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
  };
  return { runtime, active, steered, aborted };
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
