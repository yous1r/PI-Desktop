import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import { CommandCenterExecutionTargetSchema, commandCenterExecutionKey } from "./identity.js";
import {
  CommandCenterInterventionRequestSchema, CommandCenterOperationSchema,
  type CommandCenterInterventionRequest,
} from "./intervention.js";
import {
  COMMAND_CENTER_MAX_RECEIPT_BYTES, COMMAND_CENTER_MAX_REVISION, COMMAND_CENTER_VERSION,
  CommandCenterRevisionSchema, CommandCenterUuidSchema, commandCenterWithinBytes,
} from "./primitives.js";

/** Durable receipt states from the control-contract draft, in lifecycle order. */
export const COMMAND_CENTER_RECEIPT_STATUSES = [
  "recorded", "accepted", "consumed", "completed", "rejected", "conflicted", "interrupted", "outcome_unknown",
] as const;
export type CommandCenterReceiptStatus = (typeof COMMAND_CENTER_RECEIPT_STATUSES)[number];
export const CommandCenterReceiptStatusSchema = Type.Union([
  Type.Literal("recorded"), Type.Literal("accepted"), Type.Literal("consumed"), Type.Literal("completed"),
  Type.Literal("rejected"), Type.Literal("conflicted"), Type.Literal("interrupted"), Type.Literal("outcome_unknown"),
]);

const receiptError = Type.Object({
  /** Existing error family value; new detail codes need shared registration. */
  code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }),
  message: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000]+$" }),
}, { additionalProperties: false });

/**
 * One durable intervention receipt.
 *
 * `fingerprint` is the SHA-256 of the canonical request payload. Reusing a
 * `(hostId, principal, requestId)` key with the same fingerprint returns this
 * receipt; a different fingerprint conflicts. The receipt binds the concrete
 * turn or native generation it controlled, so a delayed lookup cannot be
 * applied to a replacement run, and it carries no caller principal or role.
 */
export const CommandCenterReceiptSchema = Type.Object({
  version: Type.Literal(COMMAND_CENTER_VERSION),
  requestId: CommandCenterUuidSchema,
  fingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  target: CommandCenterExecutionTargetSchema,
  operation: CommandCenterOperationSchema,
  status: CommandCenterReceiptStatusSchema,
  revision: Type.Integer({ minimum: 1, maximum: COMMAND_CENTER_MAX_REVISION }),
  desiredGoalRevision: CommandCenterRevisionSchema,
  effectiveGoalRevision: CommandCenterRevisionSchema,
  error: Type.Optional(receiptError),
}, { additionalProperties: false });
export type CommandCenterReceipt = Static<typeof CommandCenterReceiptSchema>;

/** First-release policy: receipts are retained; no automatic deletion. */
export const COMMAND_CENTER_RECEIPT_RETENTION = "retained" as const;

/**
 * Legal continuation states. Terminal states stay terminal: a deliberate new
 * attempt needs a new request identity. `outcome_unknown` has no transition in
 * this contract because reconciliation semantics are owned by the C2 receipt
 * repository and must be added together with its transition tests; blind
 * replay is never one of them.
 */
export const COMMAND_CENTER_RECEIPT_TRANSITIONS: Readonly<
  Record<CommandCenterReceiptStatus, readonly CommandCenterReceiptStatus[]>
> = Object.freeze({
  recorded: Object.freeze(["accepted", "rejected", "conflicted", "interrupted", "outcome_unknown"] as const),
  accepted: Object.freeze(["consumed", "completed", "interrupted", "outcome_unknown"] as const),
  consumed: Object.freeze(["completed", "interrupted", "outcome_unknown"] as const),
  completed: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
  conflicted: Object.freeze([] as const),
  interrupted: Object.freeze([] as const),
  outcome_unknown: Object.freeze([] as const),
});

export function commandCenterReceiptCanTransition(
  current: CommandCenterReceiptStatus,
  next: CommandCenterReceiptStatus,
): boolean {
  return COMMAND_CENTER_RECEIPT_TRANSITIONS[current].includes(next);
}

function errorRequired(status: CommandCenterReceiptStatus): boolean {
  return status === "rejected" || status === "conflicted";
}

function errorForbidden(status: CommandCenterReceiptStatus): boolean {
  return status === "recorded" || status === "accepted" || status === "consumed" || status === "completed";
}

/**
 * Consumer-side receipt validation.
 *
 * It enforces the state/revision evidence rules that hold without database
 * access: bounded size, ordered revisions, the error-presence rule per status
 * and the fact that Stop never has a goal-consumption state. C2 owns the
 * transactional transition and exactly-once release proof.
 */
export function parseCommandCenterReceipt(value: unknown): CommandCenterReceipt {
  if (!Value.Check(CommandCenterReceiptSchema, value) ||
      !commandCenterWithinBytes(value, COMMAND_CENTER_MAX_RECEIPT_BYTES) ||
      value.effectiveGoalRevision > value.desiredGoalRevision ||
      (value.operation === "stop" && value.status === "consumed") ||
      (errorRequired(value.status) && value.error === undefined) ||
      (errorForbidden(value.status) && value.error !== undefined)) {
    throw new Error("COMMAND_CENTER_INVALID_RECEIPT");
  }
  return value;
}

/**
 * True when the receipt belongs to the exact validated request.
 *
 * Fingerprint equality is not checked here because only the Host holds the
 * SHA-256 port; `requestId`, operation and concrete execution identity must
 * still match, so a receipt for an older native generation cannot be reused.
 */
export function commandCenterReceiptBindsRequest(
  receipt: CommandCenterReceipt,
  request: CommandCenterInterventionRequest,
): boolean {
  if (!Value.Check(CommandCenterInterventionRequestSchema, request)) return false;
  return receipt.requestId === request.requestId &&
    receipt.operation === request.intent.kind &&
    commandCenterExecutionKey(receipt.target) === commandCenterExecutionKey(request.target);
}
