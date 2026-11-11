import { describe, expect, it } from "vitest";
import {
  commandCenterCanonicalJson, commandCenterUtf8Bytes, parseCommandCenterTaskSummary, type CommandCenterTaskSummary,
} from "@pi-desktop/shared";
import golden from "../../../shared/test/fixtures/command-center-summary.json";
import { bindCommandCenterObservationOwner, createCommandCenterObservationContext } from "../context.js";
import { COMMAND_CENTER_MONITOR_SUMMARY_LIMITS, createCommandCenterMonitorSummary } from "./index.js";

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, { hostId: "summary", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
  return value;
}

function row(id = "main"): CommandCenterTaskSummary {
  return parseCommandCenterTaskSummary({
    ...structuredClone(golden.snapshot.rows[0]),
    target: { kind: "session", sessionId: id }, execution: { kind: "session", sessionId: id, turnId: "turn" },
  });
}

function initial(rows: CommandCenterTaskSummary[] = [row()]) {
  return { cursor: { epoch: "monitor", sequence: 42 }, generatedAt: golden.snapshot.generatedAt, rows };
}

function change(value = row(), sequence = 43) {
  return { version: 1, epoch: "monitor", sequence, type: "upsert", row: value };
}

function bytes(value: unknown) {
  return commandCenterUtf8Bytes(commandCenterCanonicalJson(value));
}

describe("summary trust boundary and incremental budgets", () => {
  it.each([
    null,
    [],
    { ...change(), version: 2 },
    { ...change(), sequence: 0 },
    { ...change(), sequence: -1 },
    { ...change(), sequence: 1.5 },
    { ...change(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...change(), sequence: NaN },
    { ...change(), epoch: "" },
    { ...change(), epoch: "monitor\0" },
    { ...change(), epoch: "x".repeat(257) },
    { ...change(), type: "append" },
    { ...change(), principal: "owner" },
    { ...change(), target: { kind: "session", sessionId: "other" } },
    { ...change(), row: { ...row(), effectiveGoalRevision: 10 } },
    { ...change(), row: { ...row(), unknown: true } },
    { ...change(), row: { ...row(), execution: { kind: "session", sessionId: "other", turnId: "turn" } } },
    { version: 1, epoch: "monitor", sequence: 43, type: "remove" },
    { version: 1, epoch: "monitor", sequence: 43, type: "remove", target: { kind: "session", sessionId: "" } },
    { version: 1, epoch: "monitor", sequence: 43, type: "resync", row: row() },
  ])("rejects invalid change envelopes without changing the projection (%#)", (input) => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    const state = model.getState();
    expect(model.apply(input)).toEqual({ rejected: "invalid_change" });
    expect(model.getState()).toBe(state);
    model.dispose();
  });

  it("rejects symbolic and non-enumerable additional envelope fields", () => {
    for (const input of [
      { ...change(), [Symbol("extra")]: true },
      Object.defineProperty(change(), "extra", { value: true }),
    ]) {
      const model = createCommandCenterMonitorSummary(context(), initial());
      expect(model.apply(input)).toEqual({ rejected: "invalid_change" });
      model.dispose();
    }
  });

  it("rejects malformed older events rather than treating invalid input as duplicate", () => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    const state = model.getState();
    expect(model.apply({ ...change(row(), 42), role: "viewer" })).toEqual({ rejected: "invalid_change" });
    expect(model.getState()).toBe(state);
    model.dispose();
  });

  it("catches throwing input accessors as invalid boundary data without leaking details", () => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    const state = model.getState();
    const result = model.apply({ ...change(), get row() { throw new Error("private transport detail"); } });
    expect(result).toEqual({ rejected: "invalid_change" });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
    expect(model.getState()).toBe(state);
    model.dispose();
  });

  it.each([
    null,
    { ...initial(), version: 1 },
    { ...initial(), rows: {} },
    { ...initial(), cursor: { epoch: "monitor", sequence: -1 } },
    { ...initial(), cursor: { epoch: "monitor", sequence: 42, extra: true } },
    { ...initial(), generatedAt: "short" },
    { ...initial(), rows: [row(), row()] },
    { ...initial(), rows: [{ ...row(), effectiveGoalRevision: 10 }] },
  ])("rejects invalid initial complete projections (%#)", (input) => {
    expect(() => createCommandCenterMonitorSummary(context(), input)).toThrow("COMMAND_CENTER_CLIENT_INVALID_INITIAL_PROJECTION");
  });

  it("validates only the bounded initial array elements rather than an external iterator", () => {
    const rows = [row()];
    rows[Symbol.iterator] = () => { throw new Error("Untrusted iterator"); };
    const model = createCommandCenterMonitorSummary(context(), initial(rows));
    expect(model.getState().projection?.rows).toHaveLength(1);
    model.dispose();
  });

  it("accepts empty projections and an initial watermark at the exact integer ceiling", () => {
    const empty = createCommandCenterMonitorSummary(context(), initial([]));
    expect(empty.getState().projection?.rows).toEqual([]);
    expect(empty.apply(change())).toBe("applied");
    empty.dispose();
    const maximal = createCommandCenterMonitorSummary(context(), { ...initial([]), cursor: { epoch: "monitor", sequence: Number.MAX_SAFE_INTEGER } });
    expect(maximal.apply(change(row(), Number.MAX_SAFE_INTEGER))).toBe("duplicate");
    expect(maximal.apply(change(row(), Number.MAX_SAFE_INTEGER + 1))).toEqual({ rejected: "invalid_change" });
    maximal.dispose();
  });

  it("requires resync before an insertion can exceed row capacity and retains the old cut", () => {
    const model = createCommandCenterMonitorSummary(context(), initial(), { maxRows: 1 });
    expect(model.apply(change(row("main")))).toBe("applied");
    const state = model.getState();
    expect(model.apply(change(row("other"), 44))).toEqual({ resync: "row_limit" });
    expect(model.getState()).toEqual({ status: "resync_required", projection: state.projection, reason: "row_limit" });
    model.dispose();
  });

  it("frees row capacity on removal and preserves opaque task-key boundaries", () => {
    const model = createCommandCenterMonitorSummary(context(), initial(), { maxRows: 1 });
    expect(model.apply({ version: 1, epoch: "monitor", sequence: 43, type: "remove", target: row().target })).toBe("applied");
    expect(model.apply(change(row("next"), 44))).toBe("applied");
    expect(model.getState().projection?.rows).toHaveLength(1);
    model.dispose();
    const base = row();
    delete base.execution;
    const first = { ...base, target: { kind: "delegation", parentSessionId: "parent:part", delegationId: "child" } };
    const second = { ...base, target: { kind: "delegation", parentSessionId: "parent", delegationId: "part:child" } };
    const opaque = createCommandCenterMonitorSummary(context(), initial([parseCommandCenterTaskSummary(first)]));
    expect(opaque.apply(change(parseCommandCenterTaskSummary(second)))).toBe("applied");
    expect(opaque.getState().projection?.rows).toHaveLength(2);
    opaque.dispose();
  });

  it("uses exact canonical UTF-8 row bytes and applies replacement deltas rather than accumulating old bytes", () => {
    const first = row();
    first.label = "界";
    const replacement = row();
    replacement.label = "界界";
    const limit = bytes(replacement);
    const model = createCommandCenterMonitorSummary(context(), initial([first]), { maxBytes: limit });
    expect(model.apply(change(replacement))).toBe("applied");
    expect(model.apply(change(first, 44))).toBe("applied");
    expect(model.apply(change(replacement, 45))).toBe("applied");
    const larger = { ...replacement, label: "界界界" };
    const previous = model.getState().projection;
    expect(bytes(larger) - limit).toBe(3);
    expect(model.apply(change(larger, 46))).toEqual({ resync: "byte_limit" });
    expect(model.getState().projection).toBe(previous);
    model.dispose();
  });

  it("frees encoded-byte capacity after remove and can then insert an exact-bound row", () => {
    const one = row();
    const two = row("next");
    const limit = Math.max(bytes(one), bytes(two));
    const model = createCommandCenterMonitorSummary(context(), initial([one]), { maxBytes: limit });
    expect(model.apply({ version: 1, epoch: "monitor", sequence: 43, type: "remove", target: one.target })).toBe("applied");
    expect(model.apply(change(two, 44))).toBe("applied");
    expect(model.getState().projection?.rows).toEqual([two]);
    model.dispose();
  });

  it("rejects over-budget initial projections rather than publishing a partial model", () => {
    expect(() => createCommandCenterMonitorSummary(context(), initial([row(), row("two")]), { maxRows: 1 }))
      .toThrow("COMMAND_CENTER_CLIENT_INVALID_INITIAL_PROJECTION");
    expect(() => createCommandCenterMonitorSummary(context(), initial(), { maxBytes: bytes(row()) - 1 }))
      .toThrow("COMMAND_CENTER_CLIENT_INVALID_INITIAL_PROJECTION");
  });

  it.each(["maxRows", "maxBytes"] as const)("accepts only lower positive integer %s limits", (key) => {
    for (const value of [0, -1, 1.5, NaN, Infinity, COMMAND_CENTER_MONITOR_SUMMARY_LIMITS[key] + 1]) {
      expect(() => createCommandCenterMonitorSummary(context(), initial([]), { [key]: value }))
        .toThrow("COMMAND_CENTER_CLIENT_INVALID_SUMMARY_LIMIT");
    }
  });

  it("rejects unknown limits and cannot be widened by later caller mutation", () => {
    const options = { maxRows: 1, other: 1 };
    expect(() => createCommandCenterMonitorSummary(context(), initial(), options)).toThrow("COMMAND_CENTER_CLIENT_INVALID_SUMMARY_LIMIT");
    const limits = { maxRows: 1 };
    const model = createCommandCenterMonitorSummary(context(), initial(), limits);
    limits.maxRows = 10_000;
    expect(model.apply(change(row("two")))).toEqual({ resync: "row_limit" });
    model.dispose();
  });
});
