import {
  COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS,
  COMMAND_CENTER_QUOTA,
  COMMAND_CENTER_VERSION,
  parseCommandCenterReceipt,
  parseCommandCenterWorkspaceList,
  type CommandCenterMonitorSnapshot,
  type CommandCenterReceipt,
  type CommandCenterTaskSummary,
  type CommandCenterWorkspace,
} from "@pi-desktop/shared";
import type {
  CommandCenterConnectionHealthState,
  CommandCenterMonitorProjection,
  CommandCenterMonitorSession,
  CommandCenterMonitorSessionState,
} from "@pi-desktop/command-center-client";
import {
  COMMAND_CENTER_PREVIEW_RECEIPTS,
  COMMAND_CENTER_PREVIEW_SNAPSHOT,
  COMMAND_CENTER_PREVIEW_WORKSPACES,
} from "./command-center-fixtures";

/**
 * Explicit data-provider port for the mounted command-center route.
 *
 * The default provider is the deterministic fixture preview, so the route is
 * unchanged when no provider is injected. A caller that owns an authenticated
 * connection composes the browser-safe `@pi-desktop/command-center-client`
 * observation session and injects `createCommandCenterSessionProvider`:
 * task pages and connection health come from the client session, while the
 * workspace and receipt collections arrive through explicit bounded loaders
 * supplied by the same adapter. No provider opens a transport, starts a turn or
 * advertises a capability; an absent Host therefore stays explicitly offline.
 */

export type CommandCenterHostState = "connected" | "stale" | "offline";
export type CommandCenterDataCollection = "workspaces" | "receipts";

export interface CommandCenterDataState {
  readonly source: "fixture" | "session";
  readonly workspaces: readonly CommandCenterWorkspace[];
  readonly snapshot?: CommandCenterMonitorSnapshot;
  readonly receipts: readonly CommandCenterReceipt[];
  readonly host: Readonly<{ state: CommandCenterHostState }>;
  /** Collection slots whose latest read failed; their last known value is retained. */
  readonly staleCollections: readonly CommandCenterDataCollection[];
}

export type CommandCenterDataRefreshResult =
  | Readonly<{ kind: "published" }>
  | Readonly<{ kind: "partial"; staleCollections: readonly CommandCenterDataCollection[] }>
  | Readonly<{ kind: "failed"; staleCollections: readonly CommandCenterDataCollection[] }>
  | Readonly<{ kind: "disposed" }>;

export interface CommandCenterDataProvider {
  getState(): CommandCenterDataState;
  /** External-store subscription; returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Explicit refresh only; no retry loop. */
  refresh(): Promise<CommandCenterDataRefreshResult>;
  /** Owned by the caller that injected the provider, not by the route. */
  dispose(): void;
}

const EMPTY_SESSION_STATE: CommandCenterDataState = Object.freeze({
  source: "session" as const,
  workspaces: Object.freeze([]) as readonly CommandCenterWorkspace[],
  receipts: Object.freeze([]) as readonly CommandCenterReceipt[],
  host: Object.freeze({ state: "offline" as const }),
  staleCollections: Object.freeze([]) as readonly CommandCenterDataCollection[],
});

const FIXTURE_STATE: CommandCenterDataState = Object.freeze({
  source: "fixture" as const,
  workspaces: COMMAND_CENTER_PREVIEW_WORKSPACES,
  snapshot: COMMAND_CENTER_PREVIEW_SNAPSHOT,
  receipts: COMMAND_CENTER_PREVIEW_RECEIPTS,
  host: Object.freeze({ state: "offline" as const }),
  staleCollections: Object.freeze([]) as readonly CommandCenterDataCollection[],
});

export function createCommandCenterFixtureProvider(): CommandCenterDataProvider {
  return {
    getState: () => FIXTURE_STATE,
    subscribe: () => () => {},
    refresh: async () => ({ kind: "published" as const }),
    dispose: () => {},
  };
}

/** Route default: the existing deterministic preview, unchanged. */
export const COMMAND_CENTER_FIXTURE_PROVIDER: CommandCenterDataProvider = createCommandCenterFixtureProvider();

const DEFAULT_MAX_RECEIPTS = 100;

export interface CommandCenterSessionProviderOptions {
  /** Client session built over the observation context, monitor reader and health. */
  readonly session: CommandCenterMonitorSession;
  /** Authorized, bounded workspace collection for the same connection scope. */
  readonly loadWorkspaces: () => Promise<unknown>;
  /** Authorized, bounded receipt collection for the same connection scope. */
  readonly loadReceipts: () => Promise<unknown>;
  readonly maxReceipts?: number;
}

function parsedWorkspaces(value: unknown): readonly CommandCenterWorkspace[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    const list = parseCommandCenterWorkspaceList({
      version: COMMAND_CENTER_VERSION, workspaces: value, quota: COMMAND_CENTER_QUOTA,
    });
    return Object.freeze(list.workspaces.map((workspace) => Object.freeze(structuredClone(workspace))));
  } catch {
    return undefined;
  }
}

function parsedReceipts(value: unknown, maxReceipts: number): readonly CommandCenterReceipt[] | undefined {
  if (!Array.isArray(value) || value.length > maxReceipts) return undefined;
  try {
    return Object.freeze(value.map((receipt) => Object.freeze(parseCommandCenterReceipt(structuredClone(receipt)))));
  } catch {
    return undefined;
  }
}

/** Materialize one bounded C1 page from the complete client projection. */
export function commandCenterSnapshotFromProjection(
  projection: CommandCenterMonitorProjection,
): CommandCenterMonitorSnapshot {
  const rows: CommandCenterTaskSummary[] = projection.rows
    .slice(0, COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS)
    .map((row) => structuredClone(row));
  return {
    version: COMMAND_CENTER_VERSION,
    cursor: { epoch: projection.cursor.epoch, sequence: projection.cursor.sequence },
    generatedAt: projection.generatedAt,
    rows,
  };
}

/** Map client health without inferring a Host from snapshot data alone. */
export function commandCenterHostStateFromHealth(
  health: CommandCenterConnectionHealthState | undefined,
): CommandCenterHostState {
  if (health === undefined) return "offline";
  if (health.status === "foreground") {
    return health.freshness === "fresh" && health.resynchronized ? "connected" : "stale";
  }
  if (health.status === "suspended") return "stale";
  return "offline";
}

/** A fresh connection is "connected" only when the snapshot barrier also completed. */
export function commandCenterHostState(
  session: CommandCenterMonitorSessionState | undefined,
): CommandCenterHostState {
  const healthState = commandCenterHostStateFromHealth(session?.health);
  if (healthState === "connected" && session?.fresh !== true) return "stale";
  return healthState;
}

function projectionOf(state: CommandCenterMonitorSessionState): CommandCenterMonitorProjection | null {
  const summary = state.summary;
  if (summary !== null && summary.projection !== null) return summary.projection;
  const monitor = state.monitor;
  if ("projection" in monitor && monitor.projection !== null) return monitor.projection;
  return null;
}

/**
 * Create a provider over a client monitor session. The injected session is the
 * only task/health source; collection loaders are validated against the shared
 * C1 parsers and a failure retains the last complete value (never invents one).
 */
export function createCommandCenterSessionProvider(
  options: CommandCenterSessionProviderOptions,
): CommandCenterDataProvider {
  const maxReceipts = options?.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  if (!options || typeof options.session?.refresh !== "function" || typeof options.session?.getState !== "function" ||
      typeof options.loadWorkspaces !== "function" || typeof options.loadReceipts !== "function" ||
      !Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 1_000) {
    throw new TypeError("COMMAND_CENTER_DATA_INVALID_PROVIDER");
  }
  let state = EMPTY_SESSION_STATE;
  let disposed = false;
  let inflight: Promise<CommandCenterDataRefreshResult> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: CommandCenterDataState) => {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const refreshOnce = async (): Promise<CommandCenterDataRefreshResult> => {
    const [sessionOutcome, workspacesOutcome, receiptsOutcome] = await Promise.all([
      Promise.resolve()
        .then(() => options.session.refresh())
        .then((result) => ({ ok: true as const, result }))
        .catch(() => ({ ok: false as const, result: null })),
      Promise.resolve().then(() => options.loadWorkspaces()).then(
        (value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: undefined }),
      ),
      Promise.resolve().then(() => options.loadReceipts()).then(
        (value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: undefined }),
      ),
    ]);
    if (disposed) return { kind: "disposed" };
    const stale = new Set<CommandCenterDataCollection>();
    let workspaces = state.workspaces;
    if (workspacesOutcome.ok) {
      const parsed = parsedWorkspaces(workspacesOutcome.value);
      if (parsed === undefined) stale.add("workspaces");
      else workspaces = parsed;
    } else {
      stale.add("workspaces");
    }
    let receipts = state.receipts;
    if (receiptsOutcome.ok) {
      const parsed = parsedReceipts(receiptsOutcome.value, maxReceipts);
      if (parsed === undefined) stale.add("receipts");
      else receipts = parsed;
    } else {
      stale.add("receipts");
    }
    const sessionState = (() => {
      try { return options.session.getState(); } catch { return undefined; }
    })();
    const projection = sessionState === undefined ? null : projectionOf(sessionState);
    const snapshot = projection === null ? state.snapshot : commandCenterSnapshotFromProjection(projection);
    publish(Object.freeze({
      source: "session" as const,
      workspaces,
      ...(snapshot === undefined ? {} : { snapshot }),
      receipts,
      host: Object.freeze({ state: commandCenterHostState(sessionState) }),
      staleCollections: Object.freeze([...stale]),
    }));
    const staleCollections = Object.freeze([...stale]);
    if (!sessionOutcome.ok || sessionOutcome.result?.kind === "failed") {
      return { kind: "failed" as const, staleCollections };
    }
    if (sessionOutcome.result?.kind === "cancelled") {
      return disposed ? { kind: "disposed" as const } : { kind: "failed" as const, staleCollections };
    }
    return staleCollections.length === 0
      ? { kind: "published" as const }
      : { kind: "partial" as const, staleCollections };
  };

  return {
    getState: () => state,
    subscribe(listener) {
      if (typeof listener !== "function" || disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh() {
      if (disposed) return Promise.resolve({ kind: "disposed" as const });
      if (inflight !== null) return inflight;
      inflight = refreshOnce().finally(() => { inflight = null; });
      return inflight;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      state = EMPTY_SESSION_STATE;
    },
  };
}
