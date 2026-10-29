/**
 * Remote mirror synchronization engine (spec 23 §6, ADR 0338).
 *
 * Keeps a remote mirror in step with a local primary root:
 * 1. Watches the local root recursively with debounced per-path coalescing.
 *    Falls back to per-directory watches on Linux where recursive fs.watch is unsupported.
 * 2. Applies default exclusions, .pi-desktopignore patterns, and project include exceptions.
 * 3. Enforces baseline drift detection: compares remote (size, mtimeMs) before upload,
 *    refuses to overwrite on divergence, and records MIRROR_CONFLICT.
 * 4. Enforces the 50 MB per-file ceiling (non-fatal skip).
 * 5. Performs atomic uploads via HelperFs putFile and upserts baseline records on success.
 * 6. Never automatically retries failed transfers; marks them uncertain for inspection.
 * 7. NEVER deletes remote files on local deletion/rename; records drift instead.
 * 8. Stops watchers and timers on dispose().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_TRANSFER_BYTES } from "./helper-client.ts";
import { type HelperFs, type RemoteStatEntry, validateRemotePath } from "./helper-fs.ts";
import { PathCoalescingQueue, type PendingSyncEntry } from "./sync-queue.ts";
import { SyncExclusionMatcher, parseIgnorePatterns, normalizeRelPath } from "./sync-exclusions.ts";

export type MirrorSyncMode = "auto" | "manual";

export type MirrorHostRpc = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type MirrorBaselineEntry = {
  relPath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  syncedAt: number;
};

export type MirrorConflict = {
  code: "MIRROR_CONFLICT";
  relPath: string;
  local: { size: number; mtimeMs: number };
  remote: { size?: number; mtimeMs?: number; exists: boolean };
  baseline?: { size: number; mtimeMs: number; sha256: string };
  timestamp: number;
};

export type MirrorDrift = {
  relPath: string;
  kind: "local_deleted" | "local_renamed";
  newPath?: string;
  timestamp: number;
};

export type MirrorOverLimit = {
  relPath: string;
  size: number;
  limit: number;
  timestamp: number;
};

export type MirrorTransferFailure = {
  relPath: string;
  error: string;
  code: string;
  uncertain: true;
  timestamp: number;
};

export type SyncBatchResult = {
  uploaded: string[];
  conflicts: MirrorConflict[];
  drifts: MirrorDrift[];
  overLimit: MirrorOverLimit[];
  failures: MirrorTransferFailure[];
  skipped: string[];
};

export type SyncEngineOptions = {
  projectId: string;
  localRoot: string;
  helperFs: HelperFs;
  host: MirrorHostRpc;
  mode?: MirrorSyncMode;
  debounceMs?: number;
  includeExceptions?: readonly string[];
  disabledDefaultExclusions?: readonly string[];
  customIgnorePatterns?: readonly string[];
  onConflict?: (conflict: MirrorConflict) => void;
  onDrift?: (drift: MirrorDrift) => void;
  onOverLimit?: (entry: MirrorOverLimit) => void;
  onTransferFailure?: (failure: MirrorTransferFailure) => void;
  onSyncBatchComplete?: (result: SyncBatchResult) => void;
};

export class SyncEngine {
  readonly projectId: string;
  readonly localRoot: string;
  readonly helperFs: HelperFs;
  readonly host: MirrorHostRpc;
  mode: MirrorSyncMode;

  private readonly options: SyncEngineOptions;
  private readonly exclusions: SyncExclusionMatcher;
  private readonly syncQueue: PathCoalescingQueue;
  private readonly baselineMap = new Map<string, MirrorBaselineEntry>();
  private readonly conflicts = new Map<string, MirrorConflict>();
  private readonly drifts = new Map<string, MirrorDrift>();
  private readonly overLimits = new Map<string, MirrorOverLimit>();
  private readonly transferFailures = new Map<string, MirrorTransferFailure>();
  /** Remote directories already ensured during the current batch. */
  private readonly ensuredDirectories = new Set<string>();

  private readonly dirWatchers = new Map<string, fs.FSWatcher>();
  private recursiveWatcher: fs.FSWatcher | null = null;
  private abortController = new AbortController();
  private isDisposed = false;
  private isSyncing = false;

  constructor(options: SyncEngineOptions) {
    this.projectId = options.projectId;
    this.localRoot = path.resolve(options.localRoot);
    this.helperFs = options.helperFs;
    this.host = options.host;
    this.mode = options.mode ?? "auto";
    this.options = options;

    // Load any .pi-desktopignore from localRoot if customIgnorePatterns wasn't supplied
    let customPatterns = options.customIgnorePatterns;
    if (!customPatterns) {
      try {
        const ignorePath = path.join(this.localRoot, ".pi-desktopignore");
        if (fs.existsSync(ignorePath)) {
          customPatterns = parseIgnorePatterns(fs.readFileSync(ignorePath, "utf8"));
        }
      } catch {
        // Fall back to no custom patterns if file cannot be read
      }
    }

    this.exclusions = new SyncExclusionMatcher({
      includeExceptions: options.includeExceptions,
      disabledDefaultExclusions: options.disabledDefaultExclusions,
      customPatterns,
    });

    this.syncQueue = new PathCoalescingQueue({
      debounceMs: options.debounceMs ?? 400,
      onFlush: async (entries) => {
        if (this.mode === "auto") {
          await this.processPendingBatch(entries);
        }
      },
    });
  }

  get queue(): PathCoalescingQueue {
    return this.syncQueue;
  }

  get activeConflicts(): MirrorConflict[] {
    return Array.from(this.conflicts.values());
  }

  get activeDrifts(): MirrorDrift[] {
    return Array.from(this.drifts.values());
  }

  get activeOverLimits(): MirrorOverLimit[] {
    return Array.from(this.overLimits.values());
  }

  get activeFailures(): MirrorTransferFailure[] {
    return Array.from(this.transferFailures.values());
  }

  getBaseline(relPath: string): MirrorBaselineEntry | undefined {
    return this.baselineMap.get(normalizeRelPath(relPath));
  }

  /**
   * Loads or refreshes the baseline records from host-core storage.
   */
  async loadBaseline(): Promise<void> {
    try {
      const response = await this.host.call<{ entries?: MirrorBaselineEntry[] }>(
        "mirror.baseline.list",
        { projectId: this.projectId },
      );
      this.baselineMap.clear();
      for (const entry of response.entries ?? []) {
        this.baselineMap.set(normalizeRelPath(entry.relPath), entry);
      }
    } catch {
      // Non-fatal if host baseline cannot be fetched initially
    }
  }

  /**
   * Starts watching localRoot recursively.
   *
   * On Linux (or when recursive watch fails), falls back to per-directory watches
   * that prune excluded directories (like node_modules, .git) to conserve file descriptors.
   */
  startWatching(): void {
    if (this.isDisposed) return;
    this.stopWatching();

    const supportsRecursive = process.platform === "win32" || process.platform === "darwin";

    if (supportsRecursive) {
      try {
        this.recursiveWatcher = fs.watch(
          this.localRoot,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename) return;
            this.handleLocalPathChange(filename);
          },
        );
        this.recursiveWatcher.on("error", () => {
          // Fall back to per-directory watches if recursive watching errors
          this.stopWatching();
          this.startPerDirectoryWatching(this.localRoot);
        });
        return;
      } catch {
        // Recursive watching unsupported or failed: fall through to per-directory watches
      }
    }

    // Linux or fallback: per-directory watches
    this.startPerDirectoryWatching(this.localRoot);
  }

  private startPerDirectoryWatching(rootDir: string): void {
    const scanAndWatch = (currentDir: string) => {
      if (this.isDisposed) return;
      const relDir = normalizeRelPath(path.relative(this.localRoot, currentDir));
      if (relDir && this.exclusions.isExcluded(relDir, true)) {
        return;
      }

      try {
        const watcher = fs.watch(
          currentDir,
          { recursive: false },
          (_eventType, filename) => {
            if (!filename) return;
            const fullChild = path.join(currentDir, filename);
            const relChild = normalizeRelPath(path.relative(this.localRoot, fullChild));
            this.handleLocalPathChange(relChild);

            // If a new subdirectory was created, attach a watch to it
            fs.stat(fullChild, (err, stats) => {
              if (!err && stats?.isDirectory() && !this.dirWatchers.has(fullChild)) {
                scanAndWatch(fullChild);
              }
            });
          },
        );

        watcher.on("error", () => {
          watcher.close();
          this.dirWatchers.delete(currentDir);
        });

        this.dirWatchers.set(currentDir, watcher);

        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            scanAndWatch(path.join(currentDir, entry.name));
          }
        }
      } catch {
        // Ignore unreadable subdirectories
      }
    };

    scanAndWatch(rootDir);
  }

  stopWatching(): void {
    if (this.recursiveWatcher) {
      try {
        this.recursiveWatcher.close();
      } catch {
        // Ignore close error
      }
      this.recursiveWatcher = null;
    }

    for (const [dir, watcher] of this.dirWatchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close error
      }
    }
    this.dirWatchers.clear();
  }

  private handleLocalPathChange(rawRelPath: string): void {
    const rel = normalizeRelPath(rawRelPath);
    if (!rel) return;

    const fullPath = path.resolve(this.localRoot, rel);
    fs.stat(fullPath, (err, stats) => {
      if (err) {
        // Path does not exist locally anymore -> deletion
        this.syncQueue.enqueue(rel, "delete");
      } else if (stats.isFile()) {
        // Path exists as file -> modify (or create if previously unseen)
        this.syncQueue.enqueue(rel, "modify");
      }
    });
  }

  /**
   * Explicitly triggers synchronization of all currently pending changes.
   */
  async sync(): Promise<SyncBatchResult> {
    const entries = this.syncQueue.drain();
    return this.processPendingBatch(entries);
  }

  private async processPendingBatch(entries: PendingSyncEntry[]): Promise<SyncBatchResult> {
    if (this.isDisposed || entries.length === 0) {
      return {
        uploaded: [],
        conflicts: [],
        drifts: [],
        overLimit: [],
        failures: [],
        skipped: [],
      };
    }

    while (this.isSyncing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.isDisposed) break;
    }
    this.isSyncing = true;
    // A directory ensured by an earlier batch may have been removed on the host.
    this.ensuredDirectories.clear();

    const result: SyncBatchResult = {
      uploaded: [],
      conflicts: [],
      drifts: [],
      overLimit: [],
      failures: [],
      skipped: [],
    };

    try {
      for (const entry of entries) {
        if (this.isDisposed) break;
        await this.processSingleEntry(entry, result);
      }
    } finally {
      this.isSyncing = false;
      this.options.onSyncBatchComplete?.(result);
    }

    return result;
  }

  private async processSingleEntry(
    entry: PendingSyncEntry,
    result: SyncBatchResult,
  ): Promise<void> {
    const relPath = normalizeRelPath(entry.path);
    if (!relPath) return;

    try {
      validateRemotePath(relPath);
    } catch {
      // Path escapes project root or contains forbidden segments
      result.skipped.push(relPath);
      return;
    }

    // Handle deletions and rename source:
    // Spec 23 §6.2 / ADR 0338: NO remote deletion, ever. Local delete reports drift.
    if (entry.type === "delete" || (entry.type === "rename" && entry.oldPath)) {
      const deleteTarget = entry.type === "rename" && entry.oldPath
        ? normalizeRelPath(entry.oldPath)
        : relPath;

      if (!this.exclusions.isExcluded(deleteTarget)) {
        const drift: MirrorDrift = {
          relPath: deleteTarget,
          kind: entry.type === "rename" ? "local_renamed" : "local_deleted",
          newPath: entry.type === "rename" ? relPath : undefined,
          timestamp: Date.now(),
        };
        this.drifts.set(deleteTarget, drift);
        result.drifts.push(drift);
        this.options.onDrift?.(drift);

        // Delete from durable baseline storage
        await this.host.call("mirror.baseline.entry.delete", {
          projectId: this.projectId,
          relPath: deleteTarget,
        }).catch(() => null);
        this.baselineMap.delete(deleteTarget);
      }

      if (entry.type === "delete") {
        return;
      }
    }

    // Exclusions apply to upload only (Spec 23 §6.3)
    if (this.exclusions.isExcluded(relPath)) {
      result.skipped.push(relPath);
      return;
    }

    // Check local file state
    const localAbsPath = path.resolve(this.localRoot, relPath);
    let localStat: fs.Stats;
    try {
      localStat = await fs.promises.stat(localAbsPath);
    } catch {
      // Local file vanished before upload -> report drift
      const drift: MirrorDrift = {
        relPath,
        kind: "local_deleted",
        timestamp: Date.now(),
      };
      this.drifts.set(relPath, drift);
      result.drifts.push(drift);
      this.options.onDrift?.(drift);
      await this.host.call("mirror.baseline.entry.delete", {
        projectId: this.projectId,
        relPath,
      }).catch(() => null);
      this.baselineMap.delete(relPath);
      return;
    }

    if (!localStat.isFile()) {
      // Not a regular file
      result.skipped.push(relPath);
      return;
    }

    // Enforce 50 MB per-file ceiling (spec 23 §6.3, ADR 0338 §38)
    if (localStat.size > MAX_TRANSFER_BYTES) {
      const overLimit: MirrorOverLimit = {
        relPath,
        size: localStat.size,
        limit: MAX_TRANSFER_BYTES,
        timestamp: Date.now(),
      };
      this.overLimits.set(relPath, overLimit);
      result.overLimit.push(overLimit);
      this.options.onOverLimit?.(overLimit);
      return;
    }

    // Stat the remote copy and compare with baseline (spec 23 §6.2)
    let remoteEntry: RemoteStatEntry | undefined;
    try {
      const stats = await this.helperFs.stat([relPath], { signal: this.abortController.signal });
      remoteEntry = stats[0];
    } catch (error) {
      // Remote stat failure: mark transfer failure as uncertain
      const failure: MirrorTransferFailure = {
        relPath,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { errorCode?: string })?.errorCode ?? "REMOTE_TRANSFER_FAILED",
        uncertain: true,
        timestamp: Date.now(),
      };
      this.transferFailures.set(relPath, failure);
      result.failures.push(failure);
      this.options.onTransferFailure?.(failure);
      return;
    }

    const baseline = this.baselineMap.get(relPath);

    // Conflict detection:
    // If the remote (size, mtimeMs) changed since the baseline, do NOT overwrite.
    let isConflict = false;
    if (remoteEntry?.exists) {
      if (!baseline) {
        // Remote file exists, but baseline never synced it: conflict
        isConflict = true;
      } else if (
        remoteEntry.size !== baseline.size ||
        remoteEntry.mtimeMs !== baseline.mtimeMs
      ) {
        // Remote (size, mtimeMs) changed since stored baseline: conflict
        isConflict = true;
      }
    } else if (baseline) {
      // Baseline expects remote file to exist, but it was deleted remotely: conflict
      isConflict = true;
    }

    if (isConflict) {
      const conflict: MirrorConflict = {
        code: "MIRROR_CONFLICT",
        relPath,
        local: {
          size: localStat.size,
          mtimeMs: Math.round(localStat.mtimeMs),
        },
        remote: {
          size: remoteEntry?.size,
          mtimeMs: remoteEntry?.mtimeMs,
          exists: remoteEntry?.exists ?? false,
        },
        baseline: baseline
          ? {
              size: baseline.size,
              mtimeMs: baseline.mtimeMs,
              sha256: baseline.sha256,
            }
          : undefined,
        timestamp: Date.now(),
      };

      this.conflicts.set(relPath, conflict);
      result.conflicts.push(conflict);
      this.options.onConflict?.(conflict);
      return;
    }

    // Upload atomically via helperFs putFile (spec 23 §6.4)
    try {
      await this.ensureRemoteParent(relPath);
      const putResult = await this.helperFs.putFile(relPath, localAbsPath, {
        signal: this.abortController.signal,
      });

      // Obtain remote mtimeMs after upload
      let remoteMtimeMs = Math.round(localStat.mtimeMs);
      try {
        const afterStats = await this.helperFs.stat([relPath]);
        if (afterStats[0]?.mtimeMs !== undefined) {
          remoteMtimeMs = afterStats[0].mtimeMs;
        }
      } catch {
        // Use local mtimeMs as fallback if stat query fails
      }

      const newBaseline: MirrorBaselineEntry = {
        relPath,
        size: putResult.size,
        mtimeMs: remoteMtimeMs,
        sha256: putResult.sha256,
        syncedAt: Date.now(),
      };

      await this.host.call("mirror.baseline.entry.upsert", {
        projectId: this.projectId,
        entry: newBaseline,
      });

      this.baselineMap.set(relPath, newBaseline);
      this.conflicts.delete(relPath);
      this.transferFailures.delete(relPath);
      result.uploaded.push(relPath);
    } catch (error) {
      // Failed transfer is never retried automatically; mark it uncertain (spec 23 §6.2)
      const failure: MirrorTransferFailure = {
        relPath,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { errorCode?: string })?.errorCode ?? "REMOTE_TRANSFER_FAILED",
        uncertain: true,
        timestamp: Date.now(),
      };
      this.transferFailures.set(relPath, failure);
      result.failures.push(failure);
      this.options.onTransferFailure?.(failure);
    }
  }

  /**
   * Creates the remote parent of `relPath` before its upload.
   *
   * The helper replaces a file only inside an existing directory, and a new
   * mirror has none of the project's directories yet. A directory is asked for
   * once per batch together with its ancestors; creation is additive and never
   * removes anything on the host.
   */
  private async ensureRemoteParent(relPath: string): Promise<void> {
    const parent = path.posix.dirname(relPath);
    if (parent === "." || this.ensuredDirectories.has(parent)) return;
    await this.helperFs.mkdirs(parent);
    for (let directory = parent; directory !== "."; directory = path.posix.dirname(directory)) {
      this.ensuredDirectories.add(directory);
    }
  }

  /**
   * Resolves a recorded conflict by user decision (spec 23 §6.2).
   */
  async resolveConflict(
    relPath: string,
    resolution: "keep_local" | "keep_remote" | "skip",
  ): Promise<void> {
    const key = normalizeRelPath(relPath);
    const conflict = this.conflicts.get(key);
    if (!conflict) return;

    if (resolution === "skip") {
      this.conflicts.delete(key);
      return;
    }

    if (resolution === "keep_local") {
      this.conflicts.delete(key);
      // Force upload by enqueuing as modify and syncing
      this.syncQueue.enqueue(key, "modify");
      await this.sync();
      return;
    }

    if (resolution === "keep_remote") {
      this.conflicts.delete(key);
      // Download remote file to local
      const localAbsPath = path.resolve(this.localRoot, key);
      const tempPath = `${localAbsPath}.${Date.now()}.pi-pull`;
      const fileHandle = await fs.promises.open(tempPath, "w");
      try {
        const getResult = await this.helperFs.getFile(key, {
          write: async (chunk: Buffer) => {
            await fileHandle.write(chunk);
          },
        });
        await fileHandle.close();
        await fs.promises.rename(tempPath, localAbsPath);

        const newBaseline: MirrorBaselineEntry = {
          relPath: key,
          size: getResult.size,
          mtimeMs: conflict.remote.mtimeMs ?? Date.now(),
          sha256: getResult.sha256,
          syncedAt: Date.now(),
        };

        await this.host.call("mirror.baseline.entry.upsert", {
          projectId: this.projectId,
          entry: newBaseline,
        });
        this.baselineMap.set(key, newBaseline);
      } catch (error) {
        await fileHandle.close().catch(() => undefined);
        await fs.promises.unlink(tempPath).catch(() => undefined);
        throw error;
      }
    }
  }

  /**
   * Stops watchers, aborts in-flight operations, and clears timers (spec 23 §6).
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stopWatching();
    this.syncQueue.dispose();
    this.abortController.abort();
    this.conflicts.clear();
    this.drifts.clear();
    this.overLimits.clear();
    this.transferFailures.clear();
  }
}
