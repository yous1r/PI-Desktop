import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOwnerHandoffIdentity, parseOwnerHandoffIdentityRequest, parseOwnerHandoffTransferQuery, parseOwnerHandoffTransferRequest } from "./owner-handoff-query.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const request = { version: 1 as const, requestId: "44444444-4444-4444-8444-444444444444" };
const identity = { ...request, sourceEpoch: fixture.response.record.sourceEpoch, profileId: fixture.response.record.profile };
const transfer = { ...identity, transferId: fixture.response.record.id };
const reply = () => ({ ...transfer, record: structuredClone(fixture.response.record) });

describe("private original-owner queries", () => {
  it("accepts minimal identity and correlated validated journal records", () => {
    expect(parseOwnerHandoffIdentityRequest(request)).toEqual(request);
    expect(parseOwnerHandoffIdentity(identity, request)).toEqual(identity);
    expect(parseOwnerHandoffTransferRequest(transfer)).toEqual(transfer);
    expect(parseOwnerHandoffTransferQuery(reply(), transfer).record).toEqual(fixture.response.record);
  });
  it.each([{}, { ...request, version: 2 }, { ...request, sourceEpoch: identity.sourceEpoch },
    { ...request, requestId: "0".repeat(16385) }, { ...request, requestId: "00000000-0000-0000-0000-000000000000" }])("rejects invalid identity requests %j", value => {
    expect(() => parseOwnerHandoffIdentityRequest(value)).toThrow("HANDOFF_INVALID_REQUEST");
  });
  it.each(["requestId", "sourceEpoch", "profileId", "transferId"] as const)("requires exact transfer correlation for %s", key => {
    const value = reply();
    value[key] = key === "profileId" ? "b".repeat(64) : "99999999-9999-4999-8999-999999999999";
    expect(() => parseOwnerHandoffTransferQuery(value, transfer)).toThrow();
  });
  it.each(["id", "sourceEpoch", "profile", "revision", "requester", "phase"])("validates the actual journal %s", key => {
    const value = reply();
    value.record[key] = key === "revision" ? Number.MAX_SAFE_INTEGER + 1 : "invalid";
    expect(() => parseOwnerHandoffTransferQuery(value, transfer)).toThrow();
  });
  it("refuses extra fields, errors as facts, missing records and oversized identities", () => {
    for (const value of [{ ...identity, idle: true }, { ...identity, sourceEpoch: "a".repeat(17000) }, fixture.failure,
      { ...identity, requestId: transfer.transferId }]) expect(() => parseOwnerHandoffIdentity(value, request)).toThrow();
    for (const value of [{ ...reply(), idle: true }, transfer, fixture.failure]) expect(() => parseOwnerHandoffTransferQuery(value, transfer)).toThrow();
    expect(() => parseOwnerHandoffTransferRequest({ ...transfer, generation: transfer.transferId })).toThrow();
  });
  it("preserves canonical FILETIME and rejects overflow rather than rounding", () => {
    const value = reply();
    value.record.requester.createdAt = "18446744073709551616";
    expect(() => parseOwnerHandoffTransferQuery(value, transfer)).toThrow();
  });
});
