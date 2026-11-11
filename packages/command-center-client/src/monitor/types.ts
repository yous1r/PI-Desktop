import type { CommandCenterMonitorCursor, CommandCenterTaskSummary } from "@pi-desktop/shared";
import type { CommandCenterReadonly } from "../types.js";

/** All pages of one generation; deliberately not a C1 snapshot/page wire type. */
export type CommandCenterMonitorProjection = CommandCenterReadonly<{
  cursor: CommandCenterMonitorCursor;
  generatedAt: string;
  rows: CommandCenterTaskSummary[];
}>;

/** A trusted adapter supplies authorized pages. The reader never opens a transport. */
export type CommandCenterMonitorPageLoader = (
  token: string | undefined,
  signal: AbortSignal,
) => Promise<unknown>;

export interface CommandCenterMonitorReaderLimits {
  maxRows: number;
  /** Sum of canonical UTF-8 JSON page bytes, not a JavaScript heap measurement. */
  maxBytes: number;
  /**
   * Pages in one generation. The Host default permits 1,024 continuation tokens
   * in addition to the initial page, so the matching ceiling is 1,025.
   */
  maxPages: number;
  /** Original loader promises remain counted after local cancellation. */
  maxPendingLoads: number;
}

export const COMMAND_CENTER_MONITOR_READER_LIMITS: Readonly<CommandCenterMonitorReaderLimits> = Object.freeze({
  maxRows: 10_000,
  maxBytes: 16 * 1024 * 1024,
  maxPages: 1025,
  maxPendingLoads: 2,
});

/** Safe local categories only; never a wire error code or a server error message. */
export type CommandCenterMonitorReadFailure =
  | "invalid_page" | "inconsistent_generation" | "duplicate_task" | "token_cycle"
  | "row_limit" | "byte_limit" | "page_limit" | "load_failed" | "busy";

export type CommandCenterMonitorCancellation = "superseded" | "cancelled" | "context_invalidated" | "disposed";

export type CommandCenterMonitorRefreshResult =
  | Readonly<{ kind: "published"; projection: CommandCenterMonitorProjection }>
  | Readonly<{ kind: "failed"; reason: CommandCenterMonitorReadFailure }>
  | Readonly<{ kind: "cancelled"; reason: CommandCenterMonitorCancellation }>;

export type CommandCenterMonitorReaderState =
  | Readonly<{ status: "idle" | "loading" | "ready"; projection: CommandCenterMonitorProjection | null }>
  | Readonly<{
    status: "error" | "resync_required";
    projection: CommandCenterMonitorProjection | null;
    reason: CommandCenterMonitorReadFailure;
  }>
  | Readonly<{ status: "cancelled"; projection: CommandCenterMonitorProjection | null; reason: "cancelled" }>
  | Readonly<{ status: "invalidated" | "disposed"; projection: null }>;

export interface CommandCenterMonitorReader {
  getState(): CommandCenterMonitorReaderState;
  /** Explicit refresh only; no retry or queued work if original I/O fills the budget. */
  refresh(): Promise<CommandCenterMonitorRefreshResult>;
  /** Resolve the active request as cancelled immediately, even if its loader ignores abort. */
  cancel(): boolean;
  /** Clear retained data, abort observation and detach from the context. */
  dispose(): void;
}
