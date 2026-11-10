import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  CommandCenterExecutionTargetSchema, CommandCenterTaskTargetSchema,
  commandCenterExecutionBelongsToTask,
} from "./identity.js";
import {
  COMMAND_CENTER_MAX_REVISION, COMMAND_CENTER_VERSION,
  CommandCenterRevisionSchema, CommandCenterUuidSchema,
} from "./primitives.js";

/**
 * Authoritative goal head for one stable task target.
 *
 * `desiredRevision` is the latest committed user intent; `effectiveRevision`
 * is the latest revision the concrete runtime execution confirmed it consumed.
 * A committed intent is not automatically effective. Both revisions advance
 * only through Rust transactions; this schema and the helper below are the
 * shared consumer contract, not a second authority.
 */
export const CommandCenterGoalHeadSchema = Type.Object({
  version: Type.Literal(COMMAND_CENTER_VERSION),
  target: CommandCenterTaskTargetSchema,
  desiredRevision: CommandCenterRevisionSchema,
  effectiveRevision: CommandCenterRevisionSchema,
}, { additionalProperties: false });
export type CommandCenterGoalHead = Static<typeof CommandCenterGoalHeadSchema>;

/**
 * Runtime consumption acknowledgement.
 *
 * It names the exact request, concrete execution target (including the native
 * generation), the revision consumed and the supported scheduling boundary.
 * `agent.steer` returning `{ accepted: true }` is not this acknowledgement and
 * must not be reported as `consumed`.
 */
export const CommandCenterConsumptionSchema = Type.Object({
  version: Type.Literal(COMMAND_CENTER_VERSION),
  requestId: CommandCenterUuidSchema,
  target: CommandCenterExecutionTargetSchema,
  consumedRevision: Type.Integer({ minimum: 1, maximum: COMMAND_CENTER_MAX_REVISION }),
  boundary: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]{0,63}$" }),
}, { additionalProperties: false });
export type CommandCenterConsumption = Static<typeof CommandCenterConsumptionSchema>;

export function parseCommandCenterGoalHead(value: unknown): CommandCenterGoalHead {
  if (!Value.Check(CommandCenterGoalHeadSchema, value) ||
      value.effectiveRevision > value.desiredRevision) {
    throw new Error("COMMAND_CENTER_INVALID_GOAL");
  }
  return value;
}

export function parseCommandCenterConsumption(value: unknown): CommandCenterConsumption {
  if (!Value.Check(CommandCenterConsumptionSchema, value)) throw new Error("COMMAND_CENTER_INVALID_CONSUMPTION");
  return value;
}

/**
 * Apply one consumption acknowledgement to the goal head.
 *
 * - The acknowledgement must address the same stable task owner.
 * - A revision that the Host has not committed is rejected; effective can
 *   never move ahead of desired.
 * - A delayed acknowledgement for an older revision is rejected instead of
 *   rolling effective back.
 * - A duplicate acknowledgement for the current effective revision is
 *   idempotent and returns the same head, so a resent runtime event is safe.
 *
 * The caller must still compare `requestId` with the receipt that committed
 * `consumedRevision`; that durable lookup belongs to the receipt repository.
 */
export function applyCommandCenterConsumption(
  head: unknown,
  acknowledgement: unknown,
): CommandCenterGoalHead {
  const goal = parseCommandCenterGoalHead(head);
  const consumed = parseCommandCenterConsumption(acknowledgement);
  if (!commandCenterExecutionBelongsToTask(consumed.target, goal.target)) {
    throw new Error("COMMAND_CENTER_CONSUMPTION_TARGET");
  }
  if (consumed.consumedRevision > goal.desiredRevision) throw new Error("COMMAND_CENTER_CONSUMPTION_AHEAD");
  if (consumed.consumedRevision < goal.effectiveRevision) throw new Error("COMMAND_CENTER_CONSUMPTION_STALE");
  if (consumed.consumedRevision === goal.effectiveRevision) return goal;
  return { ...goal, effectiveRevision: consumed.consumedRevision };
}
