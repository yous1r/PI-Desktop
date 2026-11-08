import { type Static, Type } from "typebox";

export const OWNER_CONTROL_VERSION = 1;
export const OWNER_CONTROL_MAX_FRAME_BYTES = 16 * 1024;
const requestId = Type.String({ maxLength: OWNER_CONTROL_MAX_FRAME_BYTES });

/** Shape of the bounded native request; the Host also validates request identity/version. */
export const OwnerControlRequestSchema = Type.Object({
  version: Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
  requestId,
  operation: Type.Literal("status"),
  expectedOwnerEpoch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false });

export const OwnerControlStatusSchema = Type.Object({
  ownerEpoch: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  profileId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  processId: Type.Integer({ minimum: 1, maximum: 0xffff_ffff }),
  // Windows FILETIME exceeds the JavaScript exact integer range.
  processCreatedAt: Type.String({ pattern: "^[0-9]{1,20}$" }),
  operations: Type.Tuple([Type.Literal("status")]),
}, { additionalProperties: false });

export const OwnerControlResponseSchema = Type.Union([
  Type.Object({ version: Type.Literal(OWNER_CONTROL_VERSION), requestId, status: OwnerControlStatusSchema }, { additionalProperties: false }),
  Type.Object({ version: Type.Literal(OWNER_CONTROL_VERSION), requestId, error: Type.Union([
    Type.Literal("UNSUPPORTED_VERSION"), Type.Literal("STALE_OWNER"), Type.Literal("INVALID_REQUEST"),
  ]) }, { additionalProperties: false }),
]);
export type OwnerControlRequest = Static<typeof OwnerControlRequestSchema>;
export type OwnerControlResponse = Static<typeof OwnerControlResponseSchema>;
