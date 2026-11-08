import type { WorkspaceExecutionContext } from "@pi-desktop/shared";
import { ExternalResourceActivity } from "../external-resource-activity";
import { createSystemSshTransport, reserveLocalPort } from "./ssh-transport";
import { sshTargetOf } from "./ssh-tunnel";
import { sshMetadataOf } from "./remote-host-metadata";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
export type WorkspacePortRequest = {
  ownerId: string; context: WorkspaceExecutionContext; sessionId: string; port: number; path?: string;
  validate(): Promise<void>;
};
export type WorkspacePortOwner = { assertCurrent(): void; nativeAttempt(): void };
type Forward = { url: string; close(): Promise<void> };
type Lease = {
  ownerId: string; closed: boolean; opening: boolean; forward?: Forward;
  timer?: ReturnType<typeof setInterval>; expires: number; checking: boolean;
  closing?: Promise<void>; cleanupComplete: boolean; cleanupReported: boolean;
};

/** Explicit, bounded preview forwarding; a disconnected binding is never recreated. */
export class WorkspacePorts {
  private readonly leases = new Set<Lease>();
  private readonly activity: ExternalResourceActivity;
  private readonly options: {
    isAdmissionClosed(): boolean;
    connect(context: WorkspaceExecutionContext, port: number, owner: WorkspacePortOwner): Promise<Forward>;
    openBrowser(url: string, sessionId: string): Promise<void>;
    onCleanupError?(): void;
  };
  constructor(options: WorkspacePorts["options"]) {
    this.options = options; this.activity = new ExternalResourceActivity(options.isAdmissionClosed);
  }
  open(input: WorkspacePortRequest): Promise<{ url: string }> {
    return this.activity.run(() => this.openCurrent(input));
  }
  private async openCurrent(input: WorkspacePortRequest): Promise<{ url: string }> {
    if (this.leases.size >= 8) throw fail("LIMIT_EXCEEDED", "Workspace preview limit reached");
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535 || !input.sessionId) throw fail("INVALID_ARGUMENT", "Preview requires a session and a port between 1024 and 65535");
    const path = input.path ?? "/";
    if (!path.startsWith("/") || path.startsWith("//") || path.length > 4096 || /[\\\u0000-\u001f]/.test(path)) throw fail("INVALID_ARGUMENT", "Preview path must be an absolute URL path");
    const lease: Lease = { ownerId: input.ownerId, closed: false, opening: true, expires: Date.now() + 30 * 60_000,
      checking: false, cleanupComplete: false, cleanupReported: false };
    this.leases.add(lease);
    const assertCurrent = () => {
      if (lease.closed) throw fail("PLUGIN_GONE", "Workspace preview was closed");
      this.activity.assertOpen();
    };
    const check = async () => { assertCurrent(); await input.validate(); assertCurrent(); };
    const owner: WorkspacePortOwner = { assertCurrent, nativeAttempt: () => { assertCurrent(); this.activity.nativeAttempt(); } };
    try {
      await check(); assertCurrent();
      const forward = input.context.authority.kind === "remote"
        ? await this.options.connect(input.context, input.port, owner)
        : { url: `http://127.0.0.1:${input.port}`, close: async () => {} };
      lease.forward = forward; await check();
      const url = new URL(path, forward.url).toString();
      if (new URL(url).origin !== new URL(forward.url).origin) throw fail("INVALID_ARGUMENT", "Preview must remain on its forwarded origin");
      lease.timer = setInterval(() => {
        if (lease.checking || lease.closed || this.activity.isClosed()) return;
        lease.checking = true;
        void this.activity.track(async () => {
          try { if (Date.now() >= lease.expires) throw Error("expired"); await check(); }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "HOST_BUSY")) await this.close(lease);
          }
          finally { lease.checking = false; }
        }).catch(() => this.reportCleanup(lease));
      }, 5000);
      lease.timer.unref();
      owner.nativeAttempt(); await this.options.openBrowser(url, input.sessionId); await check();
      return { url };
    } catch (error) {
      await this.close(lease).catch(() => this.reportCleanup(lease)); throw error;
    } finally { lease.opening = false; this.retire(lease); }
  }
  getHandoffActivity() { return this.activity.snapshot(this.leases.size); }
  private retire(lease: Lease): void {
    if (lease.closed && !lease.opening && (!lease.forward || lease.cleanupComplete)) this.leases.delete(lease);
  }
  private close(lease: Lease): Promise<void> {
    lease.closed = true; clearInterval(lease.timer);
    if (lease.closing) return lease.closing;
    const forward = lease.forward;
    if (!forward) { this.retire(lease); return Promise.resolve(); }
    // Install the promise before calling an external closer, including synchronous reentry.
    const completion = Promise.withResolvers<void>();
    lease.closing = completion.promise;
    void this.activity.track(async () => {
      try { await forward.close(); } finally { lease.cleanupComplete = true; this.retire(lease); }
    }).then(completion.resolve, completion.reject);
    return lease.closing;
  }
  private reportCleanup(lease: Lease): void {
    if (lease.cleanupReported) return;
    lease.cleanupReported = true;
    (this.options.onCleanupError ?? (() => console.warn("Workspace preview cleanup failed; idle handoff remains unavailable")))();
  }
  closeOwner(ownerId: string): void {
    for (const lease of this.leases) if (lease.ownerId === ownerId) void this.close(lease).catch(() => this.reportCleanup(lease));
  }
  dispose(): void {
    this.activity.seal();
    for (const lease of this.leases) void this.close(lease).catch(() => this.reportCleanup(lease));
  }
}

/** Reuse paired SSH metadata and transport; never provision or reconnect a Host here. */
export async function forwardWorkspacePort(boot: RemoteHostsBoot, context: WorkspaceExecutionContext, port: number, owner: WorkspacePortOwner): Promise<Forward> {
  owner.assertCurrent();
  if (context.authority.kind !== "remote") throw fail("INVALID_ARGUMENT", "Remote workspace required");
  const hostKey = context.authority.hostKey;
  const client = boot.workspaceClient(hostKey), generation = client.generation?.() ?? 1;
  const check = () => {
    owner.assertCurrent();
    if (boot.workspaceClient(hostKey) !== client || client.state?.() !== "connected" || (client.generation?.() ?? 1) !== generation) throw fail("HOST_UNAVAILABLE", "Original workspace connection is unavailable");
  };
  check(); const record = (await boot.registry.list()).find(item => item.hostKey === hostKey); check();
  const ssh = record && sshMetadataOf(record);
  if (!ssh) throw fail("CAPABILITY_UNAVAILABLE", "Port preview requires an SSH-paired Host");
  if (port === ssh.remotePort) throw fail("PERMISSION_DENIED", "The Host control port cannot be exposed as a preview");
  const transport = createSystemSshTransport(sshTargetOf(ssh, record?.sshSecret));
  let unsubscribe: (() => void) | undefined, stopped = false;
  let forward: Awaited<ReturnType<typeof transport.forward>> | undefined, closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!stopped) { stopped = true; unsubscribe?.(); transport.dispose(); }
    if (forward) closing ??= forward.close();
    return closing ?? Promise.resolve();
  };
  unsubscribe = client.subscribeState?.(state => { if (state !== "connected") void close().catch(() => console.warn("Workspace forward cleanup failed; idle handoff remains unavailable")); });
  if (stopped) unsubscribe?.();
  const assertCurrent = () => { check(); if (stopped) throw fail("HOST_UNAVAILABLE", "Workspace disconnected"); };
  try {
    assertCurrent(); owner.nativeAttempt(); const localPort = await reserveLocalPort(); assertCurrent();
    forward = await transport.forward({ localPort, remoteHost: "127.0.0.1", remotePort: port, assertCurrent,
      beforeSpawn: () => { assertCurrent(); owner.nativeAttempt(); } });
    assertCurrent();
    return { url: `http://127.0.0.1:${forward.localPort}`, close };
  } catch (error) { await close(); throw error; }
}
