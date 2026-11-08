import * as Value from "typebox/value";
import { WorkspaceProcessRequestSchema, type WorkspaceExecutionContext, type WorkspaceProcessRequest } from "@pi-desktop/shared";
import { ExternalResourceActivity } from "../external-resource-activity";
import type { createWorkspaceExecutionResolver } from "../workspace-execution-context";
import type { RemoteHostClient } from "./remote-host-connection";

const fail = (code: string, message: string) => Object.assign(new Error(message), { code, errorCode: code });
const busy = (error: unknown) => error instanceof Error && (("code" in error && error.code === "HOST_BUSY") || ("errorCode" in error && error.errorCode === "HOST_BUSY"));
type Host = { generation: string; isAvailable(): boolean };
type Owner = { host: Host; generation: string };
type Binding = {
  sessionId: string; extensionId: string; processId: string; owner: Owner;
  cancelled: boolean; closed: boolean; opening: boolean; pending: number;
  attempted: boolean; startDone?: Promise<void>; starting: boolean;
  closing?: Promise<void>; cancelling?: Promise<unknown>; cleanupComplete: boolean; cleanupReported: boolean;
  context?: WorkspaceExecutionContext; client?: RemoteHostClient; hostKey?: string; generation?: number;
};

/** Retain the original process request, connection and cleanup until they settle. */
export class ExtensionWorkspaceProcesses {
  private readonly bindings = new Map<string, Binding>();
  private readonly activity: ExternalResourceActivity;
  private owner?: Owner;
  private sealed = false;
  private checking = false;
  private readonly idle: ReturnType<typeof setInterval>;
  private readonly options: {
    isAdmissionClosed(): boolean; getHost(): Host | null; current(): boolean;
    resolve: ReturnType<typeof createWorkspaceExecutionResolver>;
    client(hostKey: string): RemoteHostClient;
    allowed(extensionId: string, context: WorkspaceExecutionContext): boolean;
    onCleanupError(): void;
  };
  constructor(options: ExtensionWorkspaceProcesses["options"]) {
    this.options = options; this.activity = new ExternalResourceActivity(options.isAdmissionClosed);
    const host = options.getHost(); if (host) this.owner = { host, generation: host.generation };
    this.idle = setInterval(() => { void this.revalidate(); }, 5000); this.idle.unref();
  }
  rebindHost(expectedHost: object): void {
    if (this.sealed) return;
    const host = this.options.getHost();
    if (!host || host !== expectedHost || !host.isAvailable()) throw fail("HOST_UNAVAILABLE", "Extension process Host is unavailable");
    if (this.owner?.host === host && this.owner.generation === host.generation) return;
    this.activity.assertOpen();
    for (const binding of this.bindings.values()) this.retireInBackground(binding);
    this.owner = { host, generation: host.generation };
  }
  getHandoffActivity() { return this.activity.snapshot(this.bindings.size); }
  private assertOwner(owner: Owner | undefined): asserts owner is Owner {
    if (!owner || !this.options.current() || this.options.getHost() !== owner.host || this.owner !== owner ||
        owner.host.generation !== owner.generation || !owner.host.isAvailable()) throw fail("HOST_UNAVAILABLE", "Original extension process Host is unavailable");
  }
  private assertCurrent(binding: Binding): void {
    if (binding.closed || (binding.opening && binding.cancelled)) throw fail(binding.opening ? "TOOL_ABORTED" : "PROCESS_GONE", "Extension process was closed");
    this.assertOwner(binding.owner); this.activity.assertOpen();
    if (binding.client) this.connected(binding);
  }
  private authorize(binding: Binding): void {
    if (!binding.context || !this.options.allowed(binding.extensionId, binding.context)) throw fail("PERMISSION_DENIED", "Extension is not enabled for the originating project");
  }
  private connected(binding: Binding, cleanup = false): RemoteHostClient {
    const client = binding.client;
    if (!client || client.state?.() !== "connected" || (client.generation?.() ?? 1) !== binding.generation ||
        (!cleanup && (!binding.hostKey || this.options.client(binding.hostKey) !== client))) {
      throw fail("HOST_UNAVAILABLE", "Original workspace connection is unavailable; command was not replayed");
    }
    return client;
  }
  private pinConnection(binding: Binding, hostKey: string): RemoteHostClient {
    this.assertCurrent(binding);
    if (!binding.client) {
      binding.client = this.options.client(hostKey); binding.hostKey = hostKey; binding.generation = binding.client.generation?.() ?? 1;
    }
    if (binding.hostKey !== hostKey) throw fail("WORKSPACE_CHANGED", "The extension workspace Host changed");
    return this.connected(binding);
  }
  private async resolve(binding: Binding): Promise<WorkspaceExecutionContext> {
    this.assertCurrent(binding);
    const context = await this.options.resolve({ sessionId: binding.sessionId, context: binding.context }, async hostKey => {
      const client = this.pinConnection(binding, hostKey);
      return { connected: client.state?.() === "connected", generation: binding.generation!, platform: "linux" };
    }, () => this.assertCurrent(binding));
    this.assertCurrent(binding);
    if (!context || context.authority.kind !== "remote") throw fail("WORKSPACE_CHANGED", "The extension session is no longer remote");
    this.pinConnection(binding, context.authority.hostKey);
    return context;
  }
  private async track<T>(binding: Binding, operation: () => Promise<T>): Promise<T> {
    binding.pending++;
    try { return await this.activity.track(operation); }
    finally { binding.pending--; this.release(binding); }
  }
  private release(binding: Binding): void {
    if (binding.closed && !binding.opening && binding.pending === 0 && binding.cleanupComplete && this.bindings.get(binding.processId) === binding) this.bindings.delete(binding.processId);
  }
  /** Temporary admission closure suspends polling; only invalid owners retire. */
  async revalidate(): Promise<void> {
    if (this.sealed || this.checking || this.activity.isClosed()) return;
    this.checking = true;
    try {
      await Promise.all([...this.bindings.values()].filter(binding => !binding.opening && !binding.closed).map(binding => this.track(binding, async () => {
        try { await this.resolve(binding); this.assertCurrent(binding); this.authorize(binding); }
        catch (error) { if (!busy(error)) await this.closeObserved(binding); }
      })));
    } finally { this.checking = false; }
  }
  handle(raw: Record<string, unknown>): Promise<unknown> {
    return this.activity.track(() => this.handleRequest(raw));
  }
  private async handleRequest(raw: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
    const extensionId = typeof raw.extensionId === "string" ? raw.extensionId : "";
    if (!sessionId || sessionId.length > 128 || !extensionId || extensionId.length > 4096) throw fail("INVALID_ARGUMENT", "Extension and session identity are required");
    const input = raw.request;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("INVALID_ARGUMENT", "Process request must be an object");
    const request = input as Record<string, unknown>;
    const processId = typeof request.processId === "string" ? request.processId : "";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(processId)) throw fail("INVALID_ARGUMENT", "Invalid process identity");
    const cleanup = request.action === "close" || request.action === "cancel";
    if (!cleanup) { this.activity.assertOpen(); this.assertOwner(this.owner); }
    const binding = this.bindings.get(processId);
    if (request.action === "start") {
      if (binding) throw fail("CONFLICT", "Process was already requested");
      if (this.bindings.size >= 64) throw fail("LIMIT_EXCEEDED", "Extension process limit reached");
      this.assertOwner(this.owner);
      const original: Binding = { sessionId, extensionId, processId, owner: this.owner, cancelled: false, closed: false,
        opening: true, pending: 0, attempted: false, starting: false, cleanupComplete: false, cleanupReported: false };
      this.bindings.set(processId, original);
      return this.track(original, () => this.start(original, request, raw.workspace));
    }
    if (!Value.Check(WorkspaceProcessRequestSchema, request)) throw fail("INVALID_ARGUMENT", "Invalid structured process request");
    if (!binding) {
      if (cleanup) return { ok: true };
      throw fail("PROCESS_GONE", "Extension process is unavailable");
    }
    if (binding.sessionId !== sessionId || binding.extensionId !== extensionId) throw fail("FORBIDDEN", "Process belongs to another extension invocation");
    return this.track(binding, async () => {
      if (request.action === "close") { await this.close(binding); return { ok: true }; }
      if (request.action === "cancel") return this.cancel(binding);
      try {
        await this.resolve(binding); this.assertCurrent(binding); this.authorize(binding);
        const result = await this.connected(binding).request("workspace/process", request as WorkspaceProcessRequest);
        this.assertCurrent(binding); return result;
      } catch (error) { if (!busy(error)) await this.closeObserved(binding); throw error; }
    });
  }
  private async start(binding: Binding, request: Record<string, unknown>, workspace: unknown): Promise<unknown> {
    try {
      const context = await this.resolve(binding); this.assertCurrent(binding);
      const expected = workspace as { hostKey?: unknown; path?: unknown } | undefined;
      const root = context.roots.find(item => item.primary)?.path;
      if (!root || context.authority.kind !== "remote" || expected?.hostKey !== context.authority.hostKey || expected.path !== root) throw fail("WORKSPACE_CHANGED", "The extension workspace changed since launch");
      binding.context = context; this.authorize(binding);
      const start = { ...request, workspaceId: context.workspaceId, path: root };
      if (!Value.Check(WorkspaceProcessRequestSchema, start) || start.action !== "start") throw fail("INVALID_ARGUMENT", "Invalid structured process launch");
      this.assertCurrent(binding); this.activity.nativeAttempt();
      binding.attempted = true; binding.starting = true;
      const completion = Promise.withResolvers<void>(); binding.startDone = completion.promise;
      let opened: unknown;
      try { opened = await this.connected(binding).request("workspace/process", start); }
      finally { binding.starting = false; completion.resolve(); }
      this.assertCurrent(binding);
      if (!opened || typeof opened !== "object" || !("processId" in opened) || opened.processId !== binding.processId) throw fail("INVALID_RESPONSE", "Workspace process start acknowledgement did not match");
      return opened;
    } catch (error) { await this.closeObserved(binding); throw error; }
    finally { binding.opening = false; this.release(binding); }
  }
  private ack(result: unknown): void {
    if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw fail("INVALID_RESPONSE", "Workspace process cleanup was not acknowledged");
  }
  private cancel(binding: Binding): Promise<unknown> {
    binding.cancelled = true;
    if (binding.opening || binding.closed) return this.close(binding).then(() => ({ ok: true }));
    if (binding.cancelling) return binding.cancelling;
    const completion = Promise.withResolvers<unknown>(); binding.cancelling = completion.promise;
    void (async () => {
      try { const result = await this.connected(binding, true).request("workspace/process", { action: "cancel", processId: binding.processId }); this.ack(result); return result; }
      catch (error) { await this.closeObserved(binding); throw error; }
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }
  private close(binding: Binding): Promise<void> {
    binding.cancelled = true; binding.closed = true;
    if (binding.closing) return binding.closing;
    if (!binding.attempted) { binding.cleanupComplete = true; this.release(binding); return Promise.resolve(); }
    // Install before calling the original transport; synchronous reentry joins it.
    const completion = Promise.withResolvers<void>(); binding.closing = completion.promise;
    void this.activity.track(async () => {
      try {
        // An early close can miss a start still admitted by the remote Host.
        if (binding.starting) await binding.startDone;
        const result = await this.connected(binding, true).request("workspace/process", { action: "close", processId: binding.processId }); this.ack(result);
      } catch (error) { this.reportCleanup(binding); throw error; }
      finally { binding.cleanupComplete = true; this.release(binding); }
    }).then(completion.resolve, completion.reject);
    return completion.promise;
  }
  private reportCleanup(binding: Binding): void {
    if (binding.cleanupReported) return;
    binding.cleanupReported = true; this.options.onCleanupError();
  }
  private async closeObserved(binding: Binding): Promise<void> {
    try { await this.close(binding); } catch { /* The original close reports failure and retains native uncertainty. */ }
  }
  private retireInBackground(binding: Binding): void { void this.closeObserved(binding); }
  captureSession(sessionId: string): () => void {
    const originals = [...this.bindings.values()].filter(binding => binding.sessionId === sessionId);
    return () => { for (const binding of originals) this.retireInBackground(binding); };
  }
  dispose(): void {
    this.sealed = true; this.activity.seal(); clearInterval(this.idle);
    for (const binding of this.bindings.values()) this.retireInBackground(binding);
  }
}
