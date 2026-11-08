import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { ExecutionFenceStatusSchema, ExecutionFenceTicketSchema } from "./execution-fence.js";

const generation = "12345678-1234-4234-8234-123456789abc";
describe("native execution fence wire schemas", () => {
  it("preserves exact process creation identity and refuses unversioned adoption data", () => {
    const ticket = { version: 1, generation, capability: generation, address: "local-pipe",
      ownerPid: 123, ownerCreatedAt: "134000000000000001" };
    expect(Value.Check(ExecutionFenceTicketSchema, ticket)).toBe(true);
    expect(BigInt(ticket.ownerCreatedAt)).toBe(134000000000000001n);
    for (const invalid of [{ ...ticket, version: 2 }, { ...ticket, adoptPid: 99 },
      { ...ticket, ownerPid: 0 }, { ...ticket, ownerCreatedAt: 134000000000000001 }]) {
      expect(Value.Check(ExecutionFenceTicketSchema, invalid)).toBe(false);
    }
  });
  it("requires complete native observations without accepting an unknown state", () => {
    const status = { generation, state: "closed", activeProcesses: 0, rootExited: true, confirmed: true };
    expect(Value.Check(ExecutionFenceStatusSchema, status)).toBe(true);
    for (const invalid of [{ generation, confirmed: true }, { ...status, state: "ready" },
      { ...status, activeProcesses: -1 }, { ...status, activeProcesses: 0.5 }, { ...status, inherited: true }]) {
      expect(Value.Check(ExecutionFenceStatusSchema, invalid)).toBe(false);
    }
  });
});
