import { WorkspaceProcessService } from "@pi-desktop/host-runtime";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AgentHost, MaintenanceAdmission, type ApprovalPort } from "@pi-desktop/agent-host";
import {
  AgentSidecar, WorkspaceTerminalService, ShellRegistry, WorkspacePluginService,
  HostProcess,
  PlanExecutionDispatcher,
  RuntimeService,
  RuntimeSupervisor,
  createHeadlessLaunchResolver,
  createHostQueueStore,
  createHostSessionPort,
  listPendingToolRequests,
} from "@pi-desktop/host-runtime";
import { DeviceTokenAuthenticator, RacpServer, bindRacpWebSocket, type RacpHostOperations, type WsBinding } from "@pi-desktop/racp";
import { APP_VERSION, PROTOCOL_VERSION, type AgentEventEnvelope } from "@pi-desktop/shared";

import type { PiHostConfig } from "./config.js";
import { attachPiHostCommandCenter, type PiHostCommandCenter } from "./command-center.js";
import { FileCredentialStore, loadOrCreateHostId } from "./credentials.js";
import { createHostOperations } from "./host-operations.js";
import { createLogger, type HostLogger } from "./logger.js";
import { TerminalService, loadPty } from "./terminal.js";
import { prepareAdminDirectory, startAdminSocket } from "./admin-socket.js";
import { handleMaintenanceRequest, MAINTENANCE_PROTOCOL, type MaintenanceRequest, type MaintenanceResponse } from "./maintenance.js";

export type PiHostApp = {
  hostId: string;
  address: { host: string; port: number };
  agentHost: AgentHost;
  runtime: RuntimeService;
  authenticator: DeviceTokenAuthenticator;
  server: RacpServer;
  log: HostLogger;
  /** Maintenance admission protocol this Host serves on its admin channel. */
  maintenance: typeof MAINTENANCE_PROTOCOL;
  /** Mint a single-use pairing token for the bootstrap channel. */
  issuePairingToken(lifetimeMs: number): Promise<{ token: string; expiresAt: string }>;
  stop(): Promise<void>;
};

const APPROVAL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Compose the headless Host: host-core and the sidecar under the shared
 * supervisor, the runtime service as the module's runtime port, the Agent
 * Host module, and the RACP server on loopback. Everything the desktop
 * would own for a local session — transcript, queue, approvals, tools,
 * workspace — lives here on this machine.
 */
export async function startPiHost(config: PiHostConfig, options: { log?: HostLogger } = {}): Promise<PiHostApp> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await prepareAdminDirectory(config.dataDir);
  const log = options.log ?? createLogger({ dataDir: config.dataDir, minLevel: config.logLevel });
  const hostId = await loadOrCreateHostId(config.dataDir);
  const store = new FileCredentialStore(config.dataDir);
  const authenticator = new DeviceTokenAuthenticator(store);

  const state: { host: HostProcess | null; sidecar: AgentSidecar | null; stopping: boolean; hostEpoch: string | null } = { host: null, sidecar: null, stopping: false, hostEpoch: null };
  const getHost = () => state.host;
  const getSidecar = () => state.sidecar;
  const getHostEpoch = () => state.hostEpoch;

  // Closed before the first inspection await, so no new work can slip in.
  const maintenanceGate = new MaintenanceAdmission();
  const launch = createHeadlessLaunchResolver({ getHost, dataDir: config.dataDir, log: (level, message, data) => log(level, message, data) });
  const runtime = new RuntimeService({ getHost, getSidecar, launch, log });

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      await host.call("permissions.resolve", { requestId, decision });
    },
    async resolveContract(input) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>("plans.pending", { sessionId: input.sessionId });
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw Object.assign(new Error(`proposal ${input.proposalId} is not pending`), { errorCode: "NOT_FOUND" });
      const result = await host.call("plans.resolve", {
        proposalId: input.proposalId,
        sessionId: input.sessionId,
        turnId: proposal.turnId ?? "",
        toolCallId: proposal.toolCallId ?? "",
        action: input.action,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
      });
      if (input.action === "approve") void plans.dispatchExecutionForProposal(input.proposalId);
      return void result;
    },
    listPendingTools: (sessionId) => listPendingToolRequests(getHost, sessionId),
  };
  const agentHost = new AgentHost({
    runtime,
    sessions: createHostSessionPort(getHost),
    approvals,
    queueStore: createHostQueueStore(getHost),
    localApprovalLifetimeMs: APPROVAL_REQUEST_TIMEOUT_MS,
    gate: maintenanceGate,
  });
  const plans = new PlanExecutionDispatcher({ getHost, getSidecar, launch, runtime, log, gate: maintenanceGate });

  // Every runtime event feeds the module; a settled turn closes it there too.
  const abortingSessions = new Set<string>();
  runtime.onEvent((envelope: AgentEventEnvelope) => {
    const interrupted = envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
    if (envelope.event.type === "agent_end" || envelope.event.type === "error") abortingSessions.delete(envelope.sessionId);
    try {
      agentHost.ingest(envelope, { interrupted });
    } catch (error) {
      log("warn", "agent host ingest failed", { sessionId: envelope.sessionId, type: envelope.event.type, error: String(error) });
    }
  });
  runtime.onTurnEnded((info) => {
    abortingSessions.delete(info.sessionId);
    const status = info.reason === "aborted" ? "interrupted" : info.reason === "error" ? "failed" : "completed";
    try {
      agentHost.endTurn(info.sessionId, info.turnId, status, info.errorCode ? { error: { code: info.errorCode, message: info.errorCode, retriable: false, traceId: "" } } : {});
      agentHost.kick(info.sessionId);
    } catch (error) {
      log("warn", "agent host end turn failed", { sessionId: info.sessionId, turnId: info.turnId, error: String(error) });
    }
  });
  const originalAbort = runtime.abort.bind(runtime);
  runtime.abort = async (sessionId, turnId) => {
    abortingSessions.add(sessionId);
    try {
      await originalAbort(sessionId, turnId);
    } catch (error) {
      abortingSessions.delete(sessionId);
      throw error;
    }
  };

  const startHost = async () => {
    const host = new HostProcess({ binaryPath: config.hostCoreBinary, dataDir: config.dataDir, onStderr: log.child("host") });
    host.onExit(({ intentional }) => {
      if (state.host !== host) return;
      state.host = null;
      state.hostEpoch = null;
      if (intentional || state.stopping) return;
      log("error", "host-core exited unexpectedly");
      void supervisor.superviseRestart("host");
    });
    state.host = host;
    try {
      // `HostProcess.handshake()` discards the result, but the command-center
      // consumer needs the actual boot/fenced owner epoch from this instance.
      const handshake = await host.call<{ commandCenter?: { version?: number; hostEpoch?: string } }>(
        "app.handshake",
        { protocolVersion: PROTOCOL_VERSION },
      );
      const epoch = handshake?.commandCenter?.hostEpoch;
      if (config.commandCenter && (typeof epoch !== "string" || epoch.length === 0)) {
        throw Object.assign(new Error("host-core did not report a command-center boot epoch"), { errorCode: "HOST_BOOTSTRAP_FAILED" });
      }
      state.hostEpoch = typeof epoch === "string" && epoch.length > 0 ? epoch : null;
      await host.call("session.recoverInflightMessages").catch((error: unknown) => log("warn", "in-flight recovery failed", { error: String(error) }));
    } catch (error) {
      if (state.host === host) state.host = null;
      state.hostEpoch = null;
      await host.dispose();
      throw error;
    }
    runtime.attachHost(host);
    state.sidecar?.setHost(host);
    log("info", "host-core handshake ok", { generation: host.generation });
  };
  const startSidecar = async () => {
    const sidecar = new AgentSidecar({
      launch: { command: config.nodeBinary, args: [config.sidecarEntry], env: { ...process.env, PI_DESKTOP_DATA_DIR: config.dataDir } },
      onStderr: log.child("agent"),
    });
    sidecar.onExit(({ intentional, code, signal, stderrTail }) => {
      if (state.sidecar !== sidecar) return;
      state.sidecar = null;
      if (intentional || state.stopping) return;
      log("error", "agent sidecar exited unexpectedly", { exitCode: code, signal, stderrTail });
      void supervisor.superviseRestart("sidecar");
    });
    sidecar.setProjectInstructionResolver(async ({ projectPath, path }) => {
      const { loadInstructionChain } = await import("@pi-desktop/agent-runtime");
      return loadInstructionChain(projectPath, path);
    });
    sidecar.setLocalTool("Skill", async ({ args, sessionId }) => {
      const id = String((args as { id?: unknown })?.id ?? "").trim();
      const host = getHost();
      if (!id || !host) return { ok: false, isError: true, content: "Skill: `id` is required." };
      const session = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(() => null);
      const result = await host.call<{ skill: { id: string; name: string } | null; body: string | null }>("skills.read", { id, projectPath: session?.session?.projectPath ?? null }).catch(() => null);
      if (!result?.skill || typeof result.body !== "string") return { ok: false, isError: true, content: `Skill: "${id}" is not available on this Host.` };
      return { ok: true, content: `# Skill: ${result.skill.name} (${result.skill.id})\n\n${result.body}` };
    });
    sidecar.setTrustedExtensionBridge({
      publishCommands: () => undefined,
      publishDiagnostics: () => undefined,
      requestUi: async () => {
        throw new Error("extension UI is not available on a headless host");
      },
      configureModel: async () => {
        throw new Error("extension model configuration is not available on a headless host");
      },
      queuePush: async (params) =>
        agentHost.startTurn({ subject: "extension", roles: ["controller"] }, {
          sessionId: String(params.sessionId ?? ""),
          admission: "queue",
          input: { text: String(params.content ?? "") },
          context: { requestId: `ext-${Date.now().toString(36)}`, ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}) },
        }),
      queuePrioritize: async (params) => agentHost.prioritizeTurn({ subject: "extension", roles: ["controller"] }, String(params.id ?? "")),
    });
    state.sidecar = sidecar;
    runtime.attachSidecar(sidecar);
    if (state.host) sidecar.setHost(state.host);
    await sidecar.call("sidecar.configure", { hostBinary: config.hostCoreBinary, dataDir: config.dataDir });
    log("info", "agent sidecar configured");
  };
  const supervisor = new RuntimeSupervisor({
    start: { host: startHost, sidecar: startSidecar },
    afterRestart: () => plans.drainApprovedPlanExecutions(),
    isShuttingDown: () => state.stopping,
    onEvent: (event) => {
      if (event.phase === "fatal") log("error", `${event.kind} restart gave up`, { reason: event.reason, error: event.error ? String(event.error) : undefined });
      else if (event.phase === "restarted") log("warn", `${event.kind} restarted after crash`, { attempt: event.attempt });
      else if (event.phase === "restart_failed") log("error", `${event.kind} restart failed`, { attempt: event.attempt, error: String(event.error) });
    },
  });

  // The admin channel is claimed first, so it reads the owners through late
  // bindings instead of keeping a second copy of their state.
  const owners: {
    clients: () => number;
    tools: () => number;
    processes: () => number;
    terminals: () => number;
    plugins: () => number;
  } = { clients: () => 0, tools: () => 0, processes: () => 0, terminals: () => 0, plugins: () => 0 };
  let maintenanceReady = false;
  const maintenanceInspect = async () => {
    if (!maintenanceReady || state.stopping) throw new Error("Host maintenance is unavailable during lifecycle transitions");
    const counts = agentHost.maintenanceBusyCounts();
    return {
      clients: owners.clients(),
      turns: counts.turns + counts.admissions,
      queuedTurns: counts.queuedTurns,
      plans: plans.inFlightCount(),
      tools: owners.tools(),
      processes: owners.processes(),
      terminals: owners.terminals(),
      plugins: owners.plugins(),
    };
  };
  const maintenance = {
    // The owner-only channel is claimed before host-core, so it reads owners lazily.
    handle: (request: MaintenanceRequest): Promise<MaintenanceResponse> =>
      handleMaintenanceRequest({ hostId, version: APP_VERSION, gate: maintenanceGate, inspect: maintenanceInspect }, request),
    isClosed: () => maintenanceGate.isClosed(),
  };
  const admin = process.platform === "win32" ? undefined : await startAdminSocket({ dataDir: config.dataDir, getHost, log, maintenance });
  try {
    await startHost();
    await startSidecar();
    await agentHost.start();
    await plans.drainApprovedPlanExecutions().catch((error: unknown) => log("warn", "queued approved plan drain failed", { error: String(error) }));
  } catch (error) {
    state.stopping = true;
    maintenanceGate.dispose();
    await admin?.close();
    plans.dispose();
    await runtime.dispose();
    await state.sidecar?.dispose();
    await state.host?.dispose();
    throw error;
  }

  const pty = loadPty();
  const terminal = pty
    ? new TerminalService({
        pty,
        log,
        sessionRoot: async (sessionId) => {
          const host = getHost();
          if (!host) throw new Error("host unavailable");
          const result = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 });
          const root = result.session?.projectPath?.trim();
          if (!root) throw Object.assign(new Error("the session has no project root"), { errorCode: "CONFLICT" });
          return root;
        },
      })
    : undefined;
  if (!pty) log("warn", "node-pty is not installed; terminals are disabled");

  const shellRegistry = new ShellRegistry();
  const workspaceTerminal = pty ? new WorkspaceTerminalService({ pty, shells: refresh => shellRegistry.listShells(refresh), onError: message => log("warn", message) }) : undefined;
  const runner = [new URL("./plugin-host-process.mjs", import.meta.url), new URL("../../../packages/host-runtime/plugin-host-process.mjs", import.meta.url)]
    .map(url => fileURLToPath(url)).find(path => existsSync(path));
  const workspaceProcesses = new WorkspaceProcessService();
  const workspacePlugins = runner ? new WorkspacePluginService({ dataDir: config.dataDir, runner, pty: () => pty }) : undefined;
  owners.processes = () => workspaceProcesses.inUse();
  owners.terminals = () => (terminal?.inUse() ?? 0) + (workspaceTerminal?.inUse() ?? 0);
  owners.plugins = () => workspacePlugins?.inUse() ?? 0;
  if (!runner) log("warn", "Workspace plugin runner is missing; workspace plugins are disabled");
  const operations: RacpHostOperations = {
    ...createHostOperations({
      getHost,
      runtime,
      browseRoot: config.browseRoot,
      dataDir: config.dataDir,
      gate: maintenanceGate,
      disposeSession: async (sessionId) => {
        const sidecar = getSidecar();
        if (!sidecar) return;
        sidecar.clearProjectInstructionRoot(sessionId);
        await sidecar.call("agent.disposeSession", { sessionId }).catch(() => undefined);
      },
      revokeDevice: async (deviceId) => {
        const revoked = await store.revokeDevice(deviceId, new Date().toISOString());
        if (revoked) { workspaceTerminal?.revoke(deviceId); workspacePlugins?.revoke(deviceId); workspaceProcesses.revoke(deviceId); }
        return revoked;
      },
    }),
    ...(terminal ? { terminal } : {}),
    ...(workspaceTerminal ? { workspaceTerminal } : {}),
    ...(workspacePlugins ? { workspacePlugins } : {}),
    workspaceProcesses,
  };
  owners.tools = () => (operations.workspaceTools as { inUse?: () => number } | undefined)?.inUse?.() ?? 0;
  // Off unless `--command-center` opted in. Both the control service and the
  // monitor page port use the same single host-core instance and its handshake
  // epoch; the capability is advertised only after this binding succeeds.
  const commandCenter: PiHostCommandCenter | undefined = attachPiHostCommandCenter({
    config,
    operations,
    getHost,
    hostId,
    getHostEpoch,
    runtime,
    maintenanceClosed: () => maintenanceGate.isClosed(),
  });
  const server = new RacpServer({ agentHost, operations, authenticator, hostId, serverVersion: APP_VERSION, log, admission: maintenanceGate, ...(commandCenter ? { advertiseCommandCenter: true } : {}) });
  owners.clients = () => server.connectionCount();
  let binding: WsBinding;
  try {
    binding = await bindRacpWebSocket({ server: server, authenticator, host: config.host, port: config.port, log });
  } catch (error) {
    state.stopping = true;
    maintenanceGate.dispose();
    await admin?.close();
    server.close();
    await commandCenter?.dispose();
    workspaceTerminal?.dispose();
    workspacePlugins?.dispose(); workspaceProcesses.dispose();
    await terminal?.closeAll();
    plans.dispose();
    await runtime.dispose();
    await state.sidecar?.dispose();
    await state.host?.dispose();
    throw error;
  }
  log("info", "pi-host ready", { hostId, host: binding.address.host, port: binding.address.port, version: APP_VERSION, terminal: Boolean(terminal) });
  maintenanceReady = true;

  return {
    hostId,
    address: binding.address,
    agentHost,
    runtime,
    authenticator,
    server,
    maintenance: MAINTENANCE_PROTOCOL,
    log,
    issuePairingToken: (lifetimeMs) => authenticator.issuePairingToken(lifetimeMs),
    async stop() {
      if (state.stopping) return;
      state.stopping = true;
      maintenanceGate.dispose();
      log("info", "pi-host stopping");
      await admin?.close();
      server.close();
      await binding.close();
      await commandCenter?.dispose();
      workspaceTerminal?.dispose();
      workspacePlugins?.dispose(); workspaceProcesses.dispose();
      await terminal?.closeAll();
      plans.dispose();
      await runtime.dispose();
      await state.sidecar?.dispose();
      await state.host?.dispose();
      state.sidecar = null;
      state.host = null;
    },
  };
}
