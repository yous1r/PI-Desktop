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

/**
 * The desktop's agent sidecar: the shared stdio transport from
 * `@pi-desktop/host-runtime`, launched the only way Electron can run Node
 * code out of process — its own executable with `ELECTRON_RUN_AS_NODE` — on
 * the sidecar bundle this build ships.
 */
export class AgentSidecar extends RuntimeAgentSidecar {
  readonly extensionOwnerLaunches = new PluginExtensionLaunchBindings();
  private ownerLifecycle?: { closeSession(sessionId: string): void; dispose(): void };
  private ownerDisposed = false;
  private readonly ownerRetirements = new Map<string, Promise<void>>();

  setExtensionOwnerLifecycle(lifecycle: { closeSession(sessionId: string): void; dispose(): void }): void {
    if (this.ownerDisposed) { lifecycle.dispose(); return; }
    this.ownerLifecycle?.dispose();
    this.ownerLifecycle = lifecycle;
  }

  private disposeExtensionOwner(): void {
    const lifecycle = this.ownerLifecycle;
    this.ownerDisposed = true;
    this.ownerLifecycle = undefined;
    lifecycle?.dispose();
    this.extensionOwnerLaunches.clear();
  }

  private retireInvalidatedOwner(sessionId: string): Promise<void> {
    const existing = this.ownerRetirements.get(sessionId);
    if (existing) return existing;
    const retiring = (async () => {
      const result = await super.call<{ status?: { isRunning?: boolean } }>("agent.getStatus", { sessionId });
      if (result.status?.isRunning !== false) throw new Error("Cannot reload an active extension runtime");
      await this.call("agent.disposeSession", { sessionId, reason: "reconfigure" }, 3_000);
    })();
    this.ownerRetirements.set(sessionId, retiring);
    void retiring.finally(() => this.ownerRetirements.delete(sessionId)).catch(() => undefined);
    return retiring;
  }

  override async call<T = unknown>(method: string, params: unknown = {}, timeoutOverrideMs?: number): Promise<T> {
    if (this.ownerDisposed) throw new Error("agent sidecar is unavailable");
    if (params && typeof params === "object" && "sessionId" in params && typeof params.sessionId === "string" &&
        this.extensionOwnerLaunches.needsRetirement(params.sessionId)) {
      if (method === "extensions.command.run") throw new Error("Extension runtime changed; start a new turn to reload it");
      if (["agent.prompt", "agent.executeApprovedPlan", "agent.compact"].includes(method)) {
        await this.retireInvalidatedOwner(params.sessionId);
        if (this.ownerDisposed) throw new Error("agent sidecar is unavailable");
      }
    }
    this.extensionOwnerLaunches.observe(method, params);
    try {
      return await super.call<T>(method, params, timeoutOverrideMs);
    } finally {
      if (method === "agent.disposeSession" && params && typeof params === "object" && "sessionId" in params) {
        this.ownerLifecycle?.closeSession(String(params.sessionId));
        this.extensionOwnerLaunches.close(String(params.sessionId));
      }
    }
  }

  override async dispose(): Promise<void> {
    this.disposeExtensionOwner();
    await super.dispose();
  }
  constructor(onStderr?: StderrHandler, launch?: ConstructorParameters<typeof RuntimeAgentSidecar>[0]["launch"]) {
    super({
      launch: launch ?? {
        command: process.execPath,
        // Keep the OS trust store available to the sidecar. On macOS the
        // Electron 43 build applies `--use-system-ca` by replacing the
        // bundled roots instead of adding them (its keychain enumeration
        // misses public anchors like GlobalSign Root CA - R3, issue #1187),
        // so there the sidecar merges bundled + system + extra CAs itself
        // (agent-runtime system-ca) and this launcher omits the flag. On
        // Windows and Linux the flag behaves as documented and stays.
        // Never bypass TLS verification.
        args: [
          "--max-old-space-size=2048",
          ...(process.platform === "darwin" ? [] : ["--use-system-ca"]),
          resolveSidecarEntry(),
        ],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      onStderr: onStderr ?? fallbackStderrLogger,
    });
    this.onExit(() => this.disposeExtensionOwner());
  }
}
