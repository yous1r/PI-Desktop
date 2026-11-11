import type { CommandCenterConnectionHealthState } from "./types.js";

type StateFields = Omit<CommandCenterConnectionHealthState, "observerFailed">;

/** One trusted observer, stable immutable snapshots, and bounded diagnostic data. */
export class HealthState {
  #current: CommandCenterConnectionHealthState = Object.freeze({
    status: "disconnected", freshness: "stale", resynchronized: false,
    lastReplyAtMs: null, failure: null, observerFailed: false,
  });
  #observer?: (state: CommandCenterConnectionHealthState) => void;
  #notifying = false;
  #pending = false;
  #closing = false;

  constructor(observer?: (state: CommandCenterConnectionHealthState) => void) {
    this.#observer = observer;
  }

  get(): CommandCenterConnectionHealthState {
    return this.#current;
  }

  publish(fields: StateFields): void {
    const next = { ...fields, observerFailed: this.#current.observerFailed };
    if (next.status === this.#current.status && next.freshness === this.#current.freshness &&
        next.resynchronized === this.#current.resynchronized && next.lastReplyAtMs === this.#current.lastReplyAtMs &&
        next.failure === this.#current.failure) return;
    this.#current = Object.freeze(next);
    this.#pending = true;
    if (this.#notifying) return;
    this.#notifying = true;
    try {
      while (this.#pending && this.#observer) {
        this.#pending = false;
        try {
          this.#observer(this.#current);
        } catch {
          this.#observer = undefined;
          this.#current = Object.freeze({ ...this.#current, observerFailed: true });
        }
      }
    } finally {
      this.#notifying = false;
      if (this.#closing) this.clearObserver();
    }
  }

  close(fields: StateFields): void {
    this.#closing = true;
    this.publish(fields);
    if (!this.#notifying) this.clearObserver();
  }

  private clearObserver(): void {
    this.#observer = undefined;
    this.#pending = false;
  }
}
