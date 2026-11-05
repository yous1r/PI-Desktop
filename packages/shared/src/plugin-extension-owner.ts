/** Additive owner-call wire protocol. All routing identities are host supplied. */
export type PluginExtensionRetirementReason = "reconfigure" | "session-close" | "app-quit";
export type PluginExtensionOperation = { name: string; readOnly: boolean };
export type PluginExtensionCallContext = {
  sessionId: string;
  turnId?: string;
  runtimeId: string;
  projectPath: string | null;
  workspaceRoot: string | null;
  remoteWorkspace?: { hostKey: string; path: string };
  mode: "agent" | "plan" | "goal";
  retirementReason?: PluginExtensionRetirementReason;
  parentSessionId?: string;
};
export type PluginExtensionOwnerCall = {
  requestId: string;
  extensionId: string;
  sessionId: string;
  runtimeId: string;
  turnId?: string;
  operation: string;
  payload?: unknown;
};
export type PluginExtensionOwnerCancel = Pick<PluginExtensionOwnerCall, "requestId" | "extensionId" | "sessionId">;
export type PluginExtensionRuntimeRegistration = {
  sessionId: string;
  runtimeId: string;
  mode: PluginExtensionCallContext["mode"];
  projectPath?: string | null;
  workspaceRoot?: string | null;
  remoteWorkspace?: { hostKey: string; path: string };
  extensionIds: string[];
};
export type PluginExtensionRuntimeRetirement = {
  sessionId: string;
  runtimeId: string;
  reason: PluginExtensionRetirementReason;
};
export const PLUGIN_EXTENSION_OWNER_MAX_BYTES = 256 * 1024;
export const PLUGIN_EXTENSION_OWNER_TIMEOUT_MS = 10_000;
export const PLUGIN_EXTENSION_SHUTDOWN_TIMEOUT_MS = 2_000;

/** Detach JSON data and bound its wire size before any external work. */
export function clonePluginExtensionData(value: unknown): unknown {
  if (value === undefined) return undefined;
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new Error("Owner call data must be JSON serializable"); }
  if (json === undefined) throw new Error("Owner call data must be JSON serializable");
  if (new TextEncoder().encode(json).byteLength > PLUGIN_EXTENSION_OWNER_MAX_BYTES) {
    throw new Error("Owner call data exceeds 256 KiB");
  }
  return JSON.parse(json) as unknown;
}
