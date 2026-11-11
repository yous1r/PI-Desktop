import {
  MonitorSnapshotCaptureError,
  MonitorSnapshotStore,
  type Clock,
  type CommandCenterRepository,
  type CommandCenterRepositoryContext,
  type MonitorSnapshotLimits,
  type MonitorSnapshotPageRequest,
  type MonitorSnapshotPageResult,
} from "@pi-desktop/agent-host";
import {
  COMMAND_CENTER_MAX_AGENTS_PER_HOST,
  COMMAND_CENTER_QUOTA,
  COMMAND_CENTER_VERSION,
  commandCenterTaskKey,
  parseCommandCenterReceipt,
  parseCommandCenterWorkspaceList,
  type CommandCenterMonitorSnapshot,
  type CommandCenterReceipt,
  type CommandCenterTaskSummary,
  type CommandCenterTaskTarget,
  type CommandCenterWorkspace,
} from "@pi-desktop/shared";

/**
 * Bounded incremental producer seam between the command-center repository and
 * the monitor snapshot store.
 *
 * This module owns no transport, authorization or capability registration. A
 * trusted adapter supplies the repository context (binding plus minted auth)
 * and feeds one initial cut of already-authorized C1 summary rows; later
 * updates are applied as ordered upserts/removes against the producer's
 * bounded row cache, so no transcript or full source re-scan happens per
 * update. Workspace and receipt collections are read through the existing
 * private repository port with a fixed page budget.
 *
 * Fail-closed rules:
 * - repository, ownership or capture failures never publish partial data;
 *   the last complete publication is retained and health turns offline;
 * - a stale, duplicate or gapped change sequence is refused; the caller must
 *   publish a new cut (or reset) instead of silently bridging the gap;
 * - an epoch or access-scope change invalidates every earlier page token.
 */

export type CommandCenterMonitorChange =
  | Readonly<{ kind: "upsert"; row: CommandCenterTaskSummary }>
  | Readonly<{ kind: "remove"; target: CommandCenterTaskTarget }>;

export type CommandCenterMonitorProducerFailure =
  | "repository" | "capture" | "owner_changed";

export type CommandCenterMonitorProducerHealth = Readonly<{
  status: "connected" | "stale" | "offline";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failure: CommandCenterMonitorProducerFailure | null;
}>;

export type CommandCenterMonitorProducerState = Readonly<{
  epoch: string;
  scopeKey: string | null;
  sequence: number | null;
  rows: number;
  snapshot: CommandCenterMonitorSnapshot | null;
  workspaces: readonly CommandCenterWorkspace[];
  receipts: readonly CommandCenterReceipt[];
  health: CommandCenterMonitorProducerHealth;
}>;

export type CommandCenterMonitorRefusal =
  | "disposed" | "busy" | "invalid_scope" | "invalid_sequence" | "scope_changed"
  | "no_cut" | "duplicate_sequence" | "sequence_gap" | "row_limit"
  | "repository" | "capture" | "owner_changed";

export type CommandCenterMonitorPublication =
  | Readonly<{
    status: "published";
    snapshot: CommandCenterMonitorSnapshot;
    workspaces: readonly CommandCenterWorkspace[];
    receipts: readonly CommandCenterReceipt[];
    health: CommandCenterMonitorProducerHealth;
  }>
  | Readonly<{ status: "refused"; reason: CommandCenterMonitorRefusal }>;

export type CommandCenterMonitorProducerOptions = {
  /** Concrete adapter: `RustCommandCenterRepository` in production, a fake in tests. */
  repository: CommandCenterRepository;
  /** Trusted adapter minted context; never derived from observation input. */
  context(): CommandCenterRepositoryContext;
  /** Boot epoch of the projection owner. */
  epoch: string;
  clock: Clock;
  tokens: { next(): string };
  /** Optional smaller snapshot-retention budgets for the embedded Host. */
  snapshotLimits?: Partial<MonitorSnapshotLimits>;
  /** Cached current-row bound; C1 caps monitored tasks at 36 per Host. */
  maxRows?: number;
  /** Receipt collection bound for one publication. */
  maxReceipts?: number;
  /** Time without a successful publication after which health turns stale. */
  staleAfterMs?: number;
};

const DEFAULT_MAX_ROWS = COMMAND_CENTER_MAX_AGENTS_PER_HOST;
const DEFAULT_MAX_RECEIPTS = 100;
const RECEIPT_PAGE_LIMIT = 100;
const RECEIPT_PAGE_CEILING = 4;
const DEFAULT_STALE_AFTER_MS = 6_000;

function validEpoch(epoch: string): boolean {
  return typeof epoch === "string" && epoch.length > 0 && epoch.length <= 256 && !epoch.includes("\0");
}

function validScope(scopeKey: string): boolean {
  return typeof scopeKey === "string" && scopeKey.length > 0 && scopeKey.length <= 512 && !scopeKey.includes("\0");
}

function validSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0;
}

function refused(reason: CommandCenterMonitorRefusal): CommandCenterMonitorPublication {
  return Object.freeze({ status: "refused", reason });
}

function freezeRows(rows: readonly CommandCenterTaskSummary[]): readonly CommandCenterTaskSummary[] {
  return Object.freeze(rows.map((row) => Object.freeze(structuredClone(row))));
}

function freezeWorkspaces(workspaces: readonly CommandCenterWorkspace[]): readonly CommandCenterWorkspace[] {
  return Object.freeze(workspaces.map((workspace) => Object.freeze({ ...workspace })));
}

function freezeReceipts(receipts: readonly CommandCenterReceipt[]): readonly CommandCenterReceipt[] {
  return Object.freeze(receipts.map((receipt) => Object.freeze(structuredClone(receipt))));
}

export class CommandCenterMonitorProducer {
  readonly #repository: CommandCenterRepository;
  readonly #context: CommandCenterMonitorProducerOptions["context"];
  readonly #clock: Clock;
  readonly #tokens: { next(): string };
  readonly #snapshotLimits: Partial<MonitorSnapshotLimits> | undefined;
  readonly #maxRows: number;
  readonly #maxReceipts: number;
  readonly #staleAfterMs: number;
  #epoch: string;
  #store: MonitorSnapshotStore;
  #rows = new Map<string, CommandCenterTaskSummary>();
  #scopeKey: string | null = null;
  #sequence: number | null = null;
  #snapshot: CommandCenterMonitorSnapshot | null = null;
  #workspaces: readonly CommandCenterWorkspace[] = Object.freeze([]);
  #receipts: readonly CommandCenterReceipt[] = Object.freeze([]);
  #lastSuccessAtMs: number | null = null;
  #lastFailureAtMs: number | null = null;
  #failure: CommandCenterMonitorProducerFailure | null = null;
  #lifecycle = 0;
  #publishing = false;
  #disposed = false;

  constructor(options: CommandCenterMonitorProducerOptions) {
    if (!options || typeof options.repository?.call !== "function" || typeof options.context !== "function" ||
        typeof options.clock?.now !== "function" || typeof options.tokens?.next !== "function") {
      throw new TypeError("COMMAND_CENTER_MONITOR_INVALID_OPTIONS");
    }
    if (!validEpoch(options.epoch)) throw new RangeError("COMMAND_CENTER_MONITOR_INVALID_EPOCH");
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new RangeError("COMMAND_CENTER_MONITOR_INVALID_MAX_ROWS");
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0 || maxReceipts > 1_000) {
      throw new RangeError("COMMAND_CENTER_MONITOR_INVALID_MAX_RECEIPTS");
    }
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) throw new RangeError("COMMAND_CENTER_MONITOR_INVALID_STALE_AFTER");
    this.#repository = options.repository;
    this.#context = options.context;
    this.#clock = options.clock;
    this.#tokens = options.tokens;
    this.#snapshotLimits = options.snapshotLimits;
    this.#maxRows = maxRows;
    this.#maxReceipts = maxReceipts;
    this.#staleAfterMs = staleAfterMs;
    this.#epoch = options.epoch;
    this.#store = this.#createStore(options.epoch);
  }

  #createStore(epoch: string): MonitorSnapshotStore {
    return new MonitorSnapshotStore({
      epoch, clock: this.#clock, tokens: this.#tokens, ...(this.#snapshotLimits === undefined ? {} : { limits: this.#snapshotLimits }),
    });
  }

  getState(): CommandCenterMonitorProducerState {
    return Object.freeze({
      epoch: this.#epoch,
      scopeKey: this.#scopeKey,
      sequence: this.#sequence,
      rows: this.#rows.size,
      snapshot: this.#snapshot,
      workspaces: this.#workspaces,
      receipts: this.#receipts,
      health: this.#health(),
    });
  }

  /**
   * Publish one consistent source cut (rows plus watermark). The caller takes
   * the cut outside this module; only already-authorized rows may be supplied.
   */
  async publishCut(input: {
    readonly scopeKey: string;
    readonly sequence: number;
    readonly rows: Iterable<CommandCenterTaskSummary>;
  }): Promise<CommandCenterMonitorPublication> {
    if (this.#disposed) return refused("disposed");
    if (this.#publishing) return refused("busy");
    if (!validScope(input.scopeKey)) return refused("invalid_scope");
    if (!validSequence(input.sequence)) return refused("invalid_sequence");
    if (this.#scopeKey !== null && this.#scopeKey !== input.scopeKey) return refused("scope_changed");
    let rows: CommandCenterTaskSummary[];
    try {
      rows = [...input.rows];
    } catch {
      return this.#fail("capture", refused("capture"));
    }
    if (rows.length > this.#maxRows) return this.#fail("capture", refused("row_limit"));
    const lifecycle = this.#lifecycle;
    this.#publishing = true;
    try {
      const context = this.#context();
      const binding = { ...context.binding };
      const collection = await this.#readCollections(context, binding);
      if (collection.status === "refused") return this.#fail("repository", refused("repository"));
      if (this.#disposed) return refused("disposed");
      if (this.#lifecycle !== lifecycle) return refused("busy");
      if (!this.#sameOwner(binding)) return this.#fail("owner_changed", refused("owner_changed"));
      const snapshot = this.#store.capture({ scopeKey: input.scopeKey, sequence: input.sequence, rows });
      this.#scopeKey = input.scopeKey;
      this.#sequence = input.sequence;
      this.#rows = new Map(freezeRows(rows).map((row) => [commandCenterTaskKey(row.target), row]));
      this.#snapshot = snapshot;
      this.#workspaces = collection.workspaces;
      this.#receipts = collection.receipts;
      this.#succeed();
      return Object.freeze({
        status: "published" as const, snapshot, workspaces: this.#workspaces, receipts: this.#receipts, health: this.#health(),
      });
    } catch (error) {
      if (error instanceof MonitorSnapshotCaptureError) return this.#fail("capture", refused("capture"));
      throw error;
    } finally {
      this.#publishing = false;
    }
  }

  /**
   * Apply contiguous ordered changes against the cached cut. No source rows are
   * read again: bounded upsert/remove deltas are the only input.
   */
  async applyChanges(input: {
    readonly scopeKey: string;
    readonly sequence: number;
    readonly changes: Iterable<CommandCenterMonitorChange>;
  }): Promise<CommandCenterMonitorPublication> {
    if (this.#disposed) return refused("disposed");
    if (this.#publishing) return refused("busy");
    if (!validScope(input.scopeKey)) return refused("invalid_scope");
    if (!validSequence(input.sequence)) return refused("invalid_sequence");
    if (this.#scopeKey === null || this.#sequence === null) return refused("no_cut");
    if (this.#scopeKey !== input.scopeKey) return refused("scope_changed");
    if (input.sequence <= this.#sequence) return refused("duplicate_sequence");
    if (input.sequence !== this.#sequence + 1) return refused("sequence_gap");
    const next = new Map(this.#rows);
    try {
      for (const change of input.changes) {
        if (change.kind === "upsert") {
          const row = structuredClone(change.row);
          const key = commandCenterTaskKey(row.target);
          if (!next.has(key) && next.size >= this.#maxRows) return refused("row_limit");
          next.set(key, row);
        } else {
          next.delete(commandCenterTaskKey(change.target));
        }
      }
    } catch {
      return refused("capture");
    }
    if (next.size > this.#maxRows) return refused("row_limit");
    const lifecycle = this.#lifecycle;
    this.#publishing = true;
    try {
      const context = this.#context();
      const binding = { ...context.binding };
      const collection = await this.#readCollections(context, binding);
      if (collection.status === "refused") return this.#fail("repository", refused("repository"));
      if (this.#disposed) return refused("disposed");
      if (this.#lifecycle !== lifecycle) return refused("busy");
      if (!this.#sameOwner(binding)) return this.#fail("owner_changed", refused("owner_changed"));
      const rows = [...next.values()];
      const snapshot = this.#store.capture({ scopeKey: input.scopeKey, sequence: input.sequence, rows });
      this.#sequence = input.sequence;
      this.#rows = next;
      this.#snapshot = snapshot;
      this.#workspaces = collection.workspaces;
      this.#receipts = collection.receipts;
      this.#succeed();
      return Object.freeze({
        status: "published" as const, snapshot, workspaces: this.#workspaces, receipts: this.#receipts, health: this.#health(),
      });
    } catch (error) {
      if (error instanceof MonitorSnapshotCaptureError) return this.#fail("capture", refused("capture"));
      throw error;
    } finally {
      this.#publishing = false;
    }
  }

  /** Read a retained continuation page. Unknown handles always require resync. */
  page(request: MonitorSnapshotPageRequest): MonitorSnapshotPageResult {
    if (this.#disposed) return { status: "resync", reason: "disposed" };
    if (request.epoch !== this.#epoch) return { status: "resync", reason: "epoch" };
    return this.#store.page(request);
  }

  /**
   * Drop the retained cut and page tokens. A changed epoch also recreates the
   * snapshot store so no earlier generation can be observed across a restart.
   */
  reset(input: { readonly scopeKey?: string | null; readonly epoch?: string } = {}): void {
    if (this.#disposed) return;
    this.#lifecycle += 1;
    const previousScope = this.#scopeKey;
    if (input.epoch !== undefined && input.epoch !== this.#epoch) {
      if (!validEpoch(input.epoch)) throw new RangeError("COMMAND_CENTER_MONITOR_INVALID_EPOCH");
      this.#store.dispose();
      this.#epoch = input.epoch;
      this.#store = this.#createStore(input.epoch);
    } else if (previousScope !== null) {
      this.#store.discardScope(previousScope);
    }
    this.#scopeKey = input.scopeKey ?? null;
    this.#sequence = null;
    this.#snapshot = null;
    this.#rows = new Map();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle += 1;
    this.#store.dispose();
    this.#rows.clear();
    this.#snapshot = null;
    this.#scopeKey = null;
    this.#sequence = null;
  }

  #sameOwner(binding: Readonly<{ hostId: string; hostEpoch: string }>): boolean {
    try {
      const current = this.#context().binding;
      return current.hostId === binding.hostId && current.hostEpoch === binding.hostEpoch;
    } catch {
      return false;
    }
  }

  #health(): CommandCenterMonitorProducerHealth {
    const now = this.#clock.now();
    const lastSuccessAt = this.#lastSuccessAtMs === null ? null : new Date(this.#lastSuccessAtMs).toISOString();
    const lastFailureAt = this.#lastFailureAtMs === null ? null : new Date(this.#lastFailureAtMs).toISOString();
    if (this.#disposed || this.#failure !== null || this.#lastSuccessAtMs === null) {
      return Object.freeze({ status: "offline", lastSuccessAt, lastFailureAt, failure: this.#failure });
    }
    const status = this.#snapshot === null || now - this.#lastSuccessAtMs >= this.#staleAfterMs ? "stale" : "connected";
    return Object.freeze({ status, lastSuccessAt, lastFailureAt, failure: null });
  }

  #succeed(): void {
    this.#lastSuccessAtMs = this.#clock.now();
    this.#failure = null;
  }

  #fail(failure: CommandCenterMonitorProducerFailure, result: CommandCenterMonitorPublication): CommandCenterMonitorPublication {
    this.#lastFailureAtMs = this.#clock.now();
    this.#failure = failure;
    return result;
  }

  async #readCollections(
    context: CommandCenterRepositoryContext,
    binding: Readonly<{ hostId: string; hostEpoch: string }>,
  ): Promise<
    | Readonly<{ status: "ready"; workspaces: readonly CommandCenterWorkspace[]; receipts: readonly CommandCenterReceipt[] }>
    | Readonly<{ status: "refused" }>
  > {
    try {
      const workspacePage = await this.#repository.call("workspace/list", {
        version: COMMAND_CENTER_VERSION, hostId: binding.hostId,
      }, context);
      const list = parseCommandCenterWorkspaceList({
        version: COMMAND_CENTER_VERSION, workspaces: workspacePage.workspaces, quota: COMMAND_CENTER_QUOTA,
      });
      const receipts: CommandCenterReceipt[] = [];
      let afterSequence = 0;
      for (let page = 0; page < RECEIPT_PAGE_CEILING && receipts.length < this.#maxReceipts; page += 1) {
        const limit = Math.min(RECEIPT_PAGE_LIMIT, this.#maxReceipts - receipts.length);
        const receiptPage = await this.#repository.call("receipt/list", {
          version: COMMAND_CENTER_VERSION, hostId: binding.hostId, afterSequence, limit,
        }, context);
        for (const entry of receiptPage.entries) {
          if (entry.hostId !== binding.hostId || entry.hostEpoch !== binding.hostEpoch) return { status: "refused" };
          receipts.push(parseCommandCenterReceipt(structuredClone(entry.receipt)));
          if (receipts.length >= this.#maxReceipts) break;
        }
        const next = receiptPage.nextAfterSequence;
        if (next === null || next === undefined) break;
        if (!Number.isSafeInteger(next) || next <= afterSequence) return { status: "refused" };
        afterSequence = next;
      }
      return { status: "ready", workspaces: freezeWorkspaces(list.workspaces), receipts: freezeReceipts(receipts) };
    } catch {
      return { status: "refused" };
    }
  }
}

export function createCommandCenterMonitorProducer(
  options: CommandCenterMonitorProducerOptions,
): CommandCenterMonitorProducer {
  return new CommandCenterMonitorProducer(options);
}
