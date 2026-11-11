import {
  onContextInvalidated, requireBoundContext, type CommandCenterObservationContext,
} from "../context.js";
import {
  COMMAND_CENTER_HEALTH_PROBE_INTERVAL_MS,
  COMMAND_CENTER_HEALTH_STALE_AFTER_MS,
  createSyncToken,
  type CommandCenterConnectionHealth,
  type CommandCenterConnectionHealthOptions,
  type CommandCenterConnectionHealthState,
  type CommandCenterHealthFailure,
  type CommandCenterHealthSyncToken,
} from "./types.js";
import { HealthState } from "./state.js";
import { validClockTime, validPingReply } from "./validation.js";

interface Cycle {
  token: CommandCenterHealthSyncToken;
  startedAt: number;
  previousTime?: number;
  nextProbeAt: number;
  synchronized: boolean;
  lastReplyAt: number | null;
}

interface Resources {
  timer?: { cancel: () => void };
  controllers: AbortController[];
}

class ConnectionHealth implements CommandCenterConnectionHealth {
  readonly #context: CommandCenterObservationContext;
  readonly #now: () => number;
  readonly #schedule: CommandCenterConnectionHealthOptions["scheduler"]["schedule"];
  readonly #ping: CommandCenterConnectionHealthOptions["ping"];
  readonly #maxPending: number;
  readonly #pending = new Set<AbortController>();
  readonly #view: HealthState;
  #cycle?: Cycle;
  #timer?: { cancel: () => void };
  #closed?: "invalidated" | "disposed";
  #detach: () => void;

  constructor(context: CommandCenterObservationContext, options: CommandCenterConnectionHealthOptions) {
    this.#context = context;
    this.#view = new HealthState(options.onState);
    this.#now = options.clock.now.bind(options.clock);
    this.#schedule = options.scheduler.schedule.bind(options.scheduler);
    this.#ping = options.ping;
    this.#maxPending = options.maxPendingPings ?? 2;
    this.#detach = onContextInvalidated(context, () => this.#close("invalidated"));
  }

  getState(): CommandCenterConnectionHealthState {
    const cycle = this.#cycle;
    if (cycle) {
      const now = this.#readTime(cycle);
      if (now !== undefined) this.#publish(cycle, now);
    }
    return this.#view.get();
  }

  connect(): CommandCenterHealthSyncToken {
    if (this.#closed) throw new Error(`COMMAND_CENTER_CLIENT_HEALTH_${this.#closed.toUpperCase()}`);
    requireBoundContext(this.#context);
    const cycle: Cycle = {
      token: createSyncToken(), startedAt: 0, nextProbeAt: 0, synchronized: false, lastReplyAt: null,
    };
    const resources = this.#takeResources();
    this.#cycle = cycle;
    const now = this.#readTime(cycle);
    if (now !== undefined) {
      cycle.startedAt = now;
      cycle.nextProbeAt = now;
      this.#view.publish({
        status: "foreground", freshness: "stale", resynchronized: false, lastReplyAtMs: null, failure: null,
      });
    }
    const cleared = this.#cleanup(resources);
    // Observers and abort/cancellation adapters may synchronously change the lifecycle.
    if (!this.#owns(cycle) || now === undefined) return cycle.token;
    if (!cleared) {
      this.#fault(cycle, "scheduler_failed");
      return cycle.token;
    }
    this.#tick(cycle, now);
    return cycle.token;
  }

  resume(): CommandCenterHealthSyncToken {
    return this.connect();
  }

  completeResync(token: CommandCenterHealthSyncToken): boolean {
    const cycle = this.#cycle;
    if (!cycle || cycle.token !== token) return false;
    const now = this.#readTime(cycle);
    if (now === undefined) return false;
    cycle.synchronized = true;
    this.#publish(cycle, now);
    return this.#owns(cycle);
  }

  suspend(): void {
    this.#stop("suspended");
  }

  disconnect(): void {
    this.#stop("disconnected");
  }

  dispose(): void {
    this.#close("disposed");
  }

  #owns(cycle: Cycle): boolean {
    return this.#closed === undefined && this.#cycle === cycle;
  }

  #takeResources(): Resources {
    const resources = { timer: this.#timer, controllers: [...this.#pending] };
    this.#timer = undefined;
    return resources;
  }

  #cleanup(resources: Resources): boolean {
    let cleared = true;
    try { resources.timer?.cancel(); } catch { cleared = false; }
    // Only captured controllers: reentrant callbacks may create a newer cycle.
    for (const controller of resources.controllers) controller.abort();
    return cleared;
  }

  #stop(status: "suspended" | "disconnected"): void {
    if (this.#closed) return;
    const resources = this.#takeResources();
    this.#cycle = undefined;
    this.#view.publish({
      status, freshness: "stale", resynchronized: false, lastReplyAtMs: null, failure: null,
    });
    if (!this.#cleanup(resources) && !this.#cycle && !this.#closed) {
      this.#view.publish({ ...this.#view.get(), failure: "scheduler_failed" });
    }
  }

  #close(status: "invalidated" | "disposed"): void {
    if (this.#closed) return;
    const resources = this.#takeResources();
    this.#closed = status;
    this.#cycle = undefined;
    this.#detach();
    this.#view.close({
      status, freshness: "stale", resynchronized: false, lastReplyAtMs: null, failure: null,
    });
    if (!this.#cleanup(resources)) {
      this.#view.publish({ ...this.#view.get(), failure: "scheduler_failed" });
    }
  }

  #fault(cycle: Cycle, failure: "clock_invalid" | "scheduler_failed"): void {
    if (!this.#owns(cycle)) return;
    const resources = this.#takeResources();
    this.#cycle = undefined;
    this.#view.publish({ ...this.#view.get(), freshness: "stale", resynchronized: false, failure });
    this.#cleanup(resources);
  }

  #readTime(cycle: Cycle): number | undefined {
    let now: number;
    try {
      now = this.#now();
    } catch {
      this.#fault(cycle, "clock_invalid");
      return undefined;
    }
    if (!this.#owns(cycle)) return undefined;
    if (!validClockTime(now, cycle.previousTime)) {
      this.#fault(cycle, "clock_invalid");
      return undefined;
    }
    cycle.previousTime = now;
    return now;
  }

  #publish(cycle: Cycle, now: number, failure: CommandCenterHealthFailure | null = this.#view.get().failure): void {
    if (!this.#owns(cycle)) return;
    const timedOut = now - (cycle.lastReplyAt ?? cycle.startedAt) >= COMMAND_CENTER_HEALTH_STALE_AFTER_MS;
    this.#view.publish({
      status: "foreground",
      freshness: cycle.synchronized && cycle.lastReplyAt !== null && !timedOut ? "fresh" : "stale",
      resynchronized: cycle.synchronized,
      lastReplyAtMs: cycle.lastReplyAt,
      failure: timedOut && failure === null ? "reply_timeout" : failure,
    });
  }

  #tick(cycle: Cycle, now: number): void {
    if (!this.#owns(cycle)) return;
    this.#publish(cycle, now);
    if (!this.#owns(cycle)) return;
    if (now >= cycle.nextProbeAt) {
      // Delayed timers send one probe, never a burst of catch-up probes.
      cycle.nextProbeAt = now + COMMAND_CENTER_HEALTH_PROBE_INTERVAL_MS;
      if (this.#pending.size >= this.#maxPending) this.#publish(cycle, now, "pending_limit");
      else this.#startPing(cycle);
    }
    if (this.#owns(cycle)) this.#arm(cycle, now);
  }

  #arm(cycle: Cycle, now: number): void {
    if (!this.#owns(cycle)) return;
    const previous = this.#timer;
    this.#timer = undefined;
    try { previous?.cancel(); } catch {
      this.#fault(cycle, "scheduler_failed");
      return;
    }
    if (!this.#owns(cycle)) return;
    const deadline = (cycle.lastReplyAt ?? cycle.startedAt) + COMMAND_CENTER_HEALTH_STALE_AFTER_MS;
    const due = deadline > now ? Math.min(cycle.nextProbeAt, deadline) : cycle.nextProbeAt;
    const timer = { cancel: () => {} };
    this.#timer = timer;
    let returned = false;
    let synchronous = false;
    try {
      const cancel = this.#schedule(Math.max(0, due - now), () => {
        if (!returned) { synchronous = true; return; }
        if (this.#timer !== timer || !this.#owns(cycle)) return;
        this.#timer = undefined;
        const current = this.#readTime(cycle);
        if (current !== undefined) this.#tick(cycle, current);
      });
      returned = true;
      if (typeof cancel !== "function") throw new Error("Invalid scheduler cancellation");
      timer.cancel = cancel;
      if (synchronous || !this.#owns(cycle) || this.#timer !== timer) {
        cancel();
        if (this.#owns(cycle)) this.#fault(cycle, "scheduler_failed");
      }
    } catch {
      returned = true;
      this.#fault(cycle, "scheduler_failed");
    }
  }

  #startPing(cycle: Cycle): void {
    if (!this.#owns(cycle)) return;
    const controller = new AbortController();
    this.#pending.add(controller);
    void this.#observePing(cycle, controller);
  }

  async #observePing(cycle: Cycle, controller: AbortController): Promise<void> {
    let input: unknown;
    try {
      input = await this.#ping(controller.signal);
    } catch {
      if (this.#owns(cycle)) {
        const now = this.#readTime(cycle);
        if (now !== undefined) this.#publish(cycle, now, "ping_failed");
      }
      return;
    } finally {
      this.#pending.delete(controller);
    }
    if (!this.#owns(cycle)) return;
    let valid = false;
    try {
      valid = validPingReply(input);
    } catch {
      // A throwing accessor is malformed boundary data, never a transport diagnostic.
    }
    if (!this.#owns(cycle)) return;
    const now = this.#readTime(cycle);
    if (now === undefined) return;
    if (!valid) {
      this.#publish(cycle, now, "invalid_reply");
      return;
    }
    cycle.lastReplyAt = now;
    this.#publish(cycle, now, null);
    if (this.#owns(cycle)) this.#arm(cycle, now);
  }
}

/** One controller per authenticated connection; no transport, runtime status or authorization inference. */
export function createCommandCenterConnectionHealth(
  context: CommandCenterObservationContext,
  options: CommandCenterConnectionHealthOptions,
): CommandCenterConnectionHealth {
  requireBoundContext(context);
  if (!options || typeof options.clock?.now !== "function" || typeof options.scheduler?.schedule !== "function" ||
      typeof options.ping !== "function" || !Number.isInteger(options.maxPendingPings ?? 2) ||
      (options.maxPendingPings ?? 2) < 1 || (options.maxPendingPings ?? 2) > 2 ||
      (options.onState !== undefined && typeof options.onState !== "function")) {
    throw new TypeError("COMMAND_CENTER_CLIENT_INVALID_HEALTH_OPTIONS");
  }
  return new ConnectionHealth(context, options);
}
