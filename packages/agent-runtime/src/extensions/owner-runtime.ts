import { randomUUID } from "node:crypto";
import {
  clonePluginExtensionData, PLUGIN_EXTENSION_OWNER_TIMEOUT_MS, PLUGIN_EXTENSION_SHUTDOWN_TIMEOUT_MS,
  type PluginExtensionCallContext, type PluginExtensionRetirementReason,
  type TrustedExtensionSpec,
} from "@pi-desktop/shared";
import { waitForOperation } from "./operation.js";

type Host = { call<T = unknown>(method: string, params: unknown): Promise<T> };

/** One runtime generation; never shared by cached extension module factories. */
export class ExtensionOwnerRuntime {
  readonly runtimeId = randomUUID();
  private registration?: Promise<void>;
  private retirementReason?: PluginExtensionRetirementReason;
  private retired = false;
  private retirementContext?: PluginExtensionCallContext;

  private readonly host: Host;
  private readonly specs: TrustedExtensionSpec[];
  private readonly resolveContext: () => Omit<PluginExtensionCallContext, "runtimeId" | "retirementReason">;
  constructor(host: Host, specs: TrustedExtensionSpec[], resolveContext: ExtensionOwnerRuntime["resolveContext"]) {
    this.host = host;
    this.specs = specs;
    this.resolveContext = resolveContext;
  }

  context(): PluginExtensionCallContext {
    return { ...(this.retirementContext ?? this.resolveContext()), runtimeId: this.runtimeId,
      ...(this.retirementReason ? { retirementReason: this.retirementReason } : {}) };
  }

  private register(): Promise<void> {
    if (this.registration) return this.registration;
    const registration = (async () => {
      const context = this.context();
      await this.host.call("extensions.owner.registerRuntime", {
        sessionId: context.sessionId, runtimeId: context.runtimeId, mode: context.mode,
        projectPath: context.projectPath, workspaceRoot: context.workspaceRoot,
        remoteWorkspace: context.remoteWorkspace,
        extensionIds: this.specs.filter((spec) => spec.ownerPluginId).map((spec) => spec.id),
      });
    })();
    this.registration = registration;
    void registration.catch(() => {
      if (this.registration === registration) this.registration = undefined;
    });
    return registration;
  }

  async call(spec: TrustedExtensionSpec, operation: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.retired) throw new DOMException("Runtime retired", "AbortError");
    if (this.retirementReason && operation !== "retire") throw new Error("Only retire is available during runtime retirement");
    const declaration = spec.ownerOperations?.find((item) => item.name === operation);
    if (!spec.ownerPluginId || !declaration) throw new Error("Owner operation is not declared");
    const context = this.context();
    if (context.mode !== "agent" && !declaration.readOnly) throw new Error("Owner write operation is unavailable in Plan/Goal mode");
    const data = clonePluginExtensionData(payload);
    const deadline = new AbortController();
    const bounded = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException("Owner call timed out", "TimeoutError")), PLUGIN_EXTENSION_OWNER_TIMEOUT_MS);
    const request = { requestId: randomUUID(), extensionId: spec.id, sessionId: context.sessionId,
      runtimeId: this.runtimeId, turnId: context.turnId, operation, payload: data };
    let sent = false;
    const cancel = () => {
      if (sent) void this.host.call("extensions.owner.cancel", {
        requestId: request.requestId, extensionId: spec.id, sessionId: context.sessionId,
      }).catch(() => { /* The host also owns a deadline and generation cancellation. */ });
    };
    bounded.addEventListener("abort", cancel, { once: true });
    try {
      await waitForOperation(this.register(), bounded);
      bounded.throwIfAborted();
      if (this.retired) throw new DOMException("Runtime retired", "AbortError");
      sent = true;
      const result = await waitForOperation(this.host.call("extensions.owner.call", request), bounded);
      bounded.throwIfAborted();
      return clonePluginExtensionData(result);
    } finally {
      clearTimeout(timer);
      bounded.removeEventListener("abort", cancel);
    }
  }

  /** Publish the reason before bounded shutdown handlers make their last calls. */
  async beginRetirement(reason: PluginExtensionRetirementReason, signal: AbortSignal): Promise<void> {
    this.retirementReason = reason;
    if (!this.specs.some((spec) => spec.ownerPluginId)) return;
    await waitForOperation(this.register(), signal);
    signal.throwIfAborted();
    await this.host.call("extensions.owner.retireRuntime", {
      sessionId: this.context().sessionId, runtimeId: this.runtimeId, reason,
    });
  }

  close(runner: { cancelPending(): void; dispose(reason?: PluginExtensionRetirementReason, timeoutMs?: number): Promise<void> } | undefined,
    reason: PluginExtensionRetirementReason): Promise<void> {
    runner?.cancelPending();
    this.retirementContext ??= this.context();
    this.retirementReason = reason;
    return (async () => {
      try {
        const signal = AbortSignal.timeout(500);
        await waitForOperation(this.beginRetirement(reason, signal), signal);
      } catch (error) {
        // Unload or a disconnected host must not prevent the next chat runtime.
        this.finishRetirement();
        console.warn("[extensions] owner retirement unavailable", error instanceof Error ? error.name : "Error");
      } finally {
        try { await runner?.dispose(reason, PLUGIN_EXTENSION_SHUTDOWN_TIMEOUT_MS); } finally { this.finishRetirement(); }
      }
    })();
  }

  finishRetirement(): void { this.retired = true; }
}

export function trustedExtensionIdentity(specs: TrustedExtensionSpec[]): string {
  return JSON.stringify([...specs].sort((a, b) => a.id.localeCompare(b.id)).map((spec) =>
    [spec.id, spec.ownerPluginId, spec.ownerOperations]));
}
