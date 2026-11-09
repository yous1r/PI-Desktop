import type { ModeTurnOrigin } from "@pi-desktop/shared";
import type { ModeTurnNotice } from "./mode-runs";

export type ModeRunOwner = {
  host: { call<T = unknown>(method: string, params?: unknown): Promise<T> };
  startContinuation(sessionId: string, origin: Exclude<ModeTurnOrigin, "user">, content: string): Promise<unknown>;
  abortTurn(sessionId: string, turnId: string): Promise<void>;
  notifyTurn(sessionId: string, turnId: string, notice: ModeTurnNotice): Promise<void>;
};

export type ModeRunLifetimeDeps = {
  getOwner(): ModeRunOwner | null;
  isAdmissionClosed(): boolean;
  isQuitting(): boolean;
  warn(sessionId: string, error: unknown): void;
};

const failure = (errorCode: string) => Object.assign(new Error(errorCode), { errorCode });

/** Counts original operations, including timers and retired-owner work. It is
 * not a second mode-run ledger; Rust owns claims and all durable transitions. */
export class ModeRunLifetime {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly continuations = new Map<string, { timer?: ReturnType<typeof setTimeout>; cancel(): void }>();
  private sealed = false;
  private uncertain = false;

  constructor(private readonly deps: ModeRunLifetimeDeps) {}

  capture(): ModeRunOwner {
    if (this.closed()) throw failure("HOST_BUSY");
    const owner = this.deps.getOwner();
    if (!owner) throw failure("HOST_UNAVAILABLE");
    return owner;
  }

  assertCurrent(owner: ModeRunOwner): void {
    if (this.deps.getOwner() !== owner) throw failure("HOST_DISCONNECTED");
    if (this.closed()) throw failure("HOST_BUSY");
  }

  track<T>(operation: () => T | Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    try { resolve(operation()); } catch (error) { reject(error); }
    return promise;
  }

  markUncertain(): void { this.uncertain = true; }

  schedule(owner: ModeRunOwner, sessionId: string, origin: Exclude<ModeTurnOrigin, "user">, content: string): void {
    if (this.closed() || this.deps.getOwner() !== owner || this.continuations.has(sessionId)) return;
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const entry = { timer: undefined as ReturnType<typeof setTimeout> | undefined, cancel: finish };
    this.continuations.set(sessionId, entry);
    void this.track(() => completion).then(() => {
      if (this.continuations.get(sessionId) === entry) this.continuations.delete(sessionId);
    });
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void (async () => {
        try {
          if (this.closed() || this.deps.getOwner() !== owner) return;
          await owner.startContinuation(sessionId, origin, content);
        } catch (error) {
          // An ordinary competing user turn may win admission. Preserve the
          // existing diagnostic without letting a throwing observer hide work.
          try { this.deps.warn(sessionId, error); } catch { this.markUncertain(); }
        } finally { finish(); }
      })();
    }, 0);
  }

  snapshot(turns: number) {
    return { operations: this.pending.size, turns, queuedTurns: this.continuations.size,
      uncontainedResources: this.uncertain ? 1 : 0 };
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async dispose(): Promise<void> {
    this.sealed = true;
    for (const entry of this.continuations.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.cancel();
      }
    }
    await this.drain();
  }

  private closed(): boolean { return this.sealed || this.deps.isQuitting() || this.deps.isAdmissionClosed(); }
}
