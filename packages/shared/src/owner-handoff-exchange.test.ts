import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseOwnerHandoffExchange, parseOwnerHandoffCompletion, parseOwnerHandoffCompletionAck,
} from "./owner-handoff-exchange.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff-exchange.json", import.meta.url), "utf8"));
describe("private original-owner exchange contract", () => {
  it("shares bounded request, success, refusal and acknowledgement fixtures with Rust", () => {
    const request = parseOwnerHandoffExchange(fixture.notification);
    expect(parseOwnerHandoffCompletion(fixture.success, request)).toEqual(fixture.success);
    expect(parseOwnerHandoffCompletion(fixture.refusal, request)).toEqual(fixture.refusal);
    expect(parseOwnerHandoffCompletionAck(fixture.ack, request)).toEqual(fixture.ack);
  });
  it("rejects unsupported, malformed and oversized notifications", () => {
    const notification = fixture.notification;
    for (const value of [null, [], { ...notification, version: 2 }, { ...notification, extra: true },
      { ...notification, profileId: "f".repeat(17000) },
      ...[{ revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { holdId: notification.request.exchangeId },
        { sourceEpoch: "00000000-0000-0000-0000-000000000000" }, { operation: "ready" }]
        .map(fields => ({ ...notification, request: { ...notification.request, ...fields } }))]) {
      expect(() => parseOwnerHandoffExchange(value)).toThrow("HANDOFF_INVALID_EXCHANGE");
    }
  });
  it("correlates every original request field and the trusted profile", () => {
    for (const fields of [{ exchangeId: fixture.success.outcome.report.holdId }, { revision: 2 },
      { sourceEpoch: fixture.success.outcome.report.holdId }, { transferId: fixture.success.outcome.report.holdId },
      { operation: "inspect", holdId: fixture.success.outcome.report.holdId }]) {
      expect(() => parseOwnerHandoffCompletion({ ...fixture.success, request: { ...fixture.success.request, ...fields } }, fixture.notification))
        .toThrow("HANDOFF_INVALID_COMPLETION");
    }
    expect(() => parseOwnerHandoffCompletion({ ...fixture.success, profileId: "f".repeat(64) }, fixture.notification)).toThrow();
  });
  it("never accepts error payloads, mixed outcomes or non-idle hold success", () => {
    for (const outcome of [{}, { error: { code: "secret/path" } }, { error: { code: "HANDOFF_BUSY", message: "secret" } },
      { ...fixture.success.outcome, ...fixture.refusal.outcome },
      { report: { ...fixture.success.outcome.report, counts: { ...fixture.success.outcome.report.counts, writes: 1 } } }]) {
      expect(() => parseOwnerHandoffCompletion({ ...fixture.success, outcome }, fixture.notification)).toThrow();
    }
  });
  it("requires the exact bounded completion acknowledgement", () => {
    for (const value of [{ ...fixture.ack, accepted: false }, { ...fixture.ack, exchangeId: fixture.success.outcome.report.holdId },
      { ...fixture.ack, extra: true }, null]) expect(() => parseOwnerHandoffCompletionAck(value, fixture.notification)).toThrow();
  });
});
