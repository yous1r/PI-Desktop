/** Paired Host lifecycle. Persistence stays in the encrypted registry; session
 * projection and transport recovery live in their own domain modules. */
import {
  IPC,
  type RacpEventEnvelope, type RacpItemSummary, type RacpProjectSummary, type RacpSession,
  type RemoteHostBootstrapRequest, type RemoteHostBootstrapResult,
  type RemoteHostCreateSessionRequest, type RemoteHostSummary, type RemoteHostBrowseProjectsResult,
  type RemoteHostConnectionStatus, type RemoteHostSyncProvidersRequest, type RemoteHostSyncProvidersResult, type SessionSummary,
  type CommandShellOption, isCommandShellOption,
  type WorkspaceFilesRequest,
  type WorkspacePluginFilesRequest,
  type RemoteHostPrepareRequest,
} from "@pi-desktop/shared";
import { wsClientTransport } from "@pi-desktop/racp";
import type { HostRpcPort } from "@pi-desktop/agent-host";
import type { BackendRouter } from "../remote/backend-router.js";
import { makeRemoteSessionId, parseRemoteSessionId } from "../remote/backend-router.js";
import { createRacpRemoteHostClient, exchangePairingToken, type RacpRemoteHostClient } from "../remote/racp-remote-host-client.js";
import { createRemoteHostRealigner } from "../remote/remote-host-realign.js";
import { createRemoteHostPreparer } from "../remote/remote-host-prepare.js";
import { createSshBootstrap, type SshBootstrapDeps } from "../remote/ssh-bootstrap.js";
import { createSshTunnelManager, type SshTunnelManager } from "../remote/ssh-tunnel.js";
import { createRemoteHostConnection, type RemoteHostConnection, type RemoteHostClient } from "../remote/remote-host-connection.js";
import { createRemoteHostRegistry, type EncryptionPort, type RemoteHostRecord, type RemoteHostRegistry } from "../remote/remote-host-registry.js";
import { sshMetadataOf, sshHostRecord, transportOf } from "../remote/remote-host-metadata.js";
import { createRemoteSessionCatalog } from "../remote/remote-session-catalog.js";
import { syncRemoteProviders } from "../remote/remote-provider-transfer.js";
import { workspaceExecutionError } from "../remote/remote-workspace-outcome.js";
export { sshMetadataOf, sshHostRecord, transportOf } from "../remote/remote-host-metadata.js";
export type { RemoteHostSummary };

export type RemoteHostAdapterFactory = (record: RemoteHostRecord) => RacpRemoteHostClient;
export type RemoteWorkspaceToolInput = {
  hostKey: string; path: string; sessionId: string; turnId: string;
  toolCallId: string; toolName: string; args: unknown; timeoutMs?: number;
  expectedCommandShellId?: string; expectedCommandShellDialect?: string;
};
export type BootRemoteHostsOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  router: BackendRouter;
  emit: (channel: string, payload: unknown) => void;
  clientInfo: { name: string; version: string };
  getLocalHost?: () => HostRpcPort | null;
  buildAdapter?: RemoteHostAdapterFactory;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  tunnels?: SshTunnelManager;
  sshBootstrap?: Partial<SshBootstrapDeps>;
};
export type RemoteLiveSessionSummary = Pick<RacpSession, "id" | "title" | "mode" | "permissionMode" | "status" | "activeTurnId" | "workspaceLabel"> & {
  source: "remote"; hostKey: string; hostLabel: string;
};
export interface RemoteHostsBoot {
  open(): Promise<number>;
  listSessions(): Promise<RemoteLiveSessionSummary[]>;
  readHistory(sessionId: string, limit: number): Promise<RacpItemSummary[]>;
  subscribeSession(sessionId: string, listener: (envelope: RacpEventEnvelope) => void): (() => void) | null;
  closeAll(): Promise<void>;
  list(): Promise<RemoteHostSummary[]>;
  addHost(record: RemoteHostRecord): Promise<RemoteHostSummary>;
  bootstrapHost(request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapResult>;
  reconnectHost(hostKey: string): Promise<RemoteHostSummary>;
  ensureReady(hostKey: string): Promise<RemoteHostSummary>;
  prepareHost(request: RemoteHostPrepareRequest): Promise<RemoteHostSummary>;
  cancelPreparation(hostKey: string, requestId: string): void;
  removeHost(hostKey: string): Promise<void>;
  sessionSummaries(): SessionSummary[];
  sessions(hostKey: string): Promise<SessionSummary[]>;
  projects(hostKey: string): Promise<RacpProjectSummary[]>;
  browseProjects(hostKey: string, path?: string): Promise<RemoteHostBrowseProjectsResult>;
  registerProject(hostKey: string, path: string): Promise<RacpProjectSummary & { path?: string }>;
  createSession(request: RemoteHostCreateSessionRequest): Promise<SessionSummary>;
  syncProviders(request: RemoteHostSyncProvidersRequest): Promise<RemoteHostSyncProvidersResult>;
  executeWorkspaceTool(request: RemoteWorkspaceToolInput): Promise<unknown>;
  abortWorkspaceTool(request: { hostKey: string; sessionId: string; toolCallId: string }): Promise<void>;
  workspaceCommandShell(hostKey: string): Promise<CommandShellOption>;
  workspaceFiles(hostKey: string, input: WorkspaceFilesRequest): Promise<unknown>;
  workspacePluginFiles(hostKey: string, input: WorkspacePluginFilesRequest): Promise<unknown>;
  /** Existing live connection only: never reconnect/replay a mutation implicitly. */
  workspaceClient(hostKey: string): RemoteHostClient;
  readonly registry: RemoteHostRegistry;
}
let activeRemoteHostsBoot: RemoteHostsBoot | null = null;
export function setActiveRemoteHostsBoot(boot: RemoteHostsBoot | null): void { activeRemoteHostsBoot = boot; }
export function getActiveRemoteHostsBoot(): RemoteHostsBoot | null { return activeRemoteHostsBoot; }

type OpenHost = {
  hostKey: string; label: string; url: string;
  adapter: RacpRemoteHostClient; connection: RemoteHostConnection;
};
function unavailable(): Error {
  return Object.assign(new Error("remote host is unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
}

function requiresUserAction(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fields = error as { errorCode?: string; code?: string };
  return ["HOST_AUTH_FAILED", "REMOTE_AUTH_FAILED", "HOST_VERSION_MISMATCH", "CAPABILITY_UNAVAILABLE"]
    .includes(fields.errorCode ?? fields.code ?? "");
}


/**
 * A paired Host can run the right release and still predate the additive
 * workspace services a remote project needs — the bundle is reused by release
 * receipt, not by the capabilities it happens to contain. The handshake is the
 * only place that is observable, so it is checked once per connect rather than
 * on every `workspace/*` call. Adapters that report no capabilities (tests,
 * legacy callers) are left alone.
 */
function assertWorkspaceCapabilities(adapter: RacpRemoteHostClient): void {
  const capabilities = adapter.workspaceCapabilities?.();
  if (!capabilities || (capabilities.workspaceTools && capabilities.workspaceFiles)) return;
  throw Object.assign(
    new Error("the remote Host predates the workspace tools and files this Desktop release requires"),
    { errorCode: "HOST_VERSION_MISMATCH", retriable: false },
  );
}

export function createRemoteHostsBoot(options: BootRemoteHostsOptions): RemoteHostsBoot {
  const log = options.log ?? (() => undefined);
  const registry = createRemoteHostRegistry({ dataDir: options.dataDir, encryption: options.encryption, log });
  const tunnels = options.tunnels ?? createSshTunnelManager({ log });
  const opened = new Map<string, OpenHost>();
  const actionRequired = new Set<string>();
  const openingHosts = new Set<OpenHost>();
  const hostClosings = new WeakMap<OpenHost, Promise<void>>();
  const operations = new Map<string, Promise<unknown>>();
  const bootstraps = new Map<AbortController, Promise<unknown>>();
  let closed = false;
  let opening: Promise<number> | undefined;
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closed) throw unavailable(); };
  const connectedHost = (key: string) => {
    const host = opened.get(key);
    return host?.adapter.state() === "connected" ? host : undefined;
  };
  const catalog = createRemoteSessionCatalog({
    getHost: (key) => {
      const host = connectedHost(key);
      return host ? { hostKey: key, label: host.label, client: host.adapter.client, connection: host.connection } : undefined;
    },
  });
  const changed = () => options.emit(IPC.event.sessionsChanged, { reason: "remote.host.changed" });
  const refresh = async (key: string) => {
    try { await catalog.sessions(key); }
    catch (error) { log("warn", `remote host ${key} session refresh failed`, { error: String(error) }); }
    if (!closed) changed();
  };
  function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = operations.get(key);
    const task = (async () => {
      if (previous) await previous.catch(() => undefined);
      assertOpen();
      return action();
    })();
    operations.set(key, task);
    void task.finally(() => { if (operations.get(key) === task) operations.delete(key); }).catch(() => undefined);
    return task;
  }
  const buildAdapter = options.buildAdapter ?? ((record: RemoteHostRecord) => {
    let first = true;
    const ssh = sshMetadataOf(record);
    return createRacpRemoteHostClient({
      transport: async () => {
        assertOpen();
        let url = record.url;
        if (!first && ssh) {
          // A broken forward is not reusable, even when the ssh process has
          // not emitted exit yet. Reopen it before reconnecting the WebSocket.
          await tunnels.close(record.hostKey);
          assertOpen();
          url = (await tunnels.open(record.hostKey, { ...ssh, version: options.clientInfo.version }, record.sshSecret)).url;
          assertOpen();
          const live = opened.get(record.hostKey);
          if (live) live.url = url;
        }
        first = false;
        return wsClientTransport({ url, token: record.deviceToken })();
      },
      expectedHostId: ssh?.hostId,
      onStateChange: () => { if (!closed) changed(); },
      clientInfo: options.clientInfo,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 15_000, maxAttempts: 10 },
      log,
    });
  });
  const bootstrap = createSshBootstrap({
    version: options.clientInfo.version,
    exchangePairing: ({ url, pairingToken, label, expectedHostId }) => exchangePairingToken({ url, pairingToken, label, expectedHostId, clientInfo: options.clientInfo, requireWorkspace: true, log }),
    verifyConnection: async ({ url, deviceToken, expectedHostId }) => {
      const adapter = createRacpRemoteHostClient({ transport: wsClientTransport({ url, token: deviceToken }),
        expectedHostId, clientInfo: options.clientInfo, reconnect: { enabled: false }, log });
      try { await adapter.connect(); assertWorkspaceCapabilities(adapter); }
      finally { await adapter.close(); }
    },
    log, ...options.sshBootstrap,
  });

  const realigner = createRemoteHostRealigner({
    bootstrap: (request, execOptions) => bootstrap.bootstrap(request, execOptions),
    upsert: (record) => registry.upsert(record),
  });

  function closeHost(host: OpenHost): Promise<void> {
    const existing = hostClosings.get(host);
    if (existing) return existing;
    // Closing the adapter cancels connect/RPC waits, including subscription
    // cleanup. Start both owners before awaiting either one.
    const task = Promise.all([
      host.connection.close().catch((error: unknown) => log("warn", "remote connection close failed", { error: String(error) })),
      host.adapter.close().catch((error: unknown) => log("warn", "remote adapter close failed", { error: String(error) })),
      tunnels.close(host.hostKey),
    ]).then(() => undefined);
    hostClosings.set(host, task);
    return task;
  }
  async function closeLive(key: string): Promise<void> {
    const host = opened.get(key);
    opened.delete(key);
    if (host) await closeHost(host);
  }
  async function openHostOnce(record: RemoteHostRecord): Promise<OpenHost> {
    assertOpen();
    const ssh = sshMetadataOf(record);
    if (record.metadata?.transport === "ssh" && !ssh) {
      throw Object.assign(new Error("invalid SSH host metadata"), { errorCode: "INVALID_ARGUMENT" });
    }
    // Readiness compares the running Host against the release this desktop
    // expects, not the version recorded at pairing time: a stale descriptor
    // must not mask a Host that is behind, which is the case realignment
    // repairs.
    const expected = ssh ? { ...ssh, version: options.clientInfo.version } : undefined;
    const tunnel = expected ? await tunnels.open(record.hostKey, expected, record.sshSecret) : undefined;
    const url = tunnel?.url ?? record.url;
    if (closed) { await tunnels.close(record.hostKey); throw unavailable(); }
    const adapter = buildAdapter({ ...record, url });
    const connection = createRemoteHostConnection({
      hostKey: record.hostKey, hostLabel: record.label, client: adapter.client, router: options.router,
      emit: (channel, payload) => {
        if (closed) return;
        if (channel === IPC.event.sessionsChanged) void refresh(record.hostKey);
        else options.emit(channel, payload);
      },
      log,
    });
    const live = { hostKey: record.hostKey, label: record.label, adapter, connection, url };
    openingHosts.add(live);
    try {
      assertOpen();
      actionRequired.delete(record.hostKey);
      opened.set(record.hostKey, live);
      await adapter.connect();
      assertOpen();
      assertWorkspaceCapabilities(adapter);
      await tunnel?.completePreparation?.();
      await connection.open();
      assertOpen();
      opened.set(record.hostKey, live);
      await refresh(record.hostKey);
      assertOpen();
      return live;
    } catch (error) {
      if (requiresUserAction(error)) actionRequired.add(record.hostKey);
      if (opened.get(record.hostKey) === live) opened.delete(record.hostKey);
      await closeHost(live);
      throw error;
    } finally {
      openingHosts.delete(live);
    }
  }

  async function openHost(record: RemoteHostRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const abort = () => {
      void Promise.allSettled([closeLive(record.hostKey), tunnels.close(record.hostKey)]);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await openHostOnce(record);
      if (signal?.aborted) { await closeLive(record.hostKey); signal.throwIfAborted(); }
    } finally { signal?.removeEventListener("abort", abort); }
  }
  function summaryOf(record: RemoteHostRecord): RemoteHostSummary {
    const state = opened.get(record.hostKey)?.adapter.state();
    const status: RemoteHostConnectionStatus = state === "connected" || state === "connecting" || state === "reconnecting"
      ? state
      : state === "error" || actionRequired.has(record.hostKey) ? "action-required" : "disconnected";
    return { hostKey: record.hostKey, label: record.label, url: opened.get(record.hostKey)?.url ?? record.url,
      connected: status === "connected", status, transport: transportOf(record), preparation: preparer.state(record.hostKey) };
  }
  async function addRecord(record: RemoteHostRecord): Promise<RemoteHostSummary> {
    assertOpen();
    await registry.upsert(record);
    await closeLive(record.hostKey);
    try { await openHost(record); }
    catch (error) {
      if (closed) throw error;
      log("warn", `remote host ${record.hostKey} paired but failed to open`, { error: String(error) });
    }
    return summaryOf(record);
  }

  const preparer = createRemoteHostPreparer({
    version: options.clientInfo.version, registry, summary: summaryOf, changed,
    connect: (record, signal) => serial(record.hostKey, async () => {
      signal.throwIfAborted();
      if (connectedHost(record.hostKey)) return;
      await closeLive(record.hostKey);
      await openHost(record, signal);
    }),
    upgrade: (record, run) => serial(record.hostKey, async () => {
      assertOpen();
      run.signal.throwIfAborted();
      await closeLive(record.hostKey);
      await tunnels.close(record.hostKey);
      const ssh = sshMetadataOf(record);
      if (ssh && run.currentVersion) {
        // Authenticate the existing device before replacing an older running Host.
        const { url } = await tunnels.open(record.hostKey, { ...ssh, version: run.currentVersion }, record.sshSecret);
        const adapter = buildAdapter({ ...record, url });
        try { await adapter.connect(); }
        finally { await adapter.close(); await tunnels.close(record.hostKey); }
      }
      run.signal.throwIfAborted();
      const result = await realigner(record, run);
      try {
        assertOpen(); run.signal.throwIfAborted();
        await tunnels.adopt(record.hostKey, result.outcome.ssh, result.outcome.forward);
        return result.record;
      } catch (error) { await result.outcome.forward.close(); throw error; }
    }),
  });
  const ensureReady = preparer.ensureReady;

  return {
    registry,
    ensureReady,
    prepareHost: preparer.prepare,
    cancelPreparation: preparer.cancel,
    open() {
      if (opening) return opening;
      opening = (async () => {
        assertOpen();
        const records = await registry.list();
        assertOpen();
        let successes = 0;
        for (const record of records) {
          if (closed) break;
          try {
            await serial(record.hostKey, async () => {
              if (!opened.has(record.hostKey)) await openHost(record);
            });
            successes++;
          } catch (error) {
            if (closed) throw error;
            log("warn", `remote host ${record.hostKey} failed to open; leaving it disconnected`, { error: String(error) });
          }
        }
        return successes;
      })();
      return opening;
    },
    closeAll() {
      if (closing) return closing;
      closed = true;
      for (const controller of bootstraps.keys()) controller.abort();
      const preparations = preparer.dispose();
      const hosts = new Set([...opened.values(), ...openingHosts]);
      opened.clear();
      closing = (async () => {
        const cleanup = [...hosts].map(closeHost);
        // Forward creation is itself an operation we must cancel, not await
        // before disposal. The same fence prevents all late registrations.
        const disposal = tunnels.dispose();
        await Promise.allSettled([...cleanup, disposal, preparations, ...operations.values(), ...bootstraps.values()]);
        await disposal;
      })();
      return closing;
    },
    async list() { return (await registry.list()).map(summaryOf); },
    sessionSummaries: () => catalog.summaries(),
    sessions: catalog.sessions,
    projects: catalog.projects,
    async browseProjects(hostKey, path) {
      await ensureReady(hostKey);
      return catalog.browseProjects(hostKey, path);
    },
    registerProject: catalog.registerProject,
    workspaceClient(hostKey) {
      const host = connectedHost(hostKey);
      if (!host) throw Object.assign(new Error("Remote workspace is disconnected"), { errorCode: "TERMINAL_HOST_OFFLINE", code: "HOST_DISCONNECTED" });
      return host.adapter.client;
    },
    async workspaceFiles(hostKey, input) {
      await ensureReady(hostKey);
      const host = connectedHost(hostKey);
      if (!host) throw unavailable();
      const result = await host.adapter.client.request("workspace/files", input);
      if (connectedHost(hostKey) !== host) throw unavailable();
      return result;
    },
    async workspacePluginFiles(hostKey, input) {
      await ensureReady(hostKey);
      const host = connectedHost(hostKey);
      if (!host) throw unavailable();
      const result = await host.adapter.client.request("workspace/pluginFiles", input);
      if (connectedHost(hostKey) !== host) throw unavailable();
      return result;
    },
    async workspaceCommandShell(hostKey) {
      await ensureReady(hostKey);
      const host = connectedHost(hostKey);
      if (!host) throw unavailable();
      const { shell } = await host.adapter.client.request<{ shell: unknown }>("workspace/toolShell", {});
      if (connectedHost(hostKey) !== host) throw unavailable();
      if (!isCommandShellOption(shell) || !shell.available) {
        throw Object.assign(new Error("remote command shell unavailable"), { errorCode: "COMMAND_SHELL_INVALID" });
      }
      return shell;
    },
    async executeWorkspaceTool(input) {
      const host = connectedHost(input.hostKey);
      if (!host) throw unavailable();
      const { hostKey: _hostKey, ...request } = input;
      if (!request.path.startsWith("/") || request.path.includes("\0")
        || !["Read", "Glob", "Grep", "Write", "Edit", "Bash"].includes(request.toolName)) {
        throw Object.assign(new Error("invalid remote workspace tool"), { errorCode: "INVALID_ARGUMENT" });
      }
      const timeoutMs = input.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 21_600_000) {
        throw Object.assign(new Error("invalid remote tool timeout"), { errorCode: "INVALID_ARGUMENT" });
      }
      try {
        const result = await host.adapter.client.request("workspace/toolExecute", request, timeoutMs + 15_000);
        if (connectedHost(input.hostKey) !== host) throw unavailable();
        if (!result || typeof result !== "object" || !("ok" in result)
          || typeof result.ok !== "boolean" || !("content" in result)) {
          throw Object.assign(new Error("remote host returned an invalid tool result"), { errorCode: "INVALID_ARGUMENT" });
        }
        return result;
      } catch (error) {
        // A timeout/disconnection never replays a side effect. Cancel on the
        // original connection only; a replacement connection owns no such call.
        if (connectedHost(input.hostKey) === host) {
          try { await host.adapter.client.request("workspace/toolAbort", {
            sessionId: input.sessionId, toolCallId: input.toolCallId,
          }); } catch (abortError) { log("warn", "remote tool abort failed", { error: String(abortError) }); }
        }
        throw workspaceExecutionError(input.toolName, error);
      }
    },
    async abortWorkspaceTool(input) {
      const host = connectedHost(input.hostKey);
      if (!host) throw unavailable();
      await host.adapter.client.request("workspace/toolAbort", {
        sessionId: input.sessionId, toolCallId: input.toolCallId,
      });
    },
    async createSession(input) {
      const session = await catalog.createSession(input);
      changed();
      return session;
    },
    syncProviders(input) {
      return serial(input.hostKey, async () => {
        if (!connectedHost(input.hostKey)) throw unavailable();
        const record = (await registry.list()).find((item) => item.hostKey === input.hostKey);
        if (!record) throw unavailable();
        const host = options.getLocalHost?.();
        if (!host) throw unavailable();
        return syncRemoteProviders(input, record, host);
      });
    },
    addHost: (record) => serial(record.hostKey, () => addRecord(record)),
    async reconnectHost(key) {
      await serial(key, async () => { await closeLive(key); await tunnels.close(key); });
      return preparer.prepare({ hostKey: key, requestId: `reconnect-${Date.now()}`, retry: true });
    },
    async bootstrapHost(request) {
      assertOpen();
      const controller = new AbortController();
      const task = bootstrap.bootstrap(request, { signal: controller.signal });
      bootstraps.set(controller, task);
      const outcome = await task.finally(() => { bootstraps.delete(controller); });
      let adopted = false;
      try {
        return await serial(outcome.hostKey, async () => {
          await closeLive(outcome.hostKey);
          assertOpen();
          await tunnels.adopt(outcome.hostKey, outcome.ssh, outcome.forward);
          adopted = true;
          try {
            assertOpen();
            const record = sshHostRecord(outcome);
            record.metadata = { ...record.metadata, piHostDownloadConsent: true };
            const host = await addRecord(record);
            return { host, ssh: outcome.ssh, steps: outcome.steps };
          } catch (error) {
            await tunnels.close(outcome.hostKey);
            throw error;
          }
        });
      } finally {
        // serial can reject before invoking the action; until adopt succeeds
        // this call, not the tunnel manager, still owns the bootstrap forward.
        if (!adopted) await outcome.forward.close();
      }
    },
    removeHost: async (key) => {
      await preparer.forget(key);
      return serial(key, async () => {
      await closeLive(key);
      await tunnels.close(key);
      await registry.remove(key);
      actionRequired.delete(key);
      catalog.forget(key);
      changed();
      });
    },
    async listSessions() {
      const results = await Promise.all([...opened.values()].map(async (host) => {
        if (!connectedHost(host.hostKey)) return [];
        try {
          const result = await host.adapter.client.request<{ sessions: RacpSession[] }>("session/list");
          if (connectedHost(host.hostKey) !== host) return [];
          return result.sessions.map((session): RemoteLiveSessionSummary => ({
            id: makeRemoteSessionId(host.hostKey, session.id), title: session.title,
            mode: session.mode, permissionMode: session.permissionMode, status: session.status,
            ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
            ...(session.workspaceLabel ? { workspaceLabel: session.workspaceLabel } : {}),
            source: "remote", hostKey: host.hostKey, hostLabel: host.label,
          }));
        } catch (error) {
          log("warn", `remote host ${host.hostKey} session list failed`, { error: String(error) });
          return [];
        }
      }));
      return results.flat();
    },
    async readHistory(sessionId, limit) {
      const parsed = parseRemoteSessionId(sessionId);
      const host = parsed ? connectedHost(parsed.hostKey) : undefined;
      if (!parsed || !host) throw Object.assign(new Error("Remote session is unavailable"), { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) throw Object.assign(new Error("Remote history limit is invalid"), { errorCode: "INVALID_ARGUMENT" });
      const result = await host.adapter.client.request<{ items?: RacpItemSummary[] }>("session/history", { sessionId: parsed.hostSessionId, limit });
      return result.items ?? [];
    },
    subscribeSession(sessionId, listener) {
      const parsed = parseRemoteSessionId(sessionId);
      const host = parsed ? connectedHost(parsed.hostKey) : undefined;
      if (!parsed || !host) return null;
      return host.adapter.client.subscribe((envelope) => {
        if (envelope.scope === "session" && envelope.sessionId === parsed.hostSessionId) listener(envelope);
      });
    },
  };
}
