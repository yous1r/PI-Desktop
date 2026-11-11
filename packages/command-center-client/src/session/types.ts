import type {
  CommandCenterConnectionHealthOptions,
  CommandCenterConnectionHealthState,
  CommandCenterHealthSyncToken,
} from "../health/types.js";
import type {
  CommandCenterMonitorPageLoader,
  CommandCenterMonitorReaderLimits,
  CommandCenterMonitorReaderState,
  CommandCenterMonitorRefreshResult,
} from "../monitor/types.js";
import type {
  CommandCenterMonitorSummaryApplyResult,
  CommandCenterMonitorSummaryLimits,
  CommandCenterMonitorSummaryState,
} from "../summary/types.js";

export interface CommandCenterMonitorSessionOptions {
  loadPage: CommandCenterMonitorPageLoader;
  ping: CommandCenterConnectionHealthOptions["ping"];
  clock: CommandCenterConnectionHealthOptions["clock"];
  scheduler: CommandCenterConnectionHealthOptions["scheduler"];
  limits?: {
    reader?: Partial<CommandCenterMonitorReaderLimits>;
    summary?: Partial<CommandCenterMonitorSummaryLimits>;
    maxPendingPings?: 1 | 2;
  };
}

export type CommandCenterMonitorSessionState = Readonly<{
  status: "active" | "invalidated" | "disposed";
  health: CommandCenterConnectionHealthState;
  monitor: CommandCenterMonitorReaderState;
  summary: CommandCenterMonitorSummaryState | null;
  snapshotReady: boolean;
  summaryReady: boolean;
  /** Requires health freshness and a ready summary built from the current reader cut. */
  fresh: boolean;
  stale: boolean;
}>;

export type CommandCenterMonitorSessionRefreshResult = CommandCenterMonitorRefreshResult
  | Readonly<{ kind: "failed"; reason: "summary_rejected" }>;

export type CommandCenterMonitorSessionApplyResult = CommandCenterMonitorSummaryApplyResult
  | Readonly<{ rejected: "not_ready" }>;

export interface CommandCenterMonitorSession {
  getState(): CommandCenterMonitorSessionState;
  connect(): CommandCenterHealthSyncToken;
  resume(): CommandCenterHealthSyncToken;
  suspend(): void;
  disconnect(): void;
  /** Resynchronization uses only the connection cycle captured before this read. */
  refresh(): Promise<CommandCenterMonitorSessionRefreshResult>;
  apply(change: unknown): CommandCenterMonitorSessionApplyResult;
  dispose(): void;
}
