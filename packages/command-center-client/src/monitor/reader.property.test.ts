import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CommandCenterMonitorSnapshot, CommandCenterTaskSummary } from "@pi-desktop/shared";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterObservationContext,
  invalidateCommandCenterObservationContext,
} from "../context.js";
import { createCommandCenterMonitorReader } from "./index.js";

/**
 * Seeded model check of the all-pages reader. Arbitrary legal page partitions
 * must reconstruct exactly the input rows in order; every corruption class must
 * fail explicitly with its documented reason and no partial publication.
 */

const summary = JSON.parse(
  readFileSync(new URL("../../../shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const baseRow: CommandCenterTaskSummary = summary.snapshot.rows[0];
const owner = {
  hostId: "reader-model-host",
  expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

function taskRow(index: number): CommandCenterTaskSummary {
  return {
    ...structuredClone(baseRow),
    target: { kind: "session", sessionId: `reader-task-${index}` },
    execution: { kind: "session", sessionId: `reader-task-${index}`, turnId: `turn-${index}` },
    label: `Task ${index}`,
  };
}

function page(
  rows: CommandCenterTaskSummary[],
  nextPage?: string,
  overrides: Partial<CommandCenterMonitorSnapshot> = {},
): CommandCenterMonitorSnapshot {
  return {
    version: 1,
    cursor: { epoch: "reader-epoch-1", sequence: 50 },
    generatedAt: "2026-01-01T00:00:00.000Z",
    rows,
    ...(nextPage === undefined ? {} : { nextPage }),
    ...overrides,
  };
}

/** Split rows into random legal page sizes; tokens bind to the following page. */
function partition(next: () => number, rows: CommandCenterTaskSummary[]) {
  const pages: CommandCenterMonitorSnapshot[] = [];
  let offset = 0;
  while (offset < rows.length) {
    const size = Math.min(1 + Math.floor(next() * 100), rows.length - offset);
    const slice = rows.slice(offset, offset + size);
    offset += size;
    const token = offset < rows.length ? `token-${pages.length + 1}` : undefined;
    pages.push(page(slice, token));
  }
  return pages;
}

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, owner);
  return value;
}

function loaderFor(pages: CommandCenterMonitorSnapshot[], onCall?: (index: number) => void) {
  return async (token: string | undefined, signal: AbortSignal): Promise<unknown> => {
    expect(signal.aborted).toBe(false);
    const index = token === undefined ? 0 : Number(token.split("-")[1]);
    onCall?.(index);
    const value = pages[index];
    if (value === undefined) throw new Error(`Missing page for ${String(token)}`);
    return value;
  };
}

describe("monitor reader seeded page partitions", () => {
  it.each([0, 4, 13])("reconstructs arbitrary legal partitions in order (seed %i)", async (seed) => {
    const next = seeded(seed + 50);
    const count = 20 + Math.floor(next() * 230);
    const rows = Array.from({ length: count }, (_, index) => taskRow(index));
    const pages = partition(next, rows);
    let calls = 0;
    const reader = createCommandCenterMonitorReader(context(), loaderFor(pages, () => { calls += 1; }));
    const result = await reader.refresh();
    expect(result.kind).toBe("published");
    if (result.kind !== "published") throw new Error("unexpected result");
    expect(result.projection.rows).toEqual(rows);
    expect(result.projection.cursor).toEqual({ epoch: "reader-epoch-1", sequence: 50 });
    expect(result.projection.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(calls).toBe(pages.length);
    for (const pageValue of pages) {
      expect(pageValue.rows.length).toBeLessThanOrEqual(100);
    }
    reader.dispose();
  });

  it("reports a changed generation, duplicate task and token cycle explicitly", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => taskRow(index));
    const cases: [string, CommandCenterMonitorSnapshot[], string][] = [
      ["inconsistent_generation", [page(rows.slice(0, 15), "token-1"), page(rows.slice(15), undefined, {
        cursor: { epoch: "reader-epoch-2", sequence: 50 },
      })], "inconsistent_generation"],
      ["duplicate_task", [page([rows[0]], "token-1"), page(rows, undefined)], "duplicate_task"],
      ["token_cycle", [page([rows[0]], "token-1"), page([rows[1]], "token-1")], "token_cycle"],
    ];
    for (const [, pages, reason] of cases) {
      const reader = createCommandCenterMonitorReader(context(), loaderFor(pages));
      const result = await reader.refresh();
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.reason).toBe(reason);
      reader.dispose();
    }
  });

  it("keeps the last complete projection when a later load fails", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => taskRow(index));
    const pages = [page(rows.slice(0, 3), "token-1"), page(rows.slice(3))];
    const bound = context();
    let failSecond = false;
    const loader = async (token: string | undefined) => {
      if (failSecond && token !== undefined) throw new Error("transport");
      return token === undefined ? pages[0] : pages[1];
    };
    const reader = createCommandCenterMonitorReader(bound, loader);
    expect((await reader.refresh()).kind).toBe("published");
    const prior = reader.getState();
    failSecond = true;
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "load_failed" });
    const after = reader.getState();
    expect(after.status).toBe("error");
    if (after.status === "error") expect(after.projection).toBe(prior.projection);
    invalidateCommandCenterObservationContext(bound);
    reader.dispose();
  });
});
