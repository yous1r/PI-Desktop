import { describe, expect, it } from "vitest";
import { MonitorSnapshotStore, type MonitorSnapshotLimits } from "./snapshot-store.js";
import { EPOCH, row, SCOPE, START } from "./snapshot-store.test-support.js";

/**
 * Deterministic model-based pagination check: for arbitrary row counts and page
 * sizes, following all continuation tokens must reproduce exactly the captured
 * rows in order at one cursor. No timers, transport or Host execution.
 */

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

function makeStore(limits: Partial<MonitorSnapshotLimits> = {}) {
  const clock = { time: START, now() { return this.time; } };
  let serial = 0;
  const store = new MonitorSnapshotStore({
    epoch: EPOCH, clock, tokens: { next: () => `prop-token-${++serial}` }, limits,
  });
  return store;
}

describe("monitor store model-based pagination", () => {
  it.each([0, 3, 11, 29])("reconstructs every captured row across random page sizes (seed %i)", (seed) => {
    const next = seeded(seed + 100);
    for (let round = 0; round < 12; round += 1) {
      const count = Math.floor(next() * 251);
      const pageRows = 1 + Math.floor(next() * 100);
      const sequence = Math.floor(next() * 10_000);
      const rows = Array.from({ length: count }, (_, index) => row(index));
      const store = makeStore({ pageRows });
      const first = store.capture({ scopeKey: SCOPE, sequence, rows });

      const collected = [...first.rows];
      const tokens = new Set<string>();
      let page = first;
      while (page.nextPage !== undefined) {
        expect(tokens.has(page.nextPage)).toBe(false);
        tokens.add(page.nextPage);
        const result = store.page({ scopeKey: SCOPE, epoch: EPOCH, token: page.nextPage });
        expect(result.status).toBe("page");
        if (result.status !== "page") break;
        page = result.snapshot;
        expect(page.cursor).toEqual(first.cursor);
        expect(page.generatedAt).toBe(first.generatedAt);
        expect(page.rows.length).toBeLessThanOrEqual(pageRows);
        collected.push(...page.rows);
      }
      expect(collected).toEqual(rows);
      expect(first.rows.length).toBeLessThanOrEqual(pageRows);
      expect(first.cursor).toEqual({ epoch: EPOCH, sequence });
      store.dispose();
    }
  });

  it("never serves source or returned-page mutations through a retained page", () => {
    const next = seeded(777);
    for (let round = 0; round < 20; round += 1) {
      const count = 8 + Math.floor(next() * 113);
      const rows = Array.from({ length: count }, (_, index) => row(index));
      const store = makeStore({ pageRows: 7 });
      const first = store.capture({ scopeKey: SCOPE, sequence: round, rows });
      const expectedSecondPage = rows.slice(7, 14).map((served) => ({ ...served }));

      // Mutate every original object and the caller's returned first page after
      // the capture. A later retained page must still serve the original labels.
      for (const source of rows) source.label = "Mutated source";
      for (const served of first.rows) served.label = "Mutated served page";
      const continuation = first.nextPage;
      expect(continuation).toBeTypeOf("string");
      if (continuation === undefined) throw new Error("Expected a continuation");
      const reread = store.page({ scopeKey: SCOPE, epoch: EPOCH, token: continuation });
      expect(reread.status).toBe("page");
      if (reread.status !== "page") throw new Error(`Unexpected resync: ${reread.reason}`);
      // The second page's served labels are untouched originals, and the caller's
      // mutations to the first page did not leak into the retained generation.
      expect(reread.snapshot.rows).toEqual(expectedSecondPage);
      expect(first.rows.every((served) => served.label === "Mutated served page")).toBe(true);
      store.dispose();
    }
  });
});
