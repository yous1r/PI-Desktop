import {
  COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES,
  COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS,
  type CommandCenterMonitorSnapshot,
  type CommandCenterTaskSummary,
} from "@pi-desktop/shared";
import type { Clock } from "../ports.js";

/** Serialized retention budgets, not a measurement of JavaScript heap usage. */
export type MonitorSnapshotLimits = {
  maxRows: number;
  maxBytes: number;
  maxGenerations: number;
  maxTokens: number;
  maxAgeMs: number;
  pageRows: number;
  pageBytes: number;
};

/** Hard ceilings; an embedding Host may negotiate smaller limits. */
export const MONITOR_SNAPSHOT_LIMITS: Readonly<MonitorSnapshotLimits> = Object.freeze({
  maxRows: 10_000,
  maxBytes: 16 * 1024 * 1024,
  maxGenerations: 8,
  maxTokens: 1024,
  maxAgeMs: 60_000,
  pageRows: COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS,
  pageBytes: COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES,
});

export type MonitorSnapshotOptions = {
  /** Boot epoch supplied by the projection owner. */
  epoch: string;
  clock: Clock;
  /** Supply fresh cryptographically unpredictable values; never use Math.random. */
  tokens: { next(): string };
  limits?: Partial<MonitorSnapshotLimits>;
};

export type MonitorSnapshotCapture = {
  /** Trusted authorization generation AND filter identity, not client input. */
  scopeKey: string;
  /** Supplied by the projection owner; this store does not create a stream barrier. */
  sequence: number;
  /** Already authorized authoritative C1 rows. No missing facts are synthesized. */
  rows: Iterable<CommandCenterTaskSummary>;
};

export type MonitorSnapshotPageRequest = {
  scopeKey: string;
  epoch: string;
  token: string;
};

export type MonitorSnapshotPageResult =
  | { status: "page"; snapshot: CommandCenterMonitorSnapshot }
  | { status: "resync"; reason: "expired_or_evicted" | "scope" | "epoch" | "disposed" };

export type MonitorSnapshotCaptureFailure =
  | "invalid_scope" | "invalid_row" | "duplicate_task" | "row_limit" | "byte_limit"
  | "token_limit" | "page_limit" | "invalid_token_source" | "generation_exhausted"
  | "disposed" | "invalidated" | "capture_in_progress" | "expired";

/** Internal failure category; not a registered RACP error or wire contract. */
export class MonitorSnapshotCaptureError extends Error {
  constructor(readonly reason: MonitorSnapshotCaptureFailure, options?: ErrorOptions) {
    super(`Monitor snapshot capture failed: ${reason}`, options);
    this.name = "MonitorSnapshotCaptureError";
  }
}

export function snapshotLimits(overrides: Partial<MonitorSnapshotLimits> = {}): Readonly<MonitorSnapshotLimits> {
  const limits = { ...MONITOR_SNAPSHOT_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof MonitorSnapshotLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > MONITOR_SNAPSHOT_LIMITS[key]) {
      throw new RangeError(`Invalid monitor snapshot limit: ${key}`);
    }
  }
  return Object.freeze(limits);
}
