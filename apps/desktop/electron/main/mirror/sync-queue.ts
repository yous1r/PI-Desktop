/**
 * Pure path-coalescing queue for remote mirror synchronization (spec 23 §6.1 / §6.2).
 *
 * Coalesces rapid filesystem bursts per relative path (debounce ~300-500ms) into
 * a consolidated pending set before transfer. Handles create, modify, delete,
 * and rename transitions without any file system or network I/O.
 */

export type SyncChangeType = "create" | "modify" | "delete" | "rename";

export type PendingSyncEntry = {
  path: string;
  type: SyncChangeType;
  oldPath?: string;
  timestamp: number;
};

export type SyncQueueClock = {
  setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeout: (timer: NodeJS.Timeout | number) => void;
  now?: () => number;
};

export type SyncQueueOptions = {
  /** Debounce delay before automatic flush in milliseconds. Defaults to 400ms (~300-500ms). */
  debounceMs?: number;
  /** Maximum wait time in milliseconds before pending changes must be flushed. */
  maxWaitMs?: number;
  /** Pluggable clock for deterministic timer testing. */
  clock?: SyncQueueClock;
  /** Invoked with the coalesced batch when debounce expires. */
  onFlush?: (entries: PendingSyncEntry[]) => void | Promise<void>;
};

export function normalizeQueuePath(value: string): string {
  if (!value) return "";
  let normalized = value.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+|\/+$/g, "");
  return normalized;
}

export class PathCoalescingQueue {
  private readonly pending = new Map<string, PendingSyncEntry>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly clock: SyncQueueClock;
  private readonly onFlush?: (entries: PendingSyncEntry[]) => void | Promise<void>;

  private debounceTimer: NodeJS.Timeout | number | null = null;
  private firstEventTimestamp: number | null = null;
  private isDisposed = false;

  constructor(options: SyncQueueOptions = {}) {
    this.debounceMs = options.debounceMs ?? 400;
    this.maxWaitMs = options.maxWaitMs ?? 2_000;
    this.clock = options.clock ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
      now: () => Date.now(),
    };
    this.onFlush = options.onFlush;
  }

  get size(): number {
    return this.pending.size;
  }

  get isPending(): boolean {
    return this.pending.size > 0;
  }

  has(relPath: string): boolean {
    const key = normalizeQueuePath(relPath);
    return this.pending.has(key);
  }

  get(relPath: string): PendingSyncEntry | undefined {
    const key = normalizeQueuePath(relPath);
    return this.pending.get(key);
  }

  remove(relPath: string): boolean {
    const key = normalizeQueuePath(relPath);
    const deleted = this.pending.delete(key);
    if (this.pending.size === 0) {
      this.clearDebounceTimer();
    }
    return deleted;
  }

  /**
   * Enqueues a filesystem change and coalesces it with existing pending state for the path.
   */
  enqueue(path: string, type: SyncChangeType, oldPath?: string): void {
    if (this.isDisposed) return;
    const targetPath = normalizeQueuePath(path);
    if (!targetPath) return;

    const now = this.clock.now ? this.clock.now() : Date.now();

    if (type === "rename" && oldPath) {
      this.handleRename(oldPath, targetPath, now);
    } else {
      this.handleSingleChange(targetPath, type, now);
    }

    this.scheduleDebounce(now);
  }

  enqueueCreate(path: string): void {
    this.enqueue(path, "create");
  }

  enqueueModify(path: string): void {
    this.enqueue(path, "modify");
  }

  enqueueDelete(path: string): void {
    this.enqueue(path, "delete");
  }

  enqueueRename(oldPath: string, newPath: string): void {
    this.enqueue(newPath, "rename", oldPath);
  }

  private handleSingleChange(path: string, type: SyncChangeType, timestamp: number): void {
    const existing = this.pending.get(path);

    if (!existing) {
      this.pending.set(path, { path, type, timestamp });
      return;
    }

    switch (existing.type) {
      case "create": {
        if (type === "delete") {
          // Created then deleted locally before sync: cancel completely.
          this.pending.delete(path);
        } else {
          // "modify" or redundant "create" remains "create"
          existing.timestamp = timestamp;
        }
        break;
      }

      case "modify": {
        if (type === "delete") {
          existing.type = "delete";
          existing.timestamp = timestamp;
        } else {
          // redundant "modify" or "create"
          existing.timestamp = timestamp;
        }
        break;
      }

      case "delete": {
        if (type === "create" || type === "modify") {
          // File was deleted then re-created: needs modify/upload
          existing.type = "modify";
          existing.timestamp = timestamp;
        } else {
          existing.timestamp = timestamp;
        }
        break;
      }

      case "rename": {
        if (type === "delete") {
          // The newly renamed file was deleted
          this.pending.delete(path);
        } else {
          existing.timestamp = timestamp;
        }
        break;
      }
    }
  }

  private handleRename(oldPath: string, newPath: string, timestamp: number): void {
    const targetOld = normalizeQueuePath(oldPath);
    const existingOld = this.pending.get(targetOld);

    if (existingOld && existingOld.type === "create") {
      // oldPath was freshly created locally, now renamed before sync:
      // Drop oldPath, newPath becomes "create".
      this.pending.delete(targetOld);
      this.handleSingleChange(newPath, "create", timestamp);
      return;
    }

    // Old path is now locally deleted (which will report drift without deleting remote)
    this.handleSingleChange(targetOld, "delete", timestamp);
    // New path is uploaded
    this.handleSingleChange(newPath, "create", timestamp);
  }

  private scheduleDebounce(now: number): void {
    if (this.pending.size === 0) {
      this.clearDebounceTimer();
      return;
    }

    if (this.firstEventTimestamp === null) {
      this.firstEventTimestamp = now;
    }

    const elapsed = now - this.firstEventTimestamp;
    const remainingToMax = Math.max(0, this.maxWaitMs - elapsed);
    const wait = Math.min(this.debounceMs, remainingToMax);

    if (this.debounceTimer !== null) {
      this.clock.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      this.firstEventTimestamp = null;
      void this.flush();
    }, wait);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      this.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.firstEventTimestamp = null;
  }

  /**
   * Returns a copy of current pending entries without draining the queue.
   */
  peek(): PendingSyncEntry[] {
    return Array.from(this.pending.values());
  }

  /**
   * Synchronously drains and returns all pending entries, cancelling the debounce timer.
   */
  drain(): PendingSyncEntry[] {
    this.clearDebounceTimer();
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    return entries;
  }

  /**
   * Flushes current pending entries, clears the queue, and invokes onFlush if configured.
   */
  async flush(): Promise<PendingSyncEntry[]> {
    const entries = this.drain();
    if (entries.length > 0 && this.onFlush) {
      await this.onFlush(entries);
    }
    return entries;
  }

  clear(): void {
    this.clearDebounceTimer();
    this.pending.clear();
  }

  dispose(): void {
    this.isDisposed = true;
    this.clear();
  }
}
