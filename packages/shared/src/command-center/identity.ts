import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  COMMAND_CENTER_MAX_AGENTS_PER_HOST, COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE,
  COMMAND_CENTER_MAX_ENABLED_WORKSPACES, COMMAND_CENTER_MAX_REVISION, COMMAND_CENTER_VERSION,
  CommandCenterCanonicalIdSchema, CommandCenterLabelSchema, CommandCenterUuidSchema,
} from "./primitives.js";

/**
 * Host identity minted by an existing Host installation. Deliberately not a
 * machine name, network address, SSH alias or browser origin; paths and
 * whitespace are rejected so this never becomes a filesystem selector.
 */
export const CommandCenterHostIdSchema = Type.String({
  minLength: 1, maxLength: 128, pattern: "^[^\\u0000\\s/\\\\]+$",
});

/**
 * Local observation binding established by a trusted transport adapter. This
 * shape validates existing fence fields; it is not a credential or RPC request.
 */
const observationOwnerSchema = Type.Object({
  hostId: CommandCenterHostIdSchema,
  expectedHostEpoch: CommandCenterUuidSchema,
}, { additionalProperties: false });
export type CommandCenterObservationOwner = Static<typeof observationOwnerSchema>;

export function parseCommandCenterObservationOwner(value: unknown): CommandCenterObservationOwner {
  if (!Value.Check(observationOwnerSchema, value)) throw new Error("COMMAND_CENTER_INVALID_OWNER");
  const owner = { hostId: value.hostId, expectedHostEpoch: value.expectedHostEpoch };
  if (!Value.Check(observationOwnerSchema, owner)) throw new Error("COMMAND_CENTER_INVALID_OWNER");
  return owner;
}

const fenceFields = {
  hostId: CommandCenterHostIdSchema,
  /** Exclusive execution-owner generation; changes on Host restart. */
  expectedHostEpoch: CommandCenterUuidSchema,
  /** Operational group; authoritative only together with `hostId`. */
  commandWorkspaceId: CommandCenterUuidSchema,
  /** Session/workspace membership version the client last observed. */
  expectedMembershipRevision: Type.Integer({ minimum: 1, maximum: COMMAND_CENTER_MAX_REVISION }),
};
/** Fence every mutation must carry; the Host rechecks it after awaits. */
export const CommandCenterFenceSchema = Type.Object(fenceFields, { additionalProperties: false });
export type CommandCenterFence = Static<typeof CommandCenterFenceSchema>;

export const CommandCenterWorkspaceSchema = Type.Object({
  id: CommandCenterUuidSchema,
  name: CommandCenterLabelSchema,
  enabled: Type.Boolean(),
  revision: Type.Integer({ minimum: 1, maximum: COMMAND_CENTER_MAX_REVISION }),
}, { additionalProperties: false });
export type CommandCenterWorkspace = Static<typeof CommandCenterWorkspaceSchema>;

/**
 * First-release quotas from the approved requirements. Literal types keep the
 * numbers visible at the contract boundary; C2 remains the transactional
 * authority that enforces them.
 */
export const CommandCenterQuotaSchema = Type.Object({
  maxEnabledWorkspaces: Type.Literal(COMMAND_CENTER_MAX_ENABLED_WORKSPACES),
  maxAgentsPerWorkspace: Type.Literal(COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE),
  maxAgentsPerHost: Type.Literal(COMMAND_CENTER_MAX_AGENTS_PER_HOST),
}, { additionalProperties: false });
export const COMMAND_CENTER_QUOTA: Static<typeof CommandCenterQuotaSchema> = Object.freeze({
  maxEnabledWorkspaces: COMMAND_CENTER_MAX_ENABLED_WORKSPACES,
  maxAgentsPerWorkspace: COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE,
  maxAgentsPerHost: COMMAND_CENTER_MAX_AGENTS_PER_HOST,
});

export const CommandCenterWorkspaceListSchema = Type.Object({
  version: Type.Literal(COMMAND_CENTER_VERSION),
  workspaces: Type.Array(CommandCenterWorkspaceSchema, { maxItems: 100 }),
  quota: CommandCenterQuotaSchema,
}, { additionalProperties: false });
export type CommandCenterWorkspaceList = Static<typeof CommandCenterWorkspaceListSchema>;

/**
 * Stable goal owner. Either a canonical session, or the canonical delegation
 * chain root (parent session plus chain identity) resolved from Host history.
 * It survives new turns and supported continuations and contains no live turn.
 */
export const CommandCenterTaskTargetSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("session"),
    sessionId: CommandCenterCanonicalIdSchema,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("delegation"),
    parentSessionId: CommandCenterCanonicalIdSchema,
    delegationId: CommandCenterCanonicalIdSchema,
  }, { additionalProperties: false }),
]);
export type CommandCenterTaskTarget = Static<typeof CommandCenterTaskTargetSchema>;

/**
 * Concrete live execution. Main and Worker executions reuse their real session
 * and turn identity; a native child adds its delegation identity and the
 * concrete execution generation. A settled session never gains a turn here.
 */
export const CommandCenterExecutionTargetSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("session"),
    sessionId: CommandCenterCanonicalIdSchema,
    turnId: CommandCenterCanonicalIdSchema,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("delegation"),
    parentSessionId: CommandCenterCanonicalIdSchema,
    parentTurnId: CommandCenterCanonicalIdSchema,
    delegationId: CommandCenterCanonicalIdSchema,
    executionGeneration: Type.Integer({ minimum: 1, maximum: COMMAND_CENTER_MAX_REVISION }),
  }, { additionalProperties: false }),
]);
export type CommandCenterExecutionTarget = Static<typeof CommandCenterExecutionTargetSchema>;

export function parseCommandCenterTaskTarget(value: unknown): CommandCenterTaskTarget {
  if (!Value.Check(CommandCenterTaskTargetSchema, value)) throw new Error("COMMAND_CENTER_INVALID_TARGET");
  return value;
}

export function parseCommandCenterExecutionTarget(value: unknown): CommandCenterExecutionTarget {
  if (!Value.Check(CommandCenterExecutionTargetSchema, value)) throw new Error("COMMAND_CENTER_INVALID_TARGET");
  return value;
}

/** Stable goal-owner key. JSON tuple boundaries preserve opaque identifiers. */
export function commandCenterTaskKey(target: CommandCenterTaskTarget): string {
  return target.kind === "session"
    ? JSON.stringify(["session", target.sessionId])
    : JSON.stringify(["delegation", target.parentSessionId, target.delegationId]);
}

/** Concrete execution key: includes turn and native generation. */
export function commandCenterExecutionKey(target: CommandCenterExecutionTarget): string {
  return target.kind === "session"
    ? JSON.stringify(["session", target.sessionId, target.turnId])
    : JSON.stringify(["delegation", target.parentSessionId, target.parentTurnId, target.delegationId, target.executionGeneration]);
}

/**
 * True only when the concrete execution addresses the same stable goal owner.
 * A resumed or restarted child keeps its owner but changes its execution key,
 * so a delayed control for the old generation cannot match the new run.
 */
export function commandCenterExecutionBelongsToTask(
  execution: CommandCenterExecutionTarget,
  task: CommandCenterTaskTarget,
): boolean {
  return execution.kind === "session"
    ? task.kind === "session" && execution.sessionId === task.sessionId
    : task.kind === "delegation" &&
      execution.parentSessionId === task.parentSessionId &&
      execution.delegationId === task.delegationId;
}

/**
 * Validates a workspace page and the first-release admission invariants that
 * the contract can check without I/O: unique IDs and at most three enabled
 * groups. Inactive saved workspaces are allowed.
 */
export function parseCommandCenterWorkspaceList(value: unknown): CommandCenterWorkspaceList {
  if (!Value.Check(CommandCenterWorkspaceListSchema, value)) throw new Error("COMMAND_CENTER_INVALID_WORKSPACES");
  const ids = new Set(value.workspaces.map((workspace) => workspace.id));
  const enabled = value.workspaces.filter((workspace) => workspace.enabled).length;
  if (ids.size !== value.workspaces.length || enabled > COMMAND_CENTER_MAX_ENABLED_WORKSPACES) {
    throw new Error("COMMAND_CENTER_INVALID_WORKSPACES");
  }
  return value;
}
