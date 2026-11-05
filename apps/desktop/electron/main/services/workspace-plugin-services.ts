import { createWorkspaceExecutionResolver } from "../workspace-execution-context";
import { RemoteWorkspacePlugins } from "../remote/remote-workspace-plugins";
import type { RemoteHostClient } from "../remote/remote-host-connection";

type Host = { call<T>(method: string, input?: unknown): Promise<T> };
export function createWorkspacePluginServices(options: {
  getHost(): Host | null; currentWorkspacePath(): string | null;
  client(hostKey: string): RemoteHostClient;
  requestConsent(input: { pluginId: string; pluginName: string; hostKey: string }): Promise<boolean>;
}) {
  const pending = new Map<string, Promise<void>>();
  const remote = new RemoteWorkspacePlugins({ client: options.client,
    isAuthorized: async input => {
      const host = options.getHost();
      if (!host) return false;
      const result = await host.call<{allowed:boolean}>("plugins.workspaceExecution.get",{id:input.pluginId,hostKey:input.hostKey,digest:input.digest});
      return options.getHost() === host && result.allowed;
    },
    authorize: input => {
    const key = JSON.stringify([input.pluginId, input.hostKey, input.digest]);
    const previous = pending.get(key); if (previous) return previous;
    const operation = (async () => {
      const host = options.getHost();
      if (!host) throw new Error("Plugin authorization owner is unavailable");
      const binding = { id: input.pluginId, hostKey: input.hostKey, digest: input.digest };
      const result = await host.call<{allowed:boolean}>("plugins.workspaceExecution.get", binding);
      if (result.allowed) return;
      const allowed = await options.requestConsent(input);
      if (!allowed) throw Object.assign(new Error("Workspace plugin execution was not authorized"), {code:"PERMISSION_DENIED"});
      if (options.getHost() !== host) throw new Error("Plugin authorization owner changed");
      await host.call("plugins.workspaceExecution.set", {...binding,allowed:true});
    })().finally(() => pending.delete(key));
    pending.set(key,operation); return operation;
  }});
  return {
    resolveWorkspaceExecution: createWorkspaceExecutionResolver({getHost:options.getHost,currentWorkspacePath:options.currentWorkspacePath,
      remoteState:async hostKey=>{const client=options.client(hostKey);return {connected:client.state?.()==="connected",generation:client.generation?.()??1,platform:"linux"};}}),
    spawnWorkspaceProcess: remote.spawn.bind(remote),
    isWorkspaceExecutionAvailable: remote.available.bind(remote),
    forgetWorkspacePluginDecisions: (pluginId: string) => remote.forget(pluginId),
    disposeWorkspaceProcesses: () => remote.dispose(),
  };
}
