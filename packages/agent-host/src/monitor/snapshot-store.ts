import { createHash } from "node:crypto";
import { parseCommandCenterMonitorSnapshot, type CommandCenterMonitorSnapshot } from "@pi-desktop/shared";
import type { Clock } from "../ports.js";
import { buildSnapshotGeneration, type SnapshotGeneration } from "./generation.js";
import {
  MonitorSnapshotCaptureError,
  snapshotLimits,
  type MonitorSnapshotCapture,
  type MonitorSnapshotLimits,
  type MonitorSnapshotOptions,
  type MonitorSnapshotPageRequest,
  type MonitorSnapshotPageResult,
} from "./types.js";

export { MONITOR_SNAPSHOT_LIMITS, MonitorSnapshotCaptureError } from "./types.js";
export type {
  MonitorSnapshotCapture, MonitorSnapshotCaptureFailure, MonitorSnapshotLimits,
  MonitorSnapshotOptions, MonitorSnapshotPageRequest, MonitorSnapshotPageResult,
} from "./types.js";

function validScope(scopeKey: string): boolean {
  return typeof scopeKey === "string" && scopeKey.length > 0 && scopeKey.length <= 512 && !scopeKey.includes("\0");
}

/**
 * Internal, synchronous snapshot pagination over authoritative C1 rows.
 *
 * The caller supplies a consistent source cut, sequence and trusted scopeKey
 * containing the authorization generation and filter identity. This class does
 * not authorize rows, collect workspace/goal facts, or open an event stream.
 *
 * Retention is FIFO by capture, never renewed by reads. Budgets include every
 * retained page's UTF-8 JSON, scope key and token-index keys. Row/generation/token
 * counts separately bound object overhead; these are not heap measurements.
 * A staged capture uses at most another generation's bounded rows/pages. Expired
 * entries are reclaimed on the next operation; no timers or external resources.
 */
export class MonitorSnapshotStore {
  readonly epoch: string;
  private readonly clock: Clock;
  private readonly tokens: MonitorSnapshotOptions["tokens"];
  private readonly limits: Readonly<MonitorSnapshotLimits>;
  private readonly generations = new Map<number, SnapshotGeneration>();
  private readonly pages = new Map<string, { generation: SnapshotGeneration; index: number }>();
  private retainedRows = 0;
  private retainedBytes = 0;
  private serial = 0;
  private lastNow = 0;
  private lifecycle = 0;
  private capturing = false;
  private disposed = false;

  constructor(options: MonitorSnapshotOptions) {
    this.epoch = options.epoch;
    this.clock = options.clock;
    this.tokens = options.tokens;
    this.limits = snapshotLimits(options.limits);
    parseCommandCenterMonitorSnapshot({
      version: 1, cursor: { epoch: this.epoch, sequence: 0 }, generatedAt: "2000-01-01T00:00:00.000Z", rows: [],
    });
  }

  /** Throws on invalid/incomplete capture; existing generations survive failure. */
  capture(request: MonitorSnapshotCapture): CommandCenterMonitorSnapshot {
    if (this.disposed) throw new MonitorSnapshotCaptureError("disposed");
    if (this.capturing) throw new MonitorSnapshotCaptureError("capture_in_progress");
    const { scopeKey, sequence, rows } = request;
    if (!validScope(scopeKey)) throw new MonitorSnapshotCaptureError("invalid_scope");
    if (this.serial === Number.MAX_SAFE_INTEGER) throw new MonitorSnapshotCaptureError("generation_exhausted");
    this.capturing = true;
    // Never reuse a generation number, including after a failed capture/eviction.
    const serial = ++this.serial;
    const lifecycle = this.lifecycle;
    const issued = new Set<string>();
    let tokenIndex = 0;
    try {
      const now = this.now();
      const generation = buildSnapshotGeneration({
        scopeKey, epoch: this.epoch, sequence, now, rows, limits: this.limits,
        nextToken: () => {
          const entropy = this.tokens.next();
          if (typeof entropy !== "string" || !entropy.length || entropy.length > 512 || entropy.includes("\0")) {
            throw new MonitorSnapshotCaptureError("invalid_token_source");
          }
          // Opaque fixed-size handles bind boot, scope, generation and page. The
          // serial prevents an old handle aliasing a new generation even when a
          // faulty entropy source repeats after eviction; no tombstones grow.
          const token = createHash("sha256")
            .update(JSON.stringify([this.epoch, scopeKey, serial, tokenIndex++, entropy]))
            .digest("hex");
          if (issued.has(token) || this.pages.has(token)) throw new MonitorSnapshotCaptureError("invalid_token_source");
          issued.add(token);
          return token;
        },
      });
      const committedAt = this.now();
      if (this.disposed) throw new MonitorSnapshotCaptureError("disposed");
      if (lifecycle !== this.lifecycle) throw new MonitorSnapshotCaptureError("invalidated");
      if (committedAt >= generation.expiresAt) throw new MonitorSnapshotCaptureError("expired");
      const first = parseCommandCenterMonitorSnapshot(JSON.parse(generation.pages[0].json));
      // Everything that can fail is staged before eviction or publication.
      this.expire(committedAt);
      if (generation.pages.length === 1) return first;
      while (this.generations.size >= this.limits.maxGenerations ||
          this.retainedRows + generation.rows > this.limits.maxRows ||
          this.retainedBytes + generation.bytes > this.limits.maxBytes ||
          this.pages.size + issued.size > this.limits.maxTokens) {
        const oldest = this.generations.keys().next().value;
        if (oldest === undefined) throw new Error("Invalid monitor snapshot retention accounting");
        this.remove(oldest);
      }
      this.generations.set(serial, generation);
      this.retainedRows += generation.rows;
      this.retainedBytes += generation.bytes;
      generation.pages.forEach((page, index) => {
        if (page.token !== undefined) this.pages.set(page.token, { generation, index });
      });
      return first;
    } finally {
      this.capturing = false;
    }
  }

  /** A missing handle always requires restart; no fallback to a newer capture. */
  page({ scopeKey, epoch, token }: MonitorSnapshotPageRequest): MonitorSnapshotPageResult {
    if (this.disposed) return { status: "resync", reason: "disposed" };
    if (epoch !== this.epoch) return { status: "resync", reason: "epoch" };
    if (!validScope(scopeKey)) return { status: "resync", reason: "scope" };
    this.expire(this.now());
    const entry = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? this.pages.get(token) : undefined;
    if (!entry) return { status: "resync", reason: "expired_or_evicted" };
    if (entry.generation.scopeKey !== scopeKey) return { status: "resync", reason: "scope" };
    // Stored strings are immutable; every response has fresh nested objects.
    return { status: "page", snapshot: parseCommandCenterMonitorSnapshot(JSON.parse(entry.generation.pages[entry.index].json)) };
  }

  /** Call when access/filter generation changes or its owning connection closes. */
  discardScope(scopeKey: string): void {
    this.lifecycle += 1;
    for (const [id, generation] of this.generations) {
      if (generation.scopeKey === scopeKey) this.remove(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycle += 1;
    this.generations.clear();
    this.pages.clear();
    this.retainedRows = 0;
    this.retainedBytes = 0;
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - this.limits.maxAgeMs) {
      throw new RangeError("Invalid monitor snapshot clock");
    }
    // A clock adjustment must not resurrect a generation or renew its lifetime.
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }

  private expire(now: number): void {
    for (const [id, generation] of this.generations) {
      if (now >= generation.expiresAt) this.remove(id);
    }
  }

  private remove(id: number): void {
    const generation = this.generations.get(id);
    if (!generation) return;
    this.generations.delete(id);
    this.retainedRows -= generation.rows;
    this.retainedBytes -= generation.bytes;
    for (const page of generation.pages) {
      if (page.token !== undefined) this.pages.delete(page.token);
    }
  }
}
