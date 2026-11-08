import { PluginExtensionOwnerBroker, type ExtensionOwnerSession } from "./plugin-extension-owner-broker";
import type { PluginExtensionLaunchBindings } from "./plugin-extension-launch-bindings";
import type { PluginRuntime } from "./plugin-runtime";

type Host = { readonly generation: string; isAvailable(): boolean; call<T = unknown>(method: string, params: unknown): Promise<T> };
type Session = { id?: string; projectPath?: string | null; worktree?: unknown; mode?: unknown;
  parentSessionId?: unknown; remoteWorkspace?: { hostKey: string; path: string } };
type OwnerPlugins = Pick<PluginRuntime, "getAgentExtensions" | "callAgentExtension" | "onExtensionOwnerUnavailable">;
/** Host persists legacy `chat` as Plan. Unknown/missing modes never grant Agent access. */
function liveMode(value: unknown, launchedMode: ExtensionOwnerSession["mode"]): ExtensionOwnerSession["mode"] | undefined {
  if (value === "agent" || value === "plan" || value === "goal") return value;
  if (value === "chat") return "plan";
  if (typeof value === "string" && value === launchedMode) return launchedMode;
  return undefined;
}
export function createPluginExtensionOwnerBridge(deps: {
  launches: PluginExtensionLaunchBindings;
  isAdmissionClosed: () => boolean;
  getHost: () => Host | null;
  plugins: OwnerPlugins;
  pluginActiveInProject: (pluginId: string, project: string | null) => boolean;
}) {
  let closed = false;
  let host = deps.getHost(), generation = host?.generation;
  const resolutions = new WeakMap<ExtensionOwnerSession, () => boolean>();
  const assertOwner = (session?: ExtensionOwnerSession) => {
    if (closed || !host || deps.getHost() !== host || host.generation !== generation || !host.isAvailable()) {
      throw Object.assign(new Error("Extension owner Host is unavailable"), { code: "HOST_UNAVAILABLE" });
    }
    if (session && !resolutions.get(session)?.()) throw new DOMException("Owner launch changed", "AbortError");
  };
  const resolveSession = async (sessionId: string, retiring?: ExtensionOwnerSession): Promise<ExtensionOwnerSession | undefined> => {
    const currentLaunch = deps.launches.get(sessionId);
    // Only the broker may supply this immutable, already authorized generation snapshot.
    const launch = retiring ?? currentLaunch;
    assertOwner();
    if (!currentLaunch || !launch || !host) return undefined;
    const originalHost = host, originalGeneration = generation;
    const sameLaunch = deps.launches.captureCurrent(sessionId);
    const isCurrent = () => !closed && host === originalHost && generation === originalGeneration &&
      Boolean(deps.launches.get(sessionId)) && (Boolean(retiring) || sameLaunch());
    const assertCurrent = () => {
      assertOwner();
      if (!isCurrent()) throw new DOMException("Owner launch changed", "AbortError");
      if (!retiring && deps.isAdmissionClosed()) throw Object.assign(new Error("Host admission is closed"), { code: "HOST_BUSY" });
    };
    assertCurrent();
    const result = await originalHost.call<{ session: Session | null }>("session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 });
    assertCurrent();
    const session = result.session;
    const mode = liveMode(session?.mode, launch.mode);
    if (!session || !mode || (session.id !== undefined && session.id !== sessionId) ||
        (session.projectPath?.trim() || null) !== launch.projectPath ||
        session.remoteWorkspace?.hostKey !== launch.remoteWorkspace?.hostKey ||
        session.remoteWorkspace?.path !== launch.remoteWorkspace?.path) return undefined;
    if (session.worktree) {
      const location = await originalHost.call<{ path?: string }>("worktree.location", { sessionId });
      assertCurrent();
      if (location.path?.trim() !== launch.workspaceRoot) return undefined;
    } else if (session.remoteWorkspace) {
      if (launch.workspaceRoot !== session.remoteWorkspace.path) return undefined;
    } else if (launch.projectPath && launch.workspaceRoot !== launch.projectPath) {
      // A removed worktree must not remain authorized through an old launch.
      return undefined;
    }
    assertCurrent();
    const parentSessionId = typeof session.parentSessionId === "string" && session.parentSessionId.trim()
      ? session.parentSessionId.trim() : launch.parentSessionId;
    const resolved: ExtensionOwnerSession = { ...launch, mode, ...(parentSessionId ? { parentSessionId } : {}), extensions: deps.plugins.getAgentExtensions()
      .filter((item) => deps.pluginActiveInProject(item.pluginId, launch.projectPath))
      .map((item) => ({ id: item.id, ownerPluginId: item.pluginId, operations: item.ownerOperations })) };
    resolutions.set(resolved, isCurrent);
    return resolved;
  };
  const broker = new PluginExtensionOwnerBroker({ resolveSession, assertOwner, isAdmissionClosed: deps.isAdmissionClosed,
    acceptRuntime: async (registration, session) => { assertOwner(session); return deps.launches.accept(registration); },
    dispatch: (pluginId, operation, payload, context) => deps.plugins.callAgentExtension(pluginId, operation, payload, context),
  });
  const unsubscribe = deps.plugins.onExtensionOwnerUnavailable((pluginId) => {
    broker.cancelPlugin(pluginId);
    deps.launches.invalidatePlugin(pluginId);
  });
  return {
    rebindHost: (expectedHost: object) => {
      if (closed) throw new DOMException("Owner invocation retired", "AbortError");
      const next = deps.getHost();
      if (!next || next !== expectedHost || !next.isAvailable()) throw Object.assign(new Error("Extension owner Host is unavailable"), { code: "HOST_UNAVAILABLE" });
      if (next === host && next.generation === generation) return;
      if (deps.isAdmissionClosed()) throw Object.assign(new Error("Host admission is closed"), { code: "HOST_BUSY" });
      broker.invalidateHost();
      deps.launches.invalidateHost();
      host = next; generation = next.generation;
    },
    getHandoffActivity: () => broker.getHandoffActivity(),
    callOwner: (params: Record<string, unknown>) => broker.callOwner(params),
    cancelOwner: (params: Record<string, unknown>) => broker.cancelOwner(params),
    registerRuntime: (params: Record<string, unknown>) => broker.registerRuntime(params),
    retireRuntime: (params: Record<string, unknown>) => {
      const result = broker.retireRuntime(params);
      deps.launches.retire(String(params.sessionId), String(params.runtimeId));
      return result;
    },
    closeSession: (sessionId: string) => { broker.closeSession(sessionId); deps.launches.close(sessionId); },
    dispose: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      broker.dispose();
      deps.launches.clear();
    },
  };
}
