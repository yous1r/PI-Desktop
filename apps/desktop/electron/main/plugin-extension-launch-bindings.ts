import { normalizeMode, type Mode, type PluginExtensionOperation, type PluginExtensionRuntimeRegistration } from "@pi-desktop/shared";

export type OwnerLaunchBinding = {
  sessionId: string;
  turnId?: string;
  parentSessionId?: string;
  projectPath: string | null;
  workspaceRoot: string | null;
  remoteWorkspace?: { hostKey: string; path: string };
  mode: Mode;
  extensions: Array<{ id: string; ownerPluginId: string; operations: PluginExtensionOperation[] }>;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** Main's outbound launch facts. Advancing a launch never relabels a retiring generation. */
export class PluginExtensionLaunchBindings {
  private readonly launches = new Map<string, OwnerLaunchBinding>();
  private readonly generations = new Map<string, { runtimeId: string; retired: boolean; launch: OwnerLaunchBinding }>();
  private readonly retiredIds = new Map<string, Set<string>>();
  private readonly invalidated = new Set<string>();
  needsRetirement(sessionId: string): boolean { return this.invalidated.has(sessionId); }
  observe(method: string, value: unknown): void {
    if (!["agent.prompt", "agent.executeApprovedPlan", "agent.compact", "extensions.command.run"].includes(method)) return;
    const input = record(value);
    const sessionId = text(input.sessionId);
    if (!sessionId || !Array.isArray(input.trustedExtensions)) return;
    const remote = record(input.remoteWorkspace);
    const remoteWorkspace = text(remote.hostKey) && text(remote.path)
      ? { hostKey: text(remote.hostKey)!, path: text(remote.path)! } : undefined;
    const projectPath = text(input.projectPath);
    const previous = this.launches.get(sessionId);
    const turnId = text(input.turnId) ?? previous?.turnId;
    const binding: OwnerLaunchBinding = {
      sessionId, projectPath, workspaceRoot: remoteWorkspace?.path ?? text(input.workspaceRoot) ?? projectPath ?? text(input.scratchDir),
      ...(remoteWorkspace ? { remoteWorkspace } : {}),
      ...(turnId ? { turnId } : {}),
      ...(text(input.parentSessionId) ? { parentSessionId: text(input.parentSessionId)! } : {}),
      mode: normalizeMode(input.mode),
      extensions: input.trustedExtensions.flatMap((value: unknown) => {
        const item = record(value);
        if (!text(item.id) || !text(item.ownerPluginId) || !Array.isArray(item.ownerOperations)) return [];
        return [{ id: text(item.id)!, ownerPluginId: text(item.ownerPluginId)!,
          operations: item.ownerOperations.map((op: unknown) => {
            const operation = record(op);
            if (!text(operation.name) || typeof operation.readOnly !== "boolean") throw new Error("Invalid owner launch declaration");
            return { name: text(operation.name)!, readOnly: operation.readOnly };
          }) }];
      }),
    };
    this.launches.set(sessionId, binding);
  }
  get(sessionId: string): OwnerLaunchBinding | undefined {
    const binding = this.launches.get(sessionId);
    return binding ? structuredClone(binding) : undefined;
  }
  accept(registration: PluginExtensionRuntimeRegistration): boolean {
    const binding = this.launches.get(registration.sessionId);
    if (!binding || binding.mode !== registration.mode || binding.projectPath !== (registration.projectPath ?? null) ||
        binding.workspaceRoot !== (registration.workspaceRoot ?? null) ||
        binding.remoteWorkspace?.hostKey !== registration.remoteWorkspace?.hostKey ||
        binding.remoteWorkspace?.path !== registration.remoteWorkspace?.path ||
        JSON.stringify(binding.extensions.map((item) => item.id).sort()) !== JSON.stringify([...registration.extensionIds].sort())) return false;
    if (this.retiredIds.get(registration.sessionId)?.has(registration.runtimeId)) return false;
    const current = this.generations.get(registration.sessionId);
    if (current && !current.retired && current.runtimeId !== registration.runtimeId) return false;
    if (!current || current.runtimeId !== registration.runtimeId) {
      this.generations.set(registration.sessionId, { runtimeId: registration.runtimeId, retired: false, launch: structuredClone(binding) });
    }
    return true;
  }
  retire(sessionId: string, runtimeId: string): void {
    const current = this.generations.get(sessionId);
    if (current?.runtimeId !== runtimeId) return;
    current.retired = true;
    const retired = this.retiredIds.get(sessionId) ?? new Set<string>();
    retired.add(runtimeId);
    this.retiredIds.set(sessionId, retired);
  }
  /** Retired IDs stay rejected for this sidecar's lifetime, including after a session close. */
  invalidatePlugin(pluginId: string): string[] {
    const sessions = new Set<string>();
    for (const [sessionId, launch] of this.launches) {
      if (launch.extensions.some((item) => item.ownerPluginId === pluginId)) sessions.add(sessionId);
    }
    for (const [sessionId, generation] of this.generations) {
      if (generation.launch.extensions.some((item) => item.ownerPluginId === pluginId)) sessions.add(sessionId);
    }
    for (const sessionId of sessions) {
      this.invalidated.add(sessionId);
      const generation = this.generations.get(sessionId);
      if (generation) this.retire(sessionId, generation.runtimeId);
      this.launches.delete(sessionId);
    }
    return [...sessions];
  }
  close(sessionId: string): void {
    const current = this.generations.get(sessionId);
    if (current) this.retire(sessionId, current.runtimeId);
    this.launches.delete(sessionId);
    this.generations.delete(sessionId);
    this.invalidated.delete(sessionId);
  }
  clear(): void { this.launches.clear(); this.generations.clear(); this.retiredIds.clear(); this.invalidated.clear(); }
}
