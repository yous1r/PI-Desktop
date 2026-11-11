import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CommandCenterRepository,
  CommandCenterRepositoryContext,
  CommandCenterRepositoryMethod,
  CommandCenterRepositoryRequests,
  CommandCenterRepositoryResults,
} from "@pi-desktop/agent-host";
import { commandCenterTaskKey, type CommandCenterReceipt } from "@pi-desktop/shared";
import {
  CommandCenterMonitorProducer,
  type CommandCenterMonitorProducerOptions,
} from "./command-center-monitor.js";

const fixture = JSON.parse(await readFile(
  new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8",
));
const control = JSON.parse(await readFile(
  new URL("../../../packages/shared/test/fixtures/command-center-control.json", import.meta.url), "utf8",
));

const WORKSPACES = fixture.workspaces.workspaces;
const ROWS = fixture.snapshot.rows;
const HOST_ID = "host-monitor-1";
const HOST_EPOCH = "11111111-1111-4111-8111-111111111111";
const SCOPE = "lease:principal-1/filter:all";

type Handler = (input: Record<string, unknown>, context: CommandCenterRepositoryContext) => unknown;

class FakeRepository implements CommandCenterRepository {
  readonly handlers = new Map<string, Handler>();
  readonly calls: { method: string; input: Record<string, unknown> }[] = [];

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  async call<M extends CommandCenterRepositoryMethod>(
    method: M,
    input: CommandCenterRepositoryRequests[M],
    context: CommandCenterRepositoryContext,
  ): Promise<CommandCenterRepositoryResults[M]> {
    this.calls.push({ method, input: input as Record<string, unknown> });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`NO_FAKE_HANDLER:${method}`);
    return handler(input as Record<string, unknown>, context) as CommandCenterRepositoryResults[M];
  }
}

function context(hostId = HOST_ID, hostEpoch = HOST_EPOCH): CommandCenterRepositoryContext {
  return {
    binding: { hostId, hostEpoch },
    auth: { subject: "owner", roles: ["owner"], sessionIds: [], workspaceIds: [] },
  };
}

function receiptEntry(receipt: CommandCenterReceipt, sequence: number, hostId = HOST_ID, hostEpoch = HOST_EPOCH) {
  return {
    receipt,
    hostId,
    hostEpoch,
    commandWorkspaceId: WORKSPACES[0].id,
    membershipRevision: 1,
    sequence,
  };
}

function options(
  repository: CommandCenterRepository,
  overrides: Partial<CommandCenterMonitorProducerOptions> = {},
): CommandCenterMonitorProducerOptions {
  return {
    repository,
    context: () => context(),
    epoch: "monitor-epoch-1",
    clock: { now: () => Date.parse("2026-01-01T00:00:00Z") },
    tokens: (() => {
      let token = 0;
      return { next: () => `test-token-${++token}` };
    })(),
    ...overrides,
  };
}

function healthyWorkspaces(repository: FakeRepository): FakeRepository {
  return repository.on("workspace/list", () => ({ workspaces: structuredClone(WORKSPACES) }));
}

function emptyReceipts(repository: FakeRepository): FakeRepository {
  return repository.on("receipt/list", () => ({ entries: [], nextAfterSequence: null }));
}

describe("CommandCenterMonitorProducer", () => {
  it("publishes a bounded cut, pages it, and reads receipts with a cursor", async () => {
    const repository = healthyWorkspaces(new FakeRepository());
    const receipts = [control.receipts.accepted, control.receipts.completed, control.receipts.conflicted];
    repository.on("receipt/list", (input) => {
      if (input.afterSequence === 0) {
        return { entries: [receiptEntry(receipts[0], 1), receiptEntry(receipts[1], 2)], nextAfterSequence: 2 };
      }
      return { entries: [receiptEntry(receipts[2], 3)], nextAfterSequence: null };
    });
    const producer = new CommandCenterMonitorProducer(options(repository, { snapshotLimits: { pageRows: 1 } }));

    const publication = await producer.publishCut({ scopeKey: SCOPE, sequence: 42, rows: ROWS.slice(0, 2) });
    expect(publication.status).toBe("published");
    if (publication.status !== "published") return;
    expect(publication.snapshot.rows).toHaveLength(1);
    expect(publication.snapshot.nextPage).toBeTruthy();
    expect(publication.workspaces).toHaveLength(4);
    expect(publication.receipts).toHaveLength(3);
    expect(publication.health.status).toBe("connected");

    const receiptReads = repository.calls.filter((call) => call.method === "receipt/list");
    expect(receiptReads.map((call) => call.input.afterSequence)).toEqual([0, 2]);
    expect(new Set(repository.calls.map((call) => call.method))).toEqual(new Set(["workspace/list", "receipt/list"]));

    const first = producer.getState();
    expect(first.sequence).toBe(42);
    expect(first.rows).toBe(2);
    expect(first.snapshot?.cursor).toEqual({ epoch: "monitor-epoch-1", sequence: 42 });

    const second = producer.page({ scopeKey: SCOPE, epoch: "monitor-epoch-1", token: publication.snapshot.nextPage! });
    expect(second.status).toBe("page");
    if (second.status !== "page") return;
    expect(second.snapshot.rows).toHaveLength(1);
    expect(second.snapshot.cursor).toEqual(publication.snapshot.cursor);
    producer.dispose();
  });

  it("refuses repository errors, retains the last publication and never invents rows", async () => {
    const repository = healthyWorkspaces(emptyReceipts(new FakeRepository()));
    const producer = new CommandCenterMonitorProducer(options(repository));
    const first = await producer.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS.slice(0, 2) });
    expect(first.status).toBe("published");

    repository.on("workspace/list", () => { throw new Error("HOST_DOWN"); });
    const failed = await producer.applyChanges({
      scopeKey: SCOPE, sequence: 2,
      changes: [{ kind: "upsert", row: { ...ROWS[2], label: "Must not appear" } }],
    });
    expect(failed).toEqual({ status: "refused", reason: "repository" });
    const state = producer.getState();
    expect(state.health.status).toBe("offline");
    expect(state.health.failure).toBe("repository");
    expect(state.snapshot?.rows.map((row) => row.label)).toEqual([ROWS[0].label, ROWS[1].label]);
    expect(state.workspaces).toHaveLength(4);
    expect(state.sequence).toBe(1);

    const fresh = new CommandCenterMonitorProducer(options(new FakeRepository()
      .on("workspace/list", () => { throw new Error("HOST_DOWN"); })
      .on("receipt/list", () => ({ entries: [], nextAfterSequence: null }))));
    const refused = await fresh.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS });
    expect(refused).toEqual({ status: "refused", reason: "repository" });
    expect(fresh.getState().snapshot).toBeNull();
    expect(fresh.getState().rows).toBe(0);
    expect(fresh.getState().workspaces).toEqual([]);
    expect(fresh.getState().health.status).toBe("offline");
    producer.dispose();
    fresh.dispose();
  });

  it("bounds cached rows and snapshot capture without publishing a partial cut", async () => {
    const repository = healthyWorkspaces(emptyReceipts(new FakeRepository()));
    const producer = new CommandCenterMonitorProducer(options(repository, { maxRows: 2 }));
    const tooMany = await producer.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS });
    expect(tooMany).toEqual({ status: "refused", reason: "row_limit" });
    expect(producer.getState().snapshot).toBeNull();
    expect(producer.getState().health.failure).toBe("capture");

    const bounded = new CommandCenterMonitorProducer(options(repository, { snapshotLimits: { maxRows: 2 } }));
    const storeRefused = await bounded.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS });
    expect(storeRefused).toEqual({ status: "refused", reason: "capture" });
    expect(bounded.getState().snapshot).toBeNull();
    producer.dispose();
    bounded.dispose();
  });

  it("applies only contiguous ordered changes and refuses stale or gapped cursors", async () => {
    const repository = healthyWorkspaces(emptyReceipts(new FakeRepository()));
    const producer = new CommandCenterMonitorProducer(options(repository));
    await producer.publishCut({ scopeKey: SCOPE, sequence: 5, rows: ROWS.slice(0, 2) });

    expect(await producer.applyChanges({ scopeKey: SCOPE, sequence: 5, changes: [] })).toEqual(
      { status: "refused", reason: "duplicate_sequence" },
    );
    expect(await producer.applyChanges({ scopeKey: SCOPE, sequence: 7, changes: [] })).toEqual(
      { status: "refused", reason: "sequence_gap" },
    );
    const applied = await producer.applyChanges({
      scopeKey: SCOPE,
      sequence: 6,
      changes: [
        { kind: "remove", target: ROWS[1].target },
        { kind: "upsert", row: { ...ROWS[2], commandWorkspaceId: WORKSPACES[0].id } },
      ],
    });
    expect(applied.status).toBe("published");
    if (applied.status !== "published") return;
    expect(applied.snapshot.rows.map((row) => row.label).sort()).toEqual([ROWS[0].label, ROWS[2].label].sort());
    expect(producer.getState().sequence).toBe(6);
    expect(producer.getState().rows).toBe(2);
    expect(producer.getState().snapshot?.cursor.sequence).toBe(6);

    const slow = await producer.applyChanges({ scopeKey: "lease:other", sequence: 7, changes: [] });
    expect(slow).toEqual({ status: "refused", reason: "scope_changed" });
    producer.dispose();
  });

  it("rotates the epoch by discarding pages, cursors and cached rows", async () => {
    const repository = healthyWorkspaces(emptyReceipts(new FakeRepository()));
    const producer = new CommandCenterMonitorProducer(options(repository, { snapshotLimits: { pageRows: 1 } }));
    const publication = await producer.publishCut({ scopeKey: SCOPE, sequence: 3, rows: ROWS.slice(0, 2) });
    expect(publication.status).toBe("published");
    if (publication.status !== "published") return;
    const token = publication.snapshot.nextPage!;
    expect(producer.page({ scopeKey: SCOPE, epoch: "monitor-epoch-1", token }).status).toBe("page");

    producer.reset({ epoch: "monitor-epoch-2" });
    expect(producer.getState().epoch).toBe("monitor-epoch-2");
    expect(producer.getState().sequence).toBeNull();
    expect(producer.getState().snapshot).toBeNull();
    expect(producer.getState().rows).toBe(0);
    expect(producer.page({ scopeKey: SCOPE, epoch: "monitor-epoch-1", token })).toEqual({ status: "resync", reason: "epoch" });

    const next = await producer.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS.slice(0, 1) });
    expect(next.status).toBe("published");
    if (next.status !== "published") return;
    expect(next.snapshot.cursor.epoch).toBe("monitor-epoch-2");
    expect(producer.page({ scopeKey: SCOPE, epoch: "monitor-epoch-1", token })).toEqual({ status: "resync", reason: "epoch" });
    producer.dispose();
  });

  it("refuses a publication when the trusted owner changes across an await", async () => {
    const repository = healthyWorkspaces(emptyReceipts(new FakeRepository()));
    let contexts = 0;
    const producer = new CommandCenterMonitorProducer(options(repository, {
      context: () => (++contexts === 1 ? context() : context("host-monitor-2")),
    }));
    const result = await producer.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS.slice(0, 1) });
    expect(result).toEqual({ status: "refused", reason: "owner_changed" });
    expect(producer.getState().snapshot).toBeNull();
    expect(producer.getState().health.failure).toBe("owner_changed");
    producer.dispose();
  });

  it("fails closed after disposal", async () => {
    const repository = healthyWorkspaces(emptyReceipts(new FakeRepository()));
    const producer = new CommandCenterMonitorProducer(options(repository, { snapshotLimits: { pageRows: 1 } }));
    const publication = await producer.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS.slice(0, 2) });
    expect(publication.status).toBe("published");
    if (publication.status !== "published") return;
    const token = publication.snapshot.nextPage!;
    producer.dispose();
    expect(producer.page({ scopeKey: SCOPE, epoch: "monitor-epoch-1", token })).toEqual({ status: "resync", reason: "disposed" });
    expect(await producer.publishCut({ scopeKey: SCOPE, sequence: 2, rows: ROWS.slice(0, 1) })).toEqual(
      { status: "refused", reason: "disposed" },
    );
  });

  it("caps receipt reads at the producer budget and refuses foreign receipts", async () => {
    const repository = healthyWorkspaces(new FakeRepository());
    repository.on("receipt/list", () => ({
      entries: [receiptEntry(control.receipts.accepted, 1), receiptEntry(control.receipts.completed, 2)],
      nextAfterSequence: 2,
    }));
    const producer = new CommandCenterMonitorProducer(options(repository, { maxReceipts: 1 }));
    const publication = await producer.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS.slice(0, 1) });
    expect(publication.status).toBe("published");
    if (publication.status !== "published") return;
    expect(publication.receipts).toHaveLength(1);
    expect(repository.calls.filter((call) => call.method === "receipt/list")).toHaveLength(1);

    const foreignRepository = healthyWorkspaces(new FakeRepository());
    foreignRepository.on("receipt/list", () => ({
      entries: [receiptEntry(control.receipts.accepted, 1, "other-host")], nextAfterSequence: null,
    }));
    const foreign = new CommandCenterMonitorProducer(options(foreignRepository));
    expect(await foreign.publishCut({ scopeKey: SCOPE, sequence: 1, rows: ROWS.slice(0, 1) })).toEqual(
      { status: "refused", reason: "repository" },
    );
    producer.dispose();
    foreign.dispose();
  });

  it("exposes the key arithmetic used to address cached rows", () => {
    const keys = ROWS.map((row: { target: never }) => commandCenterTaskKey(row.target));
    expect(new Set(keys).size).toBe(ROWS.length);
  });
});
