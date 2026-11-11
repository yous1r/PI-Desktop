import { describe, expect, it } from "vitest";
import type { CommandCenterTaskSummary } from "@pi-desktop/shared";
import { MonitorSnapshotStore } from "./snapshot-store.js";
import { byteLength, capture, EPOCH, harness, page, row, SCOPE, START, token } from "./snapshot-store.test-support.js";

describe("monitor capture atomicity and bounded work", () => {
  it.each([
    { name: "missing authoritative workspace", make() { const value = row(9); Reflect.deleteProperty(value, "commandWorkspaceId"); return value; } },
    { name: "missing authoritative goal", make() { const value = row(9); Reflect.deleteProperty(value, "desiredGoalRevision"); return value; } },
    { name: "reversed goal revisions", make() { return { ...row(9), effectiveGoalRevision: 4 }; } },
    { name: "execution owner mismatch", make() { return { ...row(9), execution: { kind: "session" as const, sessionId: "other", turnId: "turn" } }; } },
    { name: "non-summary payload", make() { return { ...row(9), transcript: "must not be retained" }; } },
  ])("rejects $name without evicting a retained generation", ({ make }) => {
    const { store } = harness({ pageRows: 1, maxGenerations: 1 });
    const retained = token(capture(store, [row(0), row(1)]));
    expect(() => capture(store, [row(2), make()])).toThrow("invalid_row");
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("rejects duplicate stable task owners even across would-be page boundaries", () => {
    const { store } = harness({ maxGenerations: 1 });
    const retained = token(capture(store, Array.from({ length: 101 }, (_, index) => row(index))));
    const duplicates = Array.from({ length: 100 }, (_, index) => row(index));
    duplicates.push({ ...row(0), label: "Newer label does not make this a distinct task" });
    expect(() => capture(store, duplicates)).toThrow("duplicate_task");
    expect(page(store, retained).rows).toEqual([row(100)]);
  });

  it("stops and closes an unbounded iterable after the first row beyond the capture cap", () => {
    const { store } = harness({ pageRows: 1, maxRows: 3, maxGenerations: 1 });
    const retained = token(capture(store, [row(0), row(1)]));
    let yielded = 0;
    let closed = false;
    function* endless() {
      try {
        for (;;) yield row(yielded++);
      } finally {
        closed = true;
      }
    }
    expect(() => capture(store, endless())).toThrow("row_limit");
    expect(yielded).toBe(4);
    expect(closed).toBe(true);
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("preserves existing generations after a source iterator failure", () => {
    const { store } = harness({ pageRows: 1, maxGenerations: 1 });
    const retained = token(capture(store, [row(0), row(1)]));
    function* broken(): Generator<CommandCenterTaskSummary> {
      yield row(2);
      throw new Error("Source read failed");
    }
    expect(() => capture(store, broken())).toThrow("Source read failed");
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("copies each row before advancing its iterable", () => {
    const { store } = harness({ pageRows: 1 });
    const mutable = row(0);
    function* source() {
      yield mutable;
      mutable.label = "Mutated by the producer";
      yield row(1);
    }
    const first = capture(store, source());
    expect(first.rows).toEqual([row(0)]);
    expect(page(store, token(first)).rows).toEqual([row(1)]);
  });

  it("rejects an entire capture exceeding the token budget without partial publication or eviction", () => {
    const { store } = harness({ pageRows: 1, maxTokens: 1 });
    const retained = token(capture(store, [row(0), row(1)]));
    expect(() => capture(store, [row(2), row(3), row(4)])).toThrow("token_limit");
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("rejects captures exceeding total bytes or a single page without evicting existing data", () => {
    const probe = harness({ pageRows: 1 }).store;
    const first = capture(probe, [row(0), row(1)]);
    const firstBytes = byteLength(first);
    const wholeBytes = firstBytes + byteLength(page(probe, token(first))) + byteLength(SCOPE) + 64;
    const big = row(3, "界".repeat(256));
    const bytes = harness({ pageRows: 1, maxBytes: wholeBytes }).store;
    const bytesToken = token(capture(bytes, [row(0), row(1)]));
    expect(() => capture(bytes, [big, row(4)])).toThrow("byte_limit");
    expect(page(bytes, bytesToken).rows).toEqual([row(1)]);
    const single = harness({ pageRows: 1, pageBytes: firstBytes }).store;
    const singleToken = token(capture(single, [row(0), row(1)]));
    expect(() => capture(single, [big, row(4)])).toThrow("page_limit");
    expect(page(single, singleToken).rows).toEqual([row(1)]);
  });

  it.each(["", "\0", "x".repeat(513)])("rejects invalid token entropy without retrying (%j)", (invalid) => {
    let fail = false;
    let calls = 0;
    const { store } = harness({ pageRows: 1, maxGenerations: 1 }, () => { calls += 1; return fail ? invalid : "test-entropy"; });
    const retained = token(capture(store, [row(0), row(1)]));
    fail = true;
    const before = calls;
    expect(() => capture(store, [row(2), row(3)])).toThrow("invalid_token_source");
    expect(calls - before).toBe(1);
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("keeps a token-source exception observable without evicting data", () => {
    let fail = false;
    const { store } = harness({ pageRows: 1 }, () => {
      if (fail) throw new Error("Token service unavailable");
      return "test-entropy";
    });
    const retained = token(capture(store, [row(0), row(1)]));
    fail = true;
    expect(() => capture(store, [row(2), row(3)])).toThrow("Token service unavailable");
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("validates scope and metadata before consuming an iterable", () => {
    const { store } = harness({ pageRows: 1 });
    const retained = token(capture(store, [row(0), row(1)]));
    let consumed = false;
    function* source() { consumed = true; yield row(2); }
    for (const scope of ["", "\0", "x".repeat(513)]) {
      expect(() => capture(store, source(), 1, scope)).toThrow("invalid_scope");
    }
    for (const sequence of [-1, 0.1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => capture(store, source(), sequence)).toThrow("COMMAND_CENTER_INVALID_SUMMARY");
    }
    expect(consumed).toBe(false);
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("never publishes a capture invalidated by scope discard during source iteration", () => {
    const { store } = harness({ pageRows: 1 });
    function* source() {
      yield row(0);
      store.discardScope(SCOPE);
      yield row(1);
    }
    expect(() => capture(store, source())).toThrow("invalidated");
    expect(page(store, token(capture(store, [row(2), row(3)]))).rows).toEqual([row(3)]);
  });

  it("never publishes a capture disposed during source iteration", () => {
    const { store } = harness({ pageRows: 1 });
    function* source() {
      yield row(0);
      store.dispose();
      yield row(1);
    }
    expect(() => capture(store, source())).toThrow("disposed");
    expect(() => capture(store, [])).toThrow("disposed");
  });

  it("rejects reentrant capture and capture whose lifetime elapsed while building", () => {
    const { store, clock } = harness({ pageRows: 1, maxAgeMs: 10 });
    function* reentrant() { yield row(0); capture(store, [row(1)]); }
    expect(() => capture(store, reentrant())).toThrow("capture_in_progress");
    function* expired() { yield row(0); clock.time += 10; yield row(1); }
    expect(() => capture(store, expired())).toThrow("expired");
    expect(capture(store, []).rows).toEqual([]);
  });

  it("enforces configuration ceilings and rejects invalid clocks/epochs", () => {
    for (const limits of [{ maxRows: 0 }, { maxAgeMs: 60_001 }, { maxGenerations: 9 }, { maxTokens: 1025 },
      { maxBytes: 16 * 1024 * 1024 + 1 }, { pageRows: 101 }, { pageBytes: 256 * 1024 + 1 }]) {
      expect(() => harness(limits)).toThrow(RangeError);
    }
    for (const epoch of ["", "\0", "x".repeat(257)]) {
      expect(() => new MonitorSnapshotStore({ epoch, clock: { now: () => START }, tokens: { next: () => "test" } }))
        .toThrow("COMMAND_CENTER_INVALID_SUMMARY");
    }
    const { store, clock } = harness();
    for (const time of [Number.NaN, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      clock.time = time;
      expect(() => capture(store, [])).toThrow(RangeError);
    }
    clock.time = START;
    expect(capture(store, []).cursor.epoch).toBe(EPOCH);
  });
});
