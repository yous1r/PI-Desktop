import { ExternalResourceActivity } from "./external-resource-activity";
import {
  clonePluginExtensionData, PLUGIN_EXTENSION_OWNER_TIMEOUT_MS, PLUGIN_EXTENSION_SHUTDOWN_TIMEOUT_MS,
  type PluginExtensionCallContext, type PluginExtensionOperation,
  type PluginExtensionRuntimeRegistration, type PluginExtensionRetirementReason,
} from "@pi-desktop/shared";

export type ExtensionOwnerSession = Omit<PluginExtensionCallContext, "runtimeId" | "retirementReason"> & {
  /** Current authorized manifest projection, filtered by active plugin grants and scope. */
  extensions: Array<{ id: string; ownerPluginId: string; operations: PluginExtensionOperation[] }>;
};
export type ExtensionOwnerBrokerDeps = {
  isAdmissionClosed(): boolean;
  /** The bridge's original Host and generation must still own this connection. */
  assertOwner(session?: ExtensionOwnerSession): void;
  /** Must return only sessions launched through this sidecar/host, from authoritative records. */
  resolveSession(sessionId: string, retiring?: ExtensionOwnerSession): Promise<ExtensionOwnerSession | undefined>;
  /** Consume the host's launch binding. Reject a generation not permitted by that launch. */
  acceptRuntime(registration: PluginExtensionRuntimeRegistration, session: ExtensionOwnerSession): Promise<boolean>;
  /** Run under plugin-host invocation context; abort/completion retires descendant SDK calls. */
  dispatch(pluginId: string, operation: string, payload: unknown,
    context: PluginExtensionCallContext & { signal: AbortSignal }): Promise<unknown>;
};
type Generation = { runtimeId: string; session: ExtensionOwnerSession; reason?: PluginExtensionRetirementReason;
  retirementTimer?: ReturnType<typeof setTimeout>; terminalCalls: Set<string> };
type Pending = { sessionId: string; extensionId: string; runtimeId: string; pluginId?: string; controller: AbortController;
  operations: number; finished: boolean };
const abortError = () => new DOMException("Owner invocation retired", "AbortError");
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid owner ${label}`);
  }
  return value;
}
function retirementReason(value: unknown): PluginExtensionRetirementReason {
  if (value === "reconfigure" || value === "session-close" || value === "app-quit") return value;
  throw new Error("Invalid runtime retirement reason");
}
function sameScope(a: ExtensionOwnerSession, b: ExtensionOwnerSession): boolean {
  return a.sessionId === b.sessionId && a.projectPath === b.projectPath && a.workspaceRoot === b.workspaceRoot &&
    a.remoteWorkspace?.hostKey === b.remoteWorkspace?.hostKey && a.remoteWorkspace?.path === b.remoteWorkspace?.path;
}
function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then((value) => { signal.removeEventListener("abort", abort); if (!signal.aborted) resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Instance owned by one Main sidecar connection. No module-global session state. */
export class PluginExtensionOwnerBroker {
  private readonly generations = new Map<string, Generation>();
  private readonly pending = new Map<string, Pending>();
  private readonly registrations = new Map<string, object>();
  private closed = false;
  private pluginRevision = 0;
  private readonly deps: ExtensionOwnerBrokerDeps;
  private readonly activity: ExternalResourceActivity;
  constructor(deps: ExtensionOwnerBrokerDeps) { this.deps = deps; this.activity = new ExternalResourceActivity(deps.isAdmissionClosed); }
  getHandoffActivity() { return { operations: this.activity.snapshot().operations, runtimes: this.generations.size }; }
  private assertAvailable(retiring = false): void {
    if (this.closed) throw abortError();
    this.deps.assertOwner();
    if (!retiring) this.activity.assertOpen();
  }
  registerRuntime(raw: Record<string, unknown>): Promise<{ ok: true }> {
    return this.activity.track(() => this.registerCurrentRuntime(raw));
  }
  private async registerCurrentRuntime(raw: Record<string, unknown>): Promise<{ ok: true }> {
    this.assertAvailable();
    const sessionId = text(raw.sessionId, "session ID");
    const runtimeId = text(raw.runtimeId, "runtime ID");
    const marker = {};
    const pluginRevision = this.pluginRevision;
    this.registrations.set(sessionId, marker);
    try {
      const session = await this.deps.resolveSession(sessionId);
      this.assertAvailable();
      if (this.registrations.get(sessionId) !== marker || this.pluginRevision !== pluginRevision) throw abortError();
      if (!session || session.sessionId !== sessionId) throw new Error("Owner session is not authorized");
      if (!Array.isArray(raw.extensionIds) || raw.extensionIds.length > 256 ||
          raw.extensionIds.some((id) => typeof id !== "string") ||
          new Set(raw.extensionIds).size !== raw.extensionIds.length) throw new Error("Invalid owner extension IDs");
      const extensionIds = raw.extensionIds as string[];
      const expectedIds = session.extensions.map((item) => item.id).sort();
      const remote = raw.remoteWorkspace as { hostKey?: unknown; path?: unknown } | undefined;
      if (raw.mode !== session.mode || (raw.projectPath ?? null) !== session.projectPath ||
          (raw.workspaceRoot ?? null) !== session.workspaceRoot || remote?.hostKey !== session.remoteWorkspace?.hostKey ||
          remote?.path !== session.remoteWorkspace?.path || JSON.stringify([...extensionIds].sort()) !== JSON.stringify(expectedIds)) {
        throw new Error("Runtime registration does not match the host launch binding");
      }
      const registration: PluginExtensionRuntimeRegistration = { sessionId, runtimeId, mode: session.mode,
        projectPath: session.projectPath, workspaceRoot: session.workspaceRoot, remoteWorkspace: session.remoteWorkspace, extensionIds };
      if (!await this.deps.acceptRuntime(registration, session)) throw new Error("Runtime generation is not authorized by the host launch");
      this.assertAvailable();
      if (this.closed || this.registrations.get(sessionId) !== marker || this.pluginRevision !== pluginRevision) throw abortError();
      const previous = this.generations.get(sessionId);
      if (previous?.runtimeId === runtimeId) {
        if (previous.reason) throw abortError();
        return { ok: true };
      }
      this.removeGeneration(sessionId);
      this.generations.set(sessionId, { runtimeId, session: structuredClone(session), terminalCalls: new Set() });
      return { ok: true };
    } finally {
      if (this.registrations.get(sessionId) === marker) this.registrations.delete(sessionId);
    }
  }

  callOwner(raw: Record<string, unknown>): Promise<unknown> {
    return this.activity.track(() => this.callCurrentOwner(raw));
  }
  private async callCurrentOwner(raw: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw abortError();
    const requestId = text(raw.requestId, "request ID");
    const sessionId = text(raw.sessionId, "session ID");
    const runtimeId = text(raw.runtimeId, "runtime ID");
    const extensionId = text(raw.extensionId, "extension ID", 4096);
    const operation = text(raw.operation, "operation", 64);
    const turnId = raw.turnId === undefined ? undefined : text(raw.turnId, "turn ID");
    if (this.pending.has(requestId)) throw new Error("Duplicate owner request ID");
    if (this.pending.size >= 256) throw new Error("Too many pending owner calls");
    const payload = clonePluginExtensionData(raw.payload);
    const generation = this.generations.get(sessionId);
    if (!generation || generation.runtimeId !== runtimeId) throw new Error("Stale or unknown owner runtime");
    this.assertAvailable(Boolean(generation.reason) && operation === "retire");
    const controller = new AbortController();
    const pending: Pending = { sessionId, extensionId, runtimeId, controller, operations: 0, finished: false };
    this.pending.set(requestId, pending);
    const timer = setTimeout(() => controller.abort(new DOMException("Owner call timed out", "TimeoutError")), PLUGIN_EXTENSION_OWNER_TIMEOUT_MS);
    const { signal } = controller;
    try {
      const session = await this.waitOriginal(requestId, pending, () => this.deps.resolveSession(sessionId, generation.reason ? generation.session : undefined));
      signal.throwIfAborted();
      const grant = this.validateCall(session, generation, extensionId, operation, turnId);
      if (generation.reason) {
        if (generation.terminalCalls.has(extensionId)) throw new Error("Owner terminal call already consumed");
        generation.terminalCalls.add(extensionId);
      } else {
        // Only an admitted callback advances this generation, never an outbound replacement launch.
        generation.session.turnId = session!.turnId;
        generation.session.parentSessionId = session!.parentSessionId;
      }
      pending.pluginId = grant.ownerPluginId;
      const context: PluginExtensionCallContext & { signal: AbortSignal } = {
        sessionId, runtimeId, turnId: session!.turnId, mode: session!.mode,
        projectPath: session!.projectPath, workspaceRoot: session!.workspaceRoot,
        ...(session!.remoteWorkspace ? { remoteWorkspace: { ...session!.remoteWorkspace } } : {}),
        ...(session!.parentSessionId ? { parentSessionId: session!.parentSessionId } : {}),
        ...(generation.reason ? { retirementReason: generation.reason } : {}), signal,
      };
      const result = await this.waitOriginal(requestId, pending, () => this.deps.dispatch(grant.ownerPluginId, operation, payload, context));
      signal.throwIfAborted();
      this.assertAvailable(Boolean(generation.reason) && operation === "retire");
      // Recheck grants, turn and scope after asynchronous plugin work; never publish a stale result.
      const current = await this.waitOriginal(requestId, pending, () => this.deps.resolveSession(sessionId, generation.reason ? generation.session : undefined));
      const currentGrant = this.validateCall(current, generation, extensionId, operation, turnId);
      if (currentGrant.ownerPluginId !== grant.ownerPluginId) throw abortError();
      return clonePluginExtensionData(result);
    } finally {
      clearTimeout(timer);
      pending.finished = true;
      this.releasePending(requestId, pending);
      controller.abort(abortError());
    }
  }

  private releasePending(requestId: string, pending: Pending): void {
    if (pending.finished && pending.operations === 0 && this.pending.get(requestId) === pending) this.pending.delete(requestId);
  }
  private waitOriginal<T>(requestId: string, pending: Pending, operation: () => Promise<T>): Promise<T> {
    pending.controller.signal.throwIfAborted();
    return wait(this.activity.track(async () => {
      pending.operations++;
      try { return await operation(); }
      finally { pending.operations--; this.releasePending(requestId, pending); }
    }), pending.controller.signal);
  }

  private validateCall(session: ExtensionOwnerSession | undefined, generation: Generation,
    extensionId: string, operation: string, turnId: string | undefined) {
    this.assertAvailable(Boolean(generation.reason) && operation === "retire");
    this.deps.assertOwner(session);
    if (!session || this.generations.get(session.sessionId) !== generation || !sameScope(session, generation.session) ||
        session.turnId !== turnId || (generation.reason && generation.session.turnId !== turnId)) {
      throw new Error("Owner session, turn or generation is stale");
    }
    const original = generation.session.extensions.find((item) => item.id === extensionId);
    const grant = session.extensions.find((item) => item.id === extensionId);
    const declaration = grant?.operations.find((item) => item.name === operation);
    if (!grant || !original || original.ownerPluginId !== grant.ownerPluginId || !declaration ||
        !original.operations.some((item) => item.name === operation && item.readOnly === declaration.readOnly)) {
      throw new Error("Owner plugin or operation is not authorized");
    }
    if (session.mode !== "agent" && !declaration.readOnly) throw new Error("Owner write operation is unavailable in Plan/Goal mode");
    if (generation.reason) {
      if (operation !== "retire") throw new Error("Only the declared retire operation is available during retirement");
      if (generation.session.mode !== "agent" && !declaration.readOnly) throw new Error("Owner write operation is unavailable in Plan/Goal mode");
    }
    return grant;
  }

  cancelOwner(raw: Record<string, unknown>): { ok: true } {
    const requestId = text(raw.requestId, "request ID");
    const sessionId = text(raw.sessionId, "session ID");
    const extensionId = text(raw.extensionId, "extension ID", 4096);
    const pending = this.pending.get(requestId);
    if (pending && (pending.sessionId !== sessionId || pending.extensionId !== extensionId)) {
      throw new Error("Owner cancellation identity mismatch");
    }
    pending?.controller.abort(abortError());
    return { ok: true };
  }

  retireRuntime(raw: Record<string, unknown>): { ok: true } {
    this.assertAvailable(true);
    const sessionId = text(raw.sessionId, "session ID");
    const runtimeId = text(raw.runtimeId, "runtime ID");
    const reason = retirementReason(raw.reason);
    const generation = this.generations.get(sessionId);
    if (!generation || generation.runtimeId !== runtimeId) throw new Error("Stale owner runtime retirement");
    if (generation.reason) return { ok: true };
    generation.reason = reason;
    this.abortPending((item) => item.sessionId === sessionId);
    generation.retirementTimer = setTimeout(() => {
      if (this.generations.get(sessionId) === generation) this.removeGeneration(sessionId);
    }, PLUGIN_EXTENSION_SHUTDOWN_TIMEOUT_MS);
    generation.retirementTimer.unref?.();
    return { ok: true };
  }

  /** Called before plugin unload/reload/permission revocation is allowed to complete. */
  cancelPlugin(pluginId: string): void {
    this.pluginRevision += 1;
    for (const [sessionId, generation] of this.generations) {
      if (generation.session.extensions.some((item) => item.ownerPluginId === pluginId)) this.removeGeneration(sessionId);
    }
    this.abortPending((item) => item.pluginId === pluginId);
  }
  closeSession(sessionId: string): void { this.registrations.delete(sessionId); this.removeGeneration(sessionId); }
  dispose(): void {
    this.closed = true;
    this.registrations.clear();
    for (const sessionId of this.generations.keys()) this.removeGeneration(sessionId);
    this.abortPending(() => true);
  }
  private removeGeneration(sessionId: string): void {
    clearTimeout(this.generations.get(sessionId)?.retirementTimer);
    this.generations.delete(sessionId);
    this.abortPending((item) => item.sessionId === sessionId);
  }
  private abortPending(predicate: (pending: Pending) => boolean): void {
    for (const pending of this.pending.values()) if (predicate(pending)) pending.controller.abort(abortError());
  }
}
