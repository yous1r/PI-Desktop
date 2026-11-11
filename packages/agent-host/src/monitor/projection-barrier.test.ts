import { describe, expect, it } from "vitest";
import { commandCenterTaskKey, type CommandCenterTaskSummary } from "@pi-desktop/shared";
import { MonitorSnapshotStore } from "./snapshot-store.js";
import { harness, page, row, SCOPE, token } from "./snapshot-store.test-support.js";

/**
 * Reference C3 adapter contract, executed against the real Host snapshot store.
 *
 * The future authorized producer must supply a consistent repository cut and the
 * matching change watermark, buffering committed changes across that read. This
 * test encodes the required sequence: subscribe first, snapshot rows and
 * watermark together, capture at that watermark, then replay only changes strictly
 * after it. It is a contract test, not a production repository, wire schema or
 * capability advertisement.
 */

type Change = Readonly<{ sequence: number; type: "upsert" | "remove"; row: CommandCenterTaskSummary }>;
type Cut = Readonly<{ rows: readonly CommandCenterTaskSummary[]; watermark: number }>;

class ReferenceChangeSource {
  readonly #rows = new Map<string, CommandCenterTaskSummary>();
  readonly #listeners = new Set<(change: Change) => void>();
  #sequence = 0;

  constructor(initial: CommandCenterTaskSummary[]) {
    for (const item of initial) this.#rows.set(commandCenterTaskKey(item.target), item);
  }

  get watermark(): number {
    return this.#sequence;
  }

  subscribe(listener: (change: Change) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** One committed authoritative change; listeners see it after it is applied. */
  commit(type: "upsert" | "remove", item: CommandCenterTaskSummary): Change {
    const key = commandCenterTaskKey(item.target);
    if (type === "upsert") this.#rows.set(key, item);
    else this.#rows.delete(key);
    this.#sequence += 1;
    const change = Object.freeze({ sequence: this.#sequence, type, row: item });
    for (const listener of this.#listeners) listener(change);
    return change;
  }

  /**
   * Consistent cut: rows and watermark are taken together, then a slow scan
   * lets `during` commit changes that must be replayed rather than merged.
   */
  readCut(during?: () => void): Cut {
    const entries = [...this.#rows.values()];
    const watermark = this.#sequence;
    const rows: CommandCenterTaskSummary[] = [];
    for (const [index, item] of entries.entries()) {
      rows.push(structuredClone(item));
      if (index === 0 && during) during();
    }
    return Object.freeze({ rows: Object.freeze(rows), watermark });
  }
}

type OpenedProjection = Readonly<{
  snapshot: ReturnType<MonitorSnapshotStore["capture"]>;
  buffered: readonly Change[];
  unsubscribe: () => void;
}>;

/** The C3 monitor service sequence; overflow requires a fresh snapshot. */
function openProjection(
  source: ReferenceChangeSource,
  store: MonitorSnapshotStore,
  scopeKey: string,
  during: () => void,
  maxBuffered = 64,
): OpenedProjection | Readonly<{ resync: "change_buffer_overflow" }> {
  const buffered: Change[] = [];
  let overflowed = false;
  const unsubscribe = source.subscribe((change) => {
    if (buffered.length >= maxBuffered) {
      overflowed = true;
      return;
    }
    buffered.push(change);
  });
  const cut = source.readCut(during);
  if (overflowed) {
    unsubscribe();
    return Object.freeze({ resync: "change_buffer_overflow" as const });
  }
  const after = buffered.filter((change) => change.sequence > cut.watermark);
  const snapshot = store.capture({ scopeKey, sequence: cut.watermark, rows: cut.rows });
  return Object.freeze({ snapshot, buffered: Object.freeze(after), unsubscribe });
}

/** Read the complete generation a client receives, page after page. */
function completeRows(
  store: MonitorSnapshotStore,
  first: Readonly<{ rows: readonly CommandCenterTaskSummary[]; nextPage?: string }>,
  scopeKey = SCOPE,
): CommandCenterTaskSummary[] {
  const rows = [...first.rows];
  let continuation = first.nextPage;
  for (let seen = 0; continuation !== undefined; seen += 1) {
    if (seen > 100) throw new Error("Runaway continuation in the reference sequence");
    const next = page(store, continuation, scopeKey);
    rows.push(...next.rows);
    continuation = next.nextPage;
  }
  return rows;
}

/** Complete C1 rows by stable task key; every field must match, not only a label. */
function appliedRows(rows: readonly CommandCenterTaskSummary[], changes: readonly Change[]) {
  const state = new Map(rows.map((item) => [commandCenterTaskKey(item.target), item]));
  for (const change of changes) {
    const key = commandCenterTaskKey(change.row.target);
    if (change.type === "remove") state.delete(key);
    else state.set(key, change.row);
  }
  return Object.fromEntries(state);
}

function authoritativeRows(source: ReferenceChangeSource): Record<string, CommandCenterTaskSummary> {
  return Object.fromEntries(source.readCut().rows.map((item) => [commandCenterTaskKey(item.target), item]));
}

describe("monitor projection barrier contractual sequence", () => {
  it("keeps changes committed during the read out of the frozen cut and replays them afterwards", () => {
    const source = new ReferenceChangeSource([row(0), row(1), row(2)]);
    const { store } = harness({ pageRows: 2 });

    const opened = openProjection(source, store, SCOPE, () => {
      source.commit("upsert", { ...row(0), label: "Changed after the cut" });
      source.commit("upsert", row(3));
    });
    if (!("snapshot" in opened)) throw new Error("unexpected resync");
    opened.unsubscribe();

    // The cut keeps the pre-change text and has no row 3. Its cursor is the
    // read watermark, not the later live sequence.
    const cutRows = completeRows(store, opened.snapshot);
    const cut = appliedRows(cutRows, []);
    expect(cut[commandCenterTaskKey(row(0).target)]?.label).toBe("Task 0");
    expect(cut[commandCenterTaskKey(row(1).target)]?.label).toBe("Task 1");
    expect(cut).not.toHaveProperty(commandCenterTaskKey(row(3).target));
    expect(cutRows).toHaveLength(3);
    expect(opened.snapshot.cursor.sequence).toBe(0);
    expect(source.watermark).toBe(2);

    expect(opened.buffered.map((change) => change.sequence)).toEqual([1, 2]);
    expect(opened.buffered.map((change) => change.type)).toEqual(["upsert", "upsert"]);
    expect(opened.buffered[0].row.label).toBe("Changed after the cut");
    expect(appliedRows(cutRows, opened.buffered)).toEqual(authoritativeRows(source));
  });

  it("produces the same bounded pages when nothing changes during the read", () => {
    const source = new ReferenceChangeSource([row(0), row(1)]);
    const { store } = harness({ pageRows: 1 });
    const opened = openProjection(source, store, SCOPE, () => {});
    if (!("snapshot" in opened)) throw new Error("unexpected resync");
    opened.unsubscribe();

    expect(opened.snapshot.rows).toEqual([row(0)]);
    expect(opened.snapshot.cursor.sequence).toBe(0);
    expect(opened.buffered).toEqual([]);
    expect(page(store, token(opened.snapshot)).rows).toEqual([row(1)]);
  });

  it("requires a fresh snapshot when the bounded change buffer overflows", () => {
    const source = new ReferenceChangeSource([row(0)]);
    const { store } = harness({ pageRows: 1 });
    const opened = openProjection(source, store, SCOPE, () => {
      source.commit("upsert", row(1));
      source.commit("upsert", row(2));
    }, 1);

    expect(opened).toEqual({ resync: "change_buffer_overflow" });
    // The aborted attempt published no generation and left no page behind.
    expect(store.page({ scopeKey: SCOPE, epoch: store.epoch, token: "0".repeat(64) }))
      .toEqual({ status: "resync", reason: "expired_or_evicted" });
  });

  it("discards pages when the authorization scope changes", () => {
    const source = new ReferenceChangeSource([row(0), row(1)]);
    const { store } = harness({ pageRows: 1 });
    const opened = openProjection(source, store, SCOPE, () => {});
    if (!("snapshot" in opened)) throw new Error("unexpected resync");
    opened.unsubscribe();
    const next = token(opened.snapshot);
    expect(page(store, next).rows).toEqual([row(1)]);

    store.discardScope(SCOPE);
    expect(store.page({ scopeKey: SCOPE, epoch: store.epoch, token: next }))
      .toEqual({ status: "resync", reason: "expired_or_evicted" });

    const replacementScope = "principal-1:authorization-5:all-workspaces";
    const replacement = openProjection(source, store, replacementScope, () => {});
    if (!("snapshot" in replacement)) throw new Error("unexpected resync");
    replacement.unsubscribe();
    expect(replacement.snapshot.cursor.sequence).toBe(0);
    expect(store.page({ scopeKey: SCOPE, epoch: store.epoch, token: token(replacement.snapshot) }))
      .toEqual({ status: "resync", reason: "scope" });
  });

  it("replays an accumulated change span to exactly the authoritative rows", () => {
    const source = new ReferenceChangeSource([row(0), row(1), row(2), row(3)]);
    const { store } = harness({ pageRows: 2 });
    const opened = openProjection(source, store, SCOPE, () => {
      source.commit("remove", row(1));
      source.commit("upsert", { ...row(2), label: "Updated mid-read" });
      source.commit("upsert", row(4));
    });
    if (!("snapshot" in opened)) throw new Error("unexpected resync");
    opened.unsubscribe();

    expect(opened.buffered.map((change) => change.type)).toEqual(["remove", "upsert", "upsert"]);
    expect(opened.buffered.map((change) => change.sequence)).toEqual([1, 2, 3]);
    const applied = appliedRows(completeRows(store, opened.snapshot), opened.buffered);
    expect(applied).toEqual(authoritativeRows(source));
    expect(Object.keys(applied)).not.toContain(commandCenterTaskKey(row(1).target));
  });
});
