const syncTokenBrand: unique symbol = Symbol("CommandCenterHealthSyncToken");

/** Local resynchronization identity; never an authentication or wire token. */
export interface CommandCenterHealthSyncToken {
  readonly [syncTokenBrand]: true;
}

export function createSyncToken(): CommandCenterHealthSyncToken {
  return Object.freeze({ [syncTokenBrand]: true as const });
}

export type CommandCenterHealthFailure =
  | "ping_failed" | "invalid_reply" | "pending_limit" | "reply_timeout"
  | "clock_invalid" | "scheduler_failed";

export type CommandCenterConnectionHealthState = Readonly<{
  status: "foreground" | "suspended" | "disconnected" | "invalidated" | "disposed";
  freshness: "fresh" | "stale";
  resynchronized: boolean;
  /** Local monotonic receive time; the server's timestamp is never used for elapsed time. */
  lastReplyAtMs: number | null;
  failure: CommandCenterHealthFailure | null;
  /** Sticky local diagnostic: a throwing state observer is detached. */
  observerFailed: boolean;
}>;

export interface CommandCenterConnectionHealthOptions {
  clock: { now(): number };
  scheduler: {
    /** Schedule once, after the call returns; return an idempotent cancellation function. */
    schedule(delayMs: number, callback: () => void): () => void;
  };
  /** Authenticated read-only adapter for the existing connection/ping result. */
  ping(signal: AbortSignal): Promise<unknown>;
  /** Count original unsettled promises across cancellation/reconnect. Default and ceiling: 2. */
  maxPendingPings?: number;
  /** Called for real state changes. A throwing observer is detached and observerFailed stays true. */
  onState?(state: CommandCenterConnectionHealthState): void;
}

export interface CommandCenterConnectionHealth {
  getState(): CommandCenterConnectionHealthState;
  /** Start a new foreground observation cycle; the first ping is immediate. */
  connect(): CommandCenterHealthSyncToken;
  /** Same lifecycle as connect; a suspended cycle can never be silently reused. */
  resume(): CommandCenterHealthSyncToken;
  /** Accept completion only for the current cycle. A valid recent ping is also required. */
  completeResync(token: CommandCenterHealthSyncToken): boolean;
  suspend(): void;
  disconnect(): void;
  dispose(): void;
}

export const COMMAND_CENTER_HEALTH_PROBE_INTERVAL_MS = 2_000;
export const COMMAND_CENTER_HEALTH_STALE_AFTER_MS = 6_000;
