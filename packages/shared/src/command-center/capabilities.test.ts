import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_CAPABILITIES, COMMAND_CENTER_IMPLEMENTED_CAPABILITIES,
  type CommandCenterCapabilities, CommandCenterCapabilitiesSchema,
  commandCenterCapabilityAvailable, parseCommandCenterCapabilities,
} from "./capabilities.js";

/** One `true` claim per capability name; kept explicit so the type stays exact. */
const singleClaims: CommandCenterCapabilities[] = [
  { workspaceList: true },
  { workspaceUpdate: true },
  { membershipBind: true },
  { monitor: true },
  { conversation: true },
  { interventions: true },
];

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));

describe("command-center capability advertisement", () => {
  it("implements and therefore advertises nothing in C1", () => {
    expect(COMMAND_CENTER_IMPLEMENTED_CAPABILITIES).toEqual([]);
    expect(Object.isFrozen(COMMAND_CENTER_IMPLEMENTED_CAPABILITIES)).toBe(true);
    expect(COMMAND_CENTER_CAPABILITIES).toEqual([
      "workspaceList", "workspaceUpdate", "membershipBind", "monitor", "conversation", "interventions",
    ]);
    COMMAND_CENTER_CAPABILITIES.forEach((name, index) => {
      expect(commandCenterCapabilityAvailable(undefined, name)).toBe(false);
      expect(commandCenterCapabilityAvailable(singleClaims[index], name)).toBe(false);
      expect(commandCenterCapabilityAvailable({}, name)).toBe(false);
    });
  });

  it("treats an absent or empty block as the normal current wire state", () => {
    expect(parseCommandCenterCapabilities(undefined)).toEqual([]);
    expect(parseCommandCenterCapabilities(null)).toEqual([]);
    expect(parseCommandCenterCapabilities({})).toEqual([]);
    expect(parseCommandCenterCapabilities(fixture.capabilities.advertised)).toEqual([]);
    expect(Value.Check(CommandCenterCapabilitiesSchema, fixture.capabilities.advertised)).toBe(true);
    // Explicit `false` claims nothing; a client may send them after negotiation.
    expect(parseCommandCenterCapabilities({ monitor: false, interventions: false })).toEqual([]);
  });

  it("rejects a producer that advertises an unimplemented path", () => {
    for (const name of COMMAND_CENTER_CAPABILITIES) {
      expect(() => parseCommandCenterCapabilities({ [name]: true })).toThrow("COMMAND_CENTER_CAPABILITY_UNAVAILABLE");
    }
    expect(() => parseCommandCenterCapabilities({ monitor: "yes" })).toThrow("COMMAND_CENTER_INVALID_CAPABILITIES");
    expect(() => parseCommandCenterCapabilities({ ...fixture.capabilities.advertised, monitor: true })).toThrow(
      "COMMAND_CENTER_CAPABILITY_UNAVAILABLE",
    );
    expect(() => parseCommandCenterCapabilities({ commandCenter: { monitor: true } })).toThrow("COMMAND_CENTER_INVALID_CAPABILITIES");
    // A typo must not silently enable or silently disable a path.
    expect(() => parseCommandCenterCapabilities({ monitors: true })).toThrow("COMMAND_CENTER_INVALID_CAPABILITIES");
    expect(Value.Check(CommandCenterCapabilitiesSchema, { monitor: true, unknown: false })).toBe(false);
  });
});

describe("command-center capability wiring boundary", () => {
  it("keeps capability names unambiguous for future negotiation", () => {
    // The RACP capability block is the future registration site; these names stay
    // contract-local until a producer, consumer and negotiation test exist.
    expect(new Set(COMMAND_CENTER_CAPABILITIES).size).toBe(COMMAND_CENTER_CAPABILITIES.length);
    for (const name of COMMAND_CENTER_CAPABILITIES) expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
  });
});
