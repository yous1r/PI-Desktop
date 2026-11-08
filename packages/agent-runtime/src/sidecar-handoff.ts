import { randomUUID } from "node:crypto";
import * as Value from "typebox/value";
import {
  SidecarHandoffActivitySchema, SidecarHandoffCountsSchema, SidecarHandoffRequestSchema,
  type SidecarHandoffCounts, type SidecarHandoffIdentity, type SidecarHandoffStatus,
} from "@pi-desktop/shared";

type Hold = SidecarHandoffIdentity & { holdId: string; state: "held" | "sealed" };
function failure(errorCode: string): Error { return Object.assign(new Error(errorCode), { errorCode }); }
function sameIdentity(left: SidecarHandoffIdentity, right: SidecarHandoffIdentity): boolean {
  return left.transferId === right.transferId && left.sourceEpoch === right.sourceEpoch && left.revision === right.revision;
}

/** Quiesces one existing stdio child; never persists or authorizes ownership. */
export class SidecarHandoff {
  private hold?: Hold;
  private lastCancelled?: SidecarHandoffStatus;
  private inspecting = false;
  private disposed = false;
  private requests = 0;
  private executions = 0;

  constructor(private readonly inspect: () => unknown) {}

  async run<T>(method: string, operation: () => Promise<T>): Promise<T> {
    const health = method === "sidecar.health";
    const teardown = method === "agent.shutdown";
    if (this.disposed && !health && !teardown) throw failure("HANDOFF_UNAVAILABLE");
    if ((this.hold || this.inspecting) && !health && !(teardown && this.hold?.state === "sealed")) {
      throw failure("HANDOFF_BUSY");
    }
    this.requests += 1;
    try { return await operation(); } finally { this.requests -= 1; }
  }

  /** Accepted background prompts remain owned through their asynchronous cleanup. */
  async track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
    if (this.hold || this.inspecting) throw failure("HANDOFF_BUSY");
    this.executions += 1;
    try { return await operation(); } finally { this.executions -= 1; }
  }

  dispose(): void { this.disposed = true; }

  blocksHostCalls(): boolean { return this.inspecting || this.hold !== undefined; }

  control(value: unknown): SidecarHandoffStatus {
    if (!Value.Check(SidecarHandoffRequestSchema, value)) throw failure("HANDOFF_INVALID_REQUEST");
    if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
    if (this.inspecting) throw failure("HANDOFF_BUSY");
    if (value.operation === "acquire") {
      if (this.hold) {
        if (!sameIdentity(this.hold, value)) throw failure("HANDOFF_BUSY");
        return this.status(this.hold);
      }
      this.inspecting = true;
      try {
        const counts = this.counts();
        if (Object.values(counts).some(count => count !== 0)) throw failure("HANDOFF_BUSY");
        if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
        this.hold = { version: 1, transferId: value.transferId, sourceEpoch: value.sourceEpoch,
          revision: value.revision, holdId: randomUUID(), state: "held" };
        return { ...this.hold, counts };
      } finally { this.inspecting = false; }
    }
    if (value.operation === "status" && value.holdId === undefined) {
      if (this.hold && sameIdentity(this.hold, value)) return this.status(this.hold);
      if (this.lastCancelled && sameIdentity(this.lastCancelled, value)) {
        return { ...this.lastCancelled, counts: { ...this.lastCancelled.counts } };
      }
      throw failure("HANDOFF_STALE");
    }
    if (this.lastCancelled && this.lastCancelled.holdId === value.holdId && sameIdentity(this.lastCancelled, value) && value.operation !== "seal") {
      return { ...this.lastCancelled, counts: { ...this.lastCancelled.counts } };
    }
    const hold = this.hold;
    if (!hold || hold.holdId !== value.holdId || !sameIdentity(hold, value)) throw failure("HANDOFF_STALE");
    if (value.operation === "cancel") {
      if (hold.state !== "held") throw failure("HANDOFF_BUSY");
      const status = { ...this.status(hold), state: "cancelled" as const };
      this.lastCancelled = status;
      this.hold = undefined;
      return { ...status, counts: { ...status.counts } };
    }
    const status = this.status(hold);
    if (value.operation === "seal") {
      if (Object.values(status.counts).some(count => count !== 0)) throw failure("HANDOFF_BUSY");
      hold.state = "sealed";
      status.state = "sealed";
    }
    return status;
  }

  private status(hold: Hold): SidecarHandoffStatus { return { ...hold, counts: this.counts() }; }
  private counts(): SidecarHandoffCounts {
    let activity: unknown;
    try { activity = this.inspect(); } catch { throw failure("HANDOFF_UNAVAILABLE"); }
    if (!Value.Check(SidecarHandoffActivitySchema, activity)) throw failure("HANDOFF_UNAVAILABLE");
    const counts = { ...activity, requests: this.requests, executions: this.executions };
    if (!Value.Check(SidecarHandoffCountsSchema, counts)) throw failure("HANDOFF_UNAVAILABLE");
    return counts;
  }
}
