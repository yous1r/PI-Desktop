import { readFileSync } from "node:fs";
import { expect } from "vitest";
import {
  parseCommandCenterMonitorSnapshot,
  type CommandCenterMonitorSnapshot,
  type CommandCenterTaskSummary,
} from "@pi-desktop/shared";
import { MonitorSnapshotStore, type MonitorSnapshotLimits } from "./snapshot-store.js";

export const EPOCH = "monitor-boot-1";
export const SCOPE = "principal-1:authorization-4:all-workspaces";
export const START = Date.parse("2026-01-01T00:00:00.000Z");

export function goldenRows(): CommandCenterTaskSummary[] {
  const fixture = JSON.parse(readFileSync(new URL("../../../shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"));
  return parseCommandCenterMonitorSnapshot(fixture.snapshot).rows;
}

export function row(index: number, label = `Task ${index}`): CommandCenterTaskSummary {
  return {
    target: { kind: "session", sessionId: `session-${index}` },
    commandWorkspaceId: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50",
    label, status: "completed", desiredGoalRevision: 3, effectiveGoalRevision: 3,
    pendingApprovals: 0, pendingInputs: 0, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function harness(limits: Partial<MonitorSnapshotLimits> = {}, next?: () => string) {
  const clock = { time: START, now() { return this.time; } };
  let tokenId = 0;
  const store = new MonitorSnapshotStore({
    epoch: EPOCH, clock, tokens: { next: next ?? (() => `test-opaque-${++tokenId}`) }, limits,
  });
  return { store, clock };
}

export function capture(store: MonitorSnapshotStore, rows: Iterable<CommandCenterTaskSummary>, sequence = 1, scopeKey = SCOPE) {
  return store.capture({ scopeKey, sequence, rows });
}

export function page(store: MonitorSnapshotStore, token: string, scopeKey = SCOPE): CommandCenterMonitorSnapshot {
  const result = store.page({ scopeKey, epoch: store.epoch, token });
  expect(result.status).toBe("page");
  if (result.status !== "page") throw new Error(`Unexpected resync: ${result.reason}`);
  return result.snapshot;
}

export function token(snapshot: CommandCenterMonitorSnapshot): string {
  expect(snapshot.nextPage).toBeTypeOf("string");
  if (snapshot.nextPage === undefined) throw new Error("Expected a continuation page");
  return snapshot.nextPage;
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
