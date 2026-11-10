import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES, OwnerHandoffSourceCommandSchema, OwnerHandoffPreflightSchema,
  OwnerHandoffResponseSchema, parseOwnerHandoffSourceCommand, parseOwnerHandoffPreflight, parseOwnerHandoffResponse,
} from "./owner-handoff.js";

export const OWNER_HANDOFF_SOURCE_PROTOCOL = "owner-transfer";
export const OwnerHandoffSourceRequestSchema = Type.Object({
  protocol: Type.Literal(OWNER_HANDOFF_SOURCE_PROTOCOL), version: Type.Literal(1),
  command: Type.Intersect([OwnerHandoffSourceCommandSchema,
    Type.Object({ operation: Type.Union([Type.Literal("preflight"), Type.Literal("status")]) })]),
}, { additionalProperties: false });
const ReplySchema = Type.Object({
  protocol: Type.Literal(OWNER_HANDOFF_SOURCE_PROTOCOL), version: Type.Literal(1),
  requestId: Type.String(), sourceEpoch: Type.String(), profileId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  result: Type.Union([OwnerHandoffPreflightSchema, OwnerHandoffResponseSchema]),
}, { additionalProperties: false });
export type OwnerHandoffSourceRequest = Static<typeof OwnerHandoffSourceRequestSchema>;
export type OwnerHandoffSourceReply = Static<typeof ReplySchema>;
function bounded(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= OWNER_HANDOFF_MAX_RECORD_BYTES; }
  catch { return false; }
}
export function parseOwnerHandoffSourceRequest(value: unknown): OwnerHandoffSourceRequest {
  if (!Value.Check(OwnerHandoffSourceRequestSchema, value) || !bounded(value)) throw new Error("HANDOFF_INVALID_REQUEST");
  parseOwnerHandoffSourceCommand(value.command);
  return value;
}
/** Native peer authentication is required separately; correlation is not authority. */
export function parseOwnerHandoffSourceReply(value: unknown, request: OwnerHandoffSourceRequest, profileId: string): OwnerHandoffSourceReply {
  try {
    parseOwnerHandoffSourceRequest(request);
    if (!Value.Check(ReplySchema, value) || !bounded(value) || value.profileId !== profileId ||
        value.requestId !== request.command.requestId || value.sourceEpoch !== request.command.sourceEpoch) throw new Error();
    const result = value.result;
    if ("error" in result) {
      parseOwnerHandoffResponse(result);
      if (!["HANDOFF_UNAVAILABLE", "HANDOFF_OWNER_CHANGED", "HANDOFF_INCOMPATIBLE_BUILD"].includes(result.error.code)) throw new Error();
    } else if ("record" in result) {
      parseOwnerHandoffResponse(result);
      if (request.command.operation !== "status" || result.record.id !== request.command.transferId ||
          result.record.profile !== profileId || result.record.sourceEpoch !== request.command.sourceEpoch) throw new Error();
    } else {
      parseOwnerHandoffPreflight(result, request.command);
      if (result.profileId !== profileId) throw new Error();
    }
    return value;
  } catch { throw new Error("HANDOFF_INVALID_RESPONSE"); }
}
