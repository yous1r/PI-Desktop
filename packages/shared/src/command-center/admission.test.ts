import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_ADMISSION_LIMITS, COMMAND_CENTER_TERMINAL_ADMISSION_STATES,
  CommandCenterAdmissionSnapshotSchema, commandCenterAdmissionHoldsCapacity,
  parseCommandCenterAdmissionSnapshot,
} from "./admission.js";

const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";
const otherWorkspaceId = "8a2e5d31-9b4c-4a67-8d23-3f8b0c1e5a42";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    hostLive: 12,
    maxHostLive: 36,
    maxWorkspaceLive: 12,
    workspaces: [{ workspaceId, live: 12, maxLive: 12 }],
    ...overrides,
  };
}

describe("command-center admission contract", () => {
  it("keeps the frozen 12 per workspace and 36 per Host limits", () => {
    expect(COMMAND_CENTER_ADMISSION_LIMITS).toEqual({ maxLivePerWorkspace: 12, maxLivePerHost: 36 });
    expect(Object.isFrozen(COMMAND_CENTER_ADMISSION_LIMITS)).toBe(true);
    expect(COMMAND_CENTER_TERMINAL_ADMISSION_STATES).toEqual(["completed", "aborted", "failed", "launch_failed"]);
  });

  it("retains capacity for every non-terminal start state, including stopping and uncertain", () => {
    for (const state of ["reserved", "starting", "running", "waiting_tool", "waiting_human", "stopping", "outcome_unknown", "interrupted"] as const) {
      expect(commandCenterAdmissionHoldsCapacity(state)).toBe(true);
    }
    for (const state of COMMAND_CENTER_TERMINAL_ADMISSION_STATES) {
      expect(commandCenterAdmissionHoldsCapacity(state)).toBe(false);
    }
  });

  it("accepts a bounded capacity projection and rejects incoherent counts", () => {
    expect(Value.Check(CommandCenterAdmissionSnapshotSchema, snapshot())).toBe(true);
    expect(() => parseCommandCenterAdmissionSnapshot(snapshot())).not.toThrow();
    expect(() => parseCommandCenterAdmissionSnapshot(snapshot({ hostLive: 37 }))).toThrow("COMMAND_CENTER_INVALID_ADMISSION");
    expect(() => parseCommandCenterAdmissionSnapshot(snapshot({
      workspaces: [{ workspaceId, live: 13, maxLive: 12 }],
    }))).toThrow("COMMAND_CENTER_INVALID_ADMISSION");
    expect(() => parseCommandCenterAdmissionSnapshot(snapshot({
      hostLive: 0,
      workspaces: [
        { workspaceId, live: 12, maxLive: 12 },
        { workspaceId: otherWorkspaceId, live: 12, maxLive: 12 },
      ],
    }))).toThrow("COMMAND_CENTER_INVALID_ADMISSION");
    expect(() => parseCommandCenterAdmissionSnapshot(snapshot({
      workspaces: [
        { workspaceId, live: 1, maxLive: 12 },
        { workspaceId, live: 1, maxLive: 12 },
      ],
    }))).toThrow("COMMAND_CENTER_INVALID_ADMISSION");
  });
});
