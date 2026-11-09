import { ExecutionFenceStatusSchema, ExecutionFenceTicketSchema, type ExecutionFenceStatus, type ExecutionFenceTicket } from "@pi-desktop/shared";
import * as Value from "typebox/value";
import type { SidecarHostLink, SidecarLaunch } from "./agent-sidecar.js";

const hostGeneration = (host: SidecarHostLink): unknown => "generation" in host ? host.generation : undefined;

/** The authority remains in Rust; this object only retains the generation identity. */
export class ExecutionFence {
  private bindingRevoked = false;
  private transportRevoked = false;
  private constructor(private readonly host: SidecarHostLink, readonly generation: string,
    private readonly ownerGeneration: unknown, private readonly ownerExited: () => boolean,
    private unsubscribeOwner: (() => void) | undefined) {}

  private assertTransport(): void {
    const available = !("isAvailable" in this.host && typeof this.host.isAvailable === "function") || this.host.isAvailable();
    if (this.transportRevoked || this.ownerExited() || !available || hostGeneration(this.host) !== this.ownerGeneration) {
      this.transportRevoked = true;
      this.revokeBinding();
      throw new Error("EXECUTION_FENCE_OWNER_CHANGED");
    }
  }

  assertHost(host: SidecarHostLink): void {
    if (host !== this.host) throw new Error("EXECUTION_FENCE_OWNER_CHANGED");
    this.assertTransport();
    if (this.bindingRevoked) throw new Error("EXECUTION_FENCE_OWNER_CHANGED");
  }

  revokeBinding(): void { this.bindingRevoked = true; }

  releaseHostObservation(): void {
    const unsubscribe = this.unsubscribeOwner;
    this.unsubscribeOwner = undefined;
    unsubscribe?.();
  }

  static async prepare(host: SidecarHostLink, binaryPath: string, launch: SidecarLaunch): Promise<{ fence: ExecutionFence; launch: SidecarLaunch }> {
    const ownerGeneration = hostGeneration(host);
    const original = { command: launch.command, args: [...launch.args], cwd: launch.cwd,
      env: { ...(launch.env ?? process.env) } };
    let exited = false;
    const unsubscribe = host.onExit(() => { exited = true; });
    try {
      const ticket: unknown = await host.call("executionFence.prepare", {});
      if (!Value.Check(ExecutionFenceTicketSchema, ticket) || ticket.address !== `\\\\.\\pipe\\pi-execution-v1-${ticket.generation}`) {
        throw new Error("EXECUTION_FENCE_INVALID_TICKET");
      }
      return {
        fence: new ExecutionFence(host, ticket.generation, ownerGeneration, () => exited, unsubscribe),
        launch: ExecutionFence.launch(binaryPath, original, ticket),
      };
    } catch (error) { unsubscribe(); throw error; }
  }

  private static launch(binaryPath: string, launch: SidecarLaunch, ticket: ExecutionFenceTicket): SidecarLaunch {
    return { command: binaryPath, args: ["--internal-execution-runner", "--", launch.command, ...launch.args],
      env: { ...(launch.env ?? process.env), PI_EXECUTION_TICKET: JSON.stringify(ticket) },
      ...(launch.cwd ? { cwd: launch.cwd } : {}) };
  }

  private validate(value: unknown): ExecutionFenceStatus {
    if (!Value.Check(ExecutionFenceStatusSchema, value) || value.generation !== this.generation
      || (value.confirmed && (value.state !== "closed" || value.activeProcesses !== 0))) {
      throw new Error("EXECUTION_FENCE_INVALID_STATUS");
    }
    return value;
  }

  private async query(method: string, params: { generation: string; timeoutMs?: number }): Promise<ExecutionFenceStatus> {
    this.assertTransport();
    try { return this.validate(await this.host.call(method, params)); }
    finally { this.assertTransport(); }
  }

  async status(): Promise<ExecutionFenceStatus> {
    return this.query("executionFence.status", { generation: this.generation });
  }

  async stop(timeoutMs = 2000): Promise<ExecutionFenceStatus> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2000) {
      throw new RangeError("execution fence timeout must be an integer from 0 to 2000");
    }
    this.revokeBinding();
    const result = await this.query("executionFence.stop", { generation: this.generation, timeoutMs });
    if (result.confirmed) this.releaseHostObservation();
    return result;
  }
}
