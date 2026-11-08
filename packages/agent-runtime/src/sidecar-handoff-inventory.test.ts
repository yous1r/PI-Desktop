import { describe, expect, it } from "vitest";
import { SidecarHandoffInventory } from "./sidecar-handoff-inventory.js";
import { SidecarHandoff } from "./sidecar-handoff.js";
import type { RuntimeHandoffActivity } from "@pi-desktop/shared";

const idle = (): RuntimeHandoffActivity => ({ turns: 0, children: 0, tools: 0, inputs: 0, settlements: 0, unqualifiedResources: 0 });
const acquire = { version: 1, operation: "acquire", transferId: "11111111-1111-4111-8111-111111111111", sourceEpoch: "22222222-2222-4222-8222-222222222222", revision: 1 };

describe("sidecar owner inventory", () => {
  it("reads live owners without a second activity store", () => {
    const activity = { ...idle(), children: 1 };
    const owners = [{ getHandoffActivity: () => activity }];
    const inventory = new SidecarHandoffInventory(() => owners, () => false);
    const gate = new SidecarHandoff(() => inventory.inspect());
    expect(() => gate.control(acquire)).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_BUSY" }));
    activity.children = 0;
    expect(gate.control(acquire).state).toBe("held");
  });
  it("never forgets unconfirmed effects after an owner was removed", () => {
    const activity = { ...idle(), children: 1 };
    const owner = { getHandoffActivity: () => activity };
    const owners = [owner];
    const inventory = new SidecarHandoffInventory(() => owners, () => false);
    inventory.retired(owner); owners.length = 0; activity.children = 0;
    expect(inventory.inspect().unqualifiedResources).toBe(1);
    const gate = new SidecarHandoff(() => inventory.inspect());
    expect(() => gate.control(acquire)).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_BUSY" }));
  });
  it("permits confirmed idle retirement but refuses native initialization and lost owners", () => {
    let native = false;
    const inventory = new SidecarHandoffInventory(() => [], () => native);
    inventory.retired({ getHandoffActivity: idle });
    expect(Object.values(inventory.inspect()).every(value => value === 0)).toBe(true);
    native = true;
    expect(inventory.inspect().nativeSessions).toBe(1);
    native = false; inventory.lostOwner();
    expect(inventory.inspect().unqualifiedResources).toBe(1);
  });
  it("refuses a malformed owner instead of silently dropping missing counters", () => {
    const owner = { getHandoffActivity: () => ({ ...idle(), tools: NaN }) };
    const inventory = new SidecarHandoffInventory(() => [owner], () => false);
    expect(() => inventory.inspect()).toThrow("HANDOFF_UNAVAILABLE");
    inventory.retired(owner);
    expect(() => new SidecarHandoff(() => inventory.inspect()).control(acquire)).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_UNAVAILABLE" }));
  });
});
