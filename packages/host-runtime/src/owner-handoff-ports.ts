import type {
  ExecutionFenceStatus, OwnerHandoffQuiescenceReport, OwnerHandoffQuiescenceRequest,
} from "@pi-desktop/shared";

/** Implemented by the owning Desktop/headless coordinator over its existing
 * private channel. Rust retains the outstanding exchange and native identity;
 * external request payloads cannot implement this port or supply its inventory.
 */
export interface OwnerHandoffCoordinatorPort {
  exchange(request: OwnerHandoffQuiescenceRequest): Promise<OwnerHandoffQuiescenceReport>;
}

/** Original registered generation only; no PID/path/process-list adoption. */
export interface OwnerHandoffContainmentPort {
  readonly generation: string;
  status(): Promise<ExecutionFenceStatus>;
  stop(timeoutMs: number): Promise<ExecutionFenceStatus>;
}
