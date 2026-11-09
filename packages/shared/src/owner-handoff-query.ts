import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import { OWNER_HANDOFF_MAX_RECORD_BYTES, OwnerHandoffRecordSchema, parseOwnerHandoffResponse } from "./owner-handoff.js";

const uuid = Type.String({ pattern: "^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const correlation = { version: Type.Literal(1), requestId: uuid };
const owner = { sourceEpoch: uuid, profileId: Type.String({ pattern: "^[0-9a-f]{64}$" }) };
/** Private original-owner stdio queries. Neither operation holds admission. */
export const OwnerHandoffIdentityRequestSchema = Type.Object(correlation, { additionalProperties: false });
export const OwnerHandoffIdentitySchema = Type.Object({ ...correlation, ...owner }, { additionalProperties: false });
export const OwnerHandoffTransferRequestSchema = Type.Object({ ...correlation, ...owner, transferId: uuid }, { additionalProperties: false });
export const OwnerHandoffTransferQuerySchema = Type.Object({ ...correlation, ...owner, transferId: uuid, record: OwnerHandoffRecordSchema }, { additionalProperties: false });
export type OwnerHandoffIdentityRequest = Static<typeof OwnerHandoffIdentityRequestSchema>;
export type OwnerHandoffIdentity = Static<typeof OwnerHandoffIdentitySchema>;
export type OwnerHandoffTransferRequest = Static<typeof OwnerHandoffTransferRequestSchema>;
export type OwnerHandoffTransferQuery = Static<typeof OwnerHandoffTransferQuerySchema>;

function bounded(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= OWNER_HANDOFF_MAX_RECORD_BYTES; }
  catch { return false; }
}
export function parseOwnerHandoffIdentityRequest(value: unknown): OwnerHandoffIdentityRequest {
  if (!Value.Check(OwnerHandoffIdentityRequestSchema, value) || !bounded(value)) throw new Error("HANDOFF_INVALID_REQUEST");
  return value;
}
export function parseOwnerHandoffIdentity(value: unknown, request: OwnerHandoffIdentityRequest): OwnerHandoffIdentity {
  parseOwnerHandoffIdentityRequest(request);
  if (!Value.Check(OwnerHandoffIdentitySchema, value) || !bounded(value) || value.requestId !== request.requestId) throw new Error("HANDOFF_INVALID_IDENTITY");
  return value;
}
export function parseOwnerHandoffTransferRequest(value: unknown): OwnerHandoffTransferRequest {
  if (!Value.Check(OwnerHandoffTransferRequestSchema, value) || !bounded(value)) throw new Error("HANDOFF_INVALID_REQUEST");
  return value;
}
export function parseOwnerHandoffTransferQuery(value: unknown, request: OwnerHandoffTransferRequest): OwnerHandoffTransferQuery {
  parseOwnerHandoffTransferRequest(request);
  if (!Value.Check(OwnerHandoffTransferQuerySchema, value) || !bounded(value) || value.requestId !== request.requestId ||
      value.sourceEpoch !== request.sourceEpoch || value.profileId !== request.profileId || value.transferId !== request.transferId ||
      value.record.sourceEpoch !== request.sourceEpoch || value.record.profile !== request.profileId || value.record.id !== request.transferId) {
    throw new Error("HANDOFF_INVALID_TRANSFER_QUERY");
  }
  parseOwnerHandoffResponse({ version: 1, record: value.record });
  return value;
}
