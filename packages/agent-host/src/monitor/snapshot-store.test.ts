import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES,
  parseCommandCenterMonitorSnapshot,
  type CommandCenterMonitorSnapshot,
} from "@pi-desktop/shared";
import { byteLength, capture, EPOCH, goldenRows, harness, page, row, SCOPE, START, token } from "./snapshot-store.test-support.js";

function collect(store: ReturnType<typeof harness>["store"], first: CommandCenterMonitorSnapshot): CommandCenterMonitorSnapshot[] {
  const pages = [first];
  let current = first;
  while (current.nextPage !== undefined) {
    current = page(store, current.nextPage);
    pages.push(current);
  }
  return pages;
}

describe("monitor snapshot public capture/page path", () => {
  it("pins real C1 main/child/settled rows while the authoritative source and returned pages mutate", () => {
    const { store, clock } = harness({ pageRows: 1 });
    const source = goldenRows();
    const original = structuredClone(source);
    const first = capture(store, source, 42);
    const continuation = token(first);
    expect(first.rows).toEqual([original[0]]);
    expect(first.cursor).toEqual({ epoch: EPOCH, sequence: 42 });
    expect(first.generatedAt).toBe(new Date(START).toISOString());

    source[0].usage!.inputTokens = 99;
    source[1].label = "Changed after capture";
    source[1].execution = undefined;
    source[1].parent = undefined;
    source.pop();
    source.push(row(99));
    first.rows[0].label = "Client mutation";
    first.cursor.epoch = "Client epoch mutation";
    first.nextPage = "Client token mutation";
    clock.time += 10;
    const newer = capture(store, source, 43);

    const second = page(store, continuation);
    const thirdToken = token(second);
    expect(second.rows).toEqual([original[1]]);
    expect(second.cursor).toEqual({ epoch: EPOCH, sequence: 42 });
    expect(second.generatedAt).toBe(new Date(START).toISOString());
    second.rows[0].target = { kind: "session", sessionId: "client-mutated-target" };
    second.rows[0].parent = { kind: "session", sessionId: "client-mutated-parent" };
    second.rows[0].label = "Client second-page mutation";
    second.cursor.sequence = 1000;
    second.nextPage = "Client second token mutation";
    expect(page(store, continuation).rows).toEqual([original[1]]);
    expect(token(page(store, continuation))).toBe(thirdToken);
    const third = page(store, thirdToken);
    expect(third.rows).toEqual([original[2]]);
    expect(third.rows[0].execution).toBeUndefined();
    expect(third.nextPage).toBeUndefined();
    expect(page(store, token(newer)).rows[0].label).toBe("Changed after capture");
    expect(page(store, token(newer)).cursor.sequence).toBe(43);
  });

  it("caps each page at 100 rows without changing row order or inventing optional facts", () => {
    const { store } = harness();
    const rows = Array.from({ length: 201 }, (_, index) => row(index));
    const pages = collect(store, capture(store, rows, 9));
    expect(pages.map((entry) => entry.rows.length)).toEqual([100, 100, 1]);
    expect(pages.flatMap((entry) => entry.rows)).toEqual(rows);
    for (const entry of pages) {
      expect(parseCommandCenterMonitorSnapshot(entry)).toBe(entry);
      expect(entry.cursor).toEqual({ epoch: EPOCH, sequence: 9 });
      expect(entry.rows.every((item) => item.execution === undefined && item.usage === undefined)).toBe(true);
    }
  });

  it("splits valid multibyte rows under the 256 KiB cap independently of row count", () => {
    const { store } = harness();
    const rows = Array.from({ length: 180 }, (_, index) => ({
      ...row(index, "控".repeat(256)),
      target: { kind: "session" as const, sessionId: `${index.toString().padStart(3, "0")}${"控".repeat(125)}` },
      parent: { kind: "session" as const, sessionId: "控".repeat(128) },
      activity: "控".repeat(256), waitingReason: "控".repeat(128), updatedAt: "控".repeat(64),
    }));
    const first = capture(store, rows);
    expect(first.rows.length).toBeLessThan(100);
    const pages = collect(store, first);
    expect(pages.flatMap((entry) => entry.rows)).toEqual(rows);
    for (const entry of pages) {
      expect(byteLength(entry)).toBeLessThanOrEqual(COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES);
      expect(parseCommandCenterMonitorSnapshot(entry)).toBe(entry);
    }
  });

  it("counts the continuation token in exact page byte boundaries", () => {
    const rows = [row(10, "𐀀界".repeat(50)), row(11, "𐀀界".repeat(50)), row(12, "𐀀界".repeat(50))];
    const full = capture(harness({ pageRows: 2 }).store, rows);
    const cap = byteLength(full);
    const { store: exact } = harness({ pageRows: 2, pageBytes: cap });
    expect(capture(exact, rows).rows).toHaveLength(2);
    const { store: below } = harness({ pageRows: 2, pageBytes: cap - 1 });
    const pages = collect(below, capture(below, rows));
    expect(pages[0].rows).toHaveLength(1);
    expect(pages.flatMap((entry) => entry.rows)).toEqual(rows);
    expect(pages.every((entry) => byteLength(entry) <= cap - 1)).toBe(true);
    expect(byteLength({ ...full, nextPage: undefined })).toBeLessThan(cap - 1);
  });

  it("returns empty/single pages without retaining unreachable generations or evicting live ones", () => {
    const { store } = harness({ maxGenerations: 1, pageRows: 1 });
    const retained = token(capture(store, [row(0), row(1)]));
    for (let index = 0; index < 20; index += 1) {
      expect(capture(store, []).rows).toEqual([]);
      expect(capture(store, [row(index)]).nextPage).toBeUndefined();
    }
    expect(page(store, retained).rows).toEqual([row(1)]);
  });

  it("rejects foreign scopes and epochs without consuming or altering a valid handle", () => {
    const { store } = harness({ pageRows: 1 });
    const next = token(capture(store, [row(0), row(1)]));
    expect(store.page({ scopeKey: "principal-1:authorization-5:all-workspaces", epoch: EPOCH, token: next }))
      .toEqual({ status: "resync", reason: "scope" });
    expect(store.page({ scopeKey: SCOPE, epoch: "old-boot", token: next }))
      .toEqual({ status: "resync", reason: "epoch" });
    expect(page(store, next).rows).toEqual([row(1)]);
    expect(store.page({ scopeKey: SCOPE, epoch: EPOCH, token: "forged" }))
      .toEqual({ status: "resync", reason: "expired_or_evicted" });
    expect(store.page({ scopeKey: "", epoch: EPOCH, token: next }))
      .toEqual({ status: "resync", reason: "scope" });
  });
});
