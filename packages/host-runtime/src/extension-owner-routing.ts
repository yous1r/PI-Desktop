/** Embedding-host endpoints. Optional owner members preserve existing clients. */
export type TrustedExtensionSidecarBridge = {
  publishCommands: (params: Record<string, unknown>) => void;
  publishDiagnostics: (params: Record<string, unknown>) => void;
  requestUi: (params: Record<string, unknown>) => Promise<unknown>;
  configureModel: (params: Record<string, unknown>) => Promise<unknown>;
  queuePush: (params: Record<string, unknown>) => Promise<unknown>;
  queuePrioritize: (params: Record<string, unknown>) => Promise<unknown>;
  callOwner?: (params: Record<string, unknown>) => Promise<unknown>;
  cancelOwner?: (params: Record<string, unknown>) => unknown | Promise<unknown>;
  registerRuntime?: (params: Record<string, unknown>) => Promise<unknown>;
  retireRuntime?: (params: Record<string, unknown>) => unknown | Promise<unknown>;
};

export const EXTENSION_OWNER_PROXY_METHODS = [
  "extensions.owner.call", "extensions.owner.cancel", "extensions.owner.registerRuntime", "extensions.owner.retireRuntime",
] as const;

export async function routeExtensionRequest(bridge: TrustedExtensionSidecarBridge, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "extensions.commands.publish": bridge.publishCommands(params); return { ok: true };
    case "extensions.diagnostics.publish": bridge.publishDiagnostics(params); return { ok: true };
    case "extensions.model.configure": return bridge.configureModel(params);
    case "extensions.ui.request": return bridge.requestUi(params);
    case "session.queuePush": return bridge.queuePush(params);
    case "session.queuePrioritize": return bridge.queuePrioritize(params);
    case "extensions.owner.call": if (bridge.callOwner) return bridge.callOwner(params); break;
    case "extensions.owner.cancel": if (bridge.cancelOwner) return bridge.cancelOwner(params); break;
    case "extensions.owner.registerRuntime": if (bridge.registerRuntime) return bridge.registerRuntime(params); break;
    case "extensions.owner.retireRuntime": if (bridge.retireRuntime) return bridge.retireRuntime(params); break;
    default: throw new Error("Unknown trusted extension method");
  }
  throw Object.assign(new Error("Extension owner capability is unavailable"), { errorCode: "UNSUPPORTED" });
}
