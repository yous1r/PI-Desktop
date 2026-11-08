import {
  isNetUrlAllowedWithGrant, parseNetDomains, resolveMcpRefs, validateMcpServer,
  type PluginManifest,
} from "@pi-desktop/plugin-sdk";
import type { WorkspaceExecutionContext } from "@pi-desktop/shared";
import { McpServerClient, type McpServerClientOptions, type McpTool } from "./mcp/client.js";
import { pluginFailure } from "./plugin-wire.js";

export function workspaceMcpServer(manifest: Pick<PluginManifest, "execution">, server: { execution?: string }): boolean {
  return (server.execution ?? manifest.execution?.main ?? "desktop") === "workspace";
}

/** MCP clients belong to the admitted workspace instance, including HTTP sessions. */
export class WorkspacePluginMcp {
  private readonly clients = new Map<string, McpServerClient>();
  private readonly catalogs = new Map<string, McpTool[]>();
  private readonly permissions: Set<string>;
  private sealed = false;
  private readonly options: {
    manifest: PluginManifest; permissions: string[]; packagePath: string; context: WorkspaceExecutionContext;
    clientOptions?: Pick<McpServerClientOptions, "spawnImpl" | "fetchImpl" | "connectTimeoutMs" | "callTimeoutMs" | "discoveryTimeoutMs" | "audit" | "beforeTransportCreate" | "trackTransportOperation">;
  };

  constructor(options: WorkspacePluginMcp["options"]) {
    this.options = options;
    this.permissions = new Set(options.permissions.filter(value => options.manifest.permissions?.includes(value)));
  }

  async call(api: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (this.sealed) throw pluginFailure("PLUGIN_GONE", "Workspace MCP instance has closed");
    if (signal?.aborted) throw pluginFailure("TOOL_ABORTED", "MCP operation was cancelled");
    const serverId = args[0];
    if (typeof serverId !== "string") throw pluginFailure("INVALID_ARGUMENT", "MCP server ID is required");
    if (api === "mcp.connect") return this.connect(serverId, args[1]);
    const client = this.clients.get(serverId);
    if (!client) throw pluginFailure("NOT_FOUND", "Workspace MCP server has not been admitted");
    if (api === "mcp.call") {
      const tool = args[1];
      if (typeof tool !== "string" || !this.catalogs.get(serverId)?.some(item => item.name === tool)) {
        throw pluginFailure("NOT_FOUND", "Tool is not in this workspace MCP catalog");
      }
      return client.callTool(tool, args[2], signal);
    }
    throw pluginFailure("INVALID_ARGUMENT", "Unknown workspace MCP operation");
  }

  private async connect(serverId: string, settings: unknown): Promise<McpTool[]> {
    const existing = this.clients.get(serverId);
    if (existing) return existing.connect();
    const { manifest, context, packagePath } = this.options;
    const raw = manifest.contributes?.mcpServers?.find(server => server.id === serverId);
    const parsed = validateMcpServer(raw);
    if (!parsed.ok || !workspaceMcpServer(manifest, parsed.server)) {
      throw pluginFailure("PLUGIN_INVALID", "MCP server is not declared for workspace execution");
    }
    const server = parsed.server;
    const permission = server.transport === "stdio" ? "mcp.server.local" : "mcp.server.remote";
    if (!this.permissions.has(permission)) throw pluginFailure("PERMISSION_DENIED", `Missing ${permission}`);
    if (this.clients.size >= 8) throw pluginFailure("LIMIT_EXCEEDED", "Workspace MCP server limit reached");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw pluginFailure("INVALID_ARGUMENT", "MCP settings must be an object");
    const refs = resolveMcpRefs(server.transport === "stdio" ? server.env : server.headers, settings as Record<string, unknown>);
    if (!refs.ok) throw pluginFailure("CONFIG_MISSING", refs.error);
    const domains = parseNetDomains(manifest.net?.domains);
    const grant = { domains: domains.ok ? domains.domains ?? [] : [], anyHost: this.permissions.has("net.anyHost") };
    const assertUrlAllowed = (url: string) => {
      if (!isNetUrlAllowedWithGrant(url, grant)) throw pluginFailure("PERMISSION_DENIED", "MCP endpoint is outside the declared network grant");
    };
    if (server.transport === "http") assertUrlAllowed(server.url!);
    const root = context.roots.find(item => item.primary)!.path;
    // Paths are substituted as individual argv values, never evaluated by a shell.
    const bind = (value: string) => value.replaceAll("${workspaceRoot}", root).replaceAll("${pluginRoot}", packagePath);
    const client = new McpServerClient({
      ...this.options.clientOptions,
      pluginId: manifest.id, rootPath: packagePath,
      server: server.transport === "stdio" ? { ...server, args: server.args?.map(bind) } : server,
      values: server.transport === "stdio" ? {
        ...Object.fromEntries(Object.entries(refs.values).map(([key, value]) => [key, bind(value)])),
        PI_WORKSPACE_ROOT: root, PI_WORKSPACE_ID: context.workspaceId, PI_PLUGIN_ROOT: packagePath,
      } : refs.values,
      assertUrlAllowed,
    });
    this.clients.set(serverId, client);
    try {
      const tools = await client.connect();
      if (this.sealed) throw pluginFailure("PLUGIN_GONE", "Workspace MCP instance closed during discovery");
      this.catalogs.set(serverId, tools);
      return tools;
    } catch (error) {
      client.close(); this.clients.delete(serverId); throw error;
    }
  }

  dispose(): void {
    this.sealed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear(); this.catalogs.clear();
  }
}
