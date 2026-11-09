import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  OwnerHandoffBootstrapCommandSchema, OwnerHandoffSourceCommandSchema,
  parseOwnerHandoffResponse, parseOwnerHandoffReady, ownerHandoffNextPhase,
  parseOwnerHandoffQuiescenceReport, parseOwnerHandoffSourceCommand, parseOwnerHandoffBootstrapCommand,
  parseOwnerHandoffPreflight,
  type OwnerHandoffInventory,
} from "./owner-handoff.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff.json", import.meta.url), "utf8"));

describe("owner handoff contracts", () => {
  it("reads the same durable record and restricted commands as Rust without rounding FILETIME", () => {
    const result = parseOwnerHandoffResponse(fixture.response);
    expect(result).toEqual(fixture.response);
    if (!("record" in result)) throw new Error("missing fixture record");
    expect(BigInt(result.record.requester.createdAt)).toBe(134115649234567891n);
    for (const command of fixture.bootstrap) expect(Value.Check(OwnerHandoffBootstrapCommandSchema, command)).toBe(true);
    expect(parseOwnerHandoffResponse(fixture.failure)).toEqual(fixture.failure);
  });

  it("rejects invalid durable identity, numeric loss, unsupported schema and oversized metadata", () => {
    const r = fixture.response.record;
    for (const record of [{ ...r, targetEpoch: r.sourceEpoch }, { ...r, version: 2 },
      { ...r, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...r, phase: "executing" },
      { ...r, capability: fixture.bootstrap[1].capability },
      ...[28, 29, 31].map(schema => ({ ...r, sourceBuild: { ...r.sourceBuild, schema } })),
      ...[134115649234567891, "0134115649234567891", "18446744073709551616", "0"].map(createdAt => ({ ...r, requester: { ...r.requester, createdAt } })),
      { ...r, requester: { ...r.requester, image: "文".repeat(3000) } }]) {
      expect(() => parseOwnerHandoffResponse({ version: 1, record })).toThrow("HANDOFF_INVALID_RESPONSE");
    }
    expect(() => parseOwnerHandoffResponse({ ...fixture.response, error: { code: "HANDOFF_BUSY" } })).toThrow("HANDOFF_INVALID_RESPONSE");
    expect(() => parseOwnerHandoffResponse({ version: 1, error: { code: "secret/path" } })).toThrow("HANDOFF_INVALID_RESPONSE");
    expect(() => parseOwnerHandoffResponse({ version: 1, error: { code: "HANDOFF_" + "A".repeat(17000) } })).toThrow("HANDOFF_INVALID_RESPONSE");
  });

  it("source operations never accept a caller's idle/process inventory or arbitrary phase", () => {
    for (const command of fixture.source) expect(Value.Check(OwnerHandoffSourceCommandSchema, command)).toBe(true);
    for (const field of ["idle", "counts", "pid", "path", "sourceBuild", "phase", "requester"]) {
      expect(Value.Check(OwnerHandoffSourceCommandSchema, { ...fixture.source[1], [field]: true })).toBe(false);
    }
    expect(Value.Check(OwnerHandoffSourceCommandSchema, { ...fixture.source[1], expectedRevision: 1 })).toBe(false);
    expect(Value.Check(OwnerHandoffSourceCommandSchema, { ...fixture.source[3], expectedRevision: 0 })).toBe(false);
    expect(Value.Check(OwnerHandoffSourceCommandSchema, { ...fixture.source[3], operation: "ready" })).toBe(false);
    expect(Value.Check(OwnerHandoffBootstrapCommandSchema, { ...fixture.bootstrap[1], operation: "ready" })).toBe(false);
  });

  it("limits transitions by operation and never treats intent as closure or readiness", () => {
    expect(ownerHandoffNextPhase("prepared", "cancel")).toBe("cancelled");
    expect(ownerHandoffNextPhase("prepared", "beginFencing")).toBe("source_fencing");
    expect(ownerHandoffNextPhase("source_fencing", "confirmFenced")).toBe("source_fenced");
    expect(ownerHandoffNextPhase("source_fenced", "release")).toBe("release_pending");
    expect(ownerHandoffNextPhase("release_pending", "claim")).toBe("target_claimed");
    expect(ownerHandoffNextPhase("target_claimed", "ready")).toBe("ready");
    for (const phase of ["source_fencing", "source_fenced", "release_pending", "target_claimed", "ready", "cancelled"] as const) {
      expect(ownerHandoffNextPhase(phase, "cancel")).toBeUndefined();
    }
    expect(ownerHandoffNextPhase("prepared", "ready")).toBeUndefined();
    expect(ownerHandoffNextPhase("source_fencing", "release")).toBeUndefined();
    expect(ownerHandoffNextPhase("cancelled", "beginFencing")).toBeUndefined();
  });

  it("binds client readiness to a committed ready record and requires fresh snapshot attachment", () => {
    const record = { ...fixture.response.record, phase: "ready", revision: 6 };
    expect(parseOwnerHandoffReady(fixture.ready, record)).toEqual(fixture.ready);
    for (const ready of [{ ...fixture.ready, ownerEpoch: record.sourceEpoch }, { ...fixture.ready, recordRevision: 5 },
      { ...fixture.ready, profileId: "f".repeat(64) }, { ...fixture.ready, snapshotRequired: false },
      { ...fixture.ready, eventEpoch: "" }, { ...fixture.ready, protocolVersion: 12 }]) {
      expect(() => parseOwnerHandoffReady(ready, record)).toThrow("HANDOFF_INVALID_READY");
    }
    expect(() => parseOwnerHandoffReady(fixture.ready, { ...record, phase: "target_claimed" })).toThrow("HANDOFF_INVALID_READY");
  });
});

describe("original coordinator quiescence exchange", () => {
  const counts: OwnerHandoffInventory = { clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0,
    terminals: 0, plugins: 0, admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0,
    schedules: 0, approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0 };
  const request = { version: 1 as const, operation: "hold" as const, exchangeId: "44444444-4444-4444-8444-444444444444",
    transferId: fixture.response.record.id, sourceEpoch: fixture.response.record.sourceEpoch, revision: 1 };
  const response = { version: 1, exchangeId: request.exchangeId, transferId: request.transferId,
    sourceEpoch: request.sourceEpoch, revision: 1, holdId: "55555555-5555-4555-8555-555555555555", state: "held", counts };
  it("requires every resource family to be reported and idle before hold or seal", () => {
    expect(parseOwnerHandoffQuiescenceReport(response, request)).toEqual(response);
    for (const key of Object.keys(counts)) for (const value of [undefined, -1, 1, NaN]) {
      expect(() => parseOwnerHandoffQuiescenceReport({ ...response, counts: { ...counts, [key]: value } }, request)).toThrow("HANDOFF_INVALID_QUIESCENCE");
    }
  });
  it("rejects stale exchanges and preserves distinct cancellation and sealing states", () => {
    for (const bad of [{ ...response, exchangeId: response.holdId }, { ...response, revision: 2 },
      { ...response, sourceEpoch: response.holdId }, { ...response, state: "cancelled" }, { ...response, pid: 1 }]) {
      expect(() => parseOwnerHandoffQuiescenceReport(bad, request)).toThrow("HANDOFF_INVALID_QUIESCENCE");
    }
    const seal = { ...request, operation: "seal" as const, holdId: response.holdId };
    expect(parseOwnerHandoffQuiescenceReport({ ...response, state: "sealed" }, seal).state).toBe("sealed");
    expect(() => parseOwnerHandoffQuiescenceReport(response, seal)).toThrow("HANDOFF_INVALID_QUIESCENCE");
    const cancel = { ...seal, operation: "cancel" as const };
    expect(parseOwnerHandoffQuiescenceReport({ ...response, state: "cancelled" }, cancel).state).toBe("cancelled");
    expect(() => parseOwnerHandoffQuiescenceReport({ ...response, state: "sealed" }, cancel)).toThrow("HANDOFF_INVALID_QUIESCENCE");
  });
  it("rejects noncanonical identity text and equal source/target epochs at parsing boundaries", () => {
    expect(() => parseOwnerHandoffSourceCommand({ ...fixture.source[1], targetEpoch: fixture.source[1].sourceEpoch })).toThrow("HANDOFF_INVALID_REQUEST");
    expect(() => parseOwnerHandoffBootstrapCommand({ ...fixture.bootstrap[1], target_epoch: fixture.bootstrap[1].source_epoch })).toThrow("HANDOFF_INVALID_REQUEST");
    expect(() => parseOwnerHandoffBootstrapCommand({ ...fixture.bootstrap[0], transfer_id: request.transferId + "\n" })).toThrow("HANDOFF_INVALID_REQUEST");
    for (const record of [{ ...fixture.response.record, id: request.transferId + "\n" },
      { ...fixture.response.record, profile: fixture.response.record.profile + "\n" },
      { ...fixture.response.record, requester: { ...fixture.response.record.requester, createdAt: "1\n" } },
      { ...fixture.response.record, lastFailure: "HANDOFF_BUSY\n" }]) {
      expect(() => parseOwnerHandoffResponse({ version: 1, record })).toThrow("HANDOFF_INVALID_RESPONSE");
    }
  });
});

it("correlates advisory preflight with the source request and selected target build", () => {
  const request = parseOwnerHandoffSourceCommand(fixture.source[0]);
  if (request.operation !== "preflight") throw new Error("preflight fixture missing");
  const response = { version: 1, requestId: request.requestId, sourceEpoch: request.sourceEpoch,
    profileId: fixture.response.record.profile, sourceBuild: fixture.response.record.sourceBuild,
    targetBuild: request.targetBuild, requiresIdle: true };
  expect(parseOwnerHandoffPreflight(response, request)).toEqual(response);
  for (const bad of [{ ...response, requiresIdle: false }, { ...response, requestId: request.sourceEpoch },
    { ...response, sourceEpoch: request.requestId }, { ...response, ready: true },
    { ...response, targetBuild: { ...request.targetBuild, sha256: "f".repeat(64) } }]) {
    expect(() => parseOwnerHandoffPreflight(bad, request)).toThrow("HANDOFF_INVALID_PREFLIGHT");
  }
});
