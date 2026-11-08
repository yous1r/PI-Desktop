import { MaintenanceAdmission } from "@pi-desktop/agent-host";
import { IPC } from "@pi-desktop/shared";

// These paths only request shutdown or answer its authenticated dialog. Reads
// are not implicitly safe: many initialize native, plugin or MCP resources.
const shutdownChannels = new Set<string>([
  IPC.invoke.appQuit,
  IPC.invoke.lifecycleDialogReady,
  IPC.invoke.lifecycleDialogRespond,
]);

/** One application-owned gate; counters describe admitted setup, not closure
 * proof. They remain visible until the original operation actually settles. */
export class DesktopHandoffAdmission {
  readonly gate = new MaintenanceAdmission();
  private pending = 0;

  isClosed(): boolean { return this.gate.isClosed(); }
  inFlightCount(): number { return this.pending; }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.isClosed()) throw Object.assign(new Error("HOST_BUSY"), { errorCode: "HOST_BUSY" });
    this.pending += 1;
    try { return await operation(); }
    finally { this.pending -= 1; }
  }

  async invoke<T>(channel: string, operation: () => T | Promise<T>): Promise<T> {
    if (shutdownChannels.has(channel)) return operation();
    return this.run(operation);
  }

  dispose(): void { this.gate.dispose(); }
}
