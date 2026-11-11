import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_ADMISSION_LIMITS, commandCenterAdmissionHoldsCapacity, commandCenterExecutionKey,
  type CommandCenterAdmissionSnapshot, type CommandCenterAdmissionState, type CommandCenterExecutionTarget,
} from "@pi-desktop/shared";
import {
  CommandCenterControl,
  type CommandCenterAdmissionHoldPortRequest,
  type CommandCenterAdmissionPort,
  type CommandCenterAdmissionReleasePortRequest,
  type CommandCenterAdmissionReservation,
  type CommandCenterAdmissionReservePortRequest,
  type CommandCenterBinding,
  type CommandCenterRepository,
} from "../command-center-control.js";
import { RacpError } from "../errors.js";
import type { Principal } from "../ports.js";

/** C4 admission seam. The fake models the C2 reservation authority; the control
 * service must keep no second counter. */

const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const workspaceA = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
const workspaceB = "8a2e5d31-9b4c-4a67-8d23-3f8b0c1e5a42";
const workspaceC = "9b3f6e42-ac5d-4b78-9e34-4a9c1d2f6b53";
const owner: Principal = { subject: "local:owner", roles: ["owner"] };
const viewer: Principal = { subject: "local:viewer", roles: ["viewer"] };

type Row = { workspaceId: string; membershipRevision: number; state: CommandCenterAdmissionState };

class FakeAdmission implements CommandCenterAdmissionPort {
  readonly rows = new Map<string, Row>();

  private key(execution: CommandCenterExecutionTarget): string {
    return commandCenterExecutionKey(execution);
  }

  private result(key: string, row: Row): CommandCenterAdmissionReservation {
    const hostLive = [...this.rows.values()].filter((item) => commandCenterAdmissionHoldsCapacity(item.state)).length;
    const workspaceLive = [...this.rows.values()]
      .filter((item) => item.workspaceId === row.workspaceId && commandCenterAdmissionHoldsCapacity(item.state)).length;
    return {
      executionKey: key,
      workspaceId: row.workspaceId,
      membershipRevision: row.membershipRevision,
      state: row.state,
      hostLive,
      workspaceLive,
    };
  }

  async reserve(request: CommandCenterAdmissionReservePortRequest): Promise<CommandCenterAdmissionReservation> {
    const key = this.key(request.execution);
    const existing = this.rows.get(key);
    if (existing) return this.result(key, existing);
    const workspaceLive = [...this.rows.values()]
      .filter((row) => row.workspaceId === request.workspaceId && commandCenterAdmissionHoldsCapacity(row.state)).length;
    if (workspaceLive >= COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerWorkspace) {
      throw new RacpError("RESOURCE_EXHAUSTED", "CC_QUOTA_EXCEEDED: workspace is at its live execution limit");
    }
    const hostLive = [...this.rows.values()].filter((row) => commandCenterAdmissionHoldsCapacity(row.state)).length;
    if (hostLive >= COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerHost) {
      throw new RacpError("RESOURCE_EXHAUSTED", "CC_QUOTA_EXCEEDED: host is at its live execution limit");
    }
    const row: Row = { workspaceId: request.workspaceId, membershipRevision: request.membershipRevision, state: "reserved" };
    this.rows.set(key, row);
    return this.result(key, row);
  }

  async hold(request: CommandCenterAdmissionHoldPortRequest): Promise<CommandCenterAdmissionReservation> {
    const key = this.key(request.execution);
    const row = this.rows.get(key);
    if (!row) throw new RacpError("NOT_FOUND", "CC_RESERVATION_NOT_FOUND: no live reservation");
    if (row.state !== request.from) throw new RacpError("CONFLICT", "CC_RESERVATION_CONFLICT: state changed");
    if (!commandCenterAdmissionHoldsCapacity(request.to as Row["state"])) {
      throw new RacpError("INVALID_ARGUMENT", "CC_TRANSITION_INVALID: hold target must retain capacity");
    }
    row.state = request.to as Row["state"];
    return this.result(key, row);
  }

  async release(request: CommandCenterAdmissionReleasePortRequest): Promise<{ released: boolean }> {
    const key = this.key(request.execution);
    const row = this.rows.get(key);
    if (!row) throw new RacpError("NOT_FOUND", "CC_RESERVATION_NOT_FOUND: no live reservation");
    if (!commandCenterAdmissionHoldsCapacity(row.state)) return { released: false };
    row.state = "completed";
    return { released: true };
  }

  async snapshot(request: { binding: CommandCenterBinding; auth: { workspaceIds: string[] } }): Promise<CommandCenterAdmissionSnapshot> {
    const live = [...this.rows.values()].filter((row) => commandCenterAdmissionHoldsCapacity(row.state));
    const byWorkspace = new Map<string, number>();
    for (const row of live) byWorkspace.set(row.workspaceId, (byWorkspace.get(row.workspaceId) ?? 0) + 1);
    return {
      version: 1,
      hostLive: live.length,
      maxHostLive: COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerHost,
      maxWorkspaceLive: COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerWorkspace,
      workspaces: [...byWorkspace.entries()]
        .filter(([workspaceId]) => request.auth.workspaceIds.includes(workspaceId))
        .map(([workspaceId, count]) => ({
          workspaceId,
          live: count,
          maxLive: COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerWorkspace,
        })),
    };
  }
}

function setup(options: {
  admission?: CommandCenterAdmissionPort;
  identity?: () => CommandCenterBinding;
  authorize?: () => Promise<boolean>;
  mutationsClosed?: () => boolean;
} = {}) {
  const repository = {
    async call() {
      throw new Error("repository is not used by admission tests");
    },
  } as unknown as CommandCenterRepository;
  const control = new CommandCenterControl({
    repository,
    hostIdentity: options.identity ?? (() => binding),
    mutationsClosed: options.mutationsClosed ?? (() => false),
    authorize: options.authorize ?? (async () => true),
    now: () => 1_000,
    ...(options.admission ? { admission: options.admission } : {}),
  });
  return { control };
}

function target(index: number): CommandCenterExecutionTarget {
  return { kind: "session", sessionId: `sess-${index}`, turnId: `turn-${index}` };
}

function admissionInput(workspaceId: string, index: number) {
  return {
    version: 1,
    hostId: binding.hostId,
    expectedHostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceId,
    expectedMembershipRevision: 1,
    target: target(index),
  };
}

function holdInput(index: number, from: string, to: string) {
  return {
    version: 1,
    hostId: binding.hostId,
    expectedHostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceA,
    target: target(index),
    from,
    to,
    evidence: "runtime-stopping",
  };
}

function releaseInput(index: number, to: string = "completed") {
  return {
    version: 1,
    hostId: binding.hostId,
    expectedHostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceA,
    target: target(index),
    to,
    evidence: "runtime-settled",
  };
}

describe("command-center admission seam", () => {
  it("refuses a new reservation when maintenance admission is closed", async () => {
    const admission = new FakeAdmission();
    const { control } = setup({ admission, mutationsClosed: () => true });
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 1)))
      .rejects.toMatchObject({ code: "HOST_BUSY" });
    expect(admission.rows.size).toBe(0);
  });

  it("rechecks maintenance closure after asynchronous authorization", async () => {
    const admission = new FakeAdmission();
    let closed = false;
    const { control } = setup({
      admission, mutationsClosed: () => closed,
      authorize: async () => { closed = true; return true; },
    });
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 1)))
      .rejects.toMatchObject({ code: "HOST_BUSY" });
    expect(admission.rows.size).toBe(0);
  });

  it("admits twelve executions per workspace and refuses the thirteenth", async () => {
    const admission = new FakeAdmission();
    const { control } = setup({ admission });
    for (let index = 0; index < 12; index += 1) {
      await expect(control.admitExecution(owner, admissionInput(workspaceA, index))).resolves.toMatchObject({
        workspaceId: workspaceA,
        state: "reserved",
      });
    }
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 12))).rejects.toMatchObject({
      code: "RESOURCE_EXHAUSTED",
    });
    const state = await control.admissionState(owner, [workspaceA]);
    expect(state.hostLive).toBe(12);
    expect(state.workspaces).toEqual([{ workspaceId: workspaceA, live: 12, maxLive: 12 }]);
  });

  it("admits thirty-six across three workspaces and refuses the thirty-seventh Host start", async () => {
    const admission = new FakeAdmission();
    const { control } = setup({ admission });
    let execution = 0;
    for (const workspaceId of [workspaceA, workspaceB, workspaceC]) {
      for (let index = 0; index < 12; index += 1) {
        await expect(control.admitExecution(owner, admissionInput(workspaceId, execution))).resolves.toMatchObject({ workspaceId });
        execution += 1;
      }
    }
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 36))).rejects.toMatchObject({
      code: "RESOURCE_EXHAUSTED",
    });
    const state = await control.admissionState(owner, [workspaceA, workspaceB, workspaceC]);
    expect(state.hostLive).toBe(36);
    expect(state.workspaces).toHaveLength(3);
  });

  it("releases exactly once and keeps stopping/uncertain states counted", async () => {
    const admission = new FakeAdmission();
    const { control } = setup({ admission });
    await control.admitExecution(owner, admissionInput(workspaceA, 1));

    await expect(control.holdExecution(owner, holdInput(1, "reserved", "stopping"))).resolves.toMatchObject({ state: "stopping" });
    expect((await control.admissionState(owner)).hostLive).toBe(1);
    await expect(control.holdExecution(owner, holdInput(1, "stopping", "outcome_unknown"))).resolves.toMatchObject({
      state: "outcome_unknown",
    });
    expect((await control.admissionState(owner)).hostLive).toBe(1);
    expect(commandCenterAdmissionHoldsCapacity("outcome_unknown")).toBe(true);

    await expect(control.releaseExecution(owner, releaseInput(1))).resolves.toEqual({ released: true });
    await expect(control.releaseExecution(owner, releaseInput(1))).resolves.toEqual({ released: false });
    expect((await control.admissionState(owner)).hostLive).toBe(0);

    // The released slot is reusable.
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 2))).resolves.toMatchObject({ state: "reserved" });
  });

  it("does not publish a reservation when scope is revoked during the call", async () => {
    let allowed = true;
    const admission = new FakeAdmission();
    const reserve = admission.reserve.bind(admission);
    admission.reserve = async (request) => {
      allowed = false;
      return reserve(request);
    };
    const { control } = setup({ admission, authorize: async () => allowed });
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 1))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses a stale owner epoch observed around the admission call", async () => {    let current = binding;
    const admission = new FakeAdmission();
    const reserve = admission.reserve.bind(admission);
    admission.reserve = async (request) => {
      current = { ...binding, hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" };
      return reserve(request);
    };
    const { control } = setup({ admission, identity: () => current });
    await expect(control.admitExecution(owner, admissionInput(workspaceA, 1))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails closed without an admission port and denies the wrong role", async () => {
    const missing = setup();
    await expect(missing.control.admitExecution(owner, admissionInput(workspaceA, 1))).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(missing.control.admissionState(owner)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(missing.control.hasAdmission()).toBe(false);

    const admission = new FakeAdmission();
    const { control } = setup({ admission });
    expect(control.hasAdmission()).toBe(true);
    await expect(control.admitExecution(viewer, admissionInput(workspaceA, 1))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(control.releaseExecution(viewer, releaseInput(1))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(control.admissionState(viewer)).resolves.toMatchObject({ hostLive: 0 });
  });

  it("rejects host or epoch mismatches before the admission authority runs", async () => {
    const admission = new FakeAdmission();
    const { control } = setup({ admission });
    await expect(control.admitExecution(owner, { ...admissionInput(workspaceA, 1), hostId: "host_other" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(control.admitExecution(owner, { ...admissionInput(workspaceA, 1), expectedHostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(admission.rows.size).toBe(0);
  });
});
