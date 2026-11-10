import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  CommandCenterExecutionTargetSchema, CommandCenterFenceSchema,
} from "./identity.js";
import {
  COMMAND_CENTER_MAX_REQUEST_BYTES, COMMAND_CENTER_VERSION,
  CommandCenterRevisionSchema, CommandCenterTextSchema, CommandCenterUuidSchema,
  commandCenterCanonicalJson, commandCenterWithinBytes,
} from "./primitives.js";

/**
 * Operations the draft contract describes. Only a versioned schema exists here;
 * the RACP catalog and IPC registration must be added together with real
 * producer and consumer paths, never from this module alone.
 */
export const COMMAND_CENTER_OPERATIONS = ["append", "steer", "reviseGoal", "stop"] as const;
export type CommandCenterOperation = (typeof COMMAND_CENTER_OPERATIONS)[number];
export const CommandCenterOperationSchema = Type.Union([
  Type.Literal("append"), Type.Literal("steer"), Type.Literal("reviseGoal"), Type.Literal("stop"),
]);

/** Goal revisions start at 0: a task may have no committed revision yet. */
const goalRevision = CommandCenterRevisionSchema;
const constraint = Type.String({ minLength: 1, maxLength: 1024, pattern: "^[^\\u0000]+$" });
const intent = {
  append: Type.Object({
    kind: Type.Literal("append"),
    text: CommandCenterTextSchema,
  }, { additionalProperties: false }),
  steer: Type.Object({
    kind: Type.Literal("steer"),
    text: CommandCenterTextSchema,
  }, { additionalProperties: false }),
  reviseGoal: Type.Object({
    kind: Type.Literal("reviseGoal"),
    objective: CommandCenterTextSchema,
    constraints: Type.Array(constraint, { maxItems: 16 }),
  }, { additionalProperties: false }),
  stop: Type.Object({
    kind: Type.Literal("stop"),
    scope: Type.Union([Type.Literal("target"), Type.Literal("subtree")]),
  }, { additionalProperties: false }),
};
export const CommandCenterInterventionIntentSchema = Type.Union([
  intent.append, intent.steer, intent.reviseGoal, intent.stop,
]);
export type CommandCenterInterventionIntent = Static<typeof CommandCenterInterventionIntentSchema>;

const envelope = {
  version: Type.Literal(COMMAND_CENTER_VERSION),
  requestId: CommandCenterUuidSchema,
  ...CommandCenterFenceSchema.properties,
  target: CommandCenterExecutionTargetSchema,
};

/**
 * Non-stop intents require the expected desired goal revision and are subject
 * to the Rust compare-and-swap. Stop deliberately omits that field: a goal
 * revision that advanced must not block cancellation. The request also carries
 * no principal, role or capability field; those come from authenticated
 * transport state and cannot be supplied or widened by a caller.
 */
export const CommandCenterInterventionRequestSchema = Type.Union([
  Type.Object({ ...envelope, expectedGoalRevision: goalRevision, intent: intent.append }, { additionalProperties: false }),
  Type.Object({ ...envelope, expectedGoalRevision: goalRevision, intent: intent.steer }, { additionalProperties: false }),
  Type.Object({ ...envelope, expectedGoalRevision: goalRevision, intent: intent.reviseGoal }, { additionalProperties: false }),
  Type.Object({ ...envelope, intent: intent.stop }, { additionalProperties: false }),
]);
export type CommandCenterInterventionRequest = Static<typeof CommandCenterInterventionRequestSchema>;

function requireIntentText(text: string): void {
  if (text.trim().length === 0) throw new Error("COMMAND_CENTER_INVALID_REQUEST");
}

/**
 * Shape, byte and intent validation at the consumer boundary.
 *
 * Callers must still authorize the authenticated principal and resolve the
 * target from Host registries; this parser proves only that the payload is a
 * bounded, unambiguous control attempt.
 */
export function parseCommandCenterInterventionRequest(value: unknown): CommandCenterInterventionRequest {
  if (!Value.Check(CommandCenterInterventionRequestSchema, value) ||
      !commandCenterWithinBytes(value, COMMAND_CENTER_MAX_REQUEST_BYTES)) {
    throw new Error("COMMAND_CENTER_INVALID_REQUEST");
  }
  const request = value;
  if (request.intent.kind === "stop") return request;
  if (request.intent.kind === "reviseGoal") {
    requireIntentText(request.intent.objective);
    for (const item of request.intent.constraints) requireIntentText(item);
  } else {
    requireIntentText(request.intent.text);
  }
  return request;
}

/**
 * Canonical idempotency fingerprint input for a validated request.
 *
 * The Host hashes these bytes with SHA-256; a repeat with the same canonical
 * payload returns the original receipt and a different payload with the same
 * request identity conflicts. This function never authorizes or dispatches.
 */
export function commandCenterCanonicalPayload(value: unknown): string {
  return commandCenterCanonicalJson(parseCommandCenterInterventionRequest(value));
}
