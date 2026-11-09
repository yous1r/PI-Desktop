import type { TrustedExtensionServices } from "./trusted-extension-services";

type Services = Pick<TrustedExtensionServices, "dispose" | "rebindHost" | "captureSession" | "getHandoffActivity">;
const add = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

/** Keep original reverse-RPC work visible after its Desktop service binding retires. */
export class SidecarExtensionServices {
  private current?: Services;
  private readonly owners = new Set<Services>();
  private sealed = false;
  private uncertainty = 0;
  set(owner: Services): void {
    if (owner === this.current) return;
    this.owners.add(owner);
    if (this.sealed) { owner.dispose(); this.snapshot(); return; }
    this.current?.dispose(); this.current = owner; this.snapshot();
  }
  rebindHost(host: object): void { if (!this.sealed) { this.current?.rebindHost(host); this.snapshot(); } }
  captureSession(sessionId: string): () => void { return this.current?.captureSession(sessionId) ?? (() => {}); }
  dispose(): void {
    this.sealed = true;
    const owner = this.current; this.current = undefined; owner?.dispose(); this.snapshot();
  }
  snapshot() {
    let operations = 0, inputs = 0, uncontainedResources = this.uncertainty;
    for (const owner of this.owners) {
      const activity = owner.getHandoffActivity?.();
      if (!activity || ![activity.operations, activity.inputs, activity.uncontainedResources].every(value => Number.isSafeInteger(value) && value >= 0)) {
        uncontainedResources = add(uncontainedResources, 1); continue;
      }
      operations = add(operations, activity.operations); inputs = add(inputs, activity.inputs);
      uncontainedResources = add(uncontainedResources, activity.uncontainedResources);
      if (owner !== this.current && activity.operations === 0 && activity.inputs === 0) {
        this.uncertainty = add(this.uncertainty, activity.uncontainedResources); this.owners.delete(owner);
      }
    }
    return { operations, inputs, uncontainedResources };
  }
}
