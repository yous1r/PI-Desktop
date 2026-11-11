import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_RECEIPT_RETENTION, COMMAND_CENTER_RECEIPT_STATUSES, COMMAND_CENTER_RECEIPT_TRANSITIONS,
  CommandCenterReceiptSchema, commandCenterConsumptionBindsReceipt, commandCenterReceiptBindsRequest,
  commandCenterReceiptCanTransition, parseCommandCenterReceipt,
} from "./receipt.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));
const receipts = Object.values(fixture.receipts) as Record<string, unknown>[];

describe("command-center intervention receipt contract", () => {
  it("accepts every golden receipt state and the retained first-release policy", () => {
    expect(Value.Check(CommandCenterReceiptSchema, fixture.receipt)).toBe(true);
    for (const receipt of receipts) expect(() => parseCommandCenterReceipt(receipt)).not.toThrow();
    expect(() => parseCommandCenterReceipt(fixture.stopReceipt)).not.toThrow();
    expect(COMMAND_CENTER_RECEIPT_RETENTION).toBe("retained");
    expect(COMMAND_CENTER_RECEIPT_STATUSES).toEqual([
      "recorded", "accepted", "consumed", "completed", "rejected", "conflicted", "interrupted", "outcome_unknown",
    ]);
  });

  it("binds a receipt to the exact request, operation and native generation", () => {
    expect(commandCenterReceiptBindsRequest(fixture.receipt, fixture.request)).toBe(true);
    expect(commandCenterReceiptBindsRequest(fixture.stopReceipt, fixture.stopRequest)).toBe(true);
    expect(commandCenterReceiptBindsRequest(fixture.stopReceipt, fixture.request)).toBe(false);
    expect(commandCenterReceiptBindsRequest({
      ...fixture.receipt,
      target: fixture.targets.replacementExecution,
    }, fixture.request)).toBe(false);
    expect(commandCenterReceiptBindsRequest({
      ...fixture.receipt,
      requestId: "a1111111-1111-4111-8111-111111111111",
    }, fixture.request)).toBe(false);
  });

  it("rejects unordered revisions, illegal error evidence and Stop consumption", () => {
    expect(() => parseCommandCenterReceipt({ ...fixture.receipt, effectiveGoalRevision: 6 })).toThrow("COMMAND_CENTER_INVALID_RECEIPT");
    expect(() => parseCommandCenterReceipt({ ...fixture.receipt, status: "rejected" })).toThrow("COMMAND_CENTER_INVALID_RECEIPT");
    expect(() => parseCommandCenterReceipt({ ...fixture.receipt, status: "accepted", error: { code: "CONFLICT", message: "no" } }))
      .toThrow("COMMAND_CENTER_INVALID_RECEIPT");
    expect(() => parseCommandCenterReceipt({
      ...fixture.stopReceipt,
      status: "consumed",
      effectiveGoalRevision: 5,
    })).toThrow("COMMAND_CENTER_INVALID_RECEIPT");
    expect(Value.Check(CommandCenterReceiptSchema, { ...fixture.receipt, principal: "owner" })).toBe(false);
    expect(Value.Check(CommandCenterReceiptSchema, { ...fixture.receipt, revision: 0 })).toBe(false);
    expect(Value.Check(CommandCenterReceiptSchema, {
      ...fixture.receipt,
      status: "rejected",
      error: { code: "CONFLICT", message: "x".repeat(513) },
    })).toBe(false);
  });

  it("keeps terminal receipts terminal and does not invent reconciliation", () => {
    expect(COMMAND_CENTER_RECEIPT_TRANSITIONS.recorded).toEqual(["accepted", "rejected", "conflicted", "interrupted", "outcome_unknown"]);
    expect(commandCenterReceiptCanTransition("recorded", "accepted")).toBe(true);
    expect(commandCenterReceiptCanTransition("accepted", "consumed")).toBe(true);
    expect(commandCenterReceiptCanTransition("consumed", "completed")).toBe(true);
    expect(commandCenterReceiptCanTransition("completed", "accepted")).toBe(false);
    expect(commandCenterReceiptCanTransition("rejected", "accepted")).toBe(false);
    expect(commandCenterReceiptCanTransition("interrupted", "accepted")).toBe(false);
    expect(commandCenterReceiptCanTransition("consumed", "accepted")).toBe(false);
    expect(COMMAND_CENTER_RECEIPT_TRANSITIONS.outcome_unknown).toEqual([]);
  });

  it("binds a consumption acknowledgement to the exact request, execution and committed revision", () => {
    const accepted = fixture.receipts.accepted;
    expect(commandCenterConsumptionBindsReceipt(fixture.consumption, accepted)).toBe(true);
    expect(commandCenterConsumptionBindsReceipt({ ...fixture.consumption, requestId: "a1111111-1111-4111-8111-111111111111" }, accepted)).toBe(false);
    expect(commandCenterConsumptionBindsReceipt({ ...fixture.consumption, consumedRevision: 4 }, accepted)).toBe(false);
    expect(commandCenterConsumptionBindsReceipt({ ...fixture.consumption, target: fixture.targets.replacementExecution }, accepted)).toBe(false);
    expect(commandCenterConsumptionBindsReceipt({ ...fixture.consumption, boundary: "Invalid Boundary" }, accepted)).toBe(false);
  });
});
