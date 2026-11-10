import { Type } from "typebox";
import * as Value from "typebox/value";
import { ErrorCodes } from "../errors.js";

/**
 * Contract-level failure reasons, in the words of the control-contract draft.
 *
 * These are diagnostic reasons, not new wire error codes: every one maps onto a
 * family that `packages/shared/src/errors.ts` already registers, so C1 adds no
 * code a consumer would have to learn. A future machine-readable detail code
 * needs shared registration and consumer tests before it appears here.
 */
export const COMMAND_CENTER_ERROR_REASONS = [
  "invalid_request",
  "payload_too_large",
  "forbidden_role",
  "capability_unavailable",
  "target_not_found",
  "target_settled",
  "execution_replaced",
  "host_epoch_conflict",
  "membership_revision_conflict",
  "goal_revision_conflict",
  "request_fingerprint_conflict",
  "quota_exceeded",
  "host_unavailable",
  "host_overloaded",
  "monitor_cursor_expired",
  "monitor_client_too_slow",
] as const;
export type CommandCenterErrorReason = (typeof COMMAND_CENTER_ERROR_REASONS)[number];

export const CommandCenterErrorReasonSchema = Type.Union([
  Type.Literal("invalid_request"), Type.Literal("payload_too_large"), Type.Literal("forbidden_role"),
  Type.Literal("capability_unavailable"), Type.Literal("target_not_found"), Type.Literal("target_settled"),
  Type.Literal("execution_replaced"), Type.Literal("host_epoch_conflict"),
  Type.Literal("membership_revision_conflict"), Type.Literal("goal_revision_conflict"),
  Type.Literal("request_fingerprint_conflict"), Type.Literal("quota_exceeded"),
  Type.Literal("host_unavailable"), Type.Literal("host_overloaded"),
  Type.Literal("monitor_cursor_expired"), Type.Literal("monitor_client_too_slow"),
]);

/**
 * Existing wire code for each reason.
 *
 * `forbidden_role` is checked before existence-sensitive target details, so an
 * unknown target never discloses more than a refused role. `target_settled` and
 * `execution_replaced` are conflicts because the caller's fence, turn or native
 * generation is stale, not because the request was malformed.
 */
export const COMMAND_CENTER_ERROR_CODES: Readonly<Record<CommandCenterErrorReason, string>> = Object.freeze({
  invalid_request: ErrorCodes.INVALID_ARGUMENT,
  payload_too_large: ErrorCodes.PAYLOAD_TOO_LARGE,
  forbidden_role: ErrorCodes.FORBIDDEN,
  capability_unavailable: ErrorCodes.CAPABILITY_UNAVAILABLE,
  target_not_found: ErrorCodes.NOT_FOUND,
  target_settled: ErrorCodes.CONFLICT,
  execution_replaced: ErrorCodes.CONFLICT,
  host_epoch_conflict: ErrorCodes.CONFLICT,
  membership_revision_conflict: ErrorCodes.CONFLICT,
  goal_revision_conflict: ErrorCodes.CONFLICT,
  request_fingerprint_conflict: ErrorCodes.IDEMPOTENCY_CONFLICT,
  quota_exceeded: ErrorCodes.LIMIT_EXCEEDED,
  host_unavailable: ErrorCodes.HOST_UNAVAILABLE,
  host_overloaded: ErrorCodes.HOST_OVERLOADED,
  monitor_cursor_expired: ErrorCodes.CURSOR_EXPIRED,
  monitor_client_too_slow: ErrorCodes.CLIENT_TOO_SLOW,
});

/** Error evidence carried by `CommandCenterReceiptSchema.error`. */
export type CommandCenterReceiptError = { code: string; message: string };

export function parseCommandCenterErrorReason(value: unknown): CommandCenterErrorReason {
  if (!Value.Check(CommandCenterErrorReasonSchema, value)) throw new Error("COMMAND_CENTER_INVALID_CALL");
  return value;
}

export function commandCenterErrorCode(reason: CommandCenterErrorReason): string {
  return COMMAND_CENTER_ERROR_CODES[reason];
}

/**
 * Human-readable detail for logs and receipts.
 *
 * The reason stays in the message because the registered code alone cannot say
 * which side of a race produced it; it is bounded to the receipt message limit.
 */
export function commandCenterErrorMessage(reason: CommandCenterErrorReason, detail: string): string {
  if (detail.length === 0) throw new Error("COMMAND_CENTER_INVALID_CALL");
  return `${reason}: ${detail}`.slice(0, 512);
}

export function commandCenterError(reason: CommandCenterErrorReason, detail: string): CommandCenterReceiptError {
  return { code: commandCenterErrorCode(reason), message: commandCenterErrorMessage(reason, detail) };
}
