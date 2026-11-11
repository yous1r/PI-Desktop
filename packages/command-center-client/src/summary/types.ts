import type { CommandCenterMonitorProjection } from "../monitor/types.js";

export interface CommandCenterMonitorSummaryLimits {
  maxRows: number;
  /** Sum of canonical per-row UTF-8 JSON bytes; not a heap or transport measurement. */
  maxBytes: number;
}

export const COMMAND_CENTER_MONITOR_SUMMARY_LIMITS: Readonly<CommandCenterMonitorSummaryLimits> = Object.freeze({
  maxRows: 10_000,
  maxBytes: 16 * 1024 * 1024,
});

/** Safe local values, not registered wire error codes. */
export type CommandCenterMonitorSummaryResyncReason =
  | "sequence_gap" | "epoch_mismatch" | "source_resync" | "row_limit" | "byte_limit" | "requested";

export type CommandCenterMonitorSummaryState =
  | Readonly<{ status: "ready"; projection: CommandCenterMonitorProjection }>
  | Readonly<{
    status: "resync_required";
    projection: CommandCenterMonitorProjection;
    reason: CommandCenterMonitorSummaryResyncReason;
  }>
  | Readonly<{ status: "invalidated" | "disposed"; projection: null }>;

export type CommandCenterMonitorSummaryApplyResult =
  | "applied" | "duplicate"
  | Readonly<{ rejected: "invalid_change" | "context_invalidated" | "disposed" | "state_changed" }>
  | Readonly<{ resync: CommandCenterMonitorSummaryResyncReason }>;

export interface CommandCenterMonitorSummary {
  getState(): CommandCenterMonitorSummaryState;
  apply(change: unknown): CommandCenterMonitorSummaryApplyResult;
  /** Explicitly require a new snapshot; this model cannot reset its sequence barrier. */
  resync(): void;
  /** Release retained rows and detach from observation. Does not affect Host execution. */
  dispose(): void;
}
