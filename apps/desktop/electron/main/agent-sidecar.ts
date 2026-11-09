import { SidecarExtensionServices } from "./agent-sidecar-extension-services";
import { SidecarWorkspaceProcesses } from "./agent-sidecar-processes";
import { PluginExtensionLaunchBindings } from "./plugin-extension-launch-bindings";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { redactValue } from "./logger";
import { getModuleDirectory } from "./module-path";

export type {
  LocalToolHandler,
  LocalToolResult,
  ProjectInstructionResolver,
  SidecarNotificationHandler,
  TrustedExtensionSidecarBridge,
  VendorAuthResolver,
} from "@pi-desktop/host-runtime";

type ExtensionOwnerLifecycle = {
  closeSession(sessionId: string): void;
  dispose(): void;
  rebindHost(host: object): void;
  getHandoffActivity(): { operations: number; runtimes: number };
};

function resolveSidecarEntry(): string {
  const candidates = [
    join(process.resourcesPath || "", "agent-runtime/sidecar.js"),
    join(
      getModuleDirectory(import.meta.url),
      "../../../agent-runtime/dist/sidecar.js",
    ),
    join(
      getModuleDirectory(import.meta.url),
      "../../../../packages/agent-runtime/dist/sidecar.js",
    ),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return join(
    getModuleDirectory(import.meta.url),
    "../../../../packages/agent-runtime/dist/sidecar.js",
  );
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[agent/runtime] ${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      channel: "agent",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

export function desktopSidecarLaunch(): ConstructorParameters<typeof RuntimeAgentSidecar>[0]["launch"] {
  return {
    command: process.execPath,
    // macOS Electron replaces bundled roots with --use-system-ca. The runtime
    // merges its bundled/system/extra roots there; keep the flag elsewhere.
    args: ["--max-old-space-size=2048", ...(process.platform === "darwin" ? [] : ["--use-system-ca"]), resolveSidecarEntry()],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * The desktop's agent sidecar: the shared stdio transport from
 * `@pi-desktop/host-runtime`, launched the only way Electron can run Node
 * code out of process — its own executable with `ELECTRON_RUN_AS_NODE` — on
 * the sidecar bundle this build ships.
 */
export class AgentSidecar extends RuntimeAgentSidecar {
  static override createFenced(options: Parameters<typeof RuntimeAgentSidecar.createFenced>[0]): Promise<AgentSidecar> {
    return this.createFencedWith(options, ({ launch, onStderr }) => new AgentSidecar(onStderr, launch));
  }

  readonly extensionOwnerLaunches = new PluginExtensionLaunchBindings();
  private ownerLifecycle?: ExtensionOwnerLifecycle;
  private readonly ownerLifecycles = new Set<ExtensionOwnerLifecycle>();
  private ownerOperations = 0;
  private ownerUncertainty = 0;
  private ownerDisposed = false;
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly workspaceProcesses = new SidecarWorkspaceProcesses();
  private readonly extensionServices = new SidecarExtensionServices();
  private hostBinding?: { host: Parameters<RuntimeAgentSidecar["setHost"]>[0]; generation: unknown; ready: boolean };
  private unsubscribeBindingExit?: () => void;

  /** A binding cannot revive after replacement, even when the same Host returns. */
  captureHostBinding(host: object): () => boolean {
    const binding = this.hostBinding;
    return () => !this.ownerDisposed && binding !== undefined && binding.ready &&
      this.hostBinding === binding && binding.host === host &&
      binding.generation === ("generation" in host ? host.generation : undefined);
  }

  setExtensionServices(owner: Parameters<SidecarExtensionServices["set"]>[0]): void { this.extensionServices.set(owner); }
  getExtensionServiceActivity() { return this.extensionServices.snapshot(); }

  setExtensionWorkspaceProcesses(owner: Parameters<SidecarWorkspaceProcesses["set"]>[0]): void { this.workspaceProcesses.set(owner); }
  getExtensionWorkspaceProcessActivity() { return this.workspaceProcesses.snapshot(); }

  setExtensionOwnerLifecycle(lifecycle: ExtensionOwnerLifecycle): void {
    if (this.ownerLifecycle === lifecycle) return;
    this.ownerLifecycles.add(lifecycle);
    if (this.ownerDisposed) { lifecycle.dispose(); this.getExtensionOwnerActivity(); return; }
    this.ownerLifecycle?.dispose();
    this.ownerLifecycle = lifecycle;
    this.getExtensionOwnerActivity();
  }

  override setHost(host: Parameters<RuntimeAgentSidecar["setHost"]>[0]): void {
    this.assertHostOwner(host);
    if (this.ownerDisposed) return;
    const generation = "generation" in host ? host.generation : undefined;
    if (this.hostBinding?.host !== host || this.hostBinding.generation !== generation) {
      const binding = { host, generation, ready: false };
      this.hostBinding = binding;
      this.unsubscribeBindingExit?.();
      this.unsubscribeBindingExit = host.onExit(() => {
        if (this.hostBinding === binding) this.hostBinding = undefined;
      });
    }
    const binding = this.hostBinding;
    this.ownerLifecycle?.rebindHost(host);
    this.workspaceProcesses.rebindHost(host);
    this.extensionServices.rebindHost(host);
    if (this.ownerDisposed || this.hostBinding !== binding) return;
    super.setHost(host);
    binding.ready = true;
  }

  getExtensionOwnerActivity() {
    let operations = this.ownerOperations, runtimes = 0, uncontainedResources = this.ownerUncertainty;
    for (const owner of this.ownerLifecycles) {
      const activity = owner.getHandoffActivity?.();
      if (!activity || ![activity.operations, activity.runtimes].every(value => Number.isSafeInteger(value) && value >= 0)) {
        uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, uncontainedResources + 1);
        continue;
      }
      operations += activity.operations; runtimes += activity.runtimes;
      if (owner !== this.ownerLifecycle && activity.operations === 0 && activity.runtimes === 0) this.ownerLifecycles.delete(owner);
    }
    return { operations, runtimes, uncontainedResources };
  }

  private disposeExtensionOwner(): void {
    const lifecycle = this.ownerLifecycle;
    this.ownerDisposed = true;
    this.hostBinding = undefined;
    this.unsubscribeBindingExit?.();
    this.unsubscribeBindingExit = undefined;
    this.ownerLifecycle = undefined;
    this.workspaceProcesses.dispose();
    this.extensionServices.dispose();
    lifecycle?.dispose();
    this.extensionOwnerLaunches.clear();
    this.getExtensionOwnerActivity();
  }

  private retireInvalidatedOwner(sessionId: string): Promise<void> {
    const existing = this.ownerRetirements.get(sessionId);
    if (existing) return existing;
    const lifecycle = this.ownerLifecycle, sameLaunch = this.extensionOwnerLaunches.captureCurrent(sessionId);
    const retiring = (async () => {
      const result = await super.call<{ status?: { isRunning?: boolean } }>("agent.getStatus", { sessionId });
      if (this.ownerDisposed || this.ownerLifecycle !== lifecycle || !sameLaunch()) throw new Error("Extension owner changed during retirement");
      if (result.status?.isRunning !== false) throw new Error("Cannot reload an active extension runtime");
      await this.call("agent.disposeSession", { sessionId, reason: "reconfigure" }, 3_000);
    })();
    this.ownerRetirements.set(sessionId, retiring);
    void retiring.finally(() => { if (this.ownerRetirements.get(sessionId) === retiring) this.ownerRetirements.delete(sessionId); }).catch(() => undefined);
    return retiring;
  }

  override async call<T = unknown>(method: string, params: unknown = {}, timeoutOverrideMs?: number): Promise<T> {
    this.ownerOperations++;
    try { return await this.callWithExtensionOwner<T>(method, params, timeoutOverrideMs); }
    finally { this.ownerOperations--; }
  }
  private async callWithExtensionOwner<T>(method: string, params: unknown, timeoutOverrideMs?: number): Promise<T> {
    if (this.ownerDisposed) throw new Error("agent sidecar is unavailable");
    const lifecycle = this.ownerLifecycle;
    if (params && typeof params === "object" && "sessionId" in params && typeof params.sessionId === "string" &&
        this.extensionOwnerLaunches.needsRetirement(params.sessionId)) {
      if (method === "extensions.command.run") throw new Error("Extension runtime changed; start a new turn to reload it");
      if (["agent.prompt", "agent.executeApprovedPlan", "agent.compact"].includes(method)) {
        await this.retireInvalidatedOwner(params.sessionId);
        if (this.ownerDisposed || this.ownerLifecycle !== lifecycle) throw new Error("agent sidecar is unavailable");
      }
    }
    this.extensionOwnerLaunches.observe(method, params);
    const sessionId = params && typeof params === "object" && "sessionId" in params ? String(params.sessionId) : undefined;
    const sameLaunch = sessionId === undefined ? undefined : this.extensionOwnerLaunches.captureCurrent(sessionId);
    const retireProcesses = method === "agent.disposeSession" && sessionId !== undefined ? this.workspaceProcesses.captureSession(sessionId) : undefined;
    const retireServices = method === "agent.disposeSession" && sessionId !== undefined ? this.extensionServices.captureSession(sessionId) : undefined;
    try {
      return await super.call<T>(method, params, timeoutOverrideMs);
    } catch (error) {
      if (method === "agent.disposeSession" || method === "agent.shutdown") this.ownerUncertainty = Math.min(Number.MAX_SAFE_INTEGER, this.ownerUncertainty + 1);
      throw error;
    } finally {
      retireProcesses?.();
      retireServices?.();
      if (method === "agent.disposeSession" && sessionId !== undefined && this.ownerLifecycle === lifecycle && sameLaunch?.()) {
        lifecycle?.closeSession(sessionId);
        this.extensionOwnerLaunches.close(sessionId);
      }
    }
  }

  override async dispose(): Promise<void> {
    this.ownerOperations++;
    try { this.disposeExtensionOwner(); await super.dispose(); }
    finally { this.ownerOperations--; }
  }
  constructor(onStderr?: StderrHandler, launch?: ConstructorParameters<typeof RuntimeAgentSidecar>[0]["launch"]) {
    super({
      launch: launch ?? desktopSidecarLaunch(),
      onStderr: onStderr ?? fallbackStderrLogger,
    });
    this.onExit(() => this.disposeExtensionOwner());
  }
}
