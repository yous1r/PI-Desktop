import { commandCenterTaskKey } from "@pi-desktop/shared";
import {
  onContextInvalidated, requireBoundContext, type CommandCenterObservationContext,
} from "../context.js";
import type {
  CommandCenterMonitorSummary,
  CommandCenterMonitorSummaryApplyResult,
  CommandCenterMonitorSummaryLimits,
  CommandCenterMonitorSummaryResyncReason,
  CommandCenterMonitorSummaryState,
} from "./types.js";
import { freeze, initialSummary, parseChange, summaryLimits, type InitialSummary, type StoredRow } from "./validation.js";

class MonitorSummary implements CommandCenterMonitorSummary {
  readonly #limits: Readonly<CommandCenterMonitorSummaryLimits>;
  #rows: Map<string, StoredRow>;
  #bytes: number;
  #state: CommandCenterMonitorSummaryState;
  #detach: () => void;

  constructor(context: CommandCenterObservationContext, initial: InitialSummary, limits: Readonly<CommandCenterMonitorSummaryLimits>) {
    this.#limits = limits;
    this.#rows = initial.rows;
    this.#bytes = initial.bytes;
    this.#state = Object.freeze({ status: "ready", projection: initial.projection });
    this.#detach = onContextInvalidated(context, () => this.#close("invalidated"));
  }

  getState(): CommandCenterMonitorSummaryState {
    return this.#state;
  }

  #closedResult(): CommandCenterMonitorSummaryApplyResult | undefined {
    if (this.#state.status === "invalidated") return Object.freeze({ rejected: "context_invalidated" });
    if (this.#state.status === "disposed") return Object.freeze({ rejected: "disposed" });
    return undefined;
  }

  apply(input: unknown): CommandCenterMonitorSummaryApplyResult {
    const closed = this.#closedResult();
    if (closed) return closed;
    const original = this.#state;
    let change: ReturnType<typeof parseChange>;
    try {
      change = parseChange(input);
    } catch {
      const afterFailure = this.#closedResult();
      return afterFailure ?? Object.freeze({ rejected: "invalid_change" });
    }
    // Input accessors may revoke/dispose or reenter apply/resync while validating.
    const afterParse = this.#closedResult();
    if (afterParse) return afterParse;
    if (this.#state !== original) return Object.freeze({ rejected: "state_changed" });
    const state = this.#state;
    if (state.projection === null) return Object.freeze({ rejected: state.status === "disposed" ? "disposed" : "context_invalidated" });
    if (state.status === "resync_required") return Object.freeze({ resync: state.reason });
    const cursor = state.projection.cursor;
    if (change.cursor.epoch !== cursor.epoch) return this.#resync("epoch_mismatch");
    if (change.cursor.sequence <= cursor.sequence) return "duplicate";
    if (change.cursor.sequence !== cursor.sequence + 1) return this.#resync("sequence_gap");
    if (change.type === "resync") return this.#resync("source_resync");

    const key = commandCenterTaskKey(change.type === "upsert" ? change.stored.row.target : change.target);
    const previous = this.#rows.get(key);
    let nextBytes = this.#bytes - (previous?.bytes ?? 0);
    if (change.type === "upsert") {
      if (!previous && this.#rows.size === this.#limits.maxRows) return this.#resync("row_limit");
      nextBytes += change.stored.bytes;
      if (nextBytes > this.#limits.maxBytes) return this.#resync("byte_limit");
    }
    const rows = new Map(this.#rows);
    if (change.type === "upsert") rows.set(key, change.stored);
    else rows.delete(key);
    const projection = freeze({
      cursor: change.cursor,
      generatedAt: state.projection.generatedAt,
      rows: [...rows.values()].map(({ row }) => row),
    });
    this.#rows = rows;
    this.#bytes = nextBytes;
    this.#state = Object.freeze({ status: "ready", projection });
    return "applied";
  }

  resync(): void {
    if (this.#state.status === "ready") this.#resync("requested");
  }

  #resync(reason: CommandCenterMonitorSummaryResyncReason): CommandCenterMonitorSummaryApplyResult {
    const state = this.#state;
    if (state.status === "ready") this.#state = Object.freeze({ status: "resync_required", projection: state.projection, reason });
    return Object.freeze({ resync: reason });
  }

  dispose(): void {
    this.#close("disposed");
  }

  #close(status: "invalidated" | "disposed"): void {
    if (this.#state.status === "invalidated" || this.#state.status === "disposed") return;
    this.#detach();
    this.#rows.clear();
    this.#bytes = 0;
    this.#state = Object.freeze({ status, projection: null });
  }
}

/** Ordered local observation only; the adapter still owns authorization, buffering and change provenance. */
export function createCommandCenterMonitorSummary(
  context: CommandCenterObservationContext,
  input: unknown,
  overrides?: Partial<CommandCenterMonitorSummaryLimits>,
): CommandCenterMonitorSummary {
  requireBoundContext(context);
  const limits = summaryLimits(overrides);
  let initial: InitialSummary;
  try {
    initial = initialSummary(input, limits);
  } catch {
    requireBoundContext(context);
    throw new Error("COMMAND_CENTER_CLIENT_INVALID_INITIAL_PROJECTION");
  }
  requireBoundContext(context);
  return new MonitorSummary(context, initial, limits);
}
