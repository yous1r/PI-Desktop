import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OWNER_HANDOFF_SOURCE_FAILURE_CODES, OWNER_HANDOFF_SOURCE_MUTATION_TIMEOUT_MS,
  OWNER_HANDOFF_SOURCE_OPERATION_PHASES, isOwnerHandoffSourceMutation, parseOwnerHandoffSourceReply,
  parseOwnerHandoffSourceRequest,
} from "./owner-handoff-source.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff-source.json", import.meta.url), "utf8"));
const original = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const operations = ["preflight", "status", "prepare", "cancel", "fence", "release"] as const;

describe("authenticated source envelope", () => {
  it("accepts every frozen H0 source command with a correlated receipt", () => {
    for (const key of operations) {
      const request = parseOwnerHandoffSourceRequest(fixture[key].request);
      expect(parseOwnerHandoffSourceReply(fixture[key].reply, request, fixture.profileId), key).toEqual(fixture[key].reply);
    }
  });
  it("keeps the original shared H0 command fingerprints unchanged", () => {
    for (const command of original.source) {
      expect(parseOwnerHandoffSourceRequest({ protocol: "owner-transfer", version: 1, command }).command).toEqual(command);
    }
    for (const command of original.bootstrap) {
      expect(() => parseOwnerHandoffSourceRequest({ protocol: "owner-transfer", version: 1, command })).toThrow("HANDOFF_INVALID_REQUEST");
    }
  });
  it("classifies mutations for transport budgets and binds their durable phase", () => {
    expect(OWNER_HANDOFF_SOURCE_MUTATION_TIMEOUT_MS).toBe(45000);
    for (const key of ["prepare", "cancel", "fence", "release"] as const) {
      const command = parseOwnerHandoffSourceRequest(fixture[key].request).command;
      expect(isOwnerHandoffSourceMutation(command), key).toBe(true);
      if (!isOwnerHandoffSourceMutation(command)) throw new Error(key);
      expect(OWNER_HANDOFF_SOURCE_OPERATION_PHASES[command.operation]).toBe(fixture[key].reply.result.record.phase);
    }
    for (const key of ["preflight", "status"] as const) {
      expect(isOwnerHandoffSourceMutation(parseOwnerHandoffSourceRequest(fixture[key].request).command), key).toBe(false);
    }
  });
  it("requires the negotiated protocol and forbids caller supplied authority", () => {
    for (const request of [{ ...fixture.preflight.request, protocol: "owner-control" },
      { ...fixture.preflight.request, version: 2 }, { ...fixture.preflight.request, pid: 1 },
      { ...fixture.preflight.request, command: { ...fixture.preflight.request.command, idle: true } },
      { ...fixture.prepare.request, command: { ...fixture.prepare.request.command, proof: "native" } },
      { ...fixture.prepare.request, command: { ...fixture.prepare.request.command, requestId: "x".repeat(17000) } },
      { ...fixture.prepare.request, command: { ...fixture.prepare.request.command, capabilityHash: "c".repeat(17000) } }]) {
      expect(() => parseOwnerHandoffSourceRequest(request)).toThrow("HANDOFF_INVALID_REQUEST");
    }
  });
  it("refuses golden invalid requests: caller proof, revision bounds, identity and target drift", () => {
    expect(fixture.rejectedRequests.length).toBeGreaterThanOrEqual(17);
    for (const item of fixture.rejectedRequests) {
      expect(() => parseOwnerHandoffSourceRequest(item.request), item.case).toThrow("HANDOFF_INVALID_REQUEST");
    }
  });
  it("refuses golden invalid replies: phase, identity, target and profile substitution", () => {
    expect(fixture.rejectedReplies.length).toBeGreaterThanOrEqual(14);
    for (const item of fixture.rejectedReplies) {
      const request = parseOwnerHandoffSourceRequest(fixture[item.operation].request);
      expect(() => parseOwnerHandoffSourceReply(item.reply, request, item.profileId ?? fixture.profileId), item.case)
        .toThrow("HANDOFF_INVALID_RESPONSE");
    }
  });
  it("rejects replacement identities, mixed replies and mismatched target builds", () => {
    const request = parseOwnerHandoffSourceRequest(fixture.preflight.request);
    for (const reply of [{ ...fixture.preflight.reply, requestId: request.command.sourceEpoch },
      { ...fixture.preflight.reply, sourceEpoch: request.command.requestId },
      { ...fixture.preflight.reply, profileId: "f".repeat(64) },
      { ...fixture.preflight.reply, result: fixture.status.reply.result },
      { ...fixture.preflight.reply, result: { ...fixture.preflight.reply.result, ready: true } },
      { ...fixture.preflight.reply, error: { code: "HANDOFF_UNAVAILABLE" } }]) {
      expect(() => parseOwnerHandoffSourceReply(reply, request, fixture.profileId)).toThrow("HANDOFF_INVALID_RESPONSE");
    }
    for (const key of ["prepare", "cancel", "fence", "release"] as const) {
      const mutation = parseOwnerHandoffSourceRequest(fixture[key].request);
      for (const reply of [
        { ...fixture[key].reply, requestId: "77777777-7777-4777-8777-777777777777" },
        { ...fixture[key].reply, sourceEpoch: "99999999-9999-4999-8999-999999999999" },
        { ...fixture[key].reply, result: fixture.preflight.reply.result }]) {
        expect(() => parseOwnerHandoffSourceReply(reply, mutation, fixture.profileId), key).toThrow("HANDOFF_INVALID_RESPONSE");
      }
    }
  });
  it("accepts replayed historic revisions while binding the operation's phase", () => {
    const request = parseOwnerHandoffSourceRequest(fixture.prepare.request);
    const replay = structuredClone(fixture.prepare.reply);
    replay.result.record.revision = 9;
    expect(parseOwnerHandoffSourceReply(replay, request, fixture.profileId)).toEqual(replay);
    // The fence script commits intent and confirmation: expected + 2.
    expect(fixture.fence.reply.result.record.revision).toBe(fixture.fence.request.command.expectedRevision + 2);
    expect(fixture.cancel.reply.result.record.revision).toBe(fixture.cancel.request.command.expectedRevision + 1);
    expect(fixture.release.reply.result.record.revision).toBe(fixture.release.request.command.expectedRevision + 1);
    expect(fixture.prepare.reply.result.record.revision).toBe(1);
    const status = parseOwnerHandoffSourceRequest(fixture.status.request);
    for (const phase of ["prepared", "source_fencing", "source_fenced", "release_pending", "target_claimed", "ready", "cancelled"]) {
      const reply = structuredClone(fixture.status.reply);
      reply.result.record.phase = phase;
      expect(parseOwnerHandoffSourceReply(reply, status, fixture.profileId), phase).toEqual(reply);
    }
  });
  it("accepts only the fixed refusal vocabulary and validates status record ownership", () => {
    expect(OWNER_HANDOFF_SOURCE_FAILURE_CODES).toHaveLength(9);
    for (const request of [fixture.preflight.request, fixture.prepare.request]) {
      const parsed = parseOwnerHandoffSourceRequest(request);
      for (const code of OWNER_HANDOFF_SOURCE_FAILURE_CODES) {
        const refusal = { ...fixture.status.reply, result: { version: 1, error: { code } } };
        expect(parseOwnerHandoffSourceReply(refusal, parsed, fixture.profileId), code).toEqual(refusal);
      }
    }
    const request = parseOwnerHandoffSourceRequest(fixture.status.request);
    const refusal = { ...fixture.status.reply, result: { version: 1, error: { code: "HANDOFF_UNAVAILABLE" } } };
    expect(parseOwnerHandoffSourceReply(refusal, request, fixture.profileId)).toEqual(refusal);
    for (const result of [{ version: 1, error: { code: "HANDOFF_secret" } },
      { version: 1, error: { code: "HANDOFF_STORAGE_ERROR", message: "private" } },
      { ...fixture.status.reply.result, record: { ...fixture.status.reply.result.record, profile: "f".repeat(64) } },
      { ...fixture.status.reply.result, record: { ...fixture.status.reply.result.record, id: request.command.sourceEpoch } }]) {
      expect(() => parseOwnerHandoffSourceReply({ ...refusal, result }, request, fixture.profileId)).toThrow("HANDOFF_INVALID_RESPONSE");
    }
    const oversized = structuredClone(fixture.status.reply);
    oversized.result.record.requester.image = "x".repeat(17000);
    expect(() => parseOwnerHandoffSourceReply(oversized, request, fixture.profileId)).toThrow("HANDOFF_INVALID_RESPONSE");
  });
});
