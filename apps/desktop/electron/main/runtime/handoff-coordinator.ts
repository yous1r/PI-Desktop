import {
  OwnerHandoffCoordinator, type OwnerHandoffBinding, type OwnerHandoffCoordinatorPort,
  queryOwnerHandoffIdentity, readOwnerHandoffTransfer,
} from "@pi-desktop/host-runtime";
import {
  ExecutionFenceStatusSchema, type OwnerHandoffQuiescenceRequest, OwnerHandoffQuiescenceRequestSchema,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";
import type { DesktopHandoffAdmission } from "./handoff-admission";
import { assertDesktopHandoffSources, type DesktopHandoffSources, inspectDesktopHandoff } from "./handoff-inventory";

export type DesktopHandoffOwners = Omit<DesktopHandoffSources, "binding" | "admission"> & {
  admission: DesktopHandoffAdmission;
  host: DesktopHandoffSources["binding"]["host"];
  sidecar: DesktopHandoffSources["binding"]["sidecar"] & OwnerHandoffBinding["sidecar"];
};
type ExchangeOrigin = { host: DesktopHandoffOwners["host"]; profileId: string; assertCurrent(): void };
type BoundSources = DesktopHandoffSources & { binding: DesktopHandoffSources["binding"] & OwnerHandoffBinding };
function failure(errorCode: string): Error { return Object.assign(new Error(errorCode), { errorCode }); }

async function boundedStatus(sidecar: DesktopHandoffOwners["sidecar"]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure("HANDOFF_QUERY_TIMEOUT")), 2500); });
    // The original readonly RPC may outlive its waiter. Observe its rejection;
    // neither a timeout nor a late result grants a coordinator binding.
    return await Promise.race([sidecar.executionStatus(), deadline]);
  } finally { clearTimeout(timer); }
}

/** Resolve optional handoff identity on demand, never during normal startup.
 * The returned view retains actual owners; it contains no authority ledger. */
export async function bindDesktopHandoffOwner(current: () => DesktopHandoffOwners | null) {
  const initial = current();
  if (!initial?.host || !initial.sidecar) throw failure("HANDOFF_OWNER_UNAVAILABLE");
  const sources = { ...initial };
  assertDesktopHandoffSources(sources);
  const hostGeneration = sources.host.generation;
  const sidecarCurrent = sources.sidecar.captureHostBinding(sources.host);
  let revoked: { error: unknown } | undefined;
  const assertCurrent = () => {
    if (revoked) throw revoked.error;
    try {
      const live = current();
      if (!live || live.host !== sources.host || live.sidecar !== sources.sidecar ||
          sources.host.generation !== hostGeneration || !sources.host.isAvailable() || !sidecarCurrent()) {
        throw failure("HANDOFF_OWNER_CHANGED");
      }
      assertDesktopHandoffSources(live, sources);
    } catch (error) { revoked = { error }; throw error; }
  };
  const original = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    try { return await operation(); }
    finally { assertCurrent(); }
  };
  const identity = await original(() => queryOwnerHandoffIdentity(() => { assertCurrent(); return sources.host; }));
  const native = await original(() => boundedStatus(sources.sidecar));
  if (!Value.Check(ExecutionFenceStatusSchema, native) || native.state !== "running" ||
      native.confirmed || native.rootExited || native.activeProcesses < 1) throw failure("HANDOFF_OWNER_CHANGED");
  const binding = Object.freeze({ host: sources.host, sidecar: sources.sidecar, sourceEpoch: identity.sourceEpoch,
    profileId: identity.profileId, generation: native.generation });
  const snapshot: BoundSources = Object.freeze({ ...sources, binding });
  assertCurrent();
  const bound = () => { assertCurrent(); return snapshot; };
  return Object.freeze({
    current: bound,
    inspect: () => inspectDesktopHandoff(bound),
    readTransfer: (transferId: string) => readOwnerHandoffTransfer(() => bound().binding, transferId),
  });
}

type BoundOwner = Awaited<ReturnType<typeof bindDesktopHandoffOwner>>;

/** One application-owned coordinator survives ordinary backend restarts. Only
 * a new exchange with open admission may resolve another original owner. */
export class DesktopHandoffCoordinator implements OwnerHandoffCoordinatorPort {
  private readonly coordinator: OwnerHandoffCoordinator;
  private selected?: BoundOwner;
  private pending = false;
  private disposed = false;

  constructor(private readonly admission: DesktopHandoffAdmission,
    private readonly current: () => DesktopHandoffOwners | null) {
    this.coordinator = new OwnerHandoffCoordinator({ gate: admission.gate,
      current: () => this.selected ? this.original().current().binding : null,
      inspect: binding => this.original(binding).inspect(),
      readTransfer: (binding, transferId) => this.original(binding).readTransfer(transferId),
    });
  }

  private original(binding?: OwnerHandoffBinding): BoundOwner {
    if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
    try {
      if (!this.selected) throw failure("HANDOFF_OWNER_UNAVAILABLE");
      const owner = this.selected.current().binding;
      if (binding && (owner.host !== binding.host || owner.sidecar !== binding.sidecar ||
          owner.sourceEpoch !== binding.sourceEpoch || owner.profileId !== binding.profileId || owner.generation !== binding.generation)) {
        throw failure("HANDOFF_OWNER_CHANGED");
      }
      return this.selected;
    } catch (error) {
      // Failed inspection must not reopen admission for a changed source.
      if (this.admission.isClosed()) this.admission.dispose();
      throw error;
    }
  }

  async exchange(value: OwnerHandoffQuiescenceRequest, origin?: ExchangeOrigin) {
    if (!Value.Check(OwnerHandoffQuiescenceRequestSchema, value)) throw failure("HANDOFF_INVALID_REQUEST");
    if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
    if (this.pending) throw failure("HANDOFF_BUSY");
    this.pending = true;
    const request = { ...value };
    const original = origin ? { ...origin, generation: origin.host.generation } : undefined;
    const assertOrigin = () => {
      if (!original) return;
      original.assertCurrent();
      if (this.current()?.host !== original.host || original.host.generation !== original.generation || !original.host.isAvailable()) {
        throw failure("HANDOFF_OWNER_CHANGED");
      }
    };
    try {
      assertOrigin();
      if (!this.selected) {
        let preparing = true;
        try {
          this.selected = await bindDesktopHandoffOwner(() => {
            if (this.disposed) throw failure("HANDOFF_UNAVAILABLE");
            assertOrigin();
            if (preparing && this.admission.isClosed()) throw failure("HANDOFF_BUSY");
            const live = this.current();
            if (live && live.admission !== this.admission) throw failure("HANDOFF_OWNER_CHANGED");
            return live;
          });
        } finally { preparing = false; }
      }
      assertOrigin();
      const binding = this.original().current().binding;
      if (original && (binding.host !== original.host || binding.profileId !== original.profileId)) throw failure("HANDOFF_OWNER_CHANGED");
      return await this.coordinator.exchange(request);
    } finally {
      try { assertOrigin(); } catch (error) {
        if (this.admission.isClosed()) this.admission.dispose();
        throw error;
      } finally {
        if (!this.admission.isClosed()) this.selected = undefined;
        this.pending = false;
      }
    }
  }

  dispose(): void { this.disposed = true; this.coordinator.dispose(); }
}
