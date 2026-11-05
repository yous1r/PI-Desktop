import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as Value from "typebox/value";
import { WorkspaceTerminalService, ShellRegistry, type WorkspacePtyModule } from "@pi-desktop/host-runtime";
import { WorkspaceTerminalEventSchema, WorkspaceTerminalRequestSchema, isTerminalOpenResult, isTerminalShellProfile,
  type TerminalTargetContext, type WorkspaceExecutionContext, type WorkspaceTerminalRequest, type WorkspaceTerminalEvent } from "@pi-desktop/shared";
import { createWorkspaceExecutionResolver } from "../workspace-execution-context";
import { parseRemoteSessionId } from "../remote/backend-router";
import type { RemoteHostClient } from "../remote/remote-host-connection";

type Host = { call<T>(method: string, input?: unknown): Promise<T> };
type Binding = { workspaceId: string; path: string; hostKey?: string; legacySessionId?: string; sessionId?: string; context?: WorkspaceExecutionContext };
type Handle = { id: string; backendId: string; binding: Binding; tabId: string };
const fail = (code: string, message: string) => Object.assign(new Error(message), { errorCode: code, code });
export type TerminalRouterOptions = {
  getHost(): Host | null;
  currentWorkspacePath(): string | null;
  remoteClient(hostKey: string): RemoteHostClient;
  emit(event: WorkspaceTerminalEvent): void;
  loadPty?: () => WorkspacePtyModule | null;
};

/** Main owns every handle; renderer hints can never select another machine. */
export class WorkspaceTerminalRouter {
  private readonly handles = new Map<string, Handle>();
  private readonly listeners = new Map<string, { client: RemoteHostClient; dispose(): void }>();
  private local: WorkspaceTerminalService | undefined;
  private sealed = false;
  private readonly resolveContext;
  private readonly owner = { deviceId: "desktop", connectionId: `window_${randomUUID()}` };
  private readonly options: TerminalRouterOptions;
  constructor(options: TerminalRouterOptions) {
    this.options = options;
    this.resolveContext = createWorkspaceExecutionResolver({
      getHost: options.getHost, currentWorkspacePath: options.currentWorkspacePath,
      remoteState: async hostKey => {
        const client = options.remoteClient(hostKey);
        return { connected: client.state?.() === "connected", generation: client.generation?.() ?? 1, platform: "linux" };
      },
    });
  }

  private localService(): WorkspaceTerminalService {
    if (this.local) return this.local;
    let pty: WorkspacePtyModule | null;
    try { pty = this.options.loadPty ? this.options.loadPty() : createRequire(import.meta.url)("node-pty") as WorkspacePtyModule; }
    catch { pty = null; }
    if (!pty) throw fail("TERMINAL_HOST_UNSUPPORTED", "This Desktop build does not include a working PTY");
    const shells = new ShellRegistry();
    return this.local = new WorkspaceTerminalService({ pty, shells: refresh => shells.listShells(refresh) });
  }

  private async binding(target: TerminalTargetContext): Promise<Binding> {
    const legacy = target.sessionId ? parseRemoteSessionId(target.sessionId) : null;
    if (legacy) {
      // The paired server authorizes this durable remote session, including its root.
      const client = this.client(legacy.hostKey);
      await client.request("session/get", { sessionId: legacy.hostSessionId });
      return { workspaceId: target.sessionId!, path: "", hostKey: legacy.hostKey, legacySessionId: legacy.hostSessionId, sessionId: target.sessionId };
    }
    const context = await this.resolveContext({ sessionId: target.sessionId });
    if (!context) {
      if (target.workspaceId) throw fail("WORKSPACE_CHANGED", "This session has no workspace");
      return { workspaceId: `local-home:${this.owner.deviceId}`, path: homedir(), sessionId: target.sessionId };
    }
    this.checkHint(target, context);
    return { context, workspaceId: context.workspaceId, path: context.roots.find(root => root.primary)!.path,
      ...(context.authority.kind === "remote" ? { hostKey: context.authority.hostKey } : {}), sessionId: target.sessionId };
  }

  private checkHint(target: TerminalTargetContext, context: WorkspaceExecutionContext): void {
    if (!target.workspaceId) return;
    const primary = context.roots.find(root => root.primary)!.path;
    const expected = context.authority.kind === "local" ? [`local:${primary}`, context.workspaceId]
      : [`ssh:${context.authority.hostKey}:${primary}`, `ssh:${context.authority.hostKey}:remote-project:${context.projectId}`, context.workspaceId];
    if (!expected.includes(target.workspaceId)) throw fail("WORKSPACE_CHANGED", "Terminal target differs from its owning project");
  }

  private client(hostKey: string): RemoteHostClient {
    let client: RemoteHostClient;
    try { client = this.options.remoteClient(hostKey); }
    catch { throw fail("TERMINAL_HOST_OFFLINE", "The terminal Host is disconnected"); }
    if (client.state?.() !== "connected") throw fail("TERMINAL_HOST_OFFLINE", "The terminal Host is disconnected");
    const existing = this.listeners.get(hostKey);
    if (existing?.client !== client) {
      existing?.dispose();
      const off = client.handleServerRequest?.("workspace/terminalEvent", async event => {
        if (!Value.Check(WorkspaceTerminalEventSchema, event)) throw fail("INVALID_RESPONSE", "Invalid terminal event");
        this.forward(hostKey, event); return { ok: true };
      });
      const legacyOff = client.subscribe(event => {
        if (event.kind !== "terminal.output" && event.kind !== "terminal.changed") return;
        const payload = event.payload as Record<string, unknown>;
        if (typeof payload.terminalId !== "string") return;
        if (event.kind === "terminal.output" && typeof payload.data === "string") this.forward(hostKey, { terminalId: payload.terminalId, data: payload.data });
        else if (payload.state === "exited") this.forward(hostKey, { terminalId: payload.terminalId, exitCode: typeof payload.code === "number" ? payload.code : null });
      });
      this.listeners.set(hostKey, { client, dispose: () => { off?.(); legacyOff(); } });
    }
    return client;
  }

  private forward(hostKey: string | undefined, event: WorkspaceTerminalEvent) {
    const record = [...this.handles.values()].find(handle => handle.binding.hostKey === hostKey && handle.backendId === event.terminalId);
    if (record) this.options.emit({ ...event, terminalId: record.id });
  }

  private async request(binding: Binding, input: WorkspaceTerminalRequest): Promise<unknown> {
    if (!Value.Check(WorkspaceTerminalRequestSchema, input)) throw fail("INVALID_ARGUMENT", "Invalid terminal request");
    if (!binding.hostKey) return this.localService().handle(input, this.owner, async event => this.forward(undefined, event));
    try { return await this.client(binding.hostKey).request("workspace/terminal", input); }
    catch (error) {
      const code = (error as {code?:string;errorCode?:string}).errorCode ?? (error as {code?:string}).code;
      if (["HOST_DISCONNECTED", "HOST_UNAVAILABLE", "AGENT_UNAVAILABLE"].includes(code ?? "")) throw fail("TERMINAL_HOST_OFFLINE", "Connection lost; input was not replayed");
      throw error;
    }
  }

  async listShells(target: TerminalTargetContext, refresh?: boolean) {
    const binding = await this.binding(target);
    if (binding.legacySessionId) return { shells: [{ id: "default", label: "Remote shell", family: "custom", isDefault: true }] };
    const result = await this.request(binding, { action: "list", workspaceId: binding.workspaceId, path: binding.path, refresh }) as { shells?: unknown };
    if (!Array.isArray(result?.shells) || !result.shells.every(isTerminalShellProfile)) throw fail("INVALID_RESPONSE", "Invalid terminal shell catalog");
    return result;
  }

  async create(input: { target: TerminalTargetContext; shellId: string; cols: number; rows: number; cwd?: string }) {
    if (this.sealed) throw fail("TERMINAL_HOST_OFFLINE", "Terminal router is closed");
    const binding = await this.binding(input.target);
    if (this.sealed) throw fail("TERMINAL_HOST_OFFLINE", "Terminal router is closed");
    let result: unknown;
    if (binding.legacySessionId) {
      if (input.shellId !== "default" || input.cwd) throw fail("INVALID_ARGUMENT", "Legacy session terminal uses the Host's configured shell and root");
      const opened = await this.client(binding.hostKey!).request<{terminalId:string;cols:number;rows:number}>("terminal/open", { sessionId: binding.legacySessionId, cols: input.cols, rows: input.rows });
      result = { ...opened, shellId: "default" };
    } else result = await this.request(binding, { action: "create", workspaceId: binding.workspaceId, path: binding.path, tabId: input.target.tabId, shellId: input.shellId, cols: input.cols, rows: input.rows, ...(input.cwd ? {cwd: input.cwd} : {}) });
    if (!isTerminalOpenResult(result)) throw fail("INVALID_RESPONSE", "Invalid terminal creation response");
    const id = `terminal_${randomUUID()}`;
    const handle = { id, backendId: result.terminalId, binding, tabId: input.target.tabId };
    this.handles.set(id, handle);
    if (this.sealed) { await this.action("close", id); throw fail("TERMINAL_HOST_OFFLINE", "Terminal router closed during creation"); }
    return { ...result, terminalId: id };
  }

  async action(action: "write" | "resize" | "close" | "replay" | "buffer", id: string, input: {data?:string;cols?:number;rows?:number;maxBytes?:number} = {}): Promise<unknown> {
    const handle = this.handles.get(id);
    if (!handle) {
      if (action === "close") return { ok: true };
      if (action === "replay") return { data: null };
      throw fail("TERMINAL_GONE", "Terminal does not belong to this window");
    }
    const { binding, backendId } = handle;
    // Reconnection is explicit: only replay may admit the new connection generation.
    if (action !== "close" && binding.context) {
      if (binding.hostKey) this.client(binding.hostKey);
      const context = await this.resolveContext({sessionId:binding.sessionId, context:binding.context, allowReconnect:action === "replay"});
      if (!context) throw fail("WORKSPACE_CHANGED", "Terminal workspace is unavailable");
      if (action === "replay") binding.context = context;
    }
    let result: unknown;
    if (binding.legacySessionId) {
      const client = this.client(binding.hostKey!);
      if (action === "replay" || action === "buffer") {
        try {
          const reply = await client.request<{replay:string}>("terminal/open", { sessionId: binding.legacySessionId, terminalId: backendId });
          result = action === "replay" ? {data:reply.replay} : {text:Buffer.from(reply.replay,"base64").toString("utf8")};
        } catch (error) { if ((error as {code?:string}).code === "NOT_FOUND") result = action === "replay" ? {data:null} : {text:""}; else throw error; }
      } else {
        result = await client.request(`terminal/${action === "write" ? "input" : action}`, {terminalId:backendId,
          ...(action === "write" ? {data:Buffer.from(input.data ?? "","utf8").toString("base64")} : {}),
          ...(action === "resize" ? {cols:input.cols,rows:input.rows} : {})});
      }
    } else {
      const request = { action, workspaceId: binding.workspaceId, path: binding.path, terminalId: backendId, ...input };
      if (!Value.Check(WorkspaceTerminalRequestSchema, request)) throw fail("INVALID_ARGUMENT", "Invalid terminal request");
      result = await this.request(binding, request);
    }
    if (action === "close") this.handles.delete(id);
    return result;
  }

  async dispose(): Promise<void> {
    this.sealed = true;
    await Promise.allSettled([...this.handles.keys()].map(id => this.action("close", id)));
    this.local?.dispose(); this.handles.clear();
    for (const listener of this.listeners.values()) listener.dispose();
    this.listeners.clear();
  }
}
