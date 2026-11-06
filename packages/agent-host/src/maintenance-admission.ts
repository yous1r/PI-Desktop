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
export type MaintenanceLease = { leaseId: string; expiresAt: string };
export type MaintenanceFailureCode = "HOST_BUSY" | "HOST_AUTH_FAILED" | "HOST_MAINTENANCE_UNAVAILABLE" | "INVALID_REQUEST";
export class MaintenanceFailure extends Error {
  constructor(readonly code: MaintenanceFailureCode) { super(code); }
}

/**
 * A process-local maintenance lease. Acquiring closes admission synchronously,
 * before the asynchronous inspection, so no new work can start in that window;
 * inspection itself only reads state the individual owners already keep.
 */
export class MaintenanceAdmission {
  private blocked = false;
  private disposed = false;
  private lease: MaintenanceLease | undefined;
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
    // A held or pending lease is the only owner; every other caller is refused.
    if (this.lease || this.blocked) throw new MaintenanceFailure("HOST_BUSY");
    this.blocked = true;
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

  release(leaseId: string): void {
    this.expireIfNeeded();
    if (!this.lease || this.lease.leaseId !== leaseId) throw new MaintenanceFailure("HOST_AUTH_FAILED");
    this.clearLease();
  }

  dispose(): void {
    this.disposed = true;
    this.clearLease();
  }

  private expireIfNeeded(): void {
    if (this.lease && Date.parse(this.lease.expiresAt) <= this.now()) this.clearLease();
  }

  private clearLease(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.lease = undefined;
    this.blocked = false;
  }
}

function isBusy(state: MaintenanceBusyState): boolean {
  return state.clients > 0 || state.turns > 0 || state.queuedTurns > 0 || state.plans > 0 ||
    state.tools > 0 || state.processes > 0 || state.terminals > 0 || state.plugins > 0;
}
