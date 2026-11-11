import { describe, expect, it } from "vitest";
import { parseCommandCenterObservationOwner } from "./identity.js";

const owner = { hostId: "host_7c1e0a93b4d2f681", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" };

describe("command-center observation owner", () => {
  it("validates the existing Host fence fields without inventing membership or execution", () => {
    const value = { ...owner };
    const parsed = parseCommandCenterObservationOwner(value);
    expect(parsed).toEqual(owner);
    value.hostId = "host_changed";
    expect(parsed.hostId).toBe(owner.hostId);
  });

  it.each([
    undefined, null, {}, { hostId: owner.hostId }, { ...owner, hostId: "" },
    { ...owner, hostId: "with spaces" }, { ...owner, hostId: "C:/profile" },
    { ...owner, expectedHostEpoch: "00000000-0000-0000-0000-000000000000" },
    { ...owner, expectedHostEpoch: "wrong" }, { ...owner, role: "owner" },
    { ...owner, commandWorkspaceId: owner.expectedHostEpoch },
  ])("rejects invalid or authority-bearing input %#", (input) => {
    expect(() => parseCommandCenterObservationOwner(input)).toThrow("COMMAND_CENTER_INVALID_OWNER");
  });
});
