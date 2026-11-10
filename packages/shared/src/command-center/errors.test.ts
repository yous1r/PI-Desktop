import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../errors.js";
import {
  COMMAND_CENTER_ERROR_CODES, COMMAND_CENTER_ERROR_REASONS, CommandCenterErrorReasonSchema,
  commandCenterError, commandCenterErrorCode, commandCenterErrorMessage, parseCommandCenterErrorReason,
} from "./errors.js";
import { parseCommandCenterReceipt } from "./receipt.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));
const registeredCodes = new Set<string>(Object.values(ErrorCodes));

describe("command-center failure vocabulary", () => {
  it("maps every reason onto an already registered error family", () => {
    expect(COMMAND_CENTER_ERROR_REASONS).toHaveLength(new Set(COMMAND_CENTER_ERROR_REASONS).size);
    for (const reason of COMMAND_CENTER_ERROR_REASONS) {
      expect(Value.Check(CommandCenterErrorReasonSchema, reason)).toBe(true);
      expect(registeredCodes.has(commandCenterErrorCode(reason))).toBe(true);
    }
    // No new code is introduced by C1, so no consumer needs a new error family.
    expect([...new Set(Object.values(COMMAND_CENTER_ERROR_CODES))].sort()).toEqual([
      "CAPABILITY_UNAVAILABLE", "CLIENT_TOO_SLOW", "CONFLICT", "CURSOR_EXPIRED", "FORBIDDEN",
      "HOST_OVERLOADED", "HOST_UNAVAILABLE", "IDEMPOTENCY_CONFLICT", "INVALID_ARGUMENT",
      "LIMIT_EXCEEDED", "NOT_FOUND", "PAYLOAD_TOO_LARGE",
    ]);
  });

  it("keeps the shared failure fixture byte-identical to this table", () => {
    const fromFixture = Object.fromEntries(
      (fixture.failures as { reason: string; code: string }[]).map((entry) => [entry.reason, entry.code]),
    );
    expect(fromFixture).toEqual(COMMAND_CENTER_ERROR_CODES);
    expect(Object.keys(fromFixture)).toEqual([...COMMAND_CENTER_ERROR_REASONS]);
    for (const code of Object.values(fromFixture)) expect(registeredCodes.has(code)).toBe(true);
  });

  it("rejects an unregistered reason instead of inventing a code", () => {
    expect(() => parseCommandCenterErrorReason("payload_rejected")).toThrow("COMMAND_CENTER_INVALID_CALL");
    expect(() => parseCommandCenterErrorReason("CONFLICT")).toThrow("COMMAND_CENTER_INVALID_CALL");
    expect(parseCommandCenterErrorReason("goal_revision_conflict")).toBe("goal_revision_conflict");
    expect(() => commandCenterErrorMessage("forbidden_role", "")).toThrow("COMMAND_CENTER_INVALID_CALL");
  });

  it("produces error evidence the receipt schema accepts", () => {
    const error = commandCenterError("goal_revision_conflict", "desired revision 4 was expected");
    expect(error).toEqual({ code: "CONFLICT", message: "goal_revision_conflict: desired revision 4 was expected" });
    expect(error.message.length).toBeLessThanOrEqual(512);
    expect(() => parseCommandCenterReceipt({ ...fixture.receipt, status: "rejected", error })).not.toThrow();
    expect(() => parseCommandCenterReceipt({
      ...fixture.receipt,
      status: "conflicted",
      error: commandCenterError("request_fingerprint_conflict", "same request id, different payload"),
    })).not.toThrow();
    expect(commandCenterErrorMessage("payload_too_large", "x".repeat(600)).length).toBe(512);
  });
});
