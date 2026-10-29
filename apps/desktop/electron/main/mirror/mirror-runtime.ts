/**
 * Per-project mirror runtime ownership (spec 23, ADR 0338).
 *
 * An open remote mirror project owns exactly one long-lived runtime: the sync
 * engine (watchers, coalescing timers, in-flight transfers) plus, when the user
 * debugs the remote side, a live DAP session (socket and SSH forward). Keeping
 * that ownership in a single registry makes "created once" and "always
 * disposed" independent of which handler or window opened the project, so a
 * second open of the same group cannot duplicate watchers, and a closed project
 * cannot leave a forward, socket, or timer behind.
 *
 * Importing this module starts nothing: no watcher, timer, socket, or SSH
 * forward exists until `ensureRuntime` is called for an open project.
 */

import { SyncEngine, type SyncEngineOptions } from "./sync-engine.ts";

/** The slice of `SyncEngine` the registry owns and must be able to stop. */
export type MirrorRuntimeSyncEngine = {
  startWatching(): void;
  stopWatching(): void;
  dispose(): void | Promise<void>;
};

/**
 * The slice of a live DAP session the registry owns. `disconnect` performs the
 * protocol handshake and then the unconditional teardown; `close` is the
 * teardown on its own, used when the handshake path fails.
 */
export type MirrorRuntimeDapSession = {
  disconnect(): void | Promise<void>;
  close(): void | Promise<void>;
};

export type MirrorRuntimeEntry = {
  readonly projectGroupId: string;
  readonly syncEngine: MirrorRuntimeSyncEngine;
  readonly createdAt: number;
  /** Mutated by attach/dispose; never reassigned concurrently. */
  dapSession: MirrorRuntimeDapSession | null;
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
    const syncEngine = this.createSyncEngine({ ...engineOptions, projectId: key });
    const entry: MirrorRuntimeEntry = {
      projectGroupId: key,
      syncEngine,
      dapSession,
      createdAt: this.now(),
    };
    // Register before starting the watcher: a watcher failure must not leave a
    // constructed engine outside the registry, where nothing would dispose it.
    this.runtimes.set(key, entry);

    if (startWatching) {
      try {
        syncEngine.startWatching();
      } catch (error) {
        this.warn("mirror watcher failed to start", {
          projectGroupId: key,
          error: describeError(error),
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
   * Disposes one project runtime: stops watchers, aborts in-flight transfers,
   * clears coalescing timers, disconnects the DAP session, closes its SSH
   * forward, and forgets the entry.
   *
   * Idempotent and non-throwing. Concurrent calls share one disposal, and a
   * failing collaborator is recorded in `errors` instead of skipping the rest.
   */
  disposeRuntime(
    projectGroupId: string,
  ): Promise<MirrorRuntimeDisposalResult> {
    const key = normalizeGroupId(projectGroupId);
    const inFlight = this.pendingDisposals.get(key);
    if (inFlight) return inFlight;

    const entry = this.runtimes.get(key);
    if (!entry) {
      return Promise.resolve({ projectGroupId: key, disposed: false, errors: [] });
    }

    // Forget the entry before awaiting teardown so a re-entrant disposal (a
    // window closing while shutdown runs, for example) cannot dispose the same
    // collaborators twice. The pending map below covers that same re-entry.
    this.runtimes.delete(key);
    const disposal = this.runDisposal(entry);
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
   * Disposes every live runtime. Each project is disposed independently, so one
   * failure cannot keep another project's watchers, forwards, or sockets alive.
   */
  async disposeAll(): Promise<MirrorRuntimeDisposalResult[]> {
    const keys = new Set([
      ...this.runtimes.keys(),
      ...this.pendingDisposals.keys(),
    ]);
    if (keys.size === 0) return [];
    return Promise.all([...keys].map((key) => this.disposeRuntime(key)));
  }

  private async runDisposal(
    entry: MirrorRuntimeEntry,
  ): Promise<MirrorRuntimeDisposalResult> {
    const errors: string[] = [];
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

    if (errors.length > 0) {
      this.warn("mirror runtime disposal completed with errors", {
        projectGroupId: entry.projectGroupId,
        errors,
      });
    }

    return {
      projectGroupId: entry.projectGroupId,
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

/**
 * Process-wide registry used by the main-process lifecycle. It holds no
 * resources of its own; it only becomes non-empty when a mirror project opens.
 */
export const mirrorRuntimeRegistry = new MirrorRuntimeRegistry();
