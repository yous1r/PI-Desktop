import { WorkspaceTerminalRouter, type TerminalHandoffActivity, type TerminalRouterOptions } from "./workspace-terminal-router";

/** Retiring windows retain original work; settled routers reduce to bounded
 * refusal evidence instead of retaining every historical window and handle. */
export class WorkspaceTerminalRegistry {
  private readonly routers = new Set<WorkspaceTerminalRouter>();
  private readonly retiring = new Map<WorkspaceTerminalRouter, Promise<void>>();
  private retiredResources = 0;
  private cleanupUnconfirmed = false;
  private sealed = false;

  create(options: TerminalRouterOptions): WorkspaceTerminalRouter {
    if (this.sealed) throw Object.assign(new Error("Terminal registry is closed"), { errorCode: "TERMINAL_HOST_OFFLINE" });
    const router = new WorkspaceTerminalRouter(options);
    this.routers.add(router);
    return router;
  }
  getHandoffActivity(): TerminalHandoffActivity {
    let terminals = 0;
    let uncontainedResources = this.retiredResources + Number(this.cleanupUnconfirmed);
    for (const router of this.routers) {
      const activity = router.getHandoffActivity();
      terminals = Math.min(Number.MAX_SAFE_INTEGER, terminals + activity.terminals);
      uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, uncontainedResources + activity.uncontainedResources);
    }
    return { terminals, uncontainedResources: Math.min(Number.MAX_SAFE_INTEGER, uncontainedResources) };
  }
  retire(router: WorkspaceTerminalRouter): Promise<void> {
    const existing = this.retiring.get(router);
    if (existing) return existing;
    if (!this.routers.has(router)) return Promise.resolve();
    const pending = router.dispose().catch(() => {
      this.cleanupUnconfirmed = true;
      console.warn("Terminal window cleanup failed; idle handoff remains unavailable");
    }).then(() => {
      const activity = router.getHandoffActivity();
      if (activity.terminals !== 0) { this.cleanupUnconfirmed = true;return; }
      this.retiredResources = Math.min(Number.MAX_SAFE_INTEGER, this.retiredResources + activity.uncontainedResources);
      this.routers.delete(router);
    }).finally(() => { this.retiring.delete(router); });
    this.retiring.set(router, pending);
    return pending;
  }
  async dispose(): Promise<void> {
    this.sealed = true;
    await Promise.allSettled([...this.routers].map(router => this.retire(router)));
  }
}
