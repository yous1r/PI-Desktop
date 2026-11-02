import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isActiveInProject,
  type McpServerRecord,
  type McpServerStatus,
} from "@pi-desktop/shared";
import { userMcpToolName } from "@pi-desktop/plugin-sdk";
import type { McpServerClient, McpTool } from "./plugin-mcp";
import { McpCallRegistry } from "./mcp-call-registry.ts";
import type { McpSecurityService } from "./mcp-security.ts";
import { createMcpTlsFetch } from "./mcp-tls.ts";
import { boundMemoryArguments, memoryToolDescription } from "./mcp-memory-bindings.ts";

/**
 * MCP servers the user configured directly, with no plugin around them.
 *
 * host-core owns the records; this runtime owns the processes and sockets. A
 * server is connected the first time a session that can see it is assembled.
 * Stdio clients are cached per workspace, so another session in the same
 * project reuses the process while a different project gets its own cwd.
 * Editing or disabling a server drops all of its connections. Previously
 * discovered names survive transport loss as routing hints, never as
 * permission to call a tool absent from the new handshake.
 */
export type UserMcpToolDescriptor = {
  /** `mcp_<serverId>_<tool>`, the name the model calls. */
  fullName: string;
  serverId: string;
  toolName: string;
  description: string;
  schema?: unknown;
};

/** The slice of {@link McpServerClient} this runtime drives. */
export type UserMcpClient = Pick<
  McpServerClient,
  "connect" | "callTool" | "getTools" | "isConnected" | "close" | "ping"
>;

export type UserMcpClientConfig = ConstructorParameters<typeof McpServerClient>[0];

export type UserMcpOAuthHandler = {
  getValidAccessToken: (serverId: string) => Promise<string | null>;
  hasOAuth: (serverId: string) => Promise<boolean>;
};

export type UserMcpRuntimeOptions = {
  /**
   * How a connection is made.
   *
   * Injected rather than imported because every value import would make this
   * module unloadable by the test runner, which reads it with Node's
   * type-stripping loader and cannot resolve extensionless specifiers. Keeping
   * the import type-only is what lets the runtime be tested against real
   * servers.
   */
  createClient: (config: UserMcpClientConfig) => UserMcpClient;
  oauth?: UserMcpOAuthHandler;
  security?: McpSecurityService;
  audit?: (entry: Record<string, unknown>) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  discoveryTimeoutMs?: number;
};

type Entry = {
  key: string;
  record: McpServerRecord;
  client: UserMcpClient;
  status: McpServerStatus;
  connecting?: Promise<McpTool[]>;
  oauthToken?: string | null;
  activeCalls: number;
  lastUsedAt: number;
};

/**
 * Servers whose processes may be alive at once.
 *
 * 16 is the width the app already uses for per-owner resource caps (watched
 * plugins, bus subscriptions, in-flight tools); a session that wants more than
 * sixteen MCP servers has a configuration problem, not a limit problem.
 */
const MAX_ACTIVE_SERVERS = 16;
const MAX_CACHED_CONNECTIONS = MAX_ACTIVE_SERVERS * 4;

export class UserMcpRuntime {
  private entries = new Map<string, Entry>();
  private statusRefreshes = new Map<string, Promise<void>>();
  private readonly calls = new McpCallRegistry();
  // Routing identity must survive a transport clearing its own tools on close.
  // These names are hints only: dispatch revalidates the fresh handshake list.
  private discoveredTools = new Map<string, Set<string>>();
  private records: McpServerRecord[] = [];
  private options: UserMcpRuntimeOptions;
  private generations = new Map<string, number>();
  private lifecycleGeneration = 0;
  private connectionFailures = new Map<string, McpServerStatus>();

  // Spelled out rather than a constructor parameter property, because the test
  // runner loads this file with Node's type-stripping loader, which rejects them.
  constructor(options: UserMcpRuntimeOptions) {
    this.options = options;
  }

  /**
   * Adopt a fresh list from host-core. Servers whose configuration changed —
   * or that vanished — lose their connection so the next call re-handshakes
   * against what the user actually saved.
   */
  setRecords(records: McpServerRecord[]): void {
    this.records = records.map((record) => ({ ...record }));
    const byId = new Map(this.records.map((record) => [record.id, record]));
    for (const id of this.connectionFailures.keys()) if (!byId.has(id)) this.connectionFailures.delete(id);
    for (const id of this.discoveredTools.keys()) {
      if (!byId.has(id)) this.discoveredTools.delete(id);
    }
    for (const [key, entry] of [...this.entries]) {
      const next = byId.get(entry.record.id);
      if (!next || configurationChanged(entry.record, next)) {
        entry.client.close();
        this.entries.delete(key);
        continue;
      }
      entry.record = next;
    }
  }

  getSecurityService(): McpSecurityService | undefined {
    return this.options.security;
  }

  listRecords(): McpServerRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Per-server connection state for the Extensions page. */
  listStatuses(): McpServerStatus[] {
    return this.records.map((record) => this.statusFor(record.id));
  }

  /** Confirm ready remote connections when the settings page refreshes. */
  async refreshStatuses(): Promise<McpServerStatus[]> {
    await Promise.all([...this.entries].map(async ([key, entry]) => {
      if (entry.record.transport === "stdio" || entry.status.state !== "ready") return;
      let pending = this.statusRefreshes.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            await entry.client.ping();
          } catch (error) {
            if (this.entries.get(key) !== entry) return;
            // A settings probe must not abort a tool call already in flight.
            // Test connection will close this client before retrying.
            const message = error instanceof Error ? error.message : "mcp server did not respond";
            entry.status = {
              ...entry.status,
              state: "failed",
              toolCount: 0,
              message: message.slice(0, 500),
              updatedAt: Date.now(),
            };
          }
        })();
        this.statusRefreshes.set(key, pending);
      }
      try {
        await pending;
      } finally {
        if (this.statusRefreshes.get(key) === pending) this.statusRefreshes.delete(key);
      }
    }));
    return this.listStatuses();
  }

  statusFor(serverId: string): McpServerStatus {
    const failure = this.connectionFailures.get(serverId);
    if (failure) return { ...failure };
    const entry = [...this.entries.values()]
      .filter((candidate) => candidate.record.id === serverId)
      .sort((left, right) => right.status.updatedAt - left.status.updatedAt)[0];
    if (entry) return { ...entry.status };
    return {
      serverId,
      state: "idle",
      toolCount: 0,
      updatedAt: Date.now(),
    };
  }

  /**
   * Connect every server active in `projectPath` and return their tools.
   *
   * Called while assembling a session, so a slow or broken server must not block
   * the turn: each handshake has its own timeout and a failure is recorded as
   * status rather than thrown.
   */
  async toolsForProject(projectPath: string | null | undefined): Promise<UserMcpToolDescriptor[]> {
    const active = this.records.filter((record) => isActiveInProject(record, projectPath));
    const admitted = active.slice(0, MAX_ACTIVE_SERVERS);
    if (admitted.length < active.length) {
      this.options.log?.("warn", "user mcp servers skipped over the active cap", {
        limit: MAX_ACTIVE_SERVERS,
        skipped: active.length - admitted.length,
      });
    }
    const lists = await Promise.all(admitted.map(async (record) => {
      const result = await this.connect(record, projectPath);
      return result.tools;
    }));
    const out: UserMcpToolDescriptor[] = [];
    admitted.forEach((record, index) => {
      const current = this.records.find((item) => item.id === record.id);
      if (!current || !isActiveInProject(current, projectPath) || configurationChanged(record, current)) return;
      for (const tool of lists[index]) {
        out.push({
          fullName: userMcpToolName(record.id, tool.name),
          serverId: record.id,
          toolName: tool.name,
          description: memoryToolDescription(record, tool.name, tool.description ?? `${record.label} tool "${tool.name}" (MCP)`, projectPath),
          schema: tool.inputSchema,
        });
      }
    });
    return out;
  }

  /** Whether a saved server advertised this name (not a readiness check). */
  hasTool(fullName: string): boolean {
    return this.findTool(fullName) !== undefined;
  }

  /**
   * Run a tool. The name carries the server id, but the lookup goes through the
   * cached tool list so a name the server never advertised is refused instead of
   * forwarded — and a server the user has since scoped away cannot be reached
   * from a session that still remembers the tool.
   */
  async callTool(
    fullName: string,
    args: unknown,
    projectPath: string | null | undefined,
    sessionId?: string,
  ): Promise<unknown> {
    return this.calls.run(sessionId, (signal) => this.callToolActive(fullName, args, projectPath, signal));
  }

  private async callToolActive(
    fullName: string,
    args: unknown,
    projectPath: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const found = this.findTool(fullName);
    if (!found) {
      throw Object.assign(new Error(`unknown mcp tool: ${fullName}`), {
        errorCode: "TOOL_NOT_FOUND",
      });
    }
    const record = this.records.find((entry) => entry.id === found.serverId);
    if (!record || !isActiveInProject(record, projectPath)) {
      throw Object.assign(
        new Error(`mcp server ${found.serverId} is not active for this session`),
        { errorCode: "TOOL_NOT_FOUND" },
      );
    }
    const { entry } = await this.connect(record, projectPath, true);
    if (!entry) {
      throw Object.assign(new Error(`mcp server ${found.serverId} is unavailable`), {
        errorCode: "UNAVAILABLE",
      });
    }
    try {
      // Configuration or scope can change while the handshake is in flight.
      const current = this.records.find((entry) => entry.id === found.serverId);
      if (!current || !isActiveInProject(current, projectPath)) {
        throw Object.assign(
          new Error(`mcp server ${found.serverId} is not active for this session`),
          { errorCode: "TOOL_NOT_FOUND" },
        );
      }
      if (
        configurationChanged(record, current) ||
        entry.status.state !== "ready" || !entry.client.isConnected()
      ) {
        throw Object.assign(new Error(`mcp server ${found.serverId} is unavailable`), {
          errorCode: "UNAVAILABLE",
        });
      }
      if (!entry.client.getTools().some((tool) => tool.name === found.toolName)) {
        throw Object.assign(new Error(`unknown mcp tool: ${fullName}`), {
          errorCode: "TOOL_NOT_FOUND",
        });
      }
      // Do not retry tools/call: a failed response may have followed a mutation.
      try {
        return await entry.client.callTool(found.toolName, boundMemoryArguments(current, found.toolName, args, projectPath), signal);
      } catch (error) {
        const msg = (error as Error).message || "";
        if (msg.includes("401") || (error as { status?: number }).status === 401) {
          entry.status = {
            ...entry.status,
            state: "failed",
            authRequired: true,
            message: msg.slice(0, 500),
            updatedAt: Date.now(),
          };
        }
        throw error;
      }
    } finally {
      entry.activeCalls -= 1;
    }
  }

  /**
   * Handshake once and report what happened, for the editor's "Test connection"
   * button. The connection is kept: a user who just tested a server is about to
   * use it.
   */
  async test(serverId: string): Promise<McpServerStatus> {
    const record = this.records.find((entry) => entry.id === serverId);
    if (!record) {
      return {
        serverId,
        state: "failed",
        toolCount: 0,
        message: "server not found",
        updatedAt: Date.now(),
      };
    }
    // Force a fresh handshake so a fixed command is retried rather than
    // reporting the cached failure.
    const key = connectionKey(record, null);
    this.entries.get(key)?.client.close();
    this.entries.delete(key);
    const { entry } = await this.connect(record, null);
    if (entry?.status.state === "ready" && record.id === "superclaude-memory" && entry.client.getTools().some((tool) => tool.name === "sc_memory_projects")) {
      try {
        const result = await entry.client.callTool("sc_memory_projects", {});
        if (this.entries.get(key) !== entry) return this.statusFor(serverId);
        const wrapped = result && typeof result === "object" ? result as Record<string, unknown> : {};
        let grants = wrapped.structuredContent;
        if (!grants && Array.isArray(wrapped.content)) {
          const text = wrapped.content.find((part) => part?.type === "text" && typeof part.text === "string");
          if (text) grants = JSON.parse(text.text);
        }
        if (grants && typeof grants === "object" && !Array.isArray(grants)) {
          const value = grants as Record<string, unknown>;
          const projects = Array.isArray(value.projects) ? value.projects : [];
          entry.status = { ...entry.status, connectionLocation: "desktop",
            authorizedProjects: projects.flatMap((item) => item && typeof item === "object" && typeof item.id === "string" ? [item.id] : []).slice(0, 200),
            authorizationPatterns: Array.isArray(value.patterns) ? value.patterns.filter((item): item is string => typeof item === "string").slice(0, 200) : [],
          };
        }
      } catch (error) {
        if (this.entries.get(key) === entry) this.recordFailure(record, error);
      }
    }
    return this.statusFor(serverId);
  }

  /** Drop a connection. Credential edits may retain routing hints; fresh discovery still authorizes every call. */
  invalidate(serverId: string, keepRoutingHints = false): void {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
    this.connectionFailures.delete(serverId);
    for (const [key, entry] of [...this.entries]) {
      if (entry.record.id === serverId) {
        entry.client.close();
        this.entries.delete(key);
      }
    }
    if (!keepRoutingHints) this.discoveredTools.delete(serverId);
  }

  /** Drop every connection, e.g. on quit. */
  disposeAll(): void {
    this.lifecycleGeneration += 1;
    this.generations.clear();
    this.connectionFailures.clear();
    this.calls.cancelAll();
    for (const entry of this.entries.values()) entry.client.close();
    this.entries.clear();
    this.statusRefreshes.clear();
    this.discoveredTools.clear();
  }

  cancelSessionCalls(sessionId: string): void {
    this.calls.cancelSession(sessionId);
  }

  private findTool(fullName: string): { serverId: string; toolName: string } | undefined {
    for (const [serverId, tools] of this.discoveredTools) {
      for (const toolName of tools) {
        if (userMcpToolName(serverId, toolName) === fullName) {
          return { serverId, toolName };
        }
      }
    }
    return undefined;
  }

  private async connect(
    record: McpServerRecord,
    projectPath: string | null | undefined = null,
    pin = false,
  ): Promise<{ tools: McpTool[]; entry?: Entry }> {
    const generation = this.generations.get(record.id) ?? 0;
    const lifecycle = this.lifecycleGeneration;
    let oauthToken: string | null = null;
    if (record.transport === "http") {
      try {
        if (record.authType === "bearer") {
          if (!this.options.security) throw Object.assign(new Error("Managed MCP credentials are unavailable. Configure the server in settings."), { errorCode: "MCP_AUTH_REQUIRED" });
          oauthToken = await this.options.security.getBearerToken(record);
        } else if (this.options.oauth) {
          try { oauthToken = await this.options.oauth.getValidAccessToken(record.id); } catch { oauthToken = null; }
        }
      } catch (error) {
        const current = this.records.find((item) => item.id === record.id);
        if (lifecycle !== this.lifecycleGeneration || generation !== (this.generations.get(record.id) ?? 0) || !current || configurationChanged(record, current)) return { tools: [] };
        return this.recordFailure(record, error);
      }
    }
    const current = this.records.find((item) => item.id === record.id);
    if (lifecycle !== this.lifecycleGeneration || generation !== (this.generations.get(record.id) ?? 0) || !current || configurationChanged(record, current)) return { tools: [] };
    this.connectionFailures.delete(record.id);

    const key = connectionKey(record, projectPath);
    let existing = this.entries.get(key);
    if (existing && record.transport === "http" && existing.oauthToken !== oauthToken) {
      existing.client.close();
      this.entries.delete(key);
      existing = undefined;
    }

    if (!existing && !this.makeRoom()) {
      this.options.log?.("warn", "user mcp connection cache is full", {
        serverId: record.id,
        limit: MAX_CACHED_CONNECTIONS,
      });
      return { tools: [] };
    }

    if (existing?.connecting) {
      if (pin) existing.activeCalls += 1;
      existing.lastUsedAt = Date.now();
      return { tools: await existing.connecting, entry: existing };
    }
    if (existing?.client.isConnected()) {
      if (pin) existing.activeCalls += 1;
      existing.lastUsedAt = Date.now();
      return { tools: existing.client.getTools(), entry: existing };
    }
    // A server that already failed its handshake this run stays failed until the
    // user edits it or asks for a test, so every session assembly does not pay
    // the connect timeout again.
    if (existing?.status.state === "failed") {
      if (pin) existing.activeCalls += 1;
      existing.lastUsedAt = Date.now();
      return { tools: [], entry: existing };
    }

    let entry: Entry;
    try { entry = existing ?? this.createEntry(record, oauthToken, key, projectPath); }
    catch (error) { return this.recordFailure(record, error); }
    if (pin) entry.activeCalls += 1;
    entry.lastUsedAt = Date.now();
    entry.connecting = this.handshake(record, entry).finally(() => {
      entry.connecting = undefined;
    });
    return { tools: await entry.connecting, entry };
  }

  private recordFailure(record: McpServerRecord, error: unknown): { tools: McpTool[] } {
    this.invalidate(record.id, true);
    const coded = error && typeof error === "object" ? error as { errorCode?: string; code?: string } : {};
    const errorCode = coded.errorCode ?? coded.code ?? "MCP_CONNECTION_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 500) : "MCP connection failed.";
    const status: McpServerStatus = { serverId: record.id, state: "failed", toolCount: 0, message, errorCode,
      connectionLocation: "desktop", updatedAt: Date.now(), authRequired: errorCode.startsWith("MCP_AUTH_") || message.includes("401") };
    this.connectionFailures.set(record.id, status);
    this.options.log?.("warn", "user mcp connection configuration failed", { serverId: record.id, errorCode });
    return { tools: [] };
  }

  private async handshake(record: McpServerRecord, entry: Entry): Promise<McpTool[]> {
    entry.status = {
      ...entry.status,
      state: "connecting",
      updatedAt: Date.now(),
    };
    try {
      const tools = await entry.client.connect();
      // An edited/deleted record must not resurrect a discarded connection.
      if (this.entries.get(entry.key) !== entry) {
        entry.client.close();
        return [];
      }
      const catalog = this.discoveredTools.get(record.id) ?? new Set<string>();
      for (const tool of tools) catalog.add(tool.name);
      this.discoveredTools.set(record.id, catalog);
      entry.status = {
        serverId: record.id,
        state: "ready",
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        updatedAt: Date.now(),
        authRequired: false,
      };
      return tools;
    } catch (error) {
      if (this.entries.get(entry.key) !== entry) return [];
      const msg = error instanceof Error ? error.message : "MCP connection failed.";
      const coded = error && typeof error === "object" ? error as { errorCode?: unknown; code?: unknown } : {};
      const errorCode = typeof coded.errorCode === "string" ? coded.errorCode
        : typeof coded.code === "string" ? coded.code : "MCP_CONNECTION_FAILED";
      entry.status = {
        serverId: record.id,
        state: "failed",
        toolCount: 0,
        message: msg.slice(0, 500),
        errorCode,
        connectionLocation: "desktop",
        updatedAt: Date.now(),
        authRequired: errorCode.startsWith("MCP_AUTH_") || msg.includes("401"),
      };
      this.options.log?.("warn", "user mcp server failed to connect", {
        serverId: record.id,
        errorCode,
        message: entry.status.message,
      });
      return [];
    }
  }

  private createEntry(
    record: McpServerRecord,
    oauthToken: string | null | undefined,
    key: string,
    projectPath: string | null | undefined,
  ): Entry {
    const headers = {
      ...(record.headers ?? {}),
      ...(oauthToken ? { Authorization: `Bearer ${oauthToken}` } : {}),
    };
    const customTimeoutMs =
      typeof record.timeoutSeconds === "number" && record.timeoutSeconds > 0
        ? record.timeoutSeconds * 1000
        : undefined;
    const client = this.options.createClient({
      // Stdio servers inherit the session workspace as their cwd. HTTP
      // transports do not spawn a child and keep the existing home default.
      rootPath: record.transport === "stdio" ? workspacePath(projectPath) : homedir(),
      commandPolicy: "trusted",
      server: {
        id: record.id,
        label: record.label,
        transport: record.transport,
        command: record.command,
        args: record.args ?? [],
        env: record.env ?? {},
        url: record.url,
        headers,
      },
      values: record.transport === "stdio" ? (record.env ?? {}) : headers,
      ...(oauthToken ? { redactValues: [oauthToken] } : {}),
      audit: this.options.audit,
      auditScope: "mcp",
      ...(record.caCertificate ? { fetchImpl: createMcpTlsFetch(record.caCertificate) } : {}),
      ...(record.authType === "bearer" || record.caCertificate ? {
        assertUrlAllowed: (url: string) => {
          if (new URL(url).toString() !== new URL(record.url ?? "").toString()) {
            throw Object.assign(new Error("Redirects are refused for managed MCP credentials and CA settings."), { errorCode: "MCP_HTTP_REDIRECT" });
          }
        },
      } : {}),
      connectTimeoutMs: customTimeoutMs ?? this.options.connectTimeoutMs,
      callTimeoutMs: customTimeoutMs ? Math.max(customTimeoutMs, this.options.callTimeoutMs ?? 0) : this.options.callTimeoutMs,
      discoveryTimeoutMs: customTimeoutMs ? Math.max(customTimeoutMs, this.options.discoveryTimeoutMs ?? 0) : this.options.discoveryTimeoutMs,
    });
    const entry: Entry = {
      key,
      record,
      client,
      oauthToken,
      activeCalls: 0,
      lastUsedAt: Date.now(),
      status: {
        serverId: record.id,
        state: "idle",
        toolCount: 0,
        updatedAt: Date.now(),
      },
    };
    this.entries.set(key, entry);
    return entry;
  }

  private makeRoom(): boolean {
    if (this.entries.size < MAX_CACHED_CONNECTIONS) return true;
    const candidate = [...this.entries.values()]
      .filter((entry) =>
        !entry.connecting &&
        entry.activeCalls === 0 &&
        !this.statusRefreshes.has(entry.key)
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) return false;
    candidate.client.close();
    this.entries.delete(candidate.key);
    return true;
  }
}

function workspacePath(projectPath: string | null | undefined): string {
  return projectPath ? resolve(projectPath) : homedir();
}

function connectionKey(record: McpServerRecord, projectPath: string | null | undefined): string {
  if (record.transport !== "stdio") return JSON.stringify([record.id, "http"]);
  const rootPath = workspacePath(projectPath);
  const identity = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  return JSON.stringify([record.id, identity]);
}

/**
 * Whether a saved edit invalidates a live connection. Scope, label and
 * description do not: they change who may call the server, not what it is.
 */
export function configurationChanged(before: McpServerRecord, after: McpServerRecord): boolean {
  if (before.enabled !== after.enabled && !after.enabled) return true;
  return (
    before.transport !== after.transport ||
    before.command !== after.command ||
    JSON.stringify(before.args ?? []) !== JSON.stringify(after.args ?? []) ||
    JSON.stringify(before.env ?? {}) !== JSON.stringify(after.env ?? {}) ||
    before.url !== after.url ||
    before.authType !== after.authType ||
    before.credentialRef !== after.credentialRef ||
    before.caCertificate !== after.caCertificate ||
    JSON.stringify(before.memoryProjectBindings ?? {}) !== JSON.stringify(after.memoryProjectBindings ?? {}) ||
    JSON.stringify(before.headers ?? {}) !== JSON.stringify(after.headers ?? {}) ||
    before.timeoutSeconds !== after.timeoutSeconds
  );
}
