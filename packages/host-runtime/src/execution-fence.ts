import { ExecutionFenceStatusSchema, ExecutionFenceTicketSchema, type ExecutionFenceStatus, type ExecutionFenceTicket } from "@pi-desktop/shared";
import * as Value from "typebox/value";
import type { SidecarHostLink, SidecarLaunch } from "./agent-sidecar.js";

/** The authority remains in Rust; this object only retains the generation identity. */
export class ExecutionFence {
  private constructor(private readonly host: SidecarHostLink, readonly generation: string) {}

  static async prepare(host: SidecarHostLink, binaryPath: string, launch: SidecarLaunch): Promise<{ fence: ExecutionFence; launch: SidecarLaunch }> {
    const original = { command: launch.command, args: [...launch.args], cwd: launch.cwd,
      env: { ...(launch.env ?? process.env) } };
    const ticket: unknown = await host.call("executionFence.prepare", {});
    if (!Value.Check(ExecutionFenceTicketSchema, ticket) || ticket.address !== `\\\\.\\pipe\\pi-execution-v1-${ticket.generation}`) {
      throw new Error("EXECUTION_FENCE_INVALID_TICKET");
    }
    return {
      fence: new ExecutionFence(host, ticket.generation),
      launch: ExecutionFence.launch(binaryPath, original, ticket),
    };
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

  async status(): Promise<ExecutionFenceStatus> {
    return this.validate(await this.host.call("executionFence.status", { generation: this.generation }));
  }

  async stop(timeoutMs = 2000): Promise<ExecutionFenceStatus> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2000) {
      throw new RangeError("execution fence timeout must be an integer from 0 to 2000");
    }
    return this.validate(await this.host.call("executionFence.stop", { generation: this.generation, timeoutMs }));
  }
}
