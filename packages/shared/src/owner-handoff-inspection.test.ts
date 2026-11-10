import { describe, expect, it } from "vitest";
import { parseOwnerHandoffInspection, parseOwnerHandoffInspectionRequest } from "./owner-handoff-inspection.js";

const request = { version: 1 as const, requestId: "11111111-1111-4111-8111-111111111111",
  sourceEpoch: "22222222-2222-4222-8222-222222222222", profileId: "a".repeat(64),
  generation: "33333333-3333-4333-8333-333333333333" };
const response = { ...request, activity: { requests: 0, backgroundTasks: 0, writes: 0, uncertain: false },
  durable: { turns: false, queuedTurns: false, plans: false, approvals: false, scheduledRuns: false,
    modeClaims: false, modeWaits: false, worktrees: false, workers: 0 },
  runtime: { tools: false, backgroundProcesses: false, remoteExecutions: false, pluginExecutions: false, permissions: false, configSync: false },
  nativeCoverage: "execution_generation_only", native: { generation: request.generation,
    state: "running", activeProcesses: 1, rootExited: false, confirmed: false } };

describe("Rust owner inspection contract", () => {
  it("accepts complete facts without certifying whole-owner native closure", () => {
    expect(parseOwnerHandoffInspection(response, request)).toEqual(response);
    expect(parseOwnerHandoffInspection({ ...response, activity: { ...response.activity, uncertain: true, writes: 2 } }, request).activity.uncertain).toBe(true);
    expect(parseOwnerHandoffInspection({ ...response, durable: { ...response.durable, workers: 3 } }, request).durable.workers).toBe(3);
  });
  it("requires canonical bounded identities and never accepts caller supplied inventory", () => {
    for (const invalid of [{ ...request, idle: true }, { ...request, counts: {} }, { ...request, version: 2 },
      { ...request, sourceEpoch: "00000000-0000-0000-0000-000000000000" },
      { ...request, generation: "x".repeat(17000) }, { ...request, profileId: "A".repeat(64) }]) {
      expect(() => parseOwnerHandoffInspectionRequest(invalid)).toThrow("HANDOFF_INVALID_REQUEST");
    }
  });
  it("binds every response to the original outstanding request and native generation", () => {
    for (const key of ["requestId", "sourceEpoch", "generation", "profileId"] as const) {
      expect(() => parseOwnerHandoffInspection({ ...response, [key]: key === "profileId" ? "b".repeat(64) : "44444444-4444-4444-8444-444444444444" }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
    }
    expect(() => parseOwnerHandoffInspection({ ...response, native: { ...response.native, generation: request.sourceEpoch } }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
  });
  it("rejects missing or malformed facts instead of defaulting to idle", () => {
    for (const group of ["activity", "durable", "runtime"] as const) {
      for (const field of Object.keys(response[group])) {
        expect(() => parseOwnerHandoffInspection({ ...response, [group]: { ...response[group], [field]: undefined } }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
      }
      expect(() => parseOwnerHandoffInspection({ ...response, [group]: { ...response[group], extra: 0 } }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
    }
    for (const writes of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseOwnerHandoffInspection({ ...response, activity: { ...response.activity, writes } }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
    }
    for (const workers of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, true, "1"]) {
      expect(() => parseOwnerHandoffInspection({ ...response, durable: { ...response.durable, workers } }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
    }
    expect(() => parseOwnerHandoffInspection({ ...response, nativeCoverage: "complete" }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
  });
  it("refuses contradictory native state even when durable and runtime work are empty", () => {
    for (const native of [{ ...response.native, confirmed: true }, { ...response.native, rootExited: true },
      { ...response.native, activeProcesses: 0 }, { ...response.native, state: "closed", confirmed: true }]) {
      expect(() => parseOwnerHandoffInspection({ ...response, native }, request)).toThrow("HANDOFF_INVALID_INSPECTION");
    }
  });
});
