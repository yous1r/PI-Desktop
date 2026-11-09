/**
 * RACP-WS-backed {@link RemoteHostClient}: adapts the single-callback
 * `RacpClient.onEvent` seam into the multi-listener `subscribe()` shape
 * `RemoteHostConnection` consumes. This is the only file in
 * `electron/main/remote/` that speaks the `@pi-desktop/racp` protocol
 * package; everything above it is transport-agnostic.
 *
 * Ownership stays inside Electron Main. The transport factory is injected —
 * production wires it to {@link wsClientTransport} against a paired host, and
 * tests wire it to the in-memory `MemoryLink` from
 * `packages/racp/src/test-harness.ts` so the adapter exercises the real
 * `RacpClient` state machine without a socket.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  RacpClient,
  wsClientTransport,
  type ClientTransportFactory,
  type RacpClientState,
} from "@pi-desktop/racp";
import { ErrorCodes, type RacpEventEnvelope } from "@pi-desktop/shared";
import type { RemoteHostClient, RemoteSubscriptionClosed } from "./remote-host-connection.js";
import { RemoteClientOwnership, remoteClientDisconnected } from "./remote-client-ownership.js";

export type PairingExchangeOptions = {
  /** Loopback RACP endpoint, either pasted by the user or forwarded by us. */
  url: string;
  /** Single-use `ppt1.` token the host printed at start. */
  pairingToken: string;
  /** Device label the host records against the minted device. */
  label: string;
  clientInfo: { name: string; version: string };
  /** New SSH workspace installs require both additive workspace services. */
  requireWorkspace?: boolean;
  expectedHostId?: string;
  isAdmissionClosed?: () => boolean;
  /** Optional lifecycle owner for the throwaway pairing connection. */
  useClient?: (client: RacpRemoteHostClient, exchange: () => Promise<string>) => Promise<string>;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

/**
 * Spend a single-use pairing token on a throwaway connection and return the
 * durable `pdt1.` device token the host minted (spec §3.4).
 *
 * The connection is closed on every path — success, refusal, and transport
 * failure — because the token is consumed by the exchange and a lingering
 * unprivileged socket would only keep a half-paired session open.
 */
export async function exchangePairingToken(options: PairingExchangeOptions): Promise<string> {
  const pairing = createRacpRemoteHostClient({
    transport: wsClientTransport({ url: options.url, token: options.pairingToken }),
    clientInfo: options.clientInfo,
    requireWorkspace: options.requireWorkspace,
    expectedHostId: options.expectedHostId,
    isAdmissionClosed: options.isAdmissionClosed,
    log: options.log,
  });
  const exchange = async () => {
    await pairing.connect();
    const result = (await pairing.client.request("connection/pair", {
      deviceLabel: options.label,
    })) as { deviceToken?: unknown };
    if (typeof result?.deviceToken !== "string" || result.deviceToken.length === 0) {
      throw Object.assign(new Error("pi-host did not return a device token"), {
        errorCode: ErrorCodes.PAIRING_FAILED,
      });
    }
    return result.deviceToken;
  };
  if (options.useClient) return options.useClient(pairing, exchange);
  try { return await exchange(); }
  finally { await pairing.close().catch(() => undefined); }
}

export type RacpRemoteHostClientOptions = {
  transport: ClientTransportFactory;
  isAdmissionClosed?: () => boolean;
  /** Identity sent in `connection/initialize`; the host records it as the device label. */
  clientInfo: { name: string; version: string };
  /** Leave false for legacy remote-Agent histories and manual pairing. */
  requireWorkspace?: boolean;
  expectedHostId?: string;
  /** Deadline for a single request; the RACP default of 15s is used when omitted. */
  requestTimeoutMs?: number;
  /** Reconnect policy; the RACP client stays disconnected when omitted. */
  reconnect?: {
    enabled: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  onReconnected?: () => Promise<void>;
  onStateChange?: (state: RacpClientState) => void;
  /** Optional structured log; defaults to a no-op. */
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

export type RacpRemoteHostClient = {
  /** The multi-listener {@link RemoteHostClient} the connection module consumes. */
  readonly client: RemoteHostClient;
  /** Underlying RACP client state, for boot diagnostics and the future host card. */
  readonly state: () => RacpClientState;
  /** Open the transport and initialize the RACP session. */
  connect(): Promise<void>;
  /** Close the transport; safe to call before {@link connect} and after failure. */
  /**
   * Workspace capabilities the live handshake advertised, or `undefined`
   * before `connection/initialize` completes. Callers use the distinction to
   * tell "not known yet" from "this Host does not offer them", which is the
   * same-version mismatch the desktop must realign (ADR 0327).
   */
  workspaceCapabilities?(): RemoteWorkspaceCapabilities | undefined;
  /** Close the transport; safe to call before {@link connect} and after failure. */
  close(): Promise<void>;
  getHandoffActivity(): { operations: number; resources: number; uncontainedResources: number };
};

/** The two additive services a remote workspace install must advertise. */
export type RemoteWorkspaceCapabilities = {
  workspaceTools: boolean;
  workspaceFiles: boolean;
};

/**
 * The adapter multiplexes {@link RacpClient.onEvent} — a single-slot callback
 * — into the `subscribe()` API {@link RemoteHostConnection} expects. Fan-out
 * is intentional: Stage 5 (terminal) and Stage 3b (resync watchdog) will
 * attach their own listeners on the same client.
 */
export function createRacpRemoteHostClient(
  options: RacpRemoteHostClientOptions,
): RacpRemoteHostClient {
  const listeners = new Set<(envelope: RacpEventEnvelope) => void>();
  const reconnectListeners = new Set<() => Promise<void>>();
  const stateListeners = new Set<(state: RacpClientState) => void>();
  const closedListeners = new Set<(notice: RemoteSubscriptionClosed) => void>();
  let closed = false;
  let generation = 0;
  let connectionGeneration = 0;
  // An inbound handler's asynchronous effects inherit the connection that
  // admitted them; a later explicit reopen must not borrow that authority.
  const inbound = new AsyncLocalStorage<() => void>();
  const serverHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  let visibleState: RacpClientState = "disconnected";
  let closing: Promise<void> | undefined;
  const ownership = new RemoteClientOwnership(options.isAdmissionClosed ?? (() => false), message => options.log?.("warn", message));
  const notify = <T>(subscribers: Set<(value: T) => void>, value: T) => {
    for (const listener of subscribers) {
      try { listener(value); }
      catch (error) { options.log?.("warn", "remote lifecycle listener threw", { error: String(error) }); }
    }
  };
  const publishState = (state: RacpClientState) => {
    if (state === "connected" && visibleState !== "connected") connectionGeneration++;
    visibleState = state;
    notify(stateListeners, state);
    try { options.onStateChange?.(state); }
    catch (error) { options.log?.("warn", "remote state listener threw", { error: String(error) }); }
  };
  const workspaceCapabilities = (): RemoteWorkspaceCapabilities | undefined => {
    const capabilities = racp.initialized?.capabilities;
    if (!capabilities) return undefined;
    return {
      workspaceTools: capabilities.workspaceTools === true,
      workspaceFiles: capabilities.workspaceFiles === true,
    };
  };
  const requireWorkspace = (capability?: keyof RemoteWorkspaceCapabilities) => {
    const capabilities = workspaceCapabilities();
    const supported = capability ? capabilities?.[capability] === true
      : capabilities?.workspaceTools === true && capabilities?.workspaceFiles === true;
    if (!supported) {
      throw Object.assign(new Error("Upgrade pi-host to a matching Desktop release with workspace tools and files support"), {
        errorCode: ErrorCodes.HOST_VERSION_MISMATCH,
        retriable: false,
      });
    }
  };
  const validateIdentity = () => {
    if (options.expectedHostId !== undefined && racp.initialized?.server.hostId !== options.expectedHostId) {
      throw Object.assign(new Error("Remote Host identity changed; pair the intended Host again"), {
        errorCode: "HOST_AUTH_FAILED", retriable: false,
      });
    }
  };
  const racp = new RacpClient({
    transport: () => {
      const token = generation;
      return ownership.open(options.transport, () => { if (closed || token !== generation) throw remoteClientDisconnected(); });
    },
    client: options.clientInfo,
    onServerRequest: (method, params) => ownership.track(async () => {
      const check = ownership.capture(true);
      const handler = serverHandlers.get(method);
      if (!handler) throw Object.assign(new Error("Unsupported server request"), { code: "METHOD_NOT_FOUND" });
      return inbound.run(check, async () => {
        const result = await handler(params);
        check();
        return result;
      });
    }),
    onStateChange: state => {
      if (closed && state !== "disconnected") return;
      if (state === "connected" && ownership.isAdmissionClosed()) return;
      // The socket is initialized before onReconnected runs. Do not advertise
      // readiness until subscription/snapshot recovery has also completed.
      if (state === "connected" && (visibleState === "reconnecting" || options.requireWorkspace || options.expectedHostId)) return;
      publishState(state);
    },
    onSubscriptionClosed: notice => { if (!closed) notify(closedListeners, notice); },
    onReconnected: () => ownership.track(async () => {
      const check = ownership.capture(true);
      validateIdentity();
      if (options.requireWorkspace) requireWorkspace();
      const results = await Promise.allSettled([...reconnectListeners].map(listener => ownership.track(async () => {
        check(); await listener(); check();
      })));
      check();
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "remote subscription recovery failed");
      await options.onReconnected?.();
      check();
      if (racp.state === "connected") publishState("connected");
    }),
    onEvent: (envelope) => {
      if (closed) return;
      const token = generation;
      for (const listener of [...listeners]) {
        if (closed || token !== generation) return;
        try {
          listener(envelope);
        } catch (error) {
          options.log?.("warn", "remote event listener threw", { error: String(error) });
        }
      }
    },
    sleep: ms => ownership.track(() => new Promise(resolve => setTimeout(resolve, ms))),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const client: RemoteHostClient = {
    async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      const bound = inbound.getStore();
      const check = bound ?? ownership.capture(false);
      if (bound) bound();
      // Offline errors remain offline errors; capabilities belong to the live handshake.
      if (racp.state === "connected") {
        if (method === "workspace/process" && racp.initialized?.capabilities.workspaceProcesses !== 1) throw Object.assign(new Error("Update the Host to execute structured workspace commands"), {code:"CAPABILITY_UNAVAILABLE",errorCode:"CAPABILITY_UNAVAILABLE"});
        if (method === "workspace/plugin" && racp.initialized?.capabilities.workspacePlugins !== 1) {
          throw Object.assign(new Error("Upgrade pi-host for workspace plugin support"), {code:"CAPABILITY_UNAVAILABLE",errorCode:"CAPABILITY_UNAVAILABLE"});
        }
        if (method === "workspace/terminal" && !racp.initialized?.capabilities.workspaceTerminal) {
          throw Object.assign(new Error("Upgrade pi-host for workspace terminal support"), { code: "TERMINAL_HOST_UNSUPPORTED", errorCode: "TERMINAL_HOST_UNSUPPORTED" });
        }
        if (method === "workspace/pluginFiles") {
          if (!racp.initialized?.capabilities.workspacePluginFiles) {
            throw Object.assign(new Error("Upgrade pi-host to a matching Desktop release with plugin file browsing support"), {
              errorCode: ErrorCodes.HOST_VERSION_MISMATCH, retriable: false,
            });
          }
        } else if (method === "workspace/files") requireWorkspace("workspaceFiles");
        else if (["workspace/toolExecute", "workspace/toolAbort", "workspace/toolShell"].includes(method)) {
          requireWorkspace("workspaceTools");
        }
      }
      return ownership.track(async () => {
        check();
        const result = await racp.request<T>(method, params, timeoutMs);
        check();
        return result;
      });
    },
    state: () => visibleState,
    generation: () => connectionGeneration,
    handleServerRequest(method, handler) {
      if (serverHandlers.has(method)) throw new Error(`Server request handler already registered: ${method}`);
      serverHandlers.set(method, handler);
      return () => { if (serverHandlers.get(method) === handler) serverHandlers.delete(method); };
    },
    subscribeReconnect(listener) { reconnectListeners.add(listener); return () => { reconnectListeners.delete(listener); }; },
    subscribeState(listener) { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    subscribeSubscriptionClosed(listener) { closedListeners.add(listener); return () => { closedListeners.delete(listener); }; },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    client,
    state: () => visibleState,
    getHandoffActivity: () => ownership.snapshot(),
    workspaceCapabilities,
    async connect() {
      ownership.assertAdmission();
      if (closed) { closed = false; closing = undefined; }
      const token = generation;
      return ownership.track(async () => {
        try {
          await racp.connect();
          if (closed || token !== generation) throw remoteClientDisconnected();
          const check = ownership.capture(true);
          validateIdentity();
          if (options.requireWorkspace) requireWorkspace();
          if ((options.requireWorkspace || options.expectedHostId) && racp.state === "connected") publishState("connected");
          check();
        } catch (error) {
          if (token === generation) { await racp.close(); ownership.closeAll(); }
          throw error;
        }
      });
    },
    close() {
      const bound = inbound.getStore();
      if (bound) {
        // An inbound callback never closes the live connection on behalf of
        // a replaced generation. The stale request is refused with its own error.
        return Promise.reject(remoteClientDisconnected());
      }
      if (closing) return closing;
      let resolve!: () => void, reject!: (error: unknown) => void;
      const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      closing = completion;
      closed = true;
      const token = ++generation;
      listeners.clear(); reconnectListeners.clear(); closedListeners.clear();
      void ownership.track(async () => {
        try {
          const originalClose = racp.close();
          ownership.closeAll();
          await originalClose;
        } finally {
          if (closed && token === generation) { stateListeners.clear(); serverHandlers.clear(); }
        }
      }).then(resolve, reject);
      return completion;
    },
  };
}
