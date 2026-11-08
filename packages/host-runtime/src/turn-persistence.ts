import { ErrorCodes, type MessageUsage, type UiMessage } from "@pi-desktop/shared";

import type { HostRpc } from "./host-ports.js";

export type TurnPersistenceLogger = (
  level: "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type MessageAppend = {
  sessionId: string;
  message?: UiMessage;
  usage?: MessageUsage;
  turnId?: string;
};

type HostAvailability = HostRpc & { isAvailable?(): boolean };

/** Bounded wait between retries while host-core is restarting. */
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000] as const;

function isHostUnavailable(error: unknown): boolean {
  return (error as { errorCode?: string } | null)?.errorCode === ErrorCodes.HOST_UNAVAILABLE;
}

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/**
 * Transcript appends for the headless Host. Rows of one session are written
 * in order, a write that only failed because host-core was restarting is
 * retried with a bounded backoff, and a duplicate message id counts as
 * written (the host already has the row). The queue is process memory: the
 * desktop keeps a file-backed outbox because a window can close mid-turn,
 * whereas a `pi-host` process ends only with its supervisor.
 */
export class TurnPersistence {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly turns = new Map<string, { turnId: string; error?: Error }>();
  private pendingCount = 0;
  private disposed = false;

  constructor(
    private readonly deps: {
      getHost: () => HostAvailability | null;
      log: TurnPersistenceLogger;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** Number of appends not yet acknowledged by host-core. */
  size(): number {
    return this.pendingCount;
  }

  beginTurn(sessionId: string, turnId: string): void {
    this.turns.set(sessionId, { turnId });
  }

  /** Drain this session and surface any failure belonging to the owning turn. */
  async flushTurn(sessionId: string, turnId: string): Promise<void> {
    const turn = this.turns.get(sessionId);
    while (this.chains.has(sessionId)) await this.chains.get(sessionId);
    if (turn?.turnId !== turnId) return;
    if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
    if (turn.error) throw turn.error;
  }

  /** Queue in session order; failures also remain observable at the turn barrier. */
  append(entry: MessageAppend, beforeWrite?: Promise<void>): Promise<void> {
    this.pendingCount += 1;
    const previous = this.chains.get(entry.sessionId) ?? Promise.resolve();
    const run = previous.then(async () => {
      await beforeWrite;
      await this.write(entry);
    }).finally(() => { this.pendingCount -= 1; });
    // Observe failures immediately, including fire-and-forget event ingress.
    // Continue the chain so a failed row never discards subsequent rows.
    const observed = run.catch((error: unknown) => {
      const turn = this.turns.get(entry.sessionId);
      if (turn && turn.turnId === entry.turnId) {
        turn.error ??= error instanceof Error ? error : new Error(String(error));
      }
      this.deps.log("warn", "transcript append failed", {
        sessionId: entry.sessionId, messageId: entry.message?.id, error: String(error),
      });
    }).finally(() => {
      if (this.chains.get(entry.sessionId) === observed) this.chains.delete(entry.sessionId);
    });
    this.chains.set(entry.sessionId, observed);
    return run;
  }

  /** Wait until every queued append has been attempted. */
  async flush(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async write(entry: MessageAppend): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.disposed) throw Object.assign(new Error("transcript persistence disposed"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
      const host = this.deps.getHost();
      if (host && (host.isAvailable?.() ?? true)) {
        try {
          await host.call(entry.usage ? "session.recordUsage" : "session.appendMessage", {
            sessionId: entry.sessionId,
            ...(entry.usage ? { usage: entry.usage } : { message: entry.message }),
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
          });
          return;
        } catch (error) {
          if (isDuplicateMessageIdError(error)) return;
          if (!isHostUnavailable(error)) throw error;
        }
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      if (attempt >= RETRY_DELAYS_MS.length * 2) {
        throw Object.assign(new Error("transcript append abandoned: host unavailable"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
      }
      await (this.deps.sleep ?? defaultSleep)(delay);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
