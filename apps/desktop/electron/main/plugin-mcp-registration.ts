import { isNetUrlAllowedWithGrant, pluginMcpToolKey, pluginToolName, resolveMcpRefs, validateMcpServer,
  type PluginMcpServerContrib } from "@pi-desktop/plugin-sdk";
import { workspaceMcpServer } from "@pi-desktop/host-runtime";
import { McpServerClient, type McpServerClientOptions } from "./plugin-mcp";
import type { PluginLifecycle } from "./plugin-lifecycle";
import type { McpCallRegistry } from "./mcp-call-registry";
import type { LoadedPlugin, PluginHostServices, RegisteredPluginTool } from "./plugin-runtime";

type Dependencies = {
  lifecycle: PluginLifecycle;
  services: PluginHostServices;
  clients: Map<string, McpServerClient[]>;
  calls: McpCallRegistry;
  tools: Map<string, RegisteredPluginTool>;
  assertCurrent(loaded: LoadedPlugin): void;
  settings(loaded: LoadedPlugin): Promise<Record<string, unknown>>;
  grant(loaded: LoadedPlugin): Parameters<typeof isNetUrlAllowedWithGrant>[1];
  assertEgress(loaded: LoadedPlugin, url: string): void;
  workspaceTarget(loaded: LoadedPlugin, sessionId: string): Promise<LoadedPlugin>;
  workspaceCall(loaded: LoadedPlugin, api: string, args: unknown[], signal?: AbortSignal): Promise<unknown>;
};
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const MAX_MCP_SERVERS_PER_PLUGIN = 8;

/** Track transport completion independently of the cancellable JSON-RPC caller. */
export function pluginMcpActivity(lifecycle: PluginLifecycle, assertCurrent: () => void):
  Pick<McpServerClientOptions, "beforeTransportCreate" | "trackTransportOperation"> {
  return {
    beforeTransportCreate: () => { assertCurrent(); lifecycle.nativeAttempt(); },
    trackTransportOperation: (operation, message) => lifecycle.track(async () => {
      if (message.method && message.method !== "notifications/cancelled") assertCurrent();
      return operation();
    }),
  };
}

/** Transfer only settings referenced by this declaration, never the whole store. */
function referencedSettings(server: PluginMcpServerContrib, settings: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const ref of Object.values(server.transport === "stdio" ? server.env ?? {} : server.headers ?? {})) {
    if (typeof ref === "object" && ref) selected[ref.setting] = settings[ref.setting];
  }
  return selected;
}

/** Register only tools discovered by the same admitted installation/workspace. */
export async function registerPluginMcpServers(d: Dependencies, loaded: LoadedPlugin): Promise<void> {
  const declared = (loaded.manifest.contributes?.mcpServers ?? []).filter(server =>
    workspaceMcpServer(loaded.manifest, server) === Boolean(loaded.workspaceContext));
  if (!declared.length) return;
  const pluginId = loaded.manifest.id;
  const skip = (serverId: string, errorCode: string, message?: string) => d.services.audit?.({
    pluginId, api: "plugin.mcp.skipped", ok: false, errorCode, serverId, ...(message ? { message } : {}), ts: Date.now(),
  });
  return d.lifecycle.track(async () => {
    d.assertCurrent(loaded);
    let settings: Record<string, unknown> = {};
    try { settings = await d.settings(loaded); }
    catch { settings = {}; }
    d.assertCurrent(loaded);
    const clients: McpServerClient[] = [];
    if (!loaded.workspaceContext) d.clients.set(pluginId, clients);
    for (const [index, raw] of declared.entries()) {
      d.assertCurrent(loaded);
      if (index >= MAX_MCP_SERVERS_PER_PLUGIN) {
        d.services.audit?.({ pluginId, api: "plugin.mcp.skipped", ok: false,
          errorCode: "LIMIT_EXCEEDED", count: declared.length - clients.length, ts: Date.now() });
        break;
      }
      const parsed = validateMcpServer(raw);
      if (!parsed.ok) { skip(String(raw?.id ?? ""), "PLUGIN_INVALID", parsed.error); continue; }
      const server = parsed.server;
      const permission = server.transport === "stdio" ? "mcp.server.local" : "mcp.server.remote";
      if (!loaded.permissions.has(permission)) { skip(server.id, "PERMISSION_DENIED", `missing ${permission}`); continue; }
      if (server.transport === "http" && !isNetUrlAllowedWithGrant(String(server.url ?? ""), d.grant(loaded))) {
        skip(server.id, "PERMISSION_DENIED", `endpoint not in manifest.net.domains: ${String(server.url ?? "")}`); continue;
      }
      const refs = resolveMcpRefs(server.transport === "stdio" ? server.env : server.headers, settings);
      if (!refs.ok) { skip(server.id, "CONFIG_MISSING", refs.error); continue; }
      const client = loaded.workspaceContext ? {
        connect: () => d.workspaceCall(loaded, "mcp.connect", [server.id, referencedSettings(server, settings)]) as ReturnType<McpServerClient["connect"]>,
        callTool: (tool: string, args: unknown, signal?: AbortSignal) => d.workspaceCall(loaded, "mcp.call", [server.id, tool, args], signal),
      } : new McpServerClient({
        pluginId, rootPath: loaded.path, server, values: refs.values, audit: d.services.audit, ...d.services.mcp,
        ...pluginMcpActivity(d.lifecycle, () => d.assertCurrent(loaded)),
        assertUrlAllowed: url => { d.assertCurrent(loaded); d.assertEgress(loaded, url); },
      });
      if (client instanceof McpServerClient) clients.push(client);
      let tools: Awaited<ReturnType<McpServerClient["connect"]>>;
      try { tools = await client.connect(); }
      catch (error) {
        d.assertCurrent(loaded);
        skip(server.id, (error as { code?: string }).code ?? "MCP_CONNECT_FAILED", (error as Error).message);
        continue;
      }
      d.assertCurrent(loaded);
      for (const tool of tools) {
        const name = pluginMcpToolKey(server.id, tool.name), fullName = pluginToolName(pluginId, name);
        (loaded.workspaceTools ?? d.tools).set(fullName, {
          fullName, pluginId, name, description: tool.description ?? `${server.label ?? server.id} tool "${tool.name}" (MCP)`,
          risk: "medium", schema: tool.inputSchema,
          execute: (toolArgs, ctx) => d.lifecycle.track(() => d.calls.run(ctx?.sessionId, async signal => {
            d.assertCurrent(loaded);
            if (!loaded.workspaceContext) return client.callTool(tool.name, toolArgs, signal);
            if (!ctx?.sessionId) throw failure("WORKSPACE_REQUIRED", "Workspace MCP requires an invoking session");
            const target = await d.workspaceTarget(loaded.installation ?? loaded, ctx.sessionId);
            d.assertCurrent(loaded); d.assertCurrent(target);
            signal?.throwIfAborted();
            if (!target.workspaceTools?.has(fullName)) throw failure("NOT_FOUND", "Tool is not available in this workspace");
            return d.workspaceCall(target, "mcp.call", [server.id, tool.name, toolArgs], signal);
          }, ctx?.signal)),
        });
      }
    }
  });
}
