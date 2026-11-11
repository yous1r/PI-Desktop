import type {
  CommandCenterAdmissionSnapshot,
  CommandCenterAdmissionState,
  CommandCenterExecutionTarget,
} from "@pi-desktop/shared";
import type { CommandCenterBinding } from "./contracts.js";

/** Transport authority minted by the control service, never by a caller. */
export type CommandCenterAdmissionAuth = {
  subject: string;
  roles: Array<"viewer" | "controller" | "approver" | "owner">;
  sessionIds: string[];
  workspaceIds: string[];
};

/**
 * One live reservation as reported by the C2 reservation authority.
 *
 * The seam owns no counts: every field comes from the injected port, and the
 * port is responsible for the transactional 12-per-workspace / 36-per-Host
 * limits and exactly-once terminal release already enforced by C2's
 * `reservation::reserve` / `reservation::transition` / `live_counts`.
 */
export type CommandCenterAdmissionReservation = {
  executionKey: string;
  workspaceId: string;
  membershipRevision: number;
  state: CommandCenterAdmissionState;
  hostLive: number;
  workspaceLive: number;
};

export type CommandCenterAdmissionReservePortRequest = {
  binding: CommandCenterBinding;
  auth: CommandCenterAdmissionAuth;
  workspaceId: string;
  membershipRevision: number;
  execution: CommandCenterExecutionTarget;
};

export type CommandCenterAdmissionHoldPortRequest = {
  binding: CommandCenterBinding;
  auth: CommandCenterAdmissionAuth;
  workspaceId: string;
  execution: CommandCenterExecutionTarget;
  from: CommandCenterAdmissionState;
  /** Non-terminal target only: stopping/outcome_unknown keep the slot. */
  to: CommandCenterAdmissionState;
  evidence: string;
};

export type CommandCenterAdmissionReleasePortRequest = {
  binding: CommandCenterBinding;
  auth: CommandCenterAdmissionAuth;
  workspaceId: string;
  execution: CommandCenterExecutionTarget;
  /** Terminal state the reservation settles as. */
  to: CommandCenterAdmissionState;
  /** C2 requires bounded transition evidence for a slot release. */
  evidence: string;
};

export type CommandCenterAdmissionStatePortRequest = {
  binding: CommandCenterBinding;
  auth: CommandCenterAdmissionAuth;
};

/**
 * The single admission decision every entry point must consult.
 *
 * Required behaviors the implementation must preserve (C2 already does):
 * - reserve refuses at 12 live executions per workspace or 36 per Host;
 * - a duplicate reserve for the same execution identity is idempotent, not a
 *   second slot;
 * - `stopping`, `outcome_unknown` and `interrupted` retain capacity;
 * - release is a terminal transition with evidence and decrements exactly once;
 * - a stale Host epoch is refused.
 */
export interface CommandCenterAdmissionPort {
  reserve(request: CommandCenterAdmissionReservePortRequest): Promise<CommandCenterAdmissionReservation>;
  hold(request: CommandCenterAdmissionHoldPortRequest): Promise<CommandCenterAdmissionReservation>;
  release(request: CommandCenterAdmissionReleasePortRequest): Promise<{ released: boolean }>;
  snapshot(request: CommandCenterAdmissionStatePortRequest): Promise<CommandCenterAdmissionSnapshot>;
}
