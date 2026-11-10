/**
 * Ownership, admission and activity accounting for the auto-updater (H1).
 *
 * electron-updater owns its own HTTP transport and hands a staged installer to
 * the platform without reporting process exit, so this owner cannot certify
 * closure of either family. The counters therefore stay separate:
 *
 *  - `operations` counts each check, download, cache pass, settings read or
 *    write and awaited external launch from start until the underlying promise
 *    actually settles. A bounded caller wait (`raceWithTimeout`), a dismissal or
 *    an abort never releases a count that the real work still holds.
 *  - `resources` is native intent this controller still holds (an installer
 *    handoff).
 *  - `uncontainedResources` counts handoffs whose closure is unobservable: the
 *    updater transport, the platform installer and an external browser launch.
 *    They do not clear, so the updater family stays an explicit blocker.
 *
 * Attribution is per operation, never one mutable field. `begin()` captures the
 * original owner once and every late continuation consults that immutable
 * guard, so a later entry can never re-point earlier work at a replacement.
 * electron-updater is a single shared emitter, so its events are attributed
 * through the live transport that produced them (`openStream()`); two
 * concurrent transports are reported as explicit ambiguity that refuses
 * effects rather than borrowing the newest owner.
 */
import { ExternalResourceActivity } from "./external-resource-activity";
import type { Logger } from "./logger";

export type UpdaterHandoffActivity = {
  operations: number;
  resources: number;
  uncontainedResources: number;
};

/** False once the original Host generation that admitted the work is replaced. */
export type UpdaterOwnerGuard = () => boolean;

export type UpdaterActivityOptions = {
  /** The shared Desktop admission gate, injected by Main composition. */
  isAdmissionClosed?: () => boolean;
  /** Captured at every entry point; the returned guard is never reassigned. */
  captureOwner?: () => UpdaterOwnerGuard;
  logger: Logger;
};

/** One entry's immutable attribution plus its counted-operation helpers. */
export type UpdaterScope = {
  readonly work: string;
  /** The original owner captured synchronously at entry; never reassigned. */
  readonly owner: UpdaterOwnerGuard;
  /** Gate open and this entry's own original owner still current. */
  current(): boolean;
  /** Throws `HOST_BUSY` when this entry may not start a fresh external effect. */
  assertFresh(): void;
  /** Counts to settlement; used for work that is already underway. */
  track<T>(operation: () => Promise<T>): Promise<T>;
  /** Refuses a fresh transport handoff, records it, then counts to settlement. */
  attemptNative<T>(start: () => Promise<T>): Promise<T>;
  /** Refuses a synchronous native effect (installer handoff) before spawning. */
  attemptNativeEffect(effect: () => void): void;
};

export type UpdaterStream = { close(): void };

export type UpdaterRefusal = "closed" | "replaced" | "unattributed";

const REFUSED = "update work refused while host admission is closed";
const REPLACED = "update work refused after its original host was replaced";

function refusal(message: string): Error {
  return Object.assign(new Error(message), {
    code: "HOST_BUSY",
    errorCode: "HOST_BUSY",
  });
}

export class UpdaterActivity {
  private readonly base: ExternalResourceActivity;
  private readonly options: UpdaterActivityOptions;
  private isSealed = false;
  /** Live electron-updater transports and the owner that started each one. */
  private readonly streams = new Map<number, UpdaterOwnerGuard>();
  private streamSequence = 0;
  private lastStreamOwner: UpdaterOwnerGuard = () => true;
  private ambiguityReported = false;

  constructor(options: UpdaterActivityOptions) {
    this.options = options;
    this.base = new ExternalResourceActivity(
      options.isAdmissionClosed ?? (() => false),
    );
  }

  /** Permanent: set by `dispose()`, it outlives any later gate reopening. */
  sealed(): boolean {
    return this.isSealed;
  }

  gateClosed(): boolean {
    return this.isSealed || this.base.isClosed();
  }

  /**
   * A fresh entry. The owner is captured here, synchronously, and stays bound to
   * this scope for its whole lifetime; no later entry can rebind it.
   */
  begin(work: string): UpdaterScope {
    const owner = this.captureOwnerNow();
    const scope: UpdaterScope = {
      work,
      owner,
      current: () => !this.gateClosed() && this.ownerCurrent(owner),
      assertFresh: () => this.assertFreshOwner(owner),
      track: <T>(operation: () => Promise<T>) => this.base.track(operation),
      attemptNative: <T>(start: () => Promise<T>) => {
        // Revalidated inside the handoff itself: a gate that closed or an owner
        // that was replaced during an await must not reach the transport.
        this.assertFreshOwner(owner);
        this.base.nativeAttempt();
        return this.base.track(start);
      },
      attemptNativeEffect: (effect: () => void) => {
        this.assertFreshOwner(owner);
        this.base.nativeAttempt();
        effect();
      },
    };
    return scope;
  }

  /** A read-only owner snapshot for pushes with no transport operation. */
  captureOwnerNow(): UpdaterOwnerGuard {
    try {
      return this.options.captureOwner?.() ?? (() => true);
    } catch {
      // An unreadable owner cannot authorize anything.
      return () => false;
    }
  }

  ownerCurrent(owner: UpdaterOwnerGuard): boolean {
    try {
      return owner();
    } catch {
      return false;
    }
  }

  /** Renderer pushes may cross a temporary inspection but never a replacement. */
  canPublish(owner: UpdaterOwnerGuard | null): boolean {
    if (this.isSealed || !owner) return false;
    return this.ownerCurrent(owner);
  }

  /** A fresh settings write needs an open gate and the entry's own owner. */
  canPersist(owner: UpdaterOwnerGuard | null): boolean {
    if (this.gateClosed() || !owner) return false;
    return this.ownerCurrent(owner);
  }

  /**
   * Counted work whose count lasts until the underlying promise settles. Used
   * for continuations that were already admitted, such as a queued settings
   * write, so the count covers the queue wait as well as the write.
   */
  track<T>(operation: () => Promise<T>): Promise<T> {
    return this.base.track(operation);
  }

  /**
   * Registers one live electron-updater transport. Its owner is retained until
   * the underlying promise settles, even if the caller already stopped waiting.
   */
  openStream(owner: UpdaterOwnerGuard): UpdaterStream {
    const id = (this.streamSequence += 1);
    this.streams.set(id, owner);
    this.lastStreamOwner = owner;
    this.ambiguityReported = false;
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        if (this.streams.delete(id)) this.ambiguityReported = false;
      },
    };
  }

  /**
   * Owner of the transport that produced a shared-emitter event.
   *
   * One live transport is attributable. Two concurrent transports (a check that
   * outlived its caller's timeout while a new check started) cannot be told
   * apart, so `null` refuses every effect and push instead of switching to the
   * newest entry's owner. With no live transport the most recent one retains
   * authority for its own stragglers.
   */
  eventOwner(): UpdaterOwnerGuard | null {
    if (this.streams.size > 1) {
      if (!this.ambiguityReported) {
        this.ambiguityReported = true;
        this.write("warn", "updater event attribution is ambiguous", {
          data: { work: "shared updater events", streams: this.streams.size },
        });
      }
      return null;
    }
    if (this.streams.size === 1) return [...this.streams.values()][0];
    return this.lastStreamOwner;
  }

  snapshot(resources: number): UpdaterHandoffActivity {
    return this.base.snapshot(resources);
  }

  seal(): void {
    this.isSealed = true;
    this.base.seal();
  }

  /** An expected but diagnosable refusal; no secret or path is logged. */
  refuse(work: string, reason: UpdaterRefusal): void {
    this.write("warn", "update work refused", { data: { work, reason } });
  }

  /** Unexpected late failure; the original caller already stopped waiting. */
  lateFailure(work: string, error: unknown): void {
    this.write("warn", "update work failed after its caller returned", {
      data: { work, detail: String(error) },
    });
  }

  /** Classifies an unexpected failure without reporting a refusal as closure. */
  noteFailure(work: string, error: unknown): void {
    const code = (error as { errorCode?: unknown } | null)?.errorCode;
    if (code === "HOST_BUSY") {
      const replaced =
        error instanceof Error && error.message.includes("replaced");
      this.refuse(work, replaced ? "replaced" : "closed");
      return;
    }
    this.lateFailure(work, error);
  }

  private assertFreshOwner(owner: UpdaterOwnerGuard): void {
    if (this.gateClosed()) throw refusal(REFUSED);
    if (!this.ownerCurrent(owner)) throw refusal(REPLACED);
  }

  private write(
    level: "warn" | "info",
    message: string,
    fields: { data?: unknown },
  ): void {
    try {
      this.options.logger.app("updater", level, message, fields);
    } catch {
      // Logging must never decide whether update work is allowed.
    }
  }
}
