import { describe, expect, it, vi } from "vitest";
import {
  commandCenterCanonicalJson,
  commandCenterUtf8Bytes,
  parseCommandCenterTaskSummary,
  type CommandCenterMonitorSnapshot,
} from "@pi-desktop/shared";
import summary from "../../../shared/test/fixtures/command-center-summary.json";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterObservationContext,
} from "../context.js";
import {
  COMMAND_CENTER_MONITOR_READER_LIMITS,
  createCommandCenterMonitorReader,
  type CommandCenterMonitorReaderLimits,
} from "./index.js";

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, {
    hostId: "host-test", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
  });
  return value;
}

function page(ids = ["one"], nextPage?: string): CommandCenterMonitorSnapshot {
  return {
    version: 1,
    cursor: { epoch: "monitor", sequence: 42 },
    generatedAt: "2026-01-01T00:00:00.000Z",
    rows: ids.map((sessionId) => parseCommandCenterTaskSummary({
      ...structuredClone(summary.snapshot.rows[0]),
      target: { kind: "session", sessionId },
      execution: { kind: "session", sessionId, turnId: `turn-${sessionId}` },
    })),
    ...(nextPage === undefined ? {} : { nextPage }),
  };
}

function bytes(value: unknown) {
  return commandCenterUtf8Bytes(commandCenterCanonicalJson(value));
}

describe("monitor reader validation and budgets", () => {
  it("rejects duplicate stable tasks across pages even with a changed execution", async () => {
    const second = page();
    second.rows[0].execution = { kind: "session", sessionId: "one", turnId: "replacement-turn" };
    const loader = vi.fn().mockResolvedValueOnce(page(["one"], "second")).mockResolvedValueOnce(second);
    const reader = createCommandCenterMonitorReader(context(), loader);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "duplicate_task" });
    expect(reader.getState().projection).toBeNull();
    reader.dispose();
  });

  it.each([
    [page([], "loop"), page([], "loop")],
    [page([], "a"), page([], "b"), page([], "a")],
  ])("rejects repeated page tokens and longer cycles without another load (%#)", async (...pages) => {
    const loader = vi.fn(async () => pages.shift());
    const expectedCalls = pages.length;
    const reader = createCommandCenterMonitorReader(context(), loader);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "token_cycle" });
    expect(loader).toHaveBeenCalledTimes(expectedCalls);
    reader.dispose();
  });

  it.each([
    null,
    { ...page(), version: 2 },
    { ...page(), credential: "secret" },
    { ...page(), nextPage: "" },
    { ...page(), nextPage: "x".repeat(513) },
    { ...page(), cursor: { epoch: "monitor", sequence: -1 } },
    { ...page(), rows: [...page().rows, ...page().rows] },
    { ...page(), rows: [{ ...page().rows[0], effectiveGoalRevision: 100 }] },
    page(Array.from({ length: 101 }, (_, index) => `task-${index}`)),
  ])("uses strict C1 parsing for malformed pages (%#)", async (input) => {
    const reader = createCommandCenterMonitorReader(context(), async () => input);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "invalid_page" });
    expect(reader.getState()).toEqual({ status: "error", projection: null, reason: "invalid_page" });
    reader.dispose();
  });

  it("rejects a shape-valid page beyond C1's byte cap", async () => {
    const input = page(Array.from({ length: 100 }, (_, index) => `task-${index}`));
    for (const row of input.rows) {
      row.label = "界".repeat(256);
      row.activity = "界".repeat(256);
      row.waitingReason = "界".repeat(128);
      row.projectId = "界".repeat(128);
      row.parent = { kind: "delegation", parentSessionId: "界".repeat(128), delegationId: "界".repeat(128) };
    }
    expect(bytes(input)).toBeGreaterThan(256 * 1024);
    const reader = createCommandCenterMonitorReader(context(), async () => input);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "invalid_page" });
    reader.dispose();
  });

  it("enforces total row budget across valid pages and accepts exactly the bound", async () => {
    const exact = createCommandCenterMonitorReader(context(), vi.fn()
      .mockResolvedValueOnce(page(["one"], "next")).mockResolvedValueOnce(page(["two"])), { maxRows: 2 });
    expect(await exact.refresh()).toMatchObject({ kind: "published", projection: { rows: [{}, {}] } });
    const over = createCommandCenterMonitorReader(context(), vi.fn()
      .mockResolvedValueOnce(page(["one"], "next")).mockResolvedValueOnce(page(["two", "three"])), { maxRows: 2 });
    expect(await over.refresh()).toEqual({ kind: "failed", reason: "row_limit" });
    expect(over.getState().projection).toBeNull();
    exact.dispose();
    over.dispose();
  });

  it("counts canonical UTF-8 serialized bytes across pages and accepts the exact bound", async () => {
    const first = page(["one"], "next");
    first.rows[0].label = "界";
    const second = page(["two"]);
    const total = bytes(first) + bytes(second);
    for (const allowance of [total, total - 1]) {
      const reader = createCommandCenterMonitorReader(context(), vi.fn()
        .mockResolvedValueOnce(first).mockResolvedValueOnce(second), { maxBytes: allowance });
      const result = await reader.refresh();
      expect(result.kind).toBe(allowance === total ? "published" : "failed");
      if (allowance < total) expect(result).toEqual({ kind: "failed", reason: "byte_limit" });
      reader.dispose();
    }
  });

  it("bounds page count including empty pages without issuing an over-budget load", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([], "next")).mockResolvedValueOnce(page([], "last"));
    const reader = createCommandCenterMonitorReader(context(), loader, { maxPages: 2 });
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "page_limit" });
    expect(loader).toHaveBeenCalledTimes(2);
    reader.dispose();
    const exact = createCommandCenterMonitorReader(context(), vi.fn()
      .mockResolvedValueOnce(page([], "next")).mockResolvedValueOnce(page([])), { maxPages: 2 });
    expect(await exact.refresh()).toMatchObject({ kind: "published", projection: { rows: [] } });
    exact.dispose();
  });

  it.each(Object.keys(COMMAND_CENTER_MONITOR_READER_LIMITS) as (keyof CommandCenterMonitorReaderLimits)[])(
    "allows only lower positive integer overrides for %s", (key) => {
      for (const value of [0, -1, 1.5, NaN, Infinity, COMMAND_CENTER_MONITOR_READER_LIMITS[key] + 1]) {
        expect(() => createCommandCenterMonitorReader(context(), async () => page(), { [key]: value }))
          .toThrow("COMMAND_CENTER_CLIENT_INVALID_MONITOR_LIMIT");
      }
      const options = { [key]: 1 };
      const reader = createCommandCenterMonitorReader(context(), async () => page(), options);
      options[key] = 1_000_000;
      reader.dispose();
    },
  );

  it("copies configured limits so later caller mutation cannot widen a running reader", async () => {
    const options = { maxRows: 1 };
    const reader = createCommandCenterMonitorReader(context(), async () => page(["one", "two"]), options);
    options.maxRows = 10_000;
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "row_limit" });
    reader.dispose();
  });

  it("reports synchronous loader throws using the same safe failure result", async () => {
    const reader = createCommandCenterMonitorReader(context(), () => { throw new Error("private detail"); });
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "load_failed" });
    expect(reader.getState()).toEqual({ status: "error", projection: null, reason: "load_failed" });
    reader.dispose();
  });

  it("rejects unknown limits instead of silently widening a budget", () => {
    const options = { maxRows: 1, unknownLimit: 1 };
    expect(() => createCommandCenterMonitorReader(context(), async () => page(), options))
      .toThrow("COMMAND_CENTER_CLIENT_INVALID_MONITOR_LIMIT");
  });

  it("detaches and freezes nested returned projection and preserves desired/effective values", async () => {
    const input = page();
    const reader = createCommandCenterMonitorReader(context(), async () => input);
    const result = await reader.refresh();
    if (result.kind !== "published") throw new Error("Expected complete projection");
    const original = structuredClone(input);
    input.rows[0].label = "Modified input";
    input.rows[0].usage!.inputTokens = 0;
    input.cursor.sequence = 123;
    expect(result.projection.rows).toEqual(original.rows);
    expect(result.projection.cursor).toEqual(original.cursor);
    expect(result.projection.rows[0]).toMatchObject({ desiredGoalRevision: 5, effectiveGoalRevision: 4 });
    expect(Object.isFrozen(reader.getState())).toBe(true);
    expect(Object.isFrozen(result.projection.rows)).toBe(true);
    expect(Reflect.set(result.projection.cursor, "sequence", 999)).toBe(false);
    expect(Reflect.set(result.projection.rows[0], "label", "Modified output")).toBe(false);
    expect(Reflect.set(result.projection.rows[0].target, "sessionId", "other")).toBe(false);
    expect(Reflect.set(result.projection.rows[0].usage!, "inputTokens", 0)).toBe(false);
    reader.dispose();
  });

  it("reports an initial loader failure safely and only retries on an explicit later refresh", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("sensitive detail")).mockResolvedValueOnce(page());
    const reader = createCommandCenterMonitorReader(context(), loader);
    expect(await reader.refresh()).toEqual({ kind: "failed", reason: "load_failed" });
    expect(reader.getState()).toEqual({ status: "error", projection: null, reason: "load_failed" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await reader.refresh()).toMatchObject({ kind: "published" });
    expect(loader).toHaveBeenCalledTimes(2);
    reader.dispose();
  });
});
