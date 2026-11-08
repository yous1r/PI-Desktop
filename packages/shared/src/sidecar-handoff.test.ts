import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { SidecarHandoffRequestSchema, SidecarHandoffStatusSchema } from "./sidecar-handoff.js";

const identity = { version: 1, transferId: "11111111-1111-4111-8111-111111111111", sourceEpoch: "22222222-2222-4222-8222-222222222222", revision: 1 };
const holdId = "33333333-3333-4333-8333-333333333333";
const counts = { turns: 0, children: 0, tools: 0, inputs: 0, settlements: 0, nativeSessions: 0, unqualifiedResources: 0, requests: 0, executions: 0 };

describe("private sidecar handoff contract", () => {
  it("accepts explicit mutations and identity-only status after lost replies", () => {
    for (const request of [{ ...identity, operation: "acquire" }, { ...identity, operation: "status" },
      ...["status", "cancel", "seal"].map(operation => ({ ...identity, operation, holdId }))]) {
      expect(Value.Check(SidecarHandoffRequestSchema, request)).toBe(true);
    }
    for (const state of ["held", "sealed", "cancelled"]) expect(Value.Check(SidecarHandoffStatusSchema, { ...identity, holdId, state, counts })).toBe(true);
  });
  it("refuses omitted resource counters, unsafe revisions and capability-confusing fields", () => {
    for (const key of Object.keys(counts)) {
      expect(Value.Check(SidecarHandoffStatusSchema, { ...identity, holdId, state: "held", counts: { ...counts, [key]: undefined } })).toBe(false);
    }
    for (const request of [{ ...identity, operation: "cancel" }, { ...identity, operation: "seal" },
      { ...identity, operation: "acquire", pid: 1 }, { ...identity, operation: "acquire", capability: holdId },
      { ...identity, operation: "acquire", revision: Number.MAX_SAFE_INTEGER + 1 }, { ...identity, operation: "acquire", revision: -1 },
      { ...identity, operation: "acquire", sourceEpoch: "00000000-0000-0000-0000-000000000000" }]) {
      expect(Value.Check(SidecarHandoffRequestSchema, request)).toBe(false);
    }
  });
});
