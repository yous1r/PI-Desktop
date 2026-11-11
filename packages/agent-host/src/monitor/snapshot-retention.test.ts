import { describe, expect, it } from "vitest";
import { MonitorSnapshotStore } from "./snapshot-store.js";
import { byteLength, capture, EPOCH, harness, page, row, SCOPE, START, token } from "./snapshot-store.test-support.js";

const unavailable = { status: "resync", reason: "expired_or_evicted" };

describe("monitor generation retention and lifecycle", () => {
  it("expires at the absolute deadline, including repeated reads and a backward clock adjustment", () => {
    const { store, clock } = harness({ maxAgeMs: 100, pageRows: 1 });
    const next = token(capture(store, [row(0), row(1)]));
    clock.time += 99;
    expect(page(store, next).rows).toEqual([row(1)]);
    clock.time += 1;
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: next })).toEqual(unavailable);
    clock.time = START;
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: next })).toEqual(unavailable);
    const fresh = token(capture(store, [row(0), row(2)], 2));
    expect(page(store, fresh).generatedAt).toBe(new Date(START + 100).toISOString());
    clock.time = START + 200;
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: fresh })).toEqual(unavailable);
  });

  it.each([
    { name: "generations", limits: { maxGenerations: 1 } },
    { name: "aggregate rows", limits: { maxRows: 3 } },
    { name: "aggregate tokens", limits: { maxTokens: 1 } },
  ])("evicts complete oldest generations under the $name budget", ({ limits }) => {
    const { store } = harness({ ...limits, pageRows: 1 });
    const oldest = token(capture(store, [row(0), row(1)], 1));
    expect(page(store, oldest).rows).toEqual([row(1)]);
    const newest = token(capture(store, [row(2), row(3)], 2));
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: oldest })).toEqual(unavailable);
    expect(page(store, newest).rows).toEqual([row(3)]);
  });

  it("bounds total encoded bytes including scope metadata and token-index keys", () => {
    const probe = harness({ pageRows: 1 }).store;
    const first = capture(probe, [row(0), row(1)]);
    const next = token(first);
    const second = page(probe, next);
    const bytes = byteLength(first) + byteLength(second) + byteLength(SCOPE) + new TextEncoder().encode(next).byteLength;
    const { store } = harness({ pageRows: 1, maxBytes: bytes });
    const oldest = token(capture(store, [row(0), row(1)]));
    const newest = token(capture(store, [row(2), row(3)]));
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: oldest })).toEqual(unavailable);
    expect(page(store, newest).rows).toEqual([row(3)]);
    const below = harness({ pageRows: 1, maxBytes: bytes - 1 }).store;
    expect(() => capture(below, [row(0), row(1)])).toThrow("byte_limit");
  });

  it("keeps FIFO order despite reads, and removes every token of an evicted generation", () => {
    const { store } = harness({ pageRows: 1, maxGenerations: 2 });
    const first = token(capture(store, [row(0), row(1), row(2)], 1));
    const second = token(capture(store, [row(3), row(4)], 2));
    const firstTail = token(page(store, first));
    expect(page(store, firstTail).rows).toEqual([row(2)]);
    const third = token(capture(store, [row(5), row(6)], 3));
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: first })).toEqual(unavailable);
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: firstTail })).toEqual(unavailable);
    expect(page(store, second).cursor.sequence).toBe(2);
    expect(page(store, third).cursor.sequence).toBe(3);
  });

  it("discards only its trusted scope and never rebinds old tokens when entropy repeats", () => {
    const { store } = harness({ pageRows: 1 }, () => "repeated-test-entropy");
    const first = token(capture(store, [row(0), row(1), row(2)]));
    const firstTail = token(page(store, first));
    const other = token(capture(store, [row(3), row(4)], 1, "other-scope"));
    store.discardScope(SCOPE);
    store.discardScope(SCOPE);
    const fresh = token(capture(store, [row(5), row(6)]));
    expect(fresh).not.toBe(first);
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: first })).toEqual(unavailable);
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: firstTail })).toEqual(unavailable);
    expect(page(store, other, "other-scope").rows).toEqual([row(4)]);
    expect(page(store, fresh).rows).toEqual([row(6)]);
  });

  it("isolates boot epochs even if the token source repeats", () => {
    const clock = { now: () => START };
    const tokens = { next: () => "repeated-test-entropy" };
    const oldStore = new MonitorSnapshotStore({ epoch: "old", clock, tokens, limits: { pageRows: 1 } });
    const newStore = new MonitorSnapshotStore({ epoch: "new", clock, tokens, limits: { pageRows: 1 } });
    const oldToken = token(capture(oldStore, [row(0), row(1)]));
    const newToken = token(capture(newStore, [row(0), row(2)]));
    expect(newToken).not.toBe(oldToken);
    expect(newStore.page({ scopeKey: SCOPE, epoch: "old", token: oldToken })).toEqual({ status: "resync", reason: "epoch" });
    expect(newStore.page({ scopeKey: SCOPE, epoch: "new", token: oldToken })).toEqual(unavailable);
    expect(page(newStore, newToken).rows).toEqual([row(2)]);
  });

  it("releases all scopes on idempotent disposal and refuses further capture", () => {
    const { store } = harness({ pageRows: 1 });
    const first = token(capture(store, [row(0), row(1)]));
    const other = token(capture(store, [row(2), row(3)], 1, "other-scope"));
    store.dispose();
    store.dispose();
    store.discardScope(SCOPE);
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: first })).toEqual({ status: "resync", reason: "disposed" });
    expect(store.page({ scopeKey: "other-scope", epoch: EPOCH, token: other })).toEqual({ status: "resync", reason: "disposed" });
    expect(() => capture(store, [row(4)])).toThrow("disposed");
  });
});
