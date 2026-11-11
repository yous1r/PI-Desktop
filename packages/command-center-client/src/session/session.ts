import {
  onContextInvalidated, requireBoundContext, type CommandCenterObservationContext,
} from "../context.js";
import { createCommandCenterConnectionHealth } from "../health/controller.js";
import type { CommandCenterConnectionHealth, CommandCenterHealthSyncToken } from "../health/types.js";
import { createCommandCenterMonitorReader } from "../monitor/reader.js";
import type { CommandCenterMonitorProjection, CommandCenterMonitorReader } from "../monitor/types.js";
import { createCommandCenterMonitorSummary } from "../summary/model.js";
import type { CommandCenterMonitorSummary, CommandCenterMonitorSummaryLimits } from "../summary/types.js";
import { summaryLimits } from "../summary/validation.js";
import { activeSessionState, closedSessionState } from "./state.js";
import type {
  CommandCenterMonitorSession,
  CommandCenterMonitorSessionApplyResult,
  CommandCenterMonitorSessionOptions,
  CommandCenterMonitorSessionRefreshResult,
  CommandCenterMonitorSessionState,
} from "./types.js";

interface ObservationCycle {
  token?: CommandCenterHealthSyncToken;
}

class MonitorSession implements CommandCenterMonitorSession {
  readonly #context: CommandCenterObservationContext;
  readonly #summaryLimits: Readonly<CommandCenterMonitorSummaryLimits>;
  #reader?: CommandCenterMonitorReader;
  #health?: CommandCenterConnectionHealth;
  #summary?: CommandCenterMonitorSummary;
  #summaryCut?: CommandCenterMonitorProjection;
  #cycle?: ObservationCycle;
  #refresh?: object;
  #closed?: "invalidated" | "disposed";
  #state: CommandCenterMonitorSessionState;
  #detach: () => void;

  constructor(
    context: CommandCenterObservationContext,
    reader: CommandCenterMonitorReader,
    health: CommandCenterConnectionHealth,
    limits: Readonly<CommandCenterMonitorSummaryLimits>,
  ) {
    this.#context = context;
    this.#reader = reader;
    this.#health = health;
    this.#summaryLimits = limits;
    this.#state = activeSessionState(undefined, health.getState(), reader.getState(), null, undefined);
    this.#detach = onContextInvalidated(context, () => this.#close("invalidated"));
  }

  #ensureActive(): boolean {
    if (this.#closed) return false;
    try {
      requireBoundContext(this.#context);
      return true;
    } catch {
      // This factory-bound context can only lose activity; revoke it before exposing child state.
      this.#close("invalidated");
      return false;
    }
  }

  getState(): CommandCenterMonitorSessionState {
    if (!this.#ensureActive()) return this.#state;
    const health = this.#health!.getState();
    // The injected clock can synchronously revoke/dispose the session during this read.
    if (this.#closed) return this.#state;
    this.#state = activeSessionState(this.#state, health, this.#reader!.getState(), this.#summary?.getState() ?? null, this.#summaryCut);
    return this.#state;
  }

  #connect(resume: boolean): CommandCenterHealthSyncToken {
    if (!this.#ensureActive()) throw new Error(`COMMAND_CENTER_CLIENT_SESSION_${this.#closed!.toUpperCase()}`);
    const cycle: ObservationCycle = {};
    this.#cycle = cycle;
    const token = resume ? this.#health!.resume() : this.#health!.connect();
    // Ping/clock/scheduler adapters may reenter connection lifecycle before it returns.
    if (!this.#closed && this.#cycle === cycle) cycle.token = token;
    return token;
  }

  connect(): CommandCenterHealthSyncToken {
    return this.#connect(false);
  }

  resume(): CommandCenterHealthSyncToken {
    return this.#connect(true);
  }

  suspend(): void {
    if (!this.#ensureActive()) return;
    this.#cycle = undefined;
    this.#health!.suspend();
  }

  disconnect(): void {
    if (!this.#ensureActive()) return;
    this.#cycle = undefined;
    this.#health!.disconnect();
  }

  async refresh(): Promise<CommandCenterMonitorSessionRefreshResult> {
    if (!this.#ensureActive()) return Object.freeze({ kind: "cancelled", reason: this.#closed === "invalidated" ? "context_invalidated" : "disposed" });
    const request = {};
    const cycle = this.#cycle;
    const token = cycle?.token;
    this.#refresh = request;
    const result = await this.#reader!.refresh();
    if (this.#closed) return Object.freeze({ kind: "cancelled", reason: this.#closed === "invalidated" ? "context_invalidated" : "disposed" });
    if (this.#refresh !== request) return Object.freeze({ kind: "cancelled", reason: "superseded" });
    this.#refresh = undefined;
    if (result.kind === "failed") {
      this.#summary?.resync();
      return result;
    }
    if (result.kind !== "published") return result;
    let summary: CommandCenterMonitorSummary;
    try {
      summary = createCommandCenterMonitorSummary(this.#context, result.projection, this.#summaryLimits);
    } catch {
      if (this.#closed) return Object.freeze({ kind: "cancelled", reason: this.#closed === "invalidated" ? "context_invalidated" : "disposed" });
      this.#summary?.resync();
      return Object.freeze({ kind: "failed", reason: "summary_rejected" });
    }
    const previous = this.#summary;
    this.#summary = summary;
    this.#summaryCut = result.projection;
    previous?.dispose();
    // A pre-resume/pre-connect read cannot satisfy a later connection's snapshot barrier.
    if (cycle && token && this.#cycle === cycle && cycle.token === token) this.#health!.completeResync(token);
    if (this.#closed) return Object.freeze({ kind: "cancelled", reason: this.#closed === "invalidated" ? "context_invalidated" : "disposed" });
    return result;
  }

  apply(input: unknown): CommandCenterMonitorSessionApplyResult {
    if (!this.#ensureActive()) return Object.freeze({ rejected: this.#closed === "invalidated" ? "context_invalidated" : "disposed" });
    return this.#summary?.apply(input) ?? Object.freeze({ rejected: "not_ready" });
  }

  dispose(): void {
    this.#close("disposed");
  }

  #close(status: "invalidated" | "disposed"): void {
    if (this.#closed) return;
    this.#closed = status;
    this.#cycle = undefined;
    this.#refresh = undefined;
    this.#detach();
    const reader = this.#reader;
    const health = this.#health;
    const summary = this.#summary;
    this.#reader = undefined;
    this.#health = undefined;
    this.#summary = undefined;
    this.#summaryCut = undefined;
    // Publish the cleared owning state before callbacks from child abort/cleanup can reenter.
    this.#state = closedSessionState(status, this.#state.health);
    reader?.dispose();
    summary?.dispose();
    health?.dispose();
    if (health) {
      const terminalHealth = health.getState();
      if (terminalHealth.failure !== this.#state.health.failure || terminalHealth.observerFailed !== this.#state.health.observerFailed) {
        this.#state = closedSessionState(status, terminalHealth);
      }
    }
  }
}

/** Composes existing read-only observation models; no stream, transport or authorization adapter is added. */
export function createCommandCenterMonitorSession(
  context: CommandCenterObservationContext,
  options: CommandCenterMonitorSessionOptions,
): CommandCenterMonitorSession {
  requireBoundContext(context);
  if (!options) throw new TypeError("COMMAND_CENTER_CLIENT_INVALID_SESSION_OPTIONS");
  const limits = summaryLimits(options.limits?.summary);
  let reader: CommandCenterMonitorReader | undefined;
  let health: CommandCenterConnectionHealth | undefined;
  try {
    reader = createCommandCenterMonitorReader(context, options.loadPage, options.limits?.reader);
    health = createCommandCenterConnectionHealth(context, {
      clock: options.clock, scheduler: options.scheduler, ping: options.ping,
      maxPendingPings: options.limits?.maxPendingPings,
    });
    requireBoundContext(context);
    return new MonitorSession(context, reader, health, limits);
  } catch (error) {
    reader?.dispose();
    health?.dispose();
    throw error;
  }
}
