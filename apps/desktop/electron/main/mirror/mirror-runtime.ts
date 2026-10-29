/**
 * Per-project mirror runtime ownership (spec 23, ADR 0338).
 *
 * An open remote mirror project owns exactly one long-lived runtime: the sync
 * engine (watchers, coalescing timers, in-flight transfers) plus, when the user
 * debugs the remote side, a live DAP session (socket and SSH forward), and — for
 * the project that runs a build — one remote run manager. Keeping that ownership
 * in a single registry makes "created once" and "always disposed" independent of
 * which handler or window opened the project, so a second open of the same group
 * cannot duplicate watchers, and a closed project cannot leave a forward, socket,
 * timer, or remote command behind.
 *
 * The registry is also the one place that knows what the renderer may see: the
 * status snapshot, the recorded conflicts, and the run outcomes are read back
 * from here, never from a socket, token, or remote path.
 *
 * Importing this module starts nothing: no watcher, timer, socket, run, or SSH
 * forward exists until `ensureRuntime` is called for an open project.
 */

import type {
  MirrorConflict as MirrorConflictWire,
  MirrorConflictResolution,
  MirrorFailure,
  MirrorSyncState,
  MirrorSyncStatus,
} from "@pi-desktop/shared";
import type { RemoteRunManager } from "./remote-run.ts";
import {
  SyncEngine,
  type MirrorConflict as SyncEngineConflict,
  type MirrorSyncMode,
  type SyncEngineOptions,
} from "./sync-engine.ts";

/**
 * The `@pi-desktop/shared` `ErrorCodes` this module reports, spelled as a union
 * the way `remote-run.ts` does: mirror code runs against the prebuilt workspace
 * copy of that package, so it must not depend on that build's age.
 */
export type MirrorRuntimeErrorCode = "HELPER_OPERATION_UNAVAILABLE";
/** The slice of `SyncEngine` the registry owns and must be able to stop. */
export type MirrorRuntimeSyncEngine = {
  startWatching(): void;
  stopWatching(): void;
  dispose(): void | Promise<void>;
  /**
   * Coalesced paths still waiting for their debounce window. The real engine
   * exposes its queue; a double that omits it reports zero pending paths rather
   * than an invented number.
   */
  readonly queue?: { readonly size: number };
  /** Conflicts awaiting a user decision (spec 23 §6.2). */
  readonly activeConflicts?: readonly MirrorRuntimeEngineConflict[];
  /**
   * Applies the user's decision for one recorded conflict. Present on the real
   * `SyncEngine`; a runtime without it cannot resolve, which is reported instead
   * of pretending the decision was recorded.
   */
  resolveConflict?(
    relPath: string,
    resolution: MirrorConflictResolution,
  ): Promise<void>;
};

/** One recorded conflict, as the engine holds it. */
export type MirrorRuntimeEngineConflict = SyncEngineConflict;

/**
 * The slice of a live DAP session the registry owns. `disconnect` performs the
 * protocol handshake and then the unconditional teardown; `close` is the
 * teardown on its own, used when the handshake path fails.
 */
export type MirrorRuntimeDapSession = {
  disconnect(): void | Promise<void>;
  close(): void | Promise<void>;
};

/**
 * Mutable per-project bookkeeping the status snapshot is computed from.
 *
 * `syncing` from the wire union is never produced here: the engine reports a
 * batch only when it finishes, so claiming a transfer is in flight would be a
 * guess. `pendingPaths` is the observable "work remains" signal instead.
 */
export type MirrorRuntimeStats = {
  /** Recorded when the runtime is created, so the snapshot needs no engine read. */
  readonly mode: MirrorSyncMode;
  state: MirrorSyncState;
  uploadedFiles: number;
  skippedFiles: number;
  lastError: MirrorFailure | null;
};

export type MirrorRuntimeEntry = {
  readonly projectGroupId: string;
  readonly syncEngine: MirrorRuntimeSyncEngine;
  readonly createdAt: number;
  /** Mutated by attach/dispose; never reassigned concurrently. */
  dapSession: MirrorRuntimeDapSession | null;
  /** Counters and sync state the status snapshot is computed from. */
  readonly stats: MirrorRuntimeStats;
};

/**
 * Options for creating a project runtime. Everything except `startWatching` is
 * forwarded to `SyncEngine`; the group id becomes the engine's `projectId`.
 */
export type MirrorRuntimeOptions = Omit<SyncEngineOptions, "projectId"> & {
  /**
   * Start the local watcher as part of opening the project. Defaults to true,
   * because `ensureRuntime` is the "project opened" act; pass false to build a
   * runtime that only syncs on explicit `sync()` calls.
   */
  startWatching?: boolean;
  /** A DAP session that is already connected, attached atomically on create. */
  dapSession?: MirrorRuntimeDapSession | null;
};

export type MirrorRuntimeDisposalResult = {
  projectGroupId: string;
  /** False when there was nothing to dispose (already disposed, never created). */
  disposed: boolean;
  /**
   * Collaborator failures during teardown, `"<step>: <message>"`. Empty on a
   * clean disposal. Disposal always settles, so these are the only signal that
   * a watcher, socket, or forward refused to close.
   */
  errors: string[];
};

/** Minimal warning sink so failures stay observable in the main-process log. */
export type MirrorRuntimeLogger = {
  warn(message: string, data?: Record<string, unknown>): void;
};

export type MirrorRuntimeRegistryOptions = {
  createSyncEngine?: (options: SyncEngineOptions) => MirrorRuntimeSyncEngine;
  logger?: MirrorRuntimeLogger;
  /** Injected clock so entry timestamps stay deterministic in tests. */
  now?: () => number;
};

const defaultLogger: MirrorRuntimeLogger = {
  warn(message, data) {
    // The main process logs to stdout before `logger` is available and during
    // shutdown, so a plain console warning is the one sink that always works.
    console.warn(`[mirror-runtime] ${message}`, data ?? {});
  },
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registry of live mirror runtimes, keyed by project group id.
 *
 * Every method is safe to call repeatedly: creation deduplicates on a live
 * entry, disposal deduplicates on an in-flight disposal, and disposal of an
 * unknown group is a no-op that reports `disposed: false`.
 */
export class MirrorRuntimeRegistry {
  private readonly createSyncEngine: (
    options: SyncEngineOptions,
  ) => MirrorRuntimeSyncEngine;
  private readonly logger: MirrorRuntimeLogger;
  private readonly now: () => number;
  private readonly runtimes = new Map<string, MirrorRuntimeEntry>();
  /** Remote run managers keyed by project, independent of an open sync runtime. */
  private readonly runManagers = new Map<string, RemoteRunManager>();
  private readonly pendingDisposals = new Map<
    string,
    Promise<MirrorRuntimeDisposalResult>
  >();

  constructor(options: MirrorRuntimeRegistryOptions = {}) {
    this.createSyncEngine = options.createSyncEngine ?? ((engineOptions) => new SyncEngine(engineOptions));
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  /** Group ids with a live runtime, in creation order. */
  get activeGroupIds(): string[] {
    return [...this.runtimes.keys()];
  }

  hasRuntime(projectGroupId: string): boolean {
    return this.runtimes.has(normalizeGroupId(projectGroupId));
  }

  getRuntime(projectGroupId: string): MirrorRuntimeEntry | undefined {
    return this.runtimes.get(normalizeGroupId(projectGroupId));
  }

  /**
   * Returns the live runtime of a project, creating it on first call.
   *
   * A second call for the same group returns the existing entry and ignores its
   * options: the project's roots, credentials, and callback wiring come from the
   * open that established them, and replacing them mid-flight would leave the
   * previous watchers and baseline cache owned by nobody.
   */
  ensureRuntime(
    projectGroupId: string,
    options: MirrorRuntimeOptions,
  ): MirrorRuntimeEntry {
    const key = normalizeGroupId(projectGroupId);
    const existing = this.runtimes.get(key);
    if (existing) return existing;

    const { startWatching = true, dapSession = null, ...engineOptions } = options;
    const stats: MirrorRuntimeStats = {
      mode: engineOptions.mode ?? "auto",
      state: "idle",
      uploadedFiles: 0,
      skippedFiles: 0,
      lastError: null,
    };
    // The batch callbacks are the only place a finished transfer, a skipped
    // file, and a failed one are visible without polling the engine, so the
    // counters are fed here and the caller's own callbacks still run.
    const syncEngine = this.createSyncEngine({
      // The registry owns the identity, so a caller cannot open the same group
      // under a second project id.
      projectId: key,
      ...engineOptions,
      onOverLimit: (entry) => {
        stats.skippedFiles += 1;
        engineOptions.onOverLimit?.(entry);
      },
      onTransferFailure: (failure) => {
        stats.lastError = { code: failure.code, message: failure.error };
        engineOptions.onTransferFailure?.(failure);
      },
      onSyncBatchComplete: (result) => {
        stats.uploadedFiles += result.uploaded.length;
        stats.skippedFiles += result.skipped.length;
        // A clean batch retires the previous error; a batch that still has an
        // unresolved conflict or failure keeps it observable.
        if (result.failures.length === 0) stats.lastError = null;
        engineOptions.onSyncBatchComplete?.(result);
      },
    });
    const entry: MirrorRuntimeEntry = {
      projectGroupId: key,
      syncEngine,
      dapSession,
      createdAt: this.now(),
      stats,
    };
    // Register before starting the watcher: a watcher failure must not leave a
    // constructed engine outside the registry, where nothing would dispose it.
    this.runtimes.set(key, entry);

    if (startWatching) {
      try {
        syncEngine.startWatching();
        stats.state = "watching";
      } catch (error) {
        const message = describeError(error);
        stats.state = "failed";
        stats.lastError = { code: "MIRROR_SYNC_START_FAILED", message };
        this.warn("mirror watcher failed to start", {
          projectGroupId: key,
          error: message,
        });
      }
    }

    return entry;
  }

  /**
   * Attaches a live DAP session to an existing runtime.
   *
   * Returns false when no runtime is live for the group, so the caller keeps
   * ownership of the session it just connected instead of leaking it here. A
   * previously attached session is disconnected, never dropped silently.
   */
  attachDapSession(
    projectGroupId: string,
    session: MirrorRuntimeDapSession,
  ): boolean {
    const entry = this.runtimes.get(normalizeGroupId(projectGroupId));
    if (!entry) return false;

    const previous = entry.dapSession;
    entry.dapSession = session;
    if (previous && previous !== session) {
      void this.disposeDapSession(entry.projectGroupId, previous).then((errors) => {
        if (errors.length > 0) {
          this.warn("replaced DAP session did not close cleanly", {
            projectGroupId: entry.projectGroupId,
            errors,
          });
        }
      });
    }
    return true;
  }

  /**
   * Disposes one project: stops watchers, aborts in-flight transfers, clears
   * coalescing timers, cancels the remote run, disconnects the DAP session,
   * closes its SSH forward, and forgets the entry.
   *
   * Idempotent and non-throwing. Concurrent calls share one disposal, and a
   * failing collaborator is recorded in `errors` instead of skipping the rest.
   * A project that only has a run manager is still disposed, so a build can
   * never outlive the project that started it.
   */
  disposeRuntime(
    projectGroupId: string,
  ): Promise<MirrorRuntimeDisposalResult> {
    const key = normalizeGroupId(projectGroupId);
    const inFlight = this.pendingDisposals.get(key);
    if (inFlight) return inFlight;

    const entry = this.runtimes.get(key);
    const runManager = this.runManagers.get(key);
    if (!entry && !runManager) {
      return Promise.resolve({ projectGroupId: key, disposed: false, errors: [] });
    }

    // Forget the entry before awaiting teardown so a re-entrant disposal (a
    // window closing while shutdown runs, for example) cannot dispose the same
    // collaborators twice. The pending map below covers that same re-entry.
    this.runtimes.delete(key);
    this.runManagers.delete(key);
    const disposal = this.runDisposal(key, entry ?? null, runManager ?? null);
    this.pendingDisposals.set(key, disposal);
    // Forget the settled promise so a later open of the same group starts clean.
    void disposal.finally(() => {
      if (this.pendingDisposals.get(key) === disposal) {
        this.pendingDisposals.delete(key);
      }
    });
    return disposal;
  }

  /**
   * Disposes every live project. Each project is disposed independently, so one
   * failure cannot keep another project's watchers, forwards, sockets, or remote
   * commands alive.
   */
  async disposeAll(): Promise<MirrorRuntimeDisposalResult[]> {
    const keys = new Set([
      ...this.runtimes.keys(),
      ...this.runManagers.keys(),
      ...this.pendingDisposals.keys(),
    ]);
    if (keys.size === 0) return [];
    return Promise.all([...keys].map((key) => this.disposeRuntime(key)));
  }

  private async runDisposal(
    projectGroupId: string,
    entry: MirrorRuntimeEntry | null,
    runManager: RemoteRunManager | null,
  ): Promise<MirrorRuntimeDisposalResult> {
    const errors: string[] = [];

    if (entry) {
      const dapSession = entry.dapSession;
      entry.dapSession = null;

      // Watchers, the coalescing queue timers, and the transfer abort signal are
      // all owned by the engine, so one dispose covers the first three steps.
      try {
        await entry.syncEngine.dispose();
      } catch (error) {
        errors.push(`sync-engine-dispose: ${describeError(error)}`);
      }

      if (dapSession) {
        const dapErrors = await this.disposeDapSession(entry.projectGroupId, dapSession);
        errors.push(...dapErrors);
      }
    }

    // A live remote command holds an SSH channel as well as the output it is
    // streaming, so it is disposed even when the sync engine already failed.
    if (runManager) {
      try {
        await runManager.dispose();
      } catch (error) {
        errors.push(`run-manager-dispose: ${describeError(error)}`);
      }
    }

    if (errors.length > 0) {
      this.warn("mirror runtime disposal completed with errors", {
        projectGroupId,
        errors,
      });
    }

    return {
      projectGroupId,
      disposed: true,
      errors,
    };
  }

  private async disposeDapSession(
    projectGroupId: string,
    session: MirrorRuntimeDapSession,
  ): Promise<string[]> {
    const errors: string[] = [];
    try {
      await session.disconnect();
    } catch (error) {
      errors.push(`dap-disconnect: ${describeError(error)}`);
      // `disconnect` can reject before its unconditional teardown runs; `close`
      // is what actually destroys the socket and closes the SSH forward.
      try {
        await session.close();
      } catch (closeError) {
        errors.push(`dap-close: ${describeError(closeError)}`);
      }
    }
    if (errors.length > 0) {
      this.warn("DAP session did not disconnect cleanly", {
        projectGroupId,
        errors,
      });
    }
    return errors;
  }

  /**
   * Snapshot of what the synchronizer is doing for one live project. Empty
   * counters are only ever reported for a runtime that really has none; a
   * project without a runtime has no snapshot at all.
   */
  getStatus(projectGroupId: string): MirrorSyncStatus | undefined {
    const entry = this.runtimes.get(normalizeGroupId(projectGroupId));
    return entry ? this.statusOf(entry) : undefined;
  }

  /**
   * Starts or resumes the project's watcher and reports the new snapshot.
   *
   * Idempotent: a project that is already watching is not started twice, so the
   * second `mirrorSyncStart` of one open project cannot install a second watcher.
   * Returns undefined when no runtime is live — the caller decides whether that
   * is "not open yet" or an error.
   */
  startSync(projectGroupId: string): MirrorSyncStatus | undefined {
    const entry = this.runtimes.get(normalizeGroupId(projectGroupId));
    if (!entry) return undefined;
    if (entry.stats.state !== "watching") {
      try {
        entry.syncEngine.startWatching();
        entry.stats.state = "watching";
        entry.stats.lastError = null;
      } catch (error) {
        const message = describeError(error);
        entry.stats.state = "failed";
        entry.stats.lastError = { code: "MIRROR_SYNC_START_FAILED", message };
        this.warn("mirror watcher failed to start", {
          projectGroupId: entry.projectGroupId,
          error: message,
        });
      }
    }
    return this.statusOf(entry);
  }

  /**
   * Stops the project's watcher but keeps the runtime and its baseline, so a
   * later start resumes from the same state. Stopping a project that is not
   * watching (already paused, or never started) does nothing.
   */
  stopSync(projectGroupId: string): MirrorSyncStatus | undefined {
    const entry = this.runtimes.get(normalizeGroupId(projectGroupId));
    if (!entry) return undefined;
    if (entry.stats.state === "watching") {
      try {
        entry.syncEngine.stopWatching();
        entry.stats.state = "paused";
      } catch (error) {
        const message = describeError(error);
        entry.stats.state = "failed";
        entry.stats.lastError = { code: "MIRROR_SYNC_STOP_FAILED", message };
        this.warn("mirror watcher failed to stop", {
          projectGroupId: entry.projectGroupId,
          error: message,
        });
      }
    }
    return this.statusOf(entry);
  }

  /** Conflicts still waiting for a user decision, newest state from the engine. */
  listConflicts(projectGroupId: string): MirrorConflictWire[] {
    const entry = this.runtimes.get(normalizeGroupId(projectGroupId));
    if (!entry) return [];
    return (entry.syncEngine.activeConflicts ?? []).map(toWireConflict);
  }

  /**
   * Applies the user's decision for one conflict and reports the new snapshot.
   *
   * Returns undefined when no runtime is live, because there is nothing to
   * resolve. A runtime whose engine cannot resolve refuses loudly instead of
   * dropping the decision.
   */
  async resolveConflict(
    projectGroupId: string,
    relPath: string,
    resolution: MirrorConflictResolution,
  ): Promise<MirrorSyncStatus | undefined> {
    const entry = this.runtimes.get(normalizeGroupId(projectGroupId));
    if (!entry) return undefined;
    const resolve = entry.syncEngine.resolveConflict;
    if (!resolve) {
      throw typedError(
        "The mirror sync engine cannot resolve conflicts",
        "HELPER_OPERATION_UNAVAILABLE",
      );
    }
    try {
      await resolve.call(entry.syncEngine, relPath, resolution);
    } catch (error) {
      entry.stats.state = "failed";
      entry.stats.lastError = {
        code: (error as { errorCode?: string }).errorCode ?? "MIRROR_CONFLICT_UNRESOLVED",
        message: describeError(error),
      };
      throw error;
    }
    return this.statusOf(entry);
  }

  /**
   * The project's remote run manager, created on first use.
   *
   * A build sits beside the sync runtime rather than inside it: a project can
   * run its configured command without an open synchronization, and the run
   * still has to be cancelled when the project closes. Ownership is the same
   * either way, so disposal covers it.
   */
  ensureRunManager(
    projectGroupId: string,
    create: () => RemoteRunManager,
  ): RemoteRunManager {
    const key = normalizeGroupId(projectGroupId);
    const existing = this.runManagers.get(key);
    if (existing) return existing;
    const manager = create();
    this.runManagers.set(key, manager);
    return manager;
  }

  getRunManager(projectGroupId: string): RemoteRunManager | undefined {
    return this.runManagers.get(normalizeGroupId(projectGroupId));
  }

  private statusOf(entry: MirrorRuntimeEntry): MirrorSyncStatus {
    return {
      projectGroupId: entry.projectGroupId,
      state: entry.stats.state,
      mode: entry.stats.mode,
      pendingPaths: entry.syncEngine.queue?.size ?? 0,
      uploadedFiles: entry.stats.uploadedFiles,
      conflictCount: entry.syncEngine.activeConflicts?.length ?? 0,
      skippedFiles: entry.stats.skippedFiles,
      lastError: entry.stats.lastError,
    };
  }

  private warn(message: string, data?: Record<string, unknown>): void {
    try {
      this.logger.warn(message, data);
    } catch {
      // A logging sink must never turn a disposal failure into an exception.
    }
  }
}

function normalizeGroupId(projectGroupId: string): string {
  const key = projectGroupId.trim();
  if (!key) {
    throw new Error("MIRROR_RUNTIME_MISSING_GROUP_ID");
  }
  return key;
}

/** A typed failure the IPC layer passes through as a `Result` error. */
function typedError(message: string, errorCode: MirrorRuntimeErrorCode): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * The wire shape of one recorded conflict. A remote side that does not exist
 * reports zeros: the renderer reads "missing" from the baseline comparison, not
 * from a fabricated size.
 */
function toWireConflict(
  conflict: MirrorRuntimeEngineConflict,
): MirrorConflictWire {
  return {
    relPath: conflict.relPath,
    localSize: conflict.local.size,
    localMtimeMs: conflict.local.mtimeMs,
    remoteSize: conflict.remote.size ?? 0,
    remoteMtimeMs: conflict.remote.mtimeMs ?? 0,
    baselineSize: conflict.baseline?.size ?? null,
    baselineMtimeMs: conflict.baseline?.mtimeMs ?? null,
  };
}

/**
 * Process-wide registry used by the main-process lifecycle. It holds no
 * resources of its own; it only becomes non-empty when a mirror project opens.
 */
export const mirrorRuntimeRegistry = new MirrorRuntimeRegistry();
