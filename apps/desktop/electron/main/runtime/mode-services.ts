/** Compose the catalog and original-runtime ownership for staged mode runs. */
import { IPC, type ModeCatalog } from "@pi-desktop/shared";
import { DESKTOP_PRINCIPAL, type AgentHostBridge } from "../agent-host-bridge";
import type { HostProcess } from "../host-process";
import { createModeCatalogService, type ModeCatalogService } from "./mode-catalog";
import { createModeRunCoordinator, type ModeRunCoordinator } from "./mode-runs";
import type { ModeRunOwner } from "./mode-run-lifetime";
import type { Logger } from "../logger";
import type { AgentSidecar } from "../agent-sidecar";
import { withModeContinuationOwner } from "./mode-continuation-owner";

export type ModeServices = { catalog: ModeCatalogService; runs: ModeRunCoordinator };
type Sidecar = Pick<AgentSidecar, "call" | "captureHostBinding">;

export function createModeServices(deps: {
  getHost: () => HostProcess | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  getSidecar: () => Sidecar | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  logger: Pick<Logger, "app">;
  isQuitting: () => boolean;
  isAdmissionClosed: () => boolean;
  modeDirectory?: string;
}): ModeServices {
  const catalog = createModeCatalogService({
    logger: deps.logger,
    dir: deps.modeDirectory,
    onChanged: (next: ModeCatalog) => deps.sendToRenderer(IPC.event.modesCatalogChanged, next),
  });
  let binding: { host: HostProcess; generation: string; bridge: AgentHostBridge | null; sidecar: Sidecar | null; valid(): boolean; owner: ModeRunOwner } | undefined;
  const getOwner = (): ModeRunOwner | null => {
    const host = deps.getHost(), bridge = deps.getAgentHostBridge(), sidecar = deps.getSidecar();
    if (!host) { binding = undefined; return null; }
    const generation = host.generation;
    if (binding?.host === host && binding.generation === generation && binding.bridge === bridge && binding.sidecar === sidecar && binding.valid()) return binding.owner;
    const valid = sidecar?.captureHostBinding(host) ?? (() => true);
    if (!valid()) { binding = undefined; return null; }
    const assertGeneration = () => {
      if (host.generation !== generation) throw Object.assign(new Error("HOST_DISCONNECTED"), { errorCode: "HOST_DISCONNECTED" });
    };
    const assertBinding = () => {
      assertGeneration();
      if (!valid()) throw Object.assign(new Error("HOST_DISCONNECTED"), { errorCode: "HOST_DISCONNECTED" });
    };
    const owner: ModeRunOwner = {
      host: { call<T = unknown>(method: string, params?: unknown): Promise<T> {
        assertGeneration();
        return host.call<T>(method, params);
      } },
      async startContinuation(sessionId, origin, content) {
        assertBinding();
        if (!bridge) throw Object.assign(new Error("agent host unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
        return withModeContinuationOwner({ host: owner.host, bridge, assertCurrent() {
          assertBinding();
          if (deps.getHost() !== host || deps.getSidecar() !== sidecar || deps.getAgentHostBridge() !== bridge) {
            throw Object.assign(new Error("HOST_DISCONNECTED"), { errorCode: "HOST_DISCONNECTED" });
          }
          if (deps.isQuitting() || deps.isAdmissionClosed()) throw Object.assign(new Error("HOST_BUSY"), { errorCode: "HOST_BUSY" });
        } }, () => bridge.startModeContinuation(sessionId, origin, content));
      },
      async abortTurn(sessionId, turnId) {
        assertBinding();
        if (!bridge || bridge.observeWorkTarget(sessionId) !== turnId) return;
        await bridge.agentHost.interruptTurn(DESKTOP_PRINCIPAL, turnId);
      },
      async notifyTurn(sessionId, turnId, notice) {
        assertBinding();
        if (!sidecar) return;
        await sidecar.call("agent.modeTurnNotice", { sessionId, turnId, ...notice });
      },
    };
    binding = { host, generation, bridge, sidecar, valid, owner };
    return owner;
  };
  const runs = createModeRunCoordinator({
    getOwner, catalog, logger: deps.logger,
    isQuitting: deps.isQuitting, isAdmissionClosed: deps.isAdmissionClosed,
  });
  return { catalog, runs };
}
