import type { CommandCenterConnectionHealthState } from "../health/types.js";
import type { CommandCenterMonitorProjection, CommandCenterMonitorReaderState } from "../monitor/types.js";
import type { CommandCenterMonitorSummaryState } from "../summary/types.js";
import type { CommandCenterMonitorSessionState } from "./types.js";

/** Compose immutable child snapshots without conflating transport health and synchronization. */
export function activeSessionState(
  previous: CommandCenterMonitorSessionState | undefined,
  health: CommandCenterConnectionHealthState,
  monitor: CommandCenterMonitorReaderState,
  summary: CommandCenterMonitorSummaryState | null,
  summaryCut: CommandCenterMonitorProjection | undefined,
): CommandCenterMonitorSessionState {
  const snapshotReady = monitor.status === "ready";
  const summaryReady = summary?.status === "ready";
  const fresh = snapshotReady && summaryReady && health.freshness === "fresh" &&
    health.status === "foreground" && summaryCut === monitor.projection;
  if (previous?.status === "active" && previous.health === health && previous.monitor === monitor && previous.summary === summary &&
      previous.snapshotReady === snapshotReady && previous.summaryReady === summaryReady && previous.fresh === fresh) return previous;
  return Object.freeze({ status: "active", health, monitor, summary, snapshotReady, summaryReady, fresh, stale: !fresh });
}

/** The owning scope is terminal even if a child was disposed earlier during callback cleanup. */
export function closedSessionState(
  status: "invalidated" | "disposed",
  health: CommandCenterConnectionHealthState,
): CommandCenterMonitorSessionState {
  return Object.freeze({
    status,
    health: Object.freeze({ ...health, status, freshness: "stale", resynchronized: false, lastReplyAtMs: null }),
    monitor: Object.freeze({ status, projection: null }),
    summary: Object.freeze({ status, projection: null }),
    snapshotReady: false,
    summaryReady: false,
    fresh: false,
    stale: true,
  });
}
