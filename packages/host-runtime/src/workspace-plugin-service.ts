import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { WorkspaceExecutionContext, WorkspacePluginRequest, WorkspacePluginEvent, WorkspacePluginOwner } from "@pi-desktop/shared";
import { WorkspacePluginPackages } from "./plugin-packages.js";
import { WorkspacePluginFiles } from "./workspace-plugin-files.js";
import { PluginMessageDecoder, encodePluginMessage, pluginFrames, pluginFailure, PLUGIN_MESSAGE_BYTES } from "./plugin-wire.js";
import { workspaceShellEnvironment, type WorkspacePtyModule } from "./workspace-terminal-service.js";
import { WorkspacePluginExecution } from "./workspace-plugin-execution.js";
import { WorkspacePluginMcp } from "./workspace-plugin-mcp.js";
import type { PluginManifest } from "@pi-desktop/plugin-sdk";

type Sink = (event: WorkspacePluginEvent) => Promise<void>;
type Instance = {
  id: string; owner: WorkspacePluginOwner; context: WorkspaceExecutionContext; child: ChildProcess;
  decoder: PluginMessageDecoder; sink: Sink; pending: Promise<void>; queued: number; closed: boolean;
  apiCalls: Map<string, AbortController>; mcp: WorkspacePluginMcp; execution: WorkspacePluginExecution; files: WorkspacePluginFiles; packagePath: string; dataPath: string; manifest: Record<string, unknown>; entry: string; initialized: boolean;
};
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Remote Node processes have SSH-user privileges; SDK checks are not an OS sandbox. */
export class WorkspacePluginService {
  readonly packages: WorkspacePluginPackages;
  private readonly instances = new Map<string, Instance>();
  private readonly admissions = new Map<string, Set<{ cancelled: boolean; deviceId: string }>>();
  private sealed = false;
  private readonly options: { dataDir: string; runner: string; env?: NodeJS.ProcessEnv; pty?: () => WorkspacePtyModule | null };
  constructor(options: { dataDir: string; runner: string; env?: NodeJS.ProcessEnv; pty?: () => WorkspacePtyModule | null }) {
    this.options = options;
    this.packages = new WorkspacePluginPackages(join(options.dataDir, "workspace-plugins", "packages"));
  }
  async handle(input: WorkspacePluginRequest, owner: WorkspacePluginOwner, sink: Sink): Promise<unknown> {
    if (this.sealed || !owner.deviceId || !owner.connectionId) throw pluginFailure("HOST_UNAVAILABLE", "Workspace plugin Host is unavailable");
    switch (input.action) {
      case "describe": return { version: 1, platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
      case "packageBegin": return this.packages.begin(input.digest, input.bytes, owner);
      case "packageChunk": return this.packages.chunk(input.uploadId, input.offset, input.data, owner);
      case "packageCommit": return this.packages.commit(input.uploadId, owner);
      case "open": return this.open(input, owner, sink);
      case "close": {
        const found = this.instances.get(input.instanceId);
        if (found) this.close(this.owned(input.instanceId, owner));
        return { ok: true };
      }
      case "message": {
        const instance = this.owned(input.instanceId, owner);
        const decoded = instance.decoder.accept(input.frame);
        if (decoded) await this.deliver(instance, decoded.message);
        return { ok: true };
      }
    }
  }
  private owned(id: string, owner: WorkspacePluginOwner): Instance {
    const instance = this.instances.get(id);
    if (!instance || instance.closed) throw pluginFailure("PLUGIN_GONE", "Workspace plugin instance is unavailable");
    if (instance.owner.deviceId !== owner.deviceId || instance.owner.connectionId !== owner.connectionId) throw pluginFailure("FORBIDDEN", "Workspace plugin belongs to another connection");
    return instance;
  }
  private async open(input: Extract<WorkspacePluginRequest, {action:"open"}>, owner: WorkspacePluginOwner, sink: Sink) {
    const token = { cancelled: false, deviceId: owner.deviceId }; const tokens = this.admissions.get(owner.connectionId) ?? new Set<{cancelled:boolean;deviceId:string}>();
    tokens.add(token); this.admissions.set(owner.connectionId, tokens);
    try {
      const pkg = this.packages.get(input.digest);
      const entry = pkg.manifest.execution.main === "workspace" ? pkg.manifest.main : pkg.manifest.execution.workspaceMain;
      if (input.entry !== entry) throw pluginFailure("FORBIDDEN", "Plugin entry differs from the admitted manifest");
      if (input.context.authority.kind !== "remote" || input.context.connectionState !== "connected") throw pluginFailure("INVALID_ARGUMENT", "Remote workspace context is required");
      const roots = [];
      for (const root of input.context.roots) {
        if (!isAbsolute(root.path) || /[\u0000-\u001f]/.test(root.path)) throw pluginFailure("INVALID_ARGUMENT", "Invalid workspace root");
        const path = await realpath(root.path);
        if (!(await stat(path)).isDirectory()) throw pluginFailure("INVALID_ARGUMENT", "Workspace root must be a directory");
        roots.push({ ...root, path });
      }
      if (!roots.length || roots.filter(root => root.primary).length !== 1) throw pluginFailure("INVALID_ARGUMENT", "One primary workspace root is required");
      const context = { ...input.context, roots, platform: process.platform === "win32" ? "win32" as const : process.platform === "darwin" ? "darwin" as const : "linux" as const };
      const scope = createHash("sha256").update(JSON.stringify([owner.deviceId, context.workspaceId, roots])).digest("hex");
      const dataPath = join(this.options.dataDir, "workspace-plugins", "data", pkg.manifest.id, scope);
      await mkdir(dataPath, { recursive: true, mode: 0o700 });
      const files = new WorkspacePluginFiles({root:roots.find(root => root.primary)!.path,
        protectedRoot:await realpath(this.options.dataDir), permissions:input.permissions,
        manifest:pkg.manifest as {permissions?:string[];fs?:unknown},
        active:()=>this.instances.has(input.instanceId) && !this.sealed});
      if (token.cancelled || this.sealed) throw pluginFailure("HOST_UNAVAILABLE", "Connection closed while opening the workspace plugin");
      if (this.instances.has(input.instanceId)) throw pluginFailure("CONFLICT", "Workspace plugin instance already exists");
      if (this.instances.size >= 64 || [...this.instances.values()].filter(item => item.owner.deviceId === owner.deviceId).length >= 16) throw pluginFailure("LIMIT_EXCEEDED", "Workspace plugin instance limit reached");
      const child = fork(this.options.runner, [], {
        cwd: roots.find(root => root.primary)!.path, env: workspaceShellEnvironment(this.options.env),
        execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
      });
      const execution = new WorkspacePluginExecution({context,permissions:input.permissions,manifestPermissions:Array.isArray(pkg.manifest.permissions)?pkg.manifest.permissions.filter((value):value is string=>typeof value==="string"):[],pty:this.options.pty});
      const mcp = new WorkspacePluginMcp({manifest:pkg.manifest as unknown as PluginManifest,permissions:input.permissions,packagePath:pkg.path,context});
      const instance: Instance = { apiCalls: new Map(), mcp, execution, files, id: input.instanceId, owner, context, child, decoder: new PluginMessageDecoder(), sink,
        pending: Promise.resolve(), queued: 0, closed: false, packagePath: pkg.path, dataPath,
        manifest: pkg.manifest, entry: input.entry, initialized: false };
      this.instances.set(instance.id, instance);
      child.on("message", message => this.receive(instance, message));
      child.on("error", () => { this.close(instance); void sink({ instanceId: instance.id, exitCode: 1 }).catch(() => undefined); });
      child.once("exit", code => {
        if (instance.closed) return;
        void instance.pending.finally(async () => {
          this.close(instance); await sink({ instanceId: instance.id, exitCode: code ?? 1 }).catch(() => undefined);
        });
      });
      return { instanceId: instance.id, context };
    } finally { tokens.delete(token); if (!tokens.size) this.admissions.delete(owner.connectionId); }
  }
  private async deliver(instance: Instance, message: unknown): Promise<void> {
    if (!object(message) || !["init", "call", "res", "cancel", "event", "workspaceApi"].includes(String(message.t))) throw pluginFailure("INVALID_ARGUMENT", "Invalid plugin process message");
    if (message.t === "workspaceApi") {
      if (!instance.initialized || typeof message.id !== "string" || !Array.isArray(message.args)) throw pluginFailure("INVALID_ARGUMENT", "Invalid workspace API request");
      if (instance.apiCalls.has(message.id)) throw pluginFailure("CONFLICT", "Workspace API call already exists");
      if (instance.apiCalls.size >= 64) throw pluginFailure("LIMIT_EXCEEDED", "Workspace API concurrency limit reached");
      const id = message.id;
      const controller = new AbortController();
      instance.apiCalls.set(id, controller);
      const api = String(message.api);
      const args = message.args;
      void (async () => {
        try {
          const value = api.startsWith("mcp.")
            ? await instance.mcp.call(api, args, controller.signal)
            : api === "workspace.process" || api === "workspace.terminal"
              ? await instance.execution.call(api, args)
              : await instance.files.call(api, args, message.consent === true);
          this.receive(instance, {t:"res",id,ok:true,value});
        } catch (error) {
          this.receive(instance, {t:"res",id,ok:false,error:{code:(error as {code?:string}).code ?? "IO_ERROR",message:(error as Error).message}});
        } finally { instance.apiCalls.delete(id); }
      })();
      return;
    }
    if (message.t === "cancel" && typeof message.callId === "string") instance.apiCalls.get(message.callId)?.abort();
    let outgoing = message;
    if (message.t === "init") {
      if (instance.initialized) throw pluginFailure("CONFLICT", "Workspace plugin is already initialized");
      instance.initialized = true;
      outgoing = { ...message, pluginId: instance.manifest.id, pluginPath: instance.packagePath, main: instance.entry, manifest: instance.manifest };
    } else if (!instance.initialized) throw pluginFailure("CONFLICT", "Workspace plugin must be initialized first");
    if (!instance.child.connected) throw pluginFailure("PLUGIN_GONE", "Workspace plugin process exited");
    instance.child.send(outgoing, error => { if (error) this.close(instance); });
  }
  private receive(instance: Instance, message: unknown): void {
    if (instance.closed || !object(message)) return;
    if (message.t === "call") {
      const workspace = instance.context;
      const root = workspace.roots.find(item => item.primary)!;
      let value: unknown;
      if (message.api === "workspace.getContext") value = workspace;
      else if (message.api === "workspace.get") value = { path: root.path, name: root.name, projectId: workspace.projectId, roots: workspace.roots, executionContext: workspace };
      else if (message.api === "plugin.getDataPath") value = instance.dataPath;
      if (value !== undefined) {
        instance.child.send({ t: "res", id: message.id, ok: true, value }); return;
      }
    }
    try {
      const bytes = encodePluginMessage(message);
      if (instance.queued + bytes.length > PLUGIN_MESSAGE_BYTES * 2) throw pluginFailure("LIMIT_EXCEEDED", "Plugin output queue exceeded its limit");
      instance.queued += bytes.length;
      instance.pending = instance.pending.then(async () => {
        for (const frame of pluginFrames(bytes)) {
          if (instance.closed) return;
          await instance.sink({ instanceId: instance.id, frame });
        }
      }).catch(() => this.close(instance)).finally(() => { instance.queued -= bytes.length; });
    } catch { this.close(instance); }
  }
  private close(instance: Instance): void {
    if (instance.closed) return;
    instance.closed = true;
    for (const controller of instance.apiCalls.values()) controller.abort();
    instance.apiCalls.clear(); instance.mcp.dispose(); instance.execution.dispose(); instance.decoder.clear(); this.instances.delete(instance.id);
    instance.child.kill();
  }
  disconnect(connectionId: string): void {
    this.packages.disconnect(connectionId);
    for (const token of this.admissions.get(connectionId) ?? []) token.cancelled = true;
    for (const instance of this.instances.values()) if (instance.owner.connectionId === connectionId) this.close(instance);
  }
  revoke(deviceId: string): void {
    this.packages.revoke(deviceId);
    for (const tokens of this.admissions.values()) for (const token of tokens) if (token.deviceId === deviceId) token.cancelled = true;
    for (const instance of this.instances.values()) if (instance.owner.deviceId === deviceId) this.close(instance);
  }
  /** Live instances plus opens still being admitted; derived, never a second registry. */
  inUse(): number {
    let pending = 0;
    for (const tokens of this.admissions.values()) pending += tokens.size;
    return this.instances.size + pending;
  }
  dispose(): void {
    this.sealed = true; this.packages.dispose();
    for (const instance of this.instances.values()) this.close(instance);
  }
}
