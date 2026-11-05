import { randomUUID } from "node:crypto";
import * as Value from "typebox/value";
import { WorkspacePluginEventSchema, type WorkspaceExecutionContext, type WorkspacePluginRequest } from "@pi-desktop/shared";
import { collectPluginPackage, encodePluginMessage, pluginFrames, PluginMessageDecoder, pluginFailure, PLUGIN_MESSAGE_BYTES } from "@pi-desktop/host-runtime";
import type { PluginProcessHandle } from "../plugin-runtime";
import type { RemoteHostClient } from "./remote-host-connection";

type Handle = { id: string; decoder: PluginMessageDecoder; message?: (message: unknown) => void; exit?: (code: number) => void;
  closed: boolean; exitCode?: number; close?: () => void; authorized?: () => Promise<boolean>; timer?: ReturnType<typeof setInterval>; pending: Promise<void>; bytes: number; generation: number };
/** A connection has one reverse request handler, shared by its plugin instances. */
export class RemoteWorkspacePlugins {
  private readonly connections = new Map<RemoteHostClient, { handles: Map<string, Handle>; dispose(): void }>();
  private sealed = false;
  /** A refusal lasts until this loaded package is unloaded, so polling cannot repeat the prompt. */
  private readonly denied = new Set<string>();
  private readonly options: {
    client(hostKey: string): RemoteHostClient;
    authorize(input: { pluginId: string; pluginName: string; hostKey: string; digest: string }): Promise<void>;
    isAuthorized?(input: { pluginId: string; hostKey: string; digest: string }): Promise<boolean>;
  };
  constructor(options: RemoteWorkspacePlugins["options"]) { this.options = options; }
  forget(pluginId: string): void { for (const key of this.denied) if (JSON.parse(key)[0] === pluginId) this.denied.delete(key); }
  async available(input: { pluginId: string; pluginPath: string; context: WorkspaceExecutionContext }): Promise<boolean> {
    if (input.context.authority.kind !== "remote") return true;
    const hostKey = input.context.authority.hostKey; const client = this.options.client(hostKey);
    if (client.state?.() !== "connected") return false;
    try { await client.request("workspace/plugin", { action: "describe" }, 30_000); } catch { return false; }
    const pkg = await collectPluginPackage(input.pluginPath);
    const key = JSON.stringify([input.pluginId, hostKey, pkg.digest]);
    // Unknown approval is offered once by the first real workspace call.
    return !this.denied.has(key);
  }
  private connection(client: RemoteHostClient) {
    const existing = this.connections.get(client); if (existing) return existing;
    const handles = new Map<string, Handle>();
    const off = client.handleServerRequest?.("workspace/pluginEvent", async raw => {
      if (!Value.Check(WorkspacePluginEventSchema, raw)) throw pluginFailure("INVALID_RESPONSE", "Invalid workspace plugin event");
      const handle = handles.get(raw.instanceId);
      if (!handle || handle.closed || handle.generation !== (client.generation?.() ?? 0)) return { ok: true };
      if ("exitCode" in raw) { this.fail(handle, raw.exitCode); handles.delete(handle.id); }
      else {
        const decoded = handle.decoder.accept(raw.frame);
        if (decoded) {
          if ((decoded.message as {t?:string})?.t === "call" && handle.authorized && !await handle.authorized()) {
            this.fail(handle,1); handle.close?.();
          } else if (!handle.closed) handle.message?.(decoded.message);
        }
      }
      return { ok: true };
    });
    if (!off) throw pluginFailure("CAPABILITY_UNAVAILABLE", "Workspace plugin callbacks are unavailable");
    const offState = client.subscribeState?.(state => {
      if (state === "connected") return;
      for (const handle of handles.values()) this.fail(handle, 1);
      handles.clear();
    });
    const connection = { handles, dispose: () => { off(); offState?.(); for (const handle of handles.values()) handle.close?.(); handles.clear(); } };
    this.connections.set(client, connection); return connection;
  }
  private fail(handle: Handle, code: number) {
    if (handle.closed) return;
    clearInterval(handle.timer);
    handle.closed = true; handle.exitCode = code; handle.decoder.clear(); handle.exit?.(code);
  }
  async spawn(input: { pluginPath: string; entry: string; context: WorkspaceExecutionContext; permissions: string[] }): Promise<PluginProcessHandle> {
    if (input.context.authority.kind !== "remote") throw pluginFailure("INVALID_ARGUMENT", "Remote plugin needs a remote workspace");
    const hostKey = input.context.authority.hostKey; const client = this.options.client(hostKey);
    if (client.state?.() !== "connected") throw pluginFailure("HOST_UNAVAILABLE", "Workspace Host is disconnected");
    const generation = client.generation?.() ?? 0;
    const check = () => {
      if (this.sealed || this.options.client(hostKey) !== client || client.state?.() !== "connected" || (client.generation?.() ?? 0) !== generation) throw pluginFailure("HOST_UNAVAILABLE", "Workspace connection changed; the operation was not replayed");
    };
    const request = async <T>(value: WorkspacePluginRequest): Promise<T> => { check(); const answer = await client.request<T>("workspace/plugin", value, 30_000); check(); return answer; };
    await request({ action: "describe" });
    const pkg = await collectPluginPackage(input.pluginPath); check();
    const decision = JSON.stringify([pkg.manifest.id, hostKey, pkg.digest]);
    if (this.denied.has(decision)) throw pluginFailure("PERMISSION_DENIED", "Workspace plugin execution was declined for this loaded package");
    try { await this.options.authorize({pluginId:pkg.manifest.id,pluginName:typeof pkg.manifest.name === "string" ? pkg.manifest.name : pkg.manifest.id,hostKey,digest:pkg.digest}); }
    catch (error) { if ((error as {code?:string}).code === "PERMISSION_DENIED") this.denied.add(decision); throw error; }
    this.denied.delete(decision); check();
    const started = await request<{present:boolean;uploadId?:string}>({action:"packageBegin",digest:pkg.digest,bytes:pkg.bytes.length});
    if (!started.present) {
      if (!started.uploadId) throw pluginFailure("INVALID_RESPONSE", "Plugin upload handle is missing");
      for (let offset = 0; offset < pkg.bytes.length; offset += 65536) await request({action:"packageChunk",uploadId:started.uploadId,offset,data:pkg.bytes.subarray(offset,offset+65536).toString("base64")});
      await request({action:"packageCommit",uploadId:started.uploadId});
    }
    const connection = this.connection(client); const id = randomUUID();
    const handle: Handle = {id,decoder:new PluginMessageDecoder(),closed:false,pending:Promise.resolve(),bytes:0,generation};
    handle.close = () => {
      this.fail(handle,0); connection.handles.delete(id);
      if (client.state?.() === "connected" && (client.generation?.() ?? 0) === generation) {
        void client.request("workspace/plugin",{action:"close",instanceId:id},5_000).catch(() => undefined);
      }
    };
    handle.authorized = async () => this.options.isAuthorized
      ? this.options.isAuthorized({pluginId:pkg.manifest.id,hostKey,digest:pkg.digest}) : true;
    if (this.options.isAuthorized) {
      let checking = false;
      handle.timer = setInterval(() => {
        if (checking || handle.closed) return;
        checking = true;
        void handle.authorized!().then(allowed => { if (!allowed) { this.fail(handle,1); handle.close?.(); } })
          .catch(() => {this.fail(handle,1);handle.close?.();}).finally(() => {checking=false;});
      },5_000);
      handle.timer.unref();
    }
    connection.handles.set(id, handle);
    try {
      await request({action:"open",instanceId:id,digest:pkg.digest,entry:input.entry,context:input.context,permissions:input.permissions});
    } catch (error) { handle.close(); throw error; }
    return {
      postMessage: message => {
        check(); if (handle.closed) throw pluginFailure("PLUGIN_GONE", "Workspace plugin is no longer running");
        const bytes = encodePluginMessage(message);
        if (handle.bytes + bytes.length > PLUGIN_MESSAGE_BYTES * 2) throw pluginFailure("LIMIT_EXCEEDED", "Workspace plugin input queue exceeded its limit");
        handle.bytes += bytes.length;
        handle.pending = handle.pending.then(async () => {
          const kind = (message as {t?:string})?.t;
          if (["init","call","workspaceApi"].includes(kind ?? "") && this.options.isAuthorized
            && !await this.options.isAuthorized({pluginId:pkg.manifest.id,hostKey,digest:pkg.digest})) {
            throw pluginFailure("PERMISSION_DENIED", "Workspace plugin execution authorization was revoked");
          }
          for (const frame of pluginFrames(bytes)) { if (handle.closed) return; await request({action:"message",instanceId:id,frame}); }
        }).catch(() => { this.fail(handle,1); handle.close?.(); }).finally(() => { handle.bytes -= bytes.length; });
      },
      onMessage: listener => { handle.message = listener; },
      onExit: listener => { handle.exit = listener; if (handle.closed) listener(handle.exitCode ?? 1); },
      kill: handle.close,
    };
  }
  dispose(): void { this.sealed = true; for (const connection of this.connections.values()) connection.dispose(); this.connections.clear(); }
}
