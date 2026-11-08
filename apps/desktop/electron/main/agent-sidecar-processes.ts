import type { ExtensionWorkspaceProcesses } from "./remote/extension-workspace-processes";

type ProcessOwner = Pick<ExtensionWorkspaceProcesses, "captureSession" | "dispose" | "rebindHost" | "getHandoffActivity">;
const add = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

/** Retired process routers remain observable after sidecar replacement/disposal. */
export class SidecarWorkspaceProcesses {
  private current?: ProcessOwner;
  private readonly owners = new Set<ProcessOwner>();
  private sealed = false;
  private uncertainty = 0;

  set(owner: ProcessOwner): void {
    if (this.current === owner) return;
    this.owners.add(owner);
    if (this.sealed) { owner.dispose(); this.snapshot(); return; }
    this.current?.dispose(); this.current = owner; this.snapshot();
  }
  rebindHost(host: object): void { if (!this.sealed) this.current?.rebindHost(host); }
  captureSession(sessionId: string): () => void {
    return this.current?.captureSession(sessionId) ?? (() => {});
  }
  dispose(): void {
    this.sealed = true;
    const owner = this.current; this.current = undefined; owner?.dispose(); this.snapshot();
  }
  snapshot() {
    let operations = 0, processes = 0, uncontainedResources = this.uncertainty;
    for (const owner of this.owners) {
      const activity = owner.getHandoffActivity?.();
      if (!activity || ![activity.operations, activity.resources, activity.uncontainedResources].every(value => Number.isSafeInteger(value) && value >= 0)) {
        uncontainedResources = add(uncontainedResources, 1); continue;
      }
      operations = add(operations, activity.operations); processes = add(processes, activity.resources);
      uncontainedResources = add(uncontainedResources, activity.uncontainedResources);
      if (owner !== this.current && activity.operations === 0 && activity.resources === 0) {
        this.uncertainty = add(this.uncertainty, activity.uncontainedResources); this.owners.delete(owner);
      }
    }
    return { operations, processes, uncontainedResources };
  }
}
