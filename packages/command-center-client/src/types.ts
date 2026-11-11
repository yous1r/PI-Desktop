import type { CommandCenterInterventionRequest, CommandCenterReceipt } from "@pi-desktop/shared";
import type { CommandCenterObservationContext } from "./context.js";

export type CommandCenterReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: CommandCenterReadonly<T[Key]> }
  : T;

/** Local observation freshness never overwrites the authoritative receipt. */
export type CommandCenterAttemptState = CommandCenterReadonly<{
  kind: "active";
  request: CommandCenterInterventionRequest;
  fingerprint: string;
  receipt: CommandCenterReceipt | null;
  observation: "awaiting_receipt" | "current" | "outcome_unknown";
  /** Only completed, rejected, conflicted and interrupted are settled. */
  settled: boolean;
}> | Readonly<{ kind: "invalidated" }>;

/** Local model results; these are not protocol error/detail codes. */
export type CommandCenterObservationResult =
  | Readonly<{ kind: "applied" | "duplicate" | "ignored_stale" }>
  | Readonly<{
    kind: "rejected";
    reason: "invalid_context" | "context_invalidated" | "invalid_receipt" |
      "request_mismatch" | "fingerprint_mismatch" | "inconsistent_revision" |
      "goal_revision_regression" | "invalid_progression";
  }>;

export interface CommandCenterInterventionAttempt {
  /** Deeply frozen snapshots; callers discard earlier snapshots on scope change. */
  getState(): CommandCenterAttemptState;
  /** The adapter must supply the context captured before starting its async read. */
  observeReceipt(context: CommandCenterObservationContext, receipt: unknown): CommandCenterObservationResult;
  /** Mark local uncertainty without modifying the last authoritative receipt. */
  markDisconnected(context: CommandCenterObservationContext): CommandCenterObservationResult;
  /** Clear this model and detach it from its context. Does not stop Host work. */
  dispose(): void;
}
