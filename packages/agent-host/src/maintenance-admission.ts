import type { OwnerHandoffInventory } from "@pi-desktop/shared";

export const HOST_MAINTENANCE_LEASE_MS = 120_000;

export type MaintenanceBusyState = {
  clients: number;
  turns: number;
  queuedTurns: number;
  plans: number;
  tools: number;
  processes: number;
  terminals: number;
  plugins: number;
};

/** Every owner must report; omitted/unknown resource families never imply idle. */
export type HandoffBusyState = OwnerHandoffInventory;
export type MaintenanceLease = { leaseId: string; expiresAt: string };
/** Process-local authority; only source orchestration may retain this handle. */
export type HandoffAdmission = {
  readonly transferId: string;
  /** Call before any native fencing side effect; this permanently forbids cancel. */
  beginFencing(): void;
  /** Call only after durable source cancellation is confirmed. */
  cancel(): void;
};
export type MaintenanceFailureCode = "HOST_BUSY" | "HOST_AUTH_FAILED" | "HOST_MAINTENANCE_UNAVAILABLE" | "INVALID_REQUEST";
export class MaintenanceFailure extends Error {
  constructor(readonly code: MaintenanceFailureCode) { super(code); }
}

/**
 * One process-local admission gate for timed maintenance and ownership handoff.
 * Acquisition closes admission before asynchronous owner inspection. Handoff
 * holds never expire; durable recovery remains the Rust owner's responsibility.
 */
export class MaintenanceAdmission {
  private blocked = false;
  private disposed = false;
  private lease: MaintenanceLease | undefined;
  private handoff: HandoffAdmission | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly now: () => number = () => Date.now()) {}

  isClosed(): boolean {
    this.expireIfNeeded();
    return this.disposed || this.blocked;
  }

  async acquire(leaseId: string, inspect: () => Promise<MaintenanceBusyState>): Promise<MaintenanceLease> {
    if (this.disposed) throw new MaintenanceFailure("HOST_MAINTENANCE_UNAVAILABLE");
    this.expireIfNeeded();
    if (this.lease && this.lease.leaseId === leaseId) return { ...this.lease };
    this.closeForInspection();
    try {
      if (isBusy(await inspect())) throw new MaintenanceFailure("HOST_BUSY");
      if (this.disposed) throw new MaintenanceFailure("HOST_MAINTENANCE_UNAVAILABLE");
      const expiresAtMs = this.now() + HOST_MAINTENANCE_LEASE_MS;
      this.lease = { leaseId, expiresAt: new Date(expiresAtMs).toISOString() };
      this.expiryTimer = setTimeout(() => this.clearLease(), HOST_MAINTENANCE_LEASE_MS);
      this.expiryTimer.unref?.();
      return { ...this.lease };
    } catch (error) {
      if (!this.lease) this.blocked = false;
      throw error;
    }
  }

  async acquireHandoff(transferId: string, inspect: () => Promise<HandoffBusyState>): Promise<HandoffAdmission> {
    if (this.disposed) throw new MaintenanceFailure("HOST_MAINTENANCE_UNAVAILABLE");
    this.expireIfNeeded();
    if (this.handoff?.transferId === transferId) return this.handoff;
    this.closeForInspection();
    try {
      const state = await inspect();
      const counts = [state.clients, state.turns, state.queuedTurns, state.plans,
        state.tools, state.processes, state.terminals, state.plugins, state.admissions,
        state.finalizations, state.writes, state.children, state.workers, state.schedules,
        state.approvals, state.inputs, state.nativeSessions, state.mcp, state.uncontainedResources];
      if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) {
        throw new MaintenanceFailure("HOST_MAINTENANCE_UNAVAILABLE");
      }
      if (counts.some(count => count > 0)) throw new MaintenanceFailure("HOST_BUSY");
      if (this.disposed) throw new MaintenanceFailure("HOST_MAINTENANCE_UNAVAILABLE");
      let fencing = false;
      const assertOwner = () => {
        if (this.disposed) throw new MaintenanceFailure("HOST_MAINTENANCE_UNAVAILABLE");
        if (this.handoff !== hold) throw new MaintenanceFailure("HOST_AUTH_FAILED");
      };
      const hold: HandoffAdmission = Object.freeze({
        transferId,
        beginFencing: () => { assertOwner(); fencing = true; },
        cancel: () => {
          assertOwner();
          if (fencing) throw new MaintenanceFailure("HOST_BUSY");
          this.handoff = undefined;
          this.blocked = false;
        },
      });
      this.handoff = hold;
      return hold;
    } catch (error) {
      if (!this.handoff) this.blocked = false;
      throw error;
    }
  }

  release(leaseId: string): void {
    this.expireIfNeeded();
    if (!this.lease || this.lease.leaseId !== leaseId) throw new MaintenanceFailure("HOST_AUTH_FAILED");
    this.clearLease();
  }

  dispose(): void {
    this.disposed = true;
    this.handoff = undefined;
    this.clearLease();
  }

  private closeForInspection(): void {
    // A held or pending operation is the only owner, regardless of its mode.
    if (this.blocked) throw new MaintenanceFailure("HOST_BUSY");
    this.blocked = true;
  }

  private expireIfNeeded(): void {
    if (this.lease && Date.parse(this.lease.expiresAt) <= this.now()) this.clearLease();
  }

  private clearLease(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.lease = undefined;
    this.blocked = this.handoff !== undefined;
  }
}

function isBusy(state: MaintenanceBusyState): boolean {
  return state.clients > 0 || state.turns > 0 || state.queuedTurns > 0 || state.plans > 0 ||
    state.tools > 0 || state.processes > 0 || state.terminals > 0 || state.plugins > 0;
}
