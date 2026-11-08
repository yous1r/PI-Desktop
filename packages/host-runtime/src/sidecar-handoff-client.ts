import * as Value from "typebox/value";
import {
  SidecarHandoffIdentitySchema, SidecarHandoffRequestSchema, SidecarHandoffStatusSchema,
  type SidecarHandoffIdentity, type SidecarHandoffRequest, type SidecarHandoffStatus,
} from "@pi-desktop/shared";
import type { AgentSidecar } from "./agent-sidecar.js";

/** One original sidecar transport. Callers explicitly reconcile lost responses. */
export class SidecarHandoffClient {
  private readonly identity: SidecarHandoffIdentity;
  constructor(private readonly sidecar: Pick<AgentSidecar, "call">, identity: SidecarHandoffIdentity) {
    if (!Value.Check(SidecarHandoffIdentitySchema, identity)) throw new Error("HANDOFF_INVALID_REQUEST");
    this.identity = Object.freeze({ ...identity });
  }

  acquire(): Promise<SidecarHandoffStatus> { return this.request({ ...this.identity, operation: "acquire" }); }
  status(holdId?: string): Promise<SidecarHandoffStatus> {
    return this.request({ ...this.identity, operation: "status", ...(holdId === undefined ? {} : { holdId }) });
  }
  cancel(holdId: string): Promise<SidecarHandoffStatus> {
    return this.request({ ...this.identity, operation: "cancel", holdId });
  }
  seal(holdId: string): Promise<SidecarHandoffStatus> {
    return this.request({ ...this.identity, operation: "seal", holdId });
  }

  private async request(request: SidecarHandoffRequest): Promise<SidecarHandoffStatus> {
    if (!Value.Check(SidecarHandoffRequestSchema, request)) throw new Error("HANDOFF_INVALID_REQUEST");
    // No retries: timeout may follow a committed local hold or seal.
    const value: unknown = await this.sidecar.call("sidecar.handoff", request, 5_000);
    if (!Value.Check(SidecarHandoffStatusSchema, value) || value.transferId !== this.identity.transferId ||
        value.sourceEpoch !== this.identity.sourceEpoch || value.revision !== this.identity.revision ||
        ("holdId" in request && request.holdId !== undefined && value.holdId !== request.holdId) ||
        (request.operation === "acquire" && value.state === "cancelled") ||
        (request.operation === "cancel" && value.state !== "cancelled") ||
        (request.operation === "seal" && value.state !== "sealed") ||
        ((request.operation === "acquire" || request.operation === "seal") && Object.values(value.counts).some(count => count !== 0))) {
      throw new Error("HANDOFF_INVALID_RESPONSE");
    }
    return value;
  }
}
