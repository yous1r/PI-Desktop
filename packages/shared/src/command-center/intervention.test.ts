import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { COMMAND_CENTER_MAX_REQUEST_BYTES } from "./primitives.js";
import {
  CommandCenterInterventionRequestSchema, commandCenterCanonicalPayload, parseCommandCenterInterventionRequest,
} from "./intervention.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  }
  return value;
}

describe("command-center intervention request contract", () => {
  it("accepts the golden reviseGoal request and pins the canonical fingerprint vector", () => {
    const request = parseCommandCenterInterventionRequest(fixture.request);
    expect(request.intent.kind).toBe("reviseGoal");
    const canonical = commandCenterCanonicalPayload(fixture.request);
    expect(canonical).toBe(fixture.canonicalPayload);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(fixture.fingerprint);
  });

  it("canonicalizes key order but not semantic intent", () => {
    const reordered = reverseKeys(fixture.request);
    expect(commandCenterCanonicalPayload(reordered)).toBe(fixture.canonicalPayload);

    const textChanged = structuredClone(fixture.request);
    textChanged.intent.objective = `${textChanged.intent.objective} `;
    expect(commandCenterCanonicalPayload(textChanged)).not.toBe(fixture.canonicalPayload);

    const revisionChanged = structuredClone(fixture.request);
    revisionChanged.expectedGoalRevision = 5;
    expect(commandCenterCanonicalPayload(revisionChanged)).not.toBe(fixture.canonicalPayload);

    const generationChanged = structuredClone(fixture.request);
    generationChanged.target.executionGeneration = 3;
    expect(commandCenterCanonicalPayload(generationChanged)).not.toBe(fixture.canonicalPayload);

    const constraintOrderChanged = structuredClone(fixture.request);
    constraintOrderChanged.intent.constraints.reverse();
    expect(commandCenterCanonicalPayload(constraintOrderChanged)).not.toBe(fixture.canonicalPayload);
  });

  it("exempts Stop from the goal compare-and-swap but keeps the execution fence", () => {
    const stop = parseCommandCenterInterventionRequest(fixture.stopRequest);
    expect(stop.intent).toEqual({ kind: "stop", scope: "subtree" });
    expect(Value.Check(CommandCenterInterventionRequestSchema, { ...fixture.stopRequest, expectedGoalRevision: 4 })).toBe(false);
    expect(() => parseCommandCenterInterventionRequest({ ...fixture.stopRequest, expectedGoalRevision: 4 })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    expect(Value.Check(CommandCenterInterventionRequestSchema, { ...fixture.stopRequest, expectedHostEpoch: undefined })).toBe(false);
    expect(Value.Check(CommandCenterInterventionRequestSchema, { ...fixture.stopRequest, scope: "everything" })).toBe(false);
  });

  it("requires the expected goal revision for every non-stop intent", () => {
    const missing = structuredClone(fixture.request);
    delete missing.expectedGoalRevision;
    expect(() => parseCommandCenterInterventionRequest(missing)).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    const negative = { ...structuredClone(fixture.request), expectedGoalRevision: -1 };
    expect(Value.Check(CommandCenterInterventionRequestSchema, negative)).toBe(false);
  });

  it("never accepts caller-supplied principal, role or widened capability fields", () => {
    for (const injected of [
      { principal: { subject: "owner", roles: ["owner"] } },
      { role: "owner" },
      { roles: ["owner"] },
      { permissions: ["*"] },
      { commandWorkspacePath: "C:/Users/Administrator" },
    ]) {
      expect(() => parseCommandCenterInterventionRequest({ ...fixture.request, ...injected })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    }
    expect(() => parseCommandCenterInterventionRequest({
      ...fixture.request,
      intent: { ...fixture.request.intent, role: "owner" },
    })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    expect(JSON.stringify(CommandCenterInterventionRequestSchema)).not.toContain("principal");
    expect(JSON.stringify(CommandCenterInterventionRequestSchema)).not.toContain("role");
  });

  it("rejects empty intent text, oversized text bytes, invalid ids and unknown versions", () => {
    expect(() => parseCommandCenterInterventionRequest({
      ...fixture.request, intent: { ...fixture.request.intent, objective: "   \n\t" },
    })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    expect(() => parseCommandCenterInterventionRequest({
      ...fixture.request, intent: { ...fixture.request.intent, constraints: ["keep", "  "] },
    })).toThrow("COMMAND_CENTER_INVALID_REQUEST");

    // 100k multi-byte characters stay under the character cap but exceed 256 KiB of UTF-8.
    const multibyte = structuredClone(fixture.request);
    multibyte.intent.objective = "控".repeat(100_000);
    expect(Value.Check(CommandCenterInterventionRequestSchema, multibyte)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(multibyte)).byteLength).toBeGreaterThan(COMMAND_CENTER_MAX_REQUEST_BYTES);
    expect(() => parseCommandCenterInterventionRequest(multibyte)).toThrow("COMMAND_CENTER_INVALID_REQUEST");

    expect(() => parseCommandCenterInterventionRequest({ ...fixture.request, version: 2 })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    expect(() => parseCommandCenterInterventionRequest({ ...fixture.request, requestId: "request-1" })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    expect(() => parseCommandCenterInterventionRequest({
      ...fixture.request, commandWorkspaceId: "C:/Users/Administrator/work",
    })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
    expect(() => parseCommandCenterInterventionRequest({
      ...fixture.request, intent: { ...fixture.request.intent, constraints: Array.from({ length: 17 }, (_, index) => `constraint ${index}`) },
    })).toThrow("COMMAND_CENTER_INVALID_REQUEST");
  });
});
