import {
  COMMAND_CENTER_RECEIPT_TRANSITIONS,
  commandCenterCanonicalJson,
  commandCenterCanonicalPayload,
  commandCenterReceiptBindsRequest,
  parseCommandCenterInterventionRequest,
  parseCommandCenterReceipt,
  type CommandCenterInterventionRequest,
  type CommandCenterReceipt,
  type CommandCenterReceiptStatus,
} from "@pi-desktop/shared";
import {
  bindContextOwner, onContextInvalidated, requireActiveContext,
  type CommandCenterObservationContext,
} from "./context.js";
import type {
  CommandCenterAttemptState, CommandCenterInterventionAttempt, CommandCenterObservationResult,
} from "./types.js";

/** Only used on detached, validated JSON owned by this model. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function settled(status: CommandCenterReceiptStatus): boolean {
  return status === "completed" || status === "rejected" || status === "conflicted" || status === "interrupted";
}

/** Observations may miss intermediate states; they cannot invent a transition. */
function reachable(current: CommandCenterReceiptStatus, next: CommandCenterReceiptStatus): boolean {
  const pending = [...COMMAND_CENTER_RECEIPT_TRANSITIONS[current]];
  const seen = new Set<CommandCenterReceiptStatus>();
  while (pending.length > 0) {
    const status = pending.pop()!;
    if (status === next) return true;
    if (seen.has(status)) continue;
    seen.add(status);
    pending.push(...COMMAND_CENTER_RECEIPT_TRANSITIONS[status]);
  }
  return false;
}

type ActiveState = {
  kind: "active";
  request: CommandCenterInterventionRequest;
  fingerprint: string;
  receipt: CommandCenterReceipt | null;
  observation: "awaiting_receipt" | "current" | "outcome_unknown";
  settled: boolean;
};

function rejected(reason: Extract<CommandCenterObservationResult, { kind: "rejected" }>["reason"]): CommandCenterObservationResult {
  return Object.freeze({ kind: "rejected", reason });
}

class InterventionAttempt implements CommandCenterInterventionAttempt {
  readonly #context: CommandCenterObservationContext;
  #state: ActiveState | Readonly<{ kind: "invalidated" }>;
  #detach: () => void;

  constructor(context: CommandCenterObservationContext, request: CommandCenterInterventionRequest, fingerprint: string) {
    this.#context = context;
    this.#state = freeze({
      kind: "active", request, fingerprint, receipt: null,
      observation: "awaiting_receipt", settled: false,
    });
    this.#detach = onContextInvalidated(context, () => this.dispose());
  }

  getState(): CommandCenterAttemptState {
    return this.#state;
  }

  #checkContext(context: CommandCenterObservationContext): CommandCenterObservationResult | undefined {
    if (context !== this.#context) return rejected("invalid_context");
    if (this.#state.kind === "invalidated") return rejected("context_invalidated");
    return undefined;
  }

  observeReceipt(context: CommandCenterObservationContext, input: unknown): CommandCenterObservationResult {
    const contextFailure = this.#checkContext(context);
    if (contextFailure) return contextFailure;

    let receipt: CommandCenterReceipt;
    try {
      // C1 parsers return their input. Detach and validate that copy before retaining it.
      receipt = parseCommandCenterReceipt(JSON.parse(commandCenterCanonicalJson(parseCommandCenterReceipt(input))));
    } catch {
      return rejected("invalid_receipt");
    }
    // Parsing untrusted input can invoke accessors; recheck before publication.
    const afterParse = this.#checkContext(context);
    if (afterParse) return afterParse;
    const state = this.#state;
    if (state.kind === "invalidated") return rejected("context_invalidated");
    if (!commandCenterReceiptBindsRequest(receipt, state.request)) return rejected("request_mismatch");
    if (receipt.fingerprint !== state.fingerprint) return rejected("fingerprint_mismatch");

    const previous = state.receipt;
    if (previous) {
      if (receipt.revision < previous.revision) return Object.freeze({ kind: "ignored_stale" });
      if (receipt.revision === previous.revision) {
        if (commandCenterCanonicalJson(receipt) !== commandCenterCanonicalJson(previous)) {
          return rejected("inconsistent_revision");
        }
        // A fresh authoritative lookup can confirm the same revision after disconnect.
        this.#state = freeze({ ...state, observation: "current" });
        return Object.freeze({ kind: "duplicate" });
      }
      if (receipt.desiredGoalRevision < previous.desiredGoalRevision ||
          receipt.effectiveGoalRevision < previous.effectiveGoalRevision) {
        return rejected("goal_revision_regression");
      }
      if (!reachable(previous.status, receipt.status)) return rejected("invalid_progression");
    }
    this.#state = freeze({ ...state, receipt, observation: "current", settled: settled(receipt.status) });
    return Object.freeze({ kind: "applied" });
  }

  markDisconnected(context: CommandCenterObservationContext): CommandCenterObservationResult {
    const contextFailure = this.#checkContext(context);
    if (contextFailure) return contextFailure;
    if (this.#state.kind === "invalidated") return rejected("context_invalidated");
    // Durable settlement does not become uncertain merely because a socket closed.
    if (!this.#state.settled) this.#state = freeze({ ...this.#state, observation: "outcome_unknown" });
    return Object.freeze({ kind: "applied" });
  }

  dispose(): void {
    this.#detach();
    this.#state = Object.freeze({ kind: "invalidated" });
  }
}

/**
 * Capture one exact C1 control attempt. This hashes only; it never dispatches.
 * The browser's Web Crypto SHA-256 hashes the shared canonical UTF-8 payload.
 */
export async function createCommandCenterInterventionAttempt(
  context: CommandCenterObservationContext,
  input: unknown,
): Promise<CommandCenterInterventionAttempt> {
  requireActiveContext(context);
  const request = parseCommandCenterInterventionRequest(JSON.parse(commandCenterCanonicalPayload(input)));
  const canonicalPayload = commandCenterCanonicalPayload(request);
  bindContextOwner(context, request);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("COMMAND_CENTER_CLIENT_WEB_CRYPTO_UNAVAILABLE");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonicalPayload));
  requireActiveContext(context);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new InterventionAttempt(context, request, fingerprint);
}
