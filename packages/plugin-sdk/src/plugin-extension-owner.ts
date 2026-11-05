/** Standalone SDK contracts; structurally identical to the host wire types. */
export type PluginExtensionOperation = { name: string; readOnly: boolean };
export type PluginExtensionRetirementReason = "reconfigure" | "session-close" | "app-quit";
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
export type PluginExtensionOwner = {
  version: 1;
  /** Only manifest-declared operations; bound to the original callback's lifetime. */
  call(operation: string, payload?: unknown): Promise<unknown>;
};
export type PluginAgentExtensionHandler = (
  operation: string,
  payload: unknown,
  context: PluginExtensionCallContext & { signal: AbortSignal },
) => unknown | Promise<unknown>;

export const MAX_AGENT_EXTENSION_OPERATIONS = 32;
export function validateAgentExtensionOperations(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_AGENT_EXTENSION_OPERATIONS) {
    return "contributes.agentExtensionOperations must be an array of at most 32 operations";
  }
  const names = new Set<string>();
  for (const operation of value) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      return "agent extension operations must be objects";
    }
    const { name, readOnly } = operation as Record<string, unknown>;
    if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
      return "agent extension operation name must be 1-64 bounded identifier characters";
    }
    if (typeof readOnly !== "boolean") return "agent extension operation readOnly must be a boolean";
    if (names.has(name)) return "agent extension operation names must be unique";
    names.add(name);
  }
  return undefined;
}
