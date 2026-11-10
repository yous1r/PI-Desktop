import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CommandCenterConsumptionSchema, CommandCenterGoalHeadSchema,
  applyCommandCenterConsumption, parseCommandCenterConsumption, parseCommandCenterGoalHead,
} from "./goal.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));

describe("command-center goal revisions and consumption", () => {
  it("keeps desired ahead of effective until an exact acknowledgement arrives", () => {
    const head = parseCommandCenterGoalHead(fixture.goalHead);
    expect(head.desiredRevision).toBe(5);
    expect(head.effectiveRevision).toBe(4);
    expect(Value.Check(CommandCenterGoalHeadSchema, fixture.goalHead)).toBe(true);
    expect(Value.Check(CommandCenterConsumptionSchema, fixture.consumption)).toBe(true);
  });

  it("rejects an effective revision ahead of the committed desired revision", () => {
    expect(() => parseCommandCenterGoalHead({ ...fixture.goalHead, effectiveRevision: 6 })).toThrow("COMMAND_CENTER_INVALID_GOAL");
    expect(Value.Check(CommandCenterGoalHeadSchema, { ...fixture.goalHead, effectiveRevision: -1 })).toBe(false);
    expect(Value.Check(CommandCenterGoalHeadSchema, { ...fixture.goalHead, target: fixture.targets.execution })).toBe(false);
  });

  it("advances effective only to the consumed revision", () => {
    const advanced = applyCommandCenterConsumption(fixture.goalHead, fixture.consumption);
    expect(advanced.desiredRevision).toBe(5);
    expect(advanced.effectiveRevision).toBe(5);
    // A duplicate runtime acknowledgement is idempotent, not a second advance.
    expect(applyCommandCenterConsumption(advanced, fixture.consumption)).toEqual(advanced);
  });

  it("rejects stale, uncommitted and unrelated consumption acknowledgements", () => {
    const advanced = { ...fixture.goalHead, effectiveRevision: 5 };
    expect(() => applyCommandCenterConsumption(advanced, {
      ...fixture.consumption, consumedRevision: fixture.goalHead.effectiveRevision,
    })).toThrow("COMMAND_CENTER_CONSUMPTION_STALE");
    expect(() => applyCommandCenterConsumption(fixture.goalHead, { ...fixture.consumption, consumedRevision: 6 }))
      .toThrow("COMMAND_CENTER_CONSUMPTION_AHEAD");
    expect(() => applyCommandCenterConsumption(fixture.goalHead, {
      ...fixture.consumption,
      target: { kind: "session", sessionId: "sess-other", turnId: "turn-other" },
    })).toThrow("COMMAND_CENTER_CONSUMPTION_TARGET");
  });

  it("requires a bounded boundary identifier instead of any accepted flag", () => {
    expect(Value.Check(CommandCenterConsumptionSchema, { ...fixture.consumption, boundary: "Agent Steer" })).toBe(false);
    expect(Value.Check(CommandCenterConsumptionSchema, { ...fixture.consumption, consumedRevision: 0 })).toBe(false);
    expect(Value.Check(CommandCenterConsumptionSchema, { ...fixture.consumption, accepted: true })).toBe(false);
    expect(() => parseCommandCenterConsumption({ ...fixture.consumption, boundary: "" })).toThrow("COMMAND_CENTER_INVALID_CONSUMPTION");
  });
});
