import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_TASK_STATES, CommandCenterMonitorSnapshotSchema, CommandCenterTaskSummarySchema,
  parseCommandCenterMonitorSnapshot, parseCommandCenterTaskSummary,
} from "./summary.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-summary.json", import.meta.url), "utf8"));
const snapshot = fixture.snapshot;

function longRow(index: number): Record<string, unknown> {
  return {
    target: { kind: "session", sessionId: `${String(index).padStart(3, "0")}${"控".repeat(125)}` },
    commandWorkspaceId: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50",
    parent: { kind: "session", sessionId: `${String(index).padStart(3, "0")}${"控".repeat(125)}` },
    label: "控".repeat(256),
    status: "waiting_tool",
    waitingReason: "控".repeat(128),
    activity: "控".repeat(256),
    desiredGoalRevision: 1,
    effectiveGoalRevision: 0,
    pendingApprovals: 0,
    pendingInputs: 0,
    updatedAt: "控".repeat(64),
  };
}

describe("command-center bounded task summary contract", () => {
  it("accepts the golden snapshot with a settled row that has no fabricated turn", () => {
    const parsed = parseCommandCenterMonitorSnapshot(snapshot);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.cursor).toEqual({ epoch: "monitor-epoch-0001", sequence: 42 });
    expect(parsed.nextPage).toBe("page-2");
    expect(parsed.rows[2].status).toBe("completed");
    expect(parsed.rows[2].execution).toBeUndefined();
    expect(Value.Check(CommandCenterTaskSummarySchema, parsed.rows[0])).toBe(true);
    expect(COMMAND_CENTER_TASK_STATES).toContain(parsed.rows[0].status);
  });

  it("rejects fabricated turns, unordered revisions and execution/target mismatches", () => {
    expect(() => parseCommandCenterTaskSummary({
      ...snapshot.rows[2],
      target: { ...snapshot.rows[2].target, turnId: "turn-invented" },
    })).toThrow("COMMAND_CENTER_INVALID_SUMMARY");
    expect(() => parseCommandCenterTaskSummary({ ...snapshot.rows[0], effectiveGoalRevision: 6 })).toThrow("COMMAND_CENTER_INVALID_SUMMARY");
    expect(() => parseCommandCenterMonitorSnapshot({
      ...snapshot,
      rows: [{ ...snapshot.rows[0], execution: { kind: "session", sessionId: "sess-other", turnId: "turn-other" } }],
    })).toThrow("COMMAND_CENTER_INVALID_SUMMARY");
    expect(Value.Check(CommandCenterMonitorSnapshotSchema, {
      ...snapshot,
      rows: [{ ...snapshot.rows[0], status: "queued" }],
    })).toBe(false);
    expect(Value.Check(CommandCenterMonitorSnapshotSchema, { ...snapshot, rows: [{ ...snapshot.rows[0], providerPayload: "secret" }] })).toBe(false);
  });

  it("rejects duplicate task rows and more than one hundred rows", () => {
    expect(() => parseCommandCenterMonitorSnapshot({ ...snapshot, rows: [snapshot.rows[0], snapshot.rows[0]] }))
      .toThrow("COMMAND_CENTER_INVALID_SUMMARY");
    const many = Array.from({ length: 101 }, (_, index) => ({
      ...snapshot.rows[0],
      target: { kind: "session", sessionId: `sess-${index}` },
      execution: undefined,
    }));
    expect(Value.Check(CommandCenterMonitorSnapshotSchema, { ...snapshot, rows: many })).toBe(false);
  });

  it("enforces the page byte cap independently of the row cap", () => {
    const rows = Array.from({ length: 100 }, (_, index) => longRow(index));
    expect(Value.Check(CommandCenterMonitorSnapshotSchema, { ...snapshot, rows })).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify({ ...snapshot, rows })).byteLength).toBeGreaterThan(256 * 1024);
    expect(() => parseCommandCenterMonitorSnapshot({ ...snapshot, rows })).toThrow("COMMAND_CENTER_INVALID_SUMMARY");
  });
});
