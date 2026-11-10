import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  CommandCenterExecutionTargetSchema, CommandCenterTaskTargetSchema,
  commandCenterExecutionBelongsToTask, commandCenterTaskKey,
} from "./identity.js";
import {
  COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES, COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS, COMMAND_CENTER_VERSION,
  CommandCenterCanonicalIdSchema, CommandCenterCountSchema, CommandCenterLabelSchema,
  CommandCenterRevisionSchema, CommandCenterTimestampSchema, CommandCenterUuidSchema, commandCenterWithinBytes,
} from "./primitives.js";

/**
 * Monitor states from the control-contract draft. `reserved` through
 * `outcome_unknown` occupy capacity; `completed`, `aborted`, `failed` and
 * `launch_failed` are terminal and release it exactly once. Queued prompt
 * entries that never reserved a runtime are not summary rows.
 */
export const COMMAND_CENTER_TASK_STATES = [
  "reserved", "starting", "running", "waiting_tool", "waiting_human", "stopping", "outcome_unknown",
  "completed", "aborted", "failed", "launch_failed",
] as const;
export type CommandCenterTaskState = (typeof COMMAND_CENTER_TASK_STATES)[number];
export const CommandCenterTaskStateSchema = Type.Union([
  Type.Literal("reserved"), Type.Literal("starting"), Type.Literal("running"), Type.Literal("waiting_tool"),
  Type.Literal("waiting_human"), Type.Literal("stopping"), Type.Literal("outcome_unknown"),
  Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed"), Type.Literal("launch_failed"),
]);

const shortLabel = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000]+$" });
const pageToken = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000]+$" });

/** Reported usage only; absent when the runtime did not report it. */
export const CommandCenterUsageSchema = Type.Object({
  inputTokens: CommandCenterCountSchema,
  outputTokens: CommandCenterCountSchema,
}, { additionalProperties: false });

/**
 * Bounded display projection of one task. It is not a transcript copy and is
 * not an execution identity: `target` is the stable goal owner and `execution`
 * is the concrete live run when one exists. A settled session therefore keeps
 * no fabricated active turn. Full provider context, tool bodies and native
 * handles never belong here.
 */
export const CommandCenterTaskSummarySchema = Type.Object({
  target: CommandCenterTaskTargetSchema,
  execution: Type.Optional(CommandCenterExecutionTargetSchema),
  commandWorkspaceId: CommandCenterUuidSchema,
  projectId: Type.Optional(CommandCenterCanonicalIdSchema),
  parent: Type.Optional(CommandCenterTaskTargetSchema),
  label: CommandCenterLabelSchema,
  status: CommandCenterTaskStateSchema,
  waitingReason: Type.Optional(shortLabel),
  activity: Type.Optional(CommandCenterLabelSchema),
  desiredGoalRevision: CommandCenterRevisionSchema,
  effectiveGoalRevision: CommandCenterRevisionSchema,
  pendingApprovals: CommandCenterCountSchema,
  pendingInputs: CommandCenterCountSchema,
  usage: Type.Optional(CommandCenterUsageSchema),
  updatedAt: CommandCenterTimestampSchema,
}, { additionalProperties: false });
export type CommandCenterTaskSummary = Static<typeof CommandCenterTaskSummarySchema>;

/** Shared cursor epoch; a change forces a fresh summary snapshot. */
export const CommandCenterMonitorCursorSchema = Type.Object({
  epoch: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" }),
  sequence: CommandCenterCountSchema,
}, { additionalProperties: false });
export type CommandCenterMonitorCursor = Static<typeof CommandCenterMonitorCursorSchema>;

/**
 * One bounded summary page at a consistent cursor. The snapshot is a pure
 * projection: it cannot grant capacity, settle work or authorize a control.
 */
export const CommandCenterMonitorSnapshotSchema = Type.Object({
  version: Type.Literal(COMMAND_CENTER_VERSION),
  cursor: CommandCenterMonitorCursorSchema,
  generatedAt: CommandCenterTimestampSchema,
  rows: Type.Array(CommandCenterTaskSummarySchema, { maxItems: COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS }),
  nextPage: Type.Optional(pageToken),
}, { additionalProperties: false });
export type CommandCenterMonitorSnapshot = Static<typeof CommandCenterMonitorSnapshotSchema>;

function validSummaryRow(row: CommandCenterTaskSummary): boolean {
  if (row.effectiveGoalRevision > row.desiredGoalRevision) return false;
  return row.execution === undefined || commandCenterExecutionBelongsToTask(row.execution, row.target);
}

export function parseCommandCenterTaskSummary(value: unknown): CommandCenterTaskSummary {
  if (!Value.Check(CommandCenterTaskSummarySchema, value) || !validSummaryRow(value)) {
    throw new Error("COMMAND_CENTER_INVALID_SUMMARY");
  }
  return value;
}

/**
 * Validates a summary page: bounded rows and bytes, ordered revisions, and one
 * row per stable task owner. Duplicate rows would double-count a task in the
 * overview and let a stale row shadow a newer one.
 */
export function parseCommandCenterMonitorSnapshot(value: unknown): CommandCenterMonitorSnapshot {
  if (!Value.Check(CommandCenterMonitorSnapshotSchema, value) ||
      !commandCenterWithinBytes(value, COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES)) {
    throw new Error("COMMAND_CENTER_INVALID_SUMMARY");
  }
  if (!value.rows.every(validSummaryRow)) throw new Error("COMMAND_CENTER_INVALID_SUMMARY");
  const keys = new Set(value.rows.map((row) => commandCenterTaskKey(row.target)));
  if (keys.size !== value.rows.length) throw new Error("COMMAND_CENTER_INVALID_SUMMARY");
  return value;
}
