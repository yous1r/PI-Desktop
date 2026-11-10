import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOwnerHandoffSourceRequest, parseOwnerHandoffSourceReply } from "./owner-handoff-source.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff-source.json", import.meta.url), "utf8"));
describe("authenticated source queries", () => {
  it("refuses otherwise valid mutation commands until source transitions are implemented", () => {
    const original = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
    for (const command of original.source.filter((item: { operation: string }) => !["preflight", "status"].includes(item.operation))) {
      expect(() => parseOwnerHandoffSourceRequest({ protocol: "owner-transfer", version: 1, command })).toThrow("HANDOFF_INVALID_REQUEST");
    }
  });
  it("shares preflight and original transfer status envelopes with Rust", () => {
    for (const key of ["preflight", "status"] as const) {
      const request = parseOwnerHandoffSourceRequest(fixture[key].request);
      expect(parseOwnerHandoffSourceReply(fixture[key].reply, request, fixture.profileId)).toEqual(fixture[key].reply);
    }
  });
  it("requires the negotiated protocol and forbids caller supplied authority", () => {
    for (const request of [{ ...fixture.preflight.request, protocol: "owner-control" },
      { ...fixture.preflight.request, version: 2 }, { ...fixture.preflight.request, pid: 1 },
      { ...fixture.preflight.request, command: { ...fixture.preflight.request.command, idle: true } },
      { ...fixture.preflight.request, command: { ...fixture.preflight.request.command, requestId: "x".repeat(17000) } }]) {
      expect(() => parseOwnerHandoffSourceRequest(request)).toThrow("HANDOFF_INVALID_REQUEST");
    }
  });
  it("rejects replacement identities, mixed replies, invalid operations and mismatched target builds", () => {
    const request = parseOwnerHandoffSourceRequest(fixture.preflight.request);
    for (const reply of [{ ...fixture.preflight.reply, requestId: request.command.sourceEpoch },
      { ...fixture.preflight.reply, sourceEpoch: request.command.requestId },
      { ...fixture.preflight.reply, profileId: "f".repeat(64) },
      { ...fixture.preflight.reply, result: fixture.status.reply.result },
      { ...fixture.preflight.reply, result: { ...fixture.preflight.reply.result, ready: true } },
      { ...fixture.preflight.reply, error: { code: "HANDOFF_UNAVAILABLE" } }]) {
      expect(() => parseOwnerHandoffSourceReply(reply, request, fixture.profileId)).toThrow("HANDOFF_INVALID_RESPONSE");
    }
  });
  it("accepts only fixed refusal codes and validates status record ownership", () => {
    const request = parseOwnerHandoffSourceRequest(fixture.status.request);
    const refusal = { ...fixture.status.reply, result: { version: 1, error: { code: "HANDOFF_UNAVAILABLE" } } };
    expect(parseOwnerHandoffSourceReply(refusal, request, fixture.profileId)).toEqual(refusal);
    for (const result of [{ version: 1, error: { code: "HANDOFF_secret" } },
      { version: 1, error: { code: "HANDOFF_STORAGE_ERROR", message: "private" } },
      { ...fixture.status.reply.result, record: { ...fixture.status.reply.result.record, profile: "f".repeat(64) } },
      { ...fixture.status.reply.result, record: { ...fixture.status.reply.result.record, id: request.command.sourceEpoch } }]) {
      expect(() => parseOwnerHandoffSourceReply({ ...refusal, result }, request, fixture.profileId)).toThrow("HANDOFF_INVALID_RESPONSE");
    }
  });
});
