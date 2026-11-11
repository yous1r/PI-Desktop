import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  COMMAND_CENTER_MAX_AGENTS_PER_HOST, COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE,
  COMMAND_CENTER_VERSION,
} from "./primitives.js";

/**
 * Admission states mirrored from the Rust C2 reservation authority.
 *
 * `queued` is deliberately absent: a queued start that has not reserved a
 * runtime holds no slot in C2. Once admitted it is `reserved`, and every state
 * here except the four terminal ones still occupies capacity.
 */
export const COMMAND_CENTER_ADMISSION_STATES = [
  "reserved", "starting", "running", "waiting_tool", "waiting_human",
  "stopping", "outcome_unknown", "interrupted",
  "completed", "aborted", "failed", "launch_failed",
] as const;
export type CommandCenterAdmissionState = (typeof COMMAND_CENTER_ADMISSION_STATES)[number];
export const CommandCenterAdmissionStateSchema = Type.Union([
  Type.Literal("reserved"), Type.Literal("starting"), Type.Literal("running"),
  Type.Literal("waiting_tool"), Type.Literal("waiting_human"), Type.Literal("stopping"),
  Type.Literal("outcome_unknown"), Type.Literal("interrupted"),
  Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed"), Type.Literal("launch_failed"),
]);

/** Terminal states release their slot exactly once; everything else retains it. */
export const COMMAND_CENTER_TERMINAL_ADMISSION_STATES: readonly CommandCenterAdmissionState[] = Object.freeze([
  "completed", "aborted", "failed", "launch_failed",
]);

export function commandCenterAdmissionHoldsCapacity(state: CommandCenterAdmissionState): boolean {
  return !COMMAND_CENTER_TERMINAL_ADMISSION_STATES.includes(state);
}

const workspaceCapacity = Type.Object({
  workspaceId: Type.String({ pattern: "^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  live: Type.Integer({ minimum: 0 }),
  maxLive: Type.Literal(COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE),
}, { additionalProperties: false });

/**
 * Read-only capacity projection. Counts come from the C2 reservation authority;
 * the seam never maintains a second counter.
 */
export const CommandCenterAdmissionSnapshotSchema = Type.Object({
  version: Type.Literal(COMMAND_CENTER_VERSION),
  hostLive: Type.Integer({ minimum: 0, maximum: COMMAND_CENTER_MAX_AGENTS_PER_HOST }),
  maxHostLive: Type.Literal(COMMAND_CENTER_MAX_AGENTS_PER_HOST),
  maxWorkspaceLive: Type.Literal(COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE),
  workspaces: Type.Array(workspaceCapacity, { maxItems: 100 }),
}, { additionalProperties: false });
export type CommandCenterAdmissionSnapshot = Static<typeof CommandCenterAdmissionSnapshotSchema>;

export function parseCommandCenterAdmissionSnapshot(value: unknown): CommandCenterAdmissionSnapshot {
  if (!Value.Check(CommandCenterAdmissionSnapshotSchema, value)) {
    throw new Error("COMMAND_CENTER_INVALID_ADMISSION");
  }
  const ids = new Set(value.workspaces.map((row) => row.workspaceId));
  if (ids.size !== value.workspaces.length ||
      value.workspaces.some((row) => row.live > row.maxLive) ||
      value.hostLive < value.workspaces.reduce((total, row) => total + row.live, 0)) {
    throw new Error("COMMAND_CENTER_INVALID_ADMISSION");
  }
  return value;
}

export const COMMAND_CENTER_ADMISSION_LIMITS = Object.freeze({
  maxLivePerWorkspace: COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE,
  maxLivePerHost: COMMAND_CENTER_MAX_AGENTS_PER_HOST,
} as const);
