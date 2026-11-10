import { randomUUID } from "node:crypto";
import type { HandoffAdmission, MaintenanceAdmission } from "@pi-desktop/agent-host";
import {
  ExecutionFenceStatusSchema,
  type OwnerHandoffInventory, OwnerHandoffInventorySchema,
  type OwnerHandoffQuiescenceReport, type OwnerHandoffQuiescenceRequest, OwnerHandoffQuiescenceRequestSchema,
  parseOwnerHandoffQuiescenceReport, parseOwnerHandoffResponse,
  type SidecarHandoffStatus,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";
import type { AgentSidecar } from "./agent-sidecar.js";
import type { HostProcess } from "./host-process.js";
import type { OwnerHandoffCoordinatorPort } from "./owner-handoff-ports.js";
import { SidecarHandoffClient } from "./sidecar-handoff-client.js";

export type OwnerHandoffBinding = {
  sourceEpoch: string;
  profileId: string;
  generation: string;
  host: Pick<HostProcess, "generation" | "isAvailable">;
  sidecar: Pick<AgentSidecar, "call" | "executionStatus">;
};
export type OwnerHandoffCoordinatorOptions = {
  gate: MaintenanceAdmission;
  current(): OwnerHandoffBinding | null;
  /** Counts from actual coordinator/resource owners; no zero-default fallback. */
  inspect(binding: OwnerHandoffBinding): Promise<OwnerHandoffInventory>;
  /** Query the original Rust owner, never a replacement selected after await. */
  readTransfer(binding: OwnerHandoffBinding, transferId: string): Promise<unknown>;
};
type Entry = {
  request: OwnerHandoffQuiescenceRequest;
  binding: OwnerHandoffBinding;
  hostGeneration: OwnerHandoffBinding["host"]["generation"];
  holdId: string;
  client: SidecarHandoffClient;
  local?: HandoffAdmission;
  generation: string;
  attempted: boolean;
  sealing: boolean;
  peer?: SidecarHandoffStatus;
};
function failure(errorCode: string): Error { return Object.assign(new Error(errorCode), { errorCode }); }
function sameIdentity(a: OwnerHandoffQuiescenceRequest, b: OwnerHandoffQuiescenceRequest): boolean {
  return a.transferId === b.transferId && a.sourceEpoch === b.sourceEpoch && a.revision === b.revision;
}
function codeOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  if ("errorCode" in error) return error.errorCode;
  return undefined;
}

/** Owns only process-local admission. The original Rust journal authorizes
 * cancellation/fencing, and Rust separately proves native process closure.
 */
export class OwnerHandoffCoordinator implements OwnerHandoffCoordinatorPort {
  private entry?: Entry;
  private cancelled?: OwnerHandoffQuiescenceReport;
  private pending = false;
  private disposed = false;
  constructor(private readonly options: OwnerHandoffCoordinatorOptions) {}

  async exchange(value: OwnerHandoffQuiescenceRequest): Promise<OwnerHandoffQuiescenceReport> {
    if (!Value.Check(OwnerHandoffQuiescenceRequestSchema, value)) throw failure("HANDOFF_INVALID_REQUEST");
    const request = { ...value };
    if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
    if (this.pending) throw failure(request.operation === "hold" && this.entry ? "HANDOFF_UNAVAILABLE" : "HANDOFF_BUSY");
    const current = this.options.current();
    if (!current || current.sourceEpoch !== request.sourceEpoch || !current.host.isAvailable() ||
        !/^[0-9a-f]{64}$/.test(current.profileId)) throw failure("HANDOFF_STALE");
    this.pending = true;
    try {
      if (request.operation !== "hold" && this.cancelled && this.cancelled.holdId === request.holdId &&
          this.cancelled.transferId === request.transferId && this.cancelled.sourceEpoch === request.sourceEpoch &&
          this.cancelled.revision === request.revision && request.operation !== "seal") {
        return { ...this.cancelled, exchangeId: request.exchangeId, counts: { ...this.cancelled.counts } };
      }
      let entry = this.entry;
      if (request.operation === "hold" && !entry) {
        if (this.options.gate.isClosed()) throw failure("HANDOFF_BUSY");
        entry = { request, binding: { ...current }, hostGeneration: current.host.generation,
          holdId: randomUUID(), generation: current.generation, attempted: false, sealing: false,
          client: new SidecarHandoffClient(current.sidecar, { version: 1, transferId: request.transferId,
            sourceEpoch: request.sourceEpoch, revision: request.revision }) };
        this.entry = entry;
        try {
          const acquiring = entry;
          entry.local = await this.options.gate.acquireHandoff(request.transferId, () => this.inventory(acquiring));
        } catch (error) {
          if (!this.options.gate.isClosed()) this.entry = undefined;
          throw error;
        }
      }
      if (!entry || !sameIdentity(entry.request, request) ||
          (request.operation !== "hold" && request.holdId !== entry.holdId)) throw failure("HANDOFF_STALE");
      this.assertBinding(entry);
      await this.nativeGeneration(entry);
      if (!entry.local) throw failure("HANDOFF_UNAVAILABLE");
      if (!entry.attempted) {
        entry.attempted = true;
        try { entry.peer = await this.original(entry, owned => owned.client.acquire()); }
        catch (error) {
          this.assertBinding(entry);
          // A classified busy refusal committed no sidecar hold and no source
          // prepare was acknowledged. An ambiguous response keeps local closed.
          if (codeOf(error) === "HANDOFF_BUSY") { entry.local.cancel(); this.entry = undefined; }
          throw error;
        }
        this.assertBinding(entry);
      } else {
        entry.peer = await this.original(entry, owned => owned.client.status(owned.peer?.holdId));
      }
      if (entry.peer.state === "sealed" && !entry.sealing) {
        entry.local.beginFencing(); entry.sealing = true;
      }
      if (request.operation === "cancel") {
        if (entry.sealing) throw failure("HANDOFF_BUSY");
        await this.requirePhase(entry, "cancelled");
        if (entry.peer.state !== "cancelled") {
          const holdId = entry.peer.holdId;
          entry.peer = await this.original(entry, owned => owned.client.cancel(holdId));
        }
        return await this.completeCancellation(entry, request);
      }
      if (entry.peer.state === "cancelled") {
        if (entry.sealing) throw failure("HANDOFF_CANCEL_UNCONFIRMED");
        await this.requirePhase(entry, "cancelled");
        return await this.completeCancellation(entry, request);
      }
      let counts = this.combine(await this.inventory(entry), entry.peer);
      if (request.operation === "seal") {
        if (Object.values(counts).some(count => count !== 0)) throw failure("HANDOFF_BUSY");
        await this.requirePhase(entry, "source_fencing");
        counts = this.combine(await this.inventory(entry), entry.peer);
        if (Object.values(counts).some(count => count !== 0)) throw failure("HANDOFF_BUSY");
        entry.local.beginFencing(); entry.sealing = true;
        const holdId = entry.peer.holdId;
        entry.peer = await this.original(entry, owned => owned.client.seal(holdId));
        counts = this.combine(await this.inventory(entry), entry.peer);
      }
      if (entry.sealing && entry.peer.state !== "sealed") throw failure("HANDOFF_SEAL_UNCONFIRMED");
      if ((request.operation === "hold" || request.operation === "seal") && Object.values(counts).some(count => count !== 0)) {
        throw failure("HANDOFF_BUSY");
      }
      const state = entry.sealing ? "sealed" : "held";
      return this.report(entry, request, state, counts);
    } catch (error) {
      // Rust may treat only a confirmed no-hold refusal as safe to continue.
      // A busy reinspection after acquisition retains both local and Sidecar
      // admission, so its outcome must remain explicitly uncertain.
      if (request.operation === "hold" && this.entry && codeOf(error) === "HANDOFF_BUSY") {
        throw failure("HANDOFF_UNAVAILABLE");
      }
      throw error;
    } finally { this.pending = false; }
  }

  private assertBinding(entry: Entry): void {
    if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
    const current = this.options.current();
    if (!current || current.sourceEpoch !== entry.binding.sourceEpoch || current.profileId !== entry.binding.profileId ||
        current.host !== entry.binding.host || current.sidecar !== entry.binding.sidecar || current.generation !== entry.generation ||
        !entry.binding.host.isAvailable() || current.host.generation !== entry.hostGeneration) {
      this.options.gate.dispose();
      throw failure("HANDOFF_OWNER_CHANGED");
    }
  }
  private async original<T>(entry: Entry, operation: (owner: Entry) => Promise<T>): Promise<T> {
    this.assertBinding(entry);
    try { return await operation(entry); }
    finally { this.assertBinding(entry); }
  }
  private async nativeGeneration(entry: Entry): Promise<void> {
    const status = await this.original(entry, owned => owned.binding.sidecar.executionStatus());
    if (!Value.Check(ExecutionFenceStatusSchema, status) || status.state !== "running" || status.confirmed || status.rootExited ||
        status.activeProcesses < 1 || status.generation !== entry.generation) {
      throw failure("HANDOFF_OWNER_CHANGED");
    }
  }
  private async inventory(entry: Entry): Promise<OwnerHandoffInventory> {
    const counts = await this.original(entry, owned => this.options.inspect(owned.binding));
    if (!Value.Check(OwnerHandoffInventorySchema, counts)) throw failure("HANDOFF_UNAVAILABLE");
    return { ...counts };
  }
  private combine(counts: OwnerHandoffInventory, peer: SidecarHandoffStatus): OwnerHandoffInventory {
    const result = { ...counts, turns: counts.turns + peer.counts.turns, children: counts.children + peer.counts.children,
      tools: counts.tools + peer.counts.tools, inputs: counts.inputs + peer.counts.inputs,
      finalizations: counts.finalizations + peer.counts.settlements,
      admissions: counts.admissions + peer.counts.requests + peer.counts.executions,
      nativeSessions: counts.nativeSessions + peer.counts.nativeSessions,
      uncontainedResources: counts.uncontainedResources + peer.counts.unqualifiedResources };
    if (!Value.Check(OwnerHandoffInventorySchema, result)) throw failure("HANDOFF_UNAVAILABLE");
    return result;
  }
  private async requirePhase(entry: Entry, phase: "cancelled" | "source_fencing"): Promise<void> {
    const value = await this.original(entry, owned => this.options.readTransfer(owned.binding, owned.request.transferId));
    const response = parseOwnerHandoffResponse(value);
    if (!("record" in response) || response.record.phase !== phase || response.record.profile !== entry.binding.profileId ||
        response.record.id !== entry.request.transferId || response.record.sourceEpoch !== entry.request.sourceEpoch) {
      throw failure(phase === "cancelled" ? "HANDOFF_CANCEL_UNCONFIRMED" : "HANDOFF_FENCING_UNCONFIRMED");
    }
  }
  private async completeCancellation(entry: Entry, request: OwnerHandoffQuiescenceRequest): Promise<OwnerHandoffQuiescenceReport> {
    const counts = await this.inventory(entry);
    this.assertBinding(entry);
    const report = this.report(entry, request, "cancelled", counts);
    if (!entry.local) throw failure("HANDOFF_CANCEL_UNCONFIRMED");
    entry.local.cancel();
    this.cancelled = { ...report, counts: { ...report.counts } }; this.entry = undefined;
    return report;
  }
  private report(entry: Entry, request: OwnerHandoffQuiescenceRequest, state: OwnerHandoffQuiescenceReport["state"], counts: OwnerHandoffInventory): OwnerHandoffQuiescenceReport {
    return parseOwnerHandoffQuiescenceReport({ version: 1, exchangeId: request.exchangeId, transferId: request.transferId,
      sourceEpoch: request.sourceEpoch, revision: request.revision, holdId: entry.holdId, state, counts }, request);
  }
  dispose(): void { this.disposed = true; this.options.gate.dispose(); }
}
