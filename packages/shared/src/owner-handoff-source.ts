import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES, OwnerHandoffSourceCommandSchema, OwnerHandoffPreflightSchema,
  OwnerHandoffResponseSchema, parseOwnerHandoffSourceCommand, parseOwnerHandoffPreflight, parseOwnerHandoffResponse,
  type OwnerHandoffRecord, type OwnerHandoffSourceCommand,
} from "./owner-handoff.js";

export const OWNER_HANDOFF_SOURCE_PROTOCOL = "owner-transfer";
/**
 * Mutations close admission, stop registered resources and commit durable
 * receipts, so they cannot share the two-second query budget the native
 * transport keeps for preflight/status.
 */
export const OWNER_HANDOFF_SOURCE_MUTATION_TIMEOUT_MS = 45000;
/** Fixed refusal codes this envelope may carry; nothing else is forwarded. */
export const OWNER_HANDOFF_SOURCE_FAILURE_CODES = [
  "HANDOFF_UNAVAILABLE", "HANDOFF_OWNER_CHANGED", "HANDOFF_INCOMPATIBLE_BUILD", "HANDOFF_BUSY",
  "HANDOFF_REQUEST_CONFLICT", "HANDOFF_STALE_REVISION", "HANDOFF_INVALID_TRANSITION",
  "HANDOFF_CANCEL_UNCONFIRMED", "HANDOFF_FENCE_UNCONFIRMED",
] as const;
export type OwnerHandoffSourceMutationOperation = "prepare" | "cancel" | "fence" | "release";
export type OwnerHandoffSourceMutation = Extract<OwnerHandoffSourceCommand, { operation: OwnerHandoffSourceMutationOperation }>;
/** Durable phase a fresh receipt must show; `status` observes any valid phase. */
export const OWNER_HANDOFF_SOURCE_OPERATION_PHASES: Record<OwnerHandoffSourceMutationOperation, OwnerHandoffRecord["phase"]> = {
  prepare: "prepared", cancel: "cancelled", fence: "source_fenced", release: "release_pending",
};
export const OwnerHandoffSourceRequestSchema = Type.Object({
  protocol: Type.Literal(OWNER_HANDOFF_SOURCE_PROTOCOL), version: Type.Literal(1),
  command: OwnerHandoffSourceCommandSchema,
}, { additionalProperties: false });
const ReplySchema = Type.Object({
  protocol: Type.Literal(OWNER_HANDOFF_SOURCE_PROTOCOL), version: Type.Literal(1),
  requestId: Type.String(), sourceEpoch: Type.String(), profileId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  result: Type.Union([OwnerHandoffPreflightSchema, OwnerHandoffResponseSchema]),
}, { additionalProperties: false });
export type OwnerHandoffSourceRequest = Static<typeof OwnerHandoffSourceRequestSchema>;
export type OwnerHandoffSourceReply = Static<typeof ReplySchema>;
export function isOwnerHandoffSourceMutation(command: OwnerHandoffSourceCommand): command is OwnerHandoffSourceMutation {
  return command.operation === "prepare" || command.operation === "cancel" ||
    command.operation === "fence" || command.operation === "release";
}
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
    const command = request.command;
    const result = value.result;
    if ("error" in result) {
      parseOwnerHandoffResponse(result);
      if (!(OWNER_HANDOFF_SOURCE_FAILURE_CODES as readonly string[]).includes(result.error.code)) throw new Error();
    } else if ("record" in result) {
      parseOwnerHandoffResponse(result);
      const record = result.record;
      // Only the original owner's transfer for this trusted profile may answer.
      if (command.operation === "preflight" || record.id !== command.transferId ||
          record.profile !== profileId || record.sourceEpoch !== command.sourceEpoch) throw new Error();
      // Prepare pins the reserved successor exactly; later transitions keep it.
      if (command.operation === "prepare" &&
          (record.targetEpoch !== command.targetEpoch || record.capabilityHash !== command.capabilityHash ||
           record.targetBuild.sha256 !== command.targetBuild.sha256 || record.targetBuild.schema !== command.targetBuild.schema ||
           record.targetBuild.protocol !== command.targetBuild.protocol)) throw new Error();
      // A replayed historic receipt may carry an older revision, so revision
      // progression stays with the Rust source; only the durable phase binds.
      const phase = isOwnerHandoffSourceMutation(command) ? OWNER_HANDOFF_SOURCE_OPERATION_PHASES[command.operation] : undefined;
      if (phase !== undefined && record.phase !== phase) throw new Error();
    } else {
      if (command.operation !== "preflight") throw new Error();
      const preflight = parseOwnerHandoffPreflight(result, command);
      if (preflight.profileId !== profileId) throw new Error();
    }
    return value;
  } catch { throw new Error("HANDOFF_INVALID_RESPONSE"); }
}
