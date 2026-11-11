import { describe, expect, it } from "vitest";
import { commandCenterTaskKey, type CommandCenterTaskSummary } from "@pi-desktop/shared";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterObservationContext,
  createCommandCenterMonitorSummary,
  invalidateCommandCenterObservationContext,
} from "../index.js";

/**
 * Deterministic model-based check: every applied change stream must leave the
 * published projection exactly equal to an independent reference map. No
 * randomness beyond a fixed seed, no clock, transport or Host execution.
 */

const epoch = "model-epoch-1";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

function randomRow(next: () => number, index: number): CommandCenterTaskSummary {
  return {
    target: { kind: "session", sessionId: `p-${index}` },
    execution: { kind: "session", sessionId: `p-${index}`, turnId: `turn-${index}` },
    commandWorkspaceId: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50",
    label: `Task ${index}`,
    status: next() < 0.5 ? "running" : "waiting_tool",
    desiredGoalRevision: 2,
    effectiveGoalRevision: 1,
    pendingApprovals: next() < 0.3 ? 1 : 0,
    pendingInputs: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, { hostId: "model-host", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
  return value;
}

describe("monitor summary model-based sequences", () => {
  it.each([0, 7, 42])("matches an independent map for seeded change stream %i", (seed) => {
    const next = seeded(seed + 1);
    const initialRows = Array.from({ length: 6 }, (_, index) => randomRow(next, index));
    const bound = context();
    const summary = createCommandCenterMonitorSummary(bound, {
      cursor: { epoch, sequence: 0 },
      generatedAt: "2026-01-01T00:00:00.000Z",
      rows: initialRows,
    });
    const reference = new Map(initialRows.map((row) => [commandCenterTaskKey(row.target), row.label]));
    let sequence = 0;
    let created = initialRows.length;

    for (let step = 0; step < 120; step += 1) {
      sequence += 1;
      const choice = next();
      if (choice < 0.45) {
        // Replace an existing row with a new label.
        const keys = [...reference.keys()];
        const key = keys[Math.floor(next() * keys.length)];
        const row = randomRow(next, Number(key.split("-").at(-1)?.replace(/\D/g, "") ?? 0));
        const updated = { ...row, label: `Rewritten ${step}` };
        expect(summary.apply({ version: 1, epoch, sequence, type: "upsert", row: updated })).toBe("applied");
        reference.set(commandCenterTaskKey(updated.target), updated.label);
      } else if (choice < 0.7) {
        // Create a row that does not exist yet.
        created += 1;
        const row = randomRow(next, created);
        expect(summary.apply({ version: 1, epoch, sequence, type: "upsert", row })).toBe("applied");
        reference.set(commandCenterTaskKey(row.target), row.label);
      } else if (choice < 0.9 && reference.size > 0) {
        // Remove a known row.
        const key = [...reference.keys()][Math.floor(next() * reference.size)];
        const target = JSON.parse(key);
        expect(summary.apply({
          version: 1, epoch, sequence, type: "remove",
          target: target[0] === "session" ? { kind: "session", sessionId: target[1] } : target,
        })).toBe("applied");
        reference.delete(key);
      } else {
        // Remove of a task that is not present: idempotent but still consumes the sequence.
        expect(summary.apply({
          version: 1, epoch, sequence, type: "remove",
          target: { kind: "session", sessionId: `absent-${step}` },
        })).toBe("applied");
      }

      const state = summary.getState();
      if (state.status !== "ready") throw new Error(`Unexpected summary state: ${state.status}`);
      const observed = new Map(state.projection.rows.map((row) => [commandCenterTaskKey(row.target), row.label]));
      expect(observed).toEqual(reference);
      expect(state.projection.cursor).toEqual({ epoch, sequence });
      expect(state.projection.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    }

    invalidateCommandCenterObservationContext(bound);
    expect(summary.getState()).toMatchObject({ status: "invalidated", projection: null });
  });

  it("treats any replayed or lower sequence as a duplicate without divergence", () => {
    const bound = context();
    const first = randomRow(() => 0.5, 0);
    const summary = createCommandCenterMonitorSummary(bound, {
      cursor: { epoch, sequence: 10 },
      generatedAt: "2026-01-01T00:00:00.000Z",
      rows: [first],
    });
    const before = summary.getState();
    if (before.status !== "ready") throw new Error(`Unexpected summary state: ${before.status}`);
    for (const sequence of [9, 10, 1]) {
      expect(summary.apply({ version: 1, epoch, sequence, type: "upsert", row: { ...first, label: "duplicate" } }))
        .toBe("duplicate");
    }
    expect(summary.getState()).toBe(before);
    expect(before.projection.rows[0].label).toBe(first.label);
    invalidateCommandCenterObservationContext(bound);
  });
});
