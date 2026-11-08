import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as Value from "typebox/value";
import { WorkspaceTerminalService, ShellRegistry, type WorkspacePtyModule } from "@pi-desktop/host-runtime";
import { WorkspaceTerminalEventSchema, WorkspaceTerminalRequestSchema, isTerminalOpenResult, isTerminalShellProfile, parseTerminalWorkspaceId,
  type TerminalTargetContext, type WorkspaceExecutionContext, type WorkspaceTerminalRequest, type WorkspaceTerminalEvent } from "@pi-desktop/shared";
import { createWorkspaceExecutionResolver } from "../workspace-execution-context";
import { sameWorkspacePath } from "../workspace-path";
import { parseRemoteSessionId } from "../remote/backend-router";
import type { RemoteHostClient } from "../remote/remote-host-connection";
import type { HostProcess } from "../host-process";

type Host = Pick<HostProcess, "generation" | "call">;
type Connection = { client: RemoteHostClient; generation: number };
type Binding = {
  workspaceId: string; path: string; hostKey?: string; legacySessionId?: string; sessionId?: string;
  context?: WorkspaceExecutionContext; host?: Host; hostGeneration?: Host["generation"]; connection?: Connection;
};
type Handle = { id: string; backendId: string; binding: Binding; tabId: string; closing?: Promise<unknown> };
type Action = "write" | "resize" | "close" | "replay" | "buffer";
type ActionInput = { data?: string; cols?: number; rows?: number; maxBytes?: number };
export type TerminalHandoffActivity = { terminals: number; uncontainedResources: number };
const fail = (code: string, message: string) => Object.assign(new Error(message), { errorCode: code, code });
const add = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
export type TerminalRouterOptions = {
  isAdmissionClosed(): boolean;
  getHost(): Host | null;
  currentWorkspacePath(): string | null;
  remoteClient(hostKey: string): RemoteHostClient;
  emit(event: WorkspaceTerminalEvent): void;
  loadPty?: () => WorkspacePtyModule | null;
  onError?: (message: string) => void;
};

/** Main owns every handle; renderer hints can never select another machine. */
export class WorkspaceTerminalRouter {
  private readonly handles = new Map<string, Handle>();
  private readonly listeners = new Map<string, { connection: Connection; dispose(): void }>();
  private readonly operations = new Set<Promise<void>>();
  private local: WorkspaceTerminalService | undefined;
  private sealed = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private remoteResources = 0;
  private cleanupUnconfirmed = false;
  private readonly resolveContext;
  private readonly owner = { deviceId: "desktop", connectionId: `window_${randomUUID()}` };
  private readonly options: TerminalRouterOptions;
  constructor(options: TerminalRouterOptions) {
    this.options = options;
    this.resolveContext = createWorkspaceExecutionResolver({
      getHost: () => { this.assertAdmission();return options.getHost(); },
      currentWorkspacePath: options.currentWorkspacePath,
      remoteState: async hostKey => {
        const connection = this.connection(hostKey);
        return { connected: true, generation: connection.generation, platform: "linux" };
      },
    });
  }

  private assertAdmission(): void {
    if (this.sealed) throw fail("TERMINAL_HOST_OFFLINE", "Terminal router is closed");
    if (this.options.isAdmissionClosed()) throw fail("HOST_BUSY", "HOST_BUSY");
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAdmission();
    let done!: () => void;
    const pending = new Promise<void>(resolve => { done = resolve; });
    this.operations.add(pending);
    try { return await operation(); }
    finally { this.operations.delete(pending);done(); }
  }
  getHandoffActivity(): TerminalHandoffActivity {
    const local = this.local?.getHandoffActivity();
    return {
      terminals: add(this.operations.size + this.handles.size + Number(this.sealed && !this.disposed), local?.terminals ?? 0),
      uncontainedResources: add(add(this.remoteResources, local?.uncontainedResources ?? 0), Number(this.cleanupUnconfirmed)),
    };
  }
  private cleanupFailed(): void {
    this.cleanupUnconfirmed = true;
    (this.options.onError ?? console.warn)("Terminal cleanup could not be confirmed; idle handoff remains unavailable");
  }
  private localService(): WorkspaceTerminalService {
    if (this.local) return this.local;
    this.assertAdmission();
    let pty: WorkspacePtyModule | null;
    try { pty = this.options.loadPty ? this.options.loadPty() : createRequire(import.meta.url)("node-pty") as WorkspacePtyModule; }
    catch { pty = null; }
    if (!pty) throw fail("TERMINAL_HOST_UNSUPPORTED", "This Desktop build does not include a working PTY");
    const shells = new ShellRegistry();
    return this.local = new WorkspaceTerminalService({ pty, shells: refresh => shells.listShells(refresh) });
  }

  private assertBinding(binding: Binding): void {
    this.assertAdmission();
    if (binding.host && (this.options.getHost() !== binding.host || binding.host.generation !== binding.hostGeneration)) {
      throw fail("HOST_UNAVAILABLE", "The terminal workspace owner was replaced");
    }
    if (binding.hostKey && binding.connection) {
      const current = this.currentClient(binding.hostKey);
      if (current !== binding.connection.client || (current.generation?.() ?? 1) !== binding.connection.generation) {
        throw fail("WORKSPACE_CHANGED", "The terminal connection changed; reattach before sending input");
      }
    }
  }
  private async binding(target: TerminalTargetContext, previous?: Binding, reconnect = false): Promise<Binding> {
    this.assertAdmission();
    if (previous?.host && (this.options.getHost() !== previous.host || previous.host.generation !== previous.hostGeneration)) {
      throw fail("HOST_UNAVAILABLE", "The terminal workspace owner was replaced");
    }
    if (previous && !reconnect) this.assertBinding(previous);
    if (previous && !previous.context && !previous.legacySessionId) return previous;
    const legacy = target.sessionId ? parseRemoteSessionId(target.sessionId) : null;
    if (legacy) {
      const connection = this.connection(legacy.hostKey);
      const binding: Binding = { workspaceId: target.sessionId!, path: "", hostKey: legacy.hostKey,
        legacySessionId: legacy.hostSessionId, sessionId: target.sessionId, connection };
      await connection.client.request("session/get", { sessionId: legacy.hostSessionId });
      this.assertBinding(binding);
      return binding;
    }
    const host = this.options.getHost();
    if (!host) throw fail("HOST_UNAVAILABLE", "Workspace owner is unavailable");
    const hostGeneration = host.generation;
    let connection: Connection | undefined;
    const context = await this.resolveContext({ sessionId: target.sessionId, context: previous?.context, allowReconnect: reconnect }, async hostKey => {
      connection = this.connection(hostKey);
      return { connected: true, generation: connection.generation, platform: "linux" };
    });
    const binding: Binding = { host, hostGeneration, sessionId: target.sessionId, connection,
      workspaceId: context?.workspaceId ?? `local-home:${this.owner.deviceId}`,
      path: context?.roots.find(root => root.primary)!.path ?? homedir(),
      ...(context ? { context } : {}), ...(context?.authority.kind === "remote" ? { hostKey: context.authority.hostKey } : {}) };
    this.assertBinding(binding);
    if (!context && target.workspaceId) throw fail("WORKSPACE_CHANGED", "This session has no workspace");
    if (context) this.checkHint(target, context);
    return binding;
  }

  private checkHint(target: TerminalTargetContext, context: WorkspaceExecutionContext): void {
    if (!target.workspaceId) return;
    const primary = context.roots.find(root => root.primary)!.path;
    const hint = parseTerminalWorkspaceId(target.workspaceId);
    if (context.authority.kind === "local" && hint && !hint.hostKey
      && sameWorkspacePath(hint.path, primary, context.platform)) return;
    const expected = context.authority.kind === "local" ? [`local:${primary}`, context.workspaceId]
      : [`ssh:${context.authority.hostKey}:${primary}`, `ssh:${context.authority.hostKey}:remote-project:${context.projectId}`, context.workspaceId];
    if (!expected.includes(target.workspaceId)) throw fail("WORKSPACE_CHANGED", "Terminal target differs from its owning project");
  }
  private currentClient(hostKey: string): RemoteHostClient {
    let client: RemoteHostClient;
    try { client = this.options.remoteClient(hostKey); }
    catch { throw fail("TERMINAL_HOST_OFFLINE", "The terminal Host is disconnected"); }
    if (client.state?.() !== "connected") throw fail("TERMINAL_HOST_OFFLINE", "The terminal Host is disconnected");
    return client;
  }
  private connection(hostKey: string): Connection {
    this.assertAdmission();
    const client = this.currentClient(hostKey);
    const generation = client.generation?.() ?? 1;
    const existing = this.listeners.get(hostKey);
    if (existing?.connection.client === client && existing.connection.generation === generation) return existing.connection;
    existing?.dispose();
    const connection = { client, generation };
    const off = client.handleServerRequest?.("workspace/terminalEvent", async event => {
      if (!Value.Check(WorkspaceTerminalEventSchema, event)) throw fail("INVALID_RESPONSE", "Invalid terminal event");
      this.forward(connection, event);return { ok: true };
    });
    const legacyOff = client.subscribe(event => {
      if (event.kind !== "terminal.output" && event.kind !== "terminal.changed") return;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.terminalId !== "string") return;
      if (event.kind === "terminal.output" && typeof payload.data === "string") this.forward(connection, { terminalId: payload.terminalId, data: payload.data });
      else if (payload.state === "exited") this.forward(connection, { terminalId: payload.terminalId, exitCode: typeof payload.code === "number" ? payload.code : null });
    });
    this.listeners.set(hostKey, { connection, dispose: () => { off?.();legacyOff(); } });
    return connection;
  }
  private forward(connection: Connection | undefined, event: WorkspaceTerminalEvent) {
    if (this.sealed) return;
    const record = [...this.handles.values()].find(handle => handle.binding.connection === connection && handle.backendId === event.terminalId);
    if (record) this.options.emit({ ...event, terminalId: record.id });
  }

  private async remoteRequest(binding: Binding, method: string, input: object): Promise<unknown> {
    const connection = binding.connection;
    if (!connection || connection.client.state?.() !== "connected" || (connection.client.generation?.() ?? 1) !== connection.generation) {
      throw fail("TERMINAL_HOST_OFFLINE", "The original terminal connection is unavailable");
    }
    if (method === "terminal/open" || (method === "workspace/terminal" && "action" in input && input.action === "create")) {
      this.remoteResources = add(this.remoteResources, 1);
    }
    try { return await connection.client.request(method, input); }
    catch (error) {
      const code = (error as { code?: string; errorCode?: string }).errorCode ?? (error as { code?: string }).code;
      if (["HOST_DISCONNECTED", "HOST_UNAVAILABLE", "AGENT_UNAVAILABLE"].includes(code ?? "")) throw fail("TERMINAL_HOST_OFFLINE", "Connection lost; input was not replayed");
      throw error;
    }
  }
  private async request(binding: Binding, input: WorkspaceTerminalRequest, cleanup = false): Promise<unknown> {
    if (!Value.Check(WorkspaceTerminalRequestSchema, input)) throw fail("INVALID_ARGUMENT", "Invalid terminal request");
    if (!cleanup) this.assertBinding(binding);
    if (!binding.hostKey) return this.localService().handle(input, this.owner, async event => this.forward(undefined, event), cleanup ? undefined : () => this.assertBinding(binding));
    return this.remoteRequest(binding, "workspace/terminal", input);
  }

  listShells(target: TerminalTargetContext, refresh?: boolean) {
    return this.run(async () => {
      const binding = await this.binding(target);
      if (binding.legacySessionId) return { shells: [{ id: "default", label: "Remote shell", family: "custom", isDefault: true }] };
      const result = await this.request(binding, { action: "list", workspaceId: binding.workspaceId, path: binding.path, refresh }) as { shells?: unknown };
      this.assertBinding(binding);
      if (!Array.isArray(result?.shells) || !result.shells.every(isTerminalShellProfile)) throw fail("INVALID_RESPONSE", "Invalid terminal shell catalog");
      return result;
    });
  }
  create(input: { target: TerminalTargetContext; shellId: string; cols: number; rows: number; cwd?: string }) {
    return this.run(async () => {
      const binding = await this.binding(input.target);
      this.assertBinding(binding);
      let result: unknown;
      if (binding.legacySessionId) {
        if (input.shellId !== "default" || input.cwd) throw fail("INVALID_ARGUMENT", "Legacy session terminal uses the Host's configured shell and root");
        const opened = await this.remoteRequest(binding, "terminal/open", { sessionId: binding.legacySessionId, cols: input.cols, rows: input.rows });
        result = { ...(opened as object), shellId: "default" };
      } else {
        result = await this.request(binding, { action: "create", workspaceId: binding.workspaceId, path: binding.path, tabId: input.target.tabId, shellId: input.shellId, cols: input.cols, rows: input.rows, ...(input.cwd ? { cwd: input.cwd } : {}) });
      }
      if (!isTerminalOpenResult(result)) throw fail("INVALID_RESPONSE", "Invalid terminal creation response");
      const id = `terminal_${randomUUID()}`;
      const handle: Handle = { id, backendId: result.terminalId, binding, tabId: input.target.tabId };
      this.handles.set(id, handle);
      try { this.assertBinding(binding); }
      catch (error) { await this.closeHandle(handle).catch(() => this.cleanupFailed());throw error; }
      return { ...result, terminalId: id };
    });
  }

  action(action: Action, id: string, input: ActionInput = {}): Promise<unknown> {
    return this.run(async () => {
      const handle = this.handles.get(id);
      if (!handle) {
        if (action === "close") return { ok: true };
        if (action === "replay") return { data: null };
        throw fail("TERMINAL_GONE", "Terminal does not belong to this window");
      }
      if (action === "close") return this.closeHandle(handle);
      const original = handle.binding;
      const binding = await this.binding({ sessionId: original.sessionId, tabId: handle.tabId }, original, action === "replay");
      this.assertHandle(handle, original, binding);this.assertBinding(binding);
      const result = await this.perform(handle, binding, action, input);
      try { this.assertHandle(handle, original, binding);this.assertBinding(binding); }
      catch (error) {
        if (action === "replay" || (binding.legacySessionId && action === "buffer")) {
          await this.closeHandle({ ...handle, binding, closing: undefined }).catch(() => this.cleanupFailed());
        }
        throw error;
      }
      if (action === "replay") handle.binding = binding;
      return result;
    });
  }
  private assertHandle(handle: Handle, original: Binding, candidate: Binding): void {
    const current = handle.binding;
    const sameOwner = current === original || (current.host === candidate.host && current.hostGeneration === candidate.hostGeneration
      && current.connection === candidate.connection && current.context?.generation === candidate.context?.generation
      && current.workspaceId === candidate.workspaceId && current.path === candidate.path && current.legacySessionId === candidate.legacySessionId);
    if (this.handles.get(handle.id) !== handle || handle.closing || !sameOwner) throw fail("TERMINAL_GONE", "Terminal changed during the operation");
  }
  private async perform(handle: Handle, binding: Binding, action: Action, input: ActionInput = {}): Promise<unknown> {
    const backendId = handle.backendId;
    if (binding.legacySessionId) {
      if (action === "replay" || action === "buffer") {
        try {
          const reply = await this.remoteRequest(binding, "terminal/open", { sessionId: binding.legacySessionId, terminalId: backendId }) as { replay: string };
          return action === "replay" ? { data: reply.replay } : { text: Buffer.from(reply.replay, "base64").toString("utf8") };
        } catch (error) { if ((error as { code?: string }).code === "NOT_FOUND") return action === "replay" ? { data: null } : { text: "" };throw error; }
      }
      return this.remoteRequest(binding, `terminal/${action === "write" ? "input" : action}`, { terminalId: backendId,
        ...(action === "write" ? { data: Buffer.from(input.data ?? "", "utf8").toString("base64") } : {}),
        ...(action === "resize" ? { cols: input.cols, rows: input.rows } : {}) });
    }
    const request = { action, workspaceId: binding.workspaceId, path: binding.path, terminalId: backendId, ...input };
    if (!Value.Check(WorkspaceTerminalRequestSchema, request)) throw fail("INVALID_ARGUMENT", "Invalid terminal request");
    return this.request(binding, request, action === "close");
  }
  private closeHandle(handle: Handle): Promise<unknown> {
    if (handle.closing) return handle.closing;
    const pending = this.perform(handle, handle.binding, "close").then(result => {
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw fail("INVALID_RESPONSE", "Terminal close was not acknowledged");
      if (this.handles.get(handle.id) === handle) this.handles.delete(handle.id);
      return result;
    });
    handle.closing = pending;
    void pending.catch(() => { if (handle.closing === pending) handle.closing = undefined; });
    return pending;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.sealed = true;
    return this.disposal = this.disposeActive();
  }
  private async disposeActive(): Promise<void> {
    const closes = [...this.handles.values()].map(handle => this.closeHandle(handle).catch(() => this.cleanupFailed()));
    await Promise.allSettled([...this.operations, ...closes]);
    try { this.local?.dispose(); } catch { this.cleanupFailed(); }
    await this.local?.drainOutput();
    this.handles.clear();
    for (const listener of this.listeners.values()) {
      try { listener.dispose(); } catch { this.cleanupFailed(); }
    }
    this.listeners.clear();this.disposed = true;
  }
}
