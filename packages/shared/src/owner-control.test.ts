import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { OwnerControlRequestSchema, OwnerControlResponseSchema } from "./owner-control.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/owner-control.json", import.meta.url), "utf8"));
describe("native owner-control wire contract", () => {
  it("accepts the same request and responses used by Rust", () => {
    expect(Value.Check(OwnerControlRequestSchema, fixture.request)).toBe(true);
    expect(Value.Check(OwnerControlResponseSchema, fixture.response)).toBe(true);
    expect(Value.Check(OwnerControlResponseSchema, fixture.failure)).toBe(true);
    expect(BigInt(fixture.response.status.processCreatedAt)).toBe(134000000000000001n);
  });
  it("rejects new mutations, paths and ambiguous or lossy responses", () => {
    for (const value of [
      { ...fixture.request, operation: "prepare" },
      { ...fixture.request, path: "C:/outside" },
      { ...fixture.request, pid: 123 },
    ]) expect(Value.Check(OwnerControlRequestSchema, value)).toBe(false);
    for (const value of [
      { ...fixture.response, error: "STALE_OWNER" },
      { ...fixture.response, status: { ...fixture.response.status, processCreatedAt: 134000000000000001 } },
      { ...fixture.response, status: { ...fixture.response.status, operations: ["status", "prepare"] } },
    ]) expect(Value.Check(OwnerControlResponseSchema, value)).toBe(false);
  });
});
