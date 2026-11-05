/** Placement describes the Node backend; plugin views always stay on Desktop. */
export type PluginExecution = {
  main: "desktop" | "workspace";
  /** A separate workspace entry for plugins whose main backend stays on Desktop. */
  workspaceMain?: string;
};

export function pluginExecutionError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "manifest.execution must be an object";
  }
  const declaration = value as Record<string, unknown>;
  if (declaration.main !== "desktop" && declaration.main !== "workspace") {
    return "manifest.execution.main must be desktop or workspace";
  }
  if (Object.keys(declaration).some(key => key !== "main" && key !== "workspaceMain")) {
    return "manifest.execution contains an unsupported field";
  }
  if (declaration.workspaceMain !== undefined) {
    if (declaration.main !== "desktop") {
      return "manifest.execution.workspaceMain requires a desktop main entry";
    }
    const entry = declaration.workspaceMain;
    if (typeof entry !== "string" || !entry.trim() || entry !== entry.trim()
      || /[\u0000-\u001f\u007f]/.test(entry) || /^(?:[a-zA-Z]:|[\\/])/.test(entry)
      || entry.split(/[\\/]/).some(part => !part || part === "..")) {
      return "manifest.execution.workspaceMain must be a relative file inside the plugin";
    }
    if (!/\.(?:c|m)?js$/.test(entry)) {
      return "manifest.execution.workspaceMain must be a JavaScript entry";
    }
  }
  return undefined;
}

/** Omitted execution metadata preserves the legacy desktop placement. */
export function pluginWorkspaceEntry(manifest: { main: string; execution?: PluginExecution }): string | null {
  if (manifest.execution?.main === "workspace") return manifest.main;
  return manifest.execution?.workspaceMain ?? null;
}

/** Host-issued workspace identity. Paths belong to the indicated authority. */
export type PluginWorkspaceContext = {
  workspaceId: string;
  projectId: string;
  authority: { kind: "local" } | { kind: "remote"; hostKey: string };
  roots: Array<{ path: string; name: string; primary: boolean }>;
  platform: "win32" | "darwin" | "linux";
  connectionState: "connected" | "disconnected";
  generation: number;
};
