import {
  RacpError,
  type CommandCenterAccess,
  type CommandCenterBinding,
  type CommandCenterRuntimeAcknowledgement,
  type CommandCenterRuntimeHandoff,
  type HostRpcPort,
  type Principal,
} from "@pi-desktop/agent-host";
import type {
  CommandCenterExecutionTarget,
  CommandCenterInterventionRequest,
  CommandCenterOperation,
} from "@pi-desktop/shared";
import {
  createCommandCenterHost,
  createCommandCenterMonitorRpcPort,
  type CommandCenterHost,
  type CommandCenterMonitorRpcPort,
  type RuntimeService,
} from "@pi-desktop/host-runtime";
import { createCommandCenterDispatch, type RacpHostOperations } from "@pi-desktop/racp";
import type { PiHostConfig } from "./config.js";

/** The exact RuntimeService operations the command-center consumer may use. */
export type PiHostCommandCenterRuntime = Pick<RuntimeService, "activeTurnId" | "steer" | "abort">;

export type PiHostCommandCenter = {
  readonly control: CommandCenterHost["control"];
  readonly monitorPage: CommandCenterMonitorRpcPort;
  /** Dispose the monitor page cache, then the host-owned dispatchers. */
  dispose(): Promise<void>;
};

export type PiHostCommandCenterDeps = {
  config: Pick<PiHostConfig, "commandCenter">;
  operations: RacpHostOperations;
  /** The one running host-core; a restart replaces this instance. */
  getHost: () => HostRpcPort | null;
  /** Installation identity loaded once at boot; never minted here. */
  hostId: string;
  /** Actual `app.handshake` commandCenter.hostEpoch for the live instance. */
  getHostEpoch: () => string | null;
  runtime: PiHostCommandCenterRuntime;
  /** True while the shared maintenance/owner-handoff gate is closed. */
  maintenanceClosed: () => boolean;
};

const SUPPORTED_INTENTS: readonly CommandCenterOperation[] = ["steer", "reviseGoal", "stop"];

function unavailable(message: string): RacpError {
  return new RacpError("CAPABILITY_UNAVAILABLE", message, { retriable: false });
}

/**
 * Paired single-user authorization over the existing RACP roles, unchanged:
 * owner keeps full scope, viewers read, controllers control sessions. A
 * workspace mutation is never granted below owner.
 */
async function authorize(principal: Principal, access: CommandCenterAccess): Promise<boolean> {
  const roles = principal.roles;
  if (roles.includes("owner")) return true;
  if (access.permission === "read") return roles.length > 0;
  // Workspace administration is separately gated by the owner-only operation
  // catalog. Controllers still need workspace scope to steer an owned session.
  return roles.includes("controller");
}

/**
 * Exact-turn command consumer over RuntimeService.
 *
 * Only a session target whose `turnId` is the RuntimeService's current
 * `activeTurnId` is supported. `steer`/`reviseGoal` go through the runtime's
 * own steering path; `stop` aborts that exact turn and reports `interrupted`
 * only after the turn is no longer active. Append and delegation targets are
 * refused before a receipt is recorded, so nothing is marked consumed or
 * accepted without a real dispatch.
 */
export function createPiHostRuntimeHandoff(runtime: PiHostCommandCenterRuntime): CommandCenterRuntimeHandoff {
  const exactTurn = (target: CommandCenterExecutionTarget): target is Extract<CommandCenterExecutionTarget, { kind: "session" }> =>
    target.kind === "session" && typeof target.turnId === "string" && target.turnId.length > 0;

  return {
    canRecord(_binding: CommandCenterBinding, target, operation) {
      return exactTurn(target) && SUPPORTED_INTENTS.includes(operation) &&
        runtime.activeTurnId(target.sessionId) === target.turnId;
    },
    async dispatch(
      _binding: CommandCenterBinding,
      request: CommandCenterInterventionRequest,
    ): Promise<CommandCenterRuntimeAcknowledgement> {
      const target = request.target;
      if (!exactTurn(target) || !SUPPORTED_INTENTS.includes(request.intent.kind) ||
          (request.intent.kind === "stop" && request.intent.scope !== "target")) {
        return { status: "rejected", error: { code: "CAPABILITY_UNAVAILABLE", message: "this command-center target or stop scope has no qualified runtime consumer" } };
      }
      const active = runtime.activeTurnId(target.sessionId);
      if (active !== target.turnId) {
        return { status: "conflicted", error: { code: "TURN_NOT_ACTIVE", message: "the target turn is no longer active" } };
      }
      if (request.intent.kind === "stop") {
        await runtime.abort(target.sessionId, target.turnId);
        if (runtime.activeTurnId(target.sessionId) === target.turnId) {
          return { status: "outcome_unknown", error: { code: "TURN_STOP_UNCONFIRMED", message: "the runtime still reports the turn as active" } };
        }
        return { status: "interrupted" };
      }
      const content = request.intent.kind === "reviseGoal"
        ? [`Objective: ${request.intent.objective}`,
           ...(request.intent.constraints.length > 0 ? ["Constraints:", ...request.intent.constraints.map((item) => `- ${item}`)] : [])].join("\n")
        : request.intent.text;
      const result = await runtime.steer({
        sessionId: target.sessionId,
        turnId: target.turnId,
        content,
        sessionMessageId: request.requestId,
        principal: { subject: "command-center", roles: ["controller"] },
      });
      if (!result.accepted) {
        return { status: "conflicted", error: { code: "TURN_NOT_ACTIVE", message: "the runtime did not accept steering for this turn" } };
      }
      return { status: "accepted" };
    },
  };
}

/**
 * Bind the real command-center composition to the running pi-host.
 *
 * Off by default: no operation key, capability or monitor port is added unless
 * `--command-center` enabled it. When enabled, both the control service and the
 * monitor page port are bound to the same single host-core instance; a restart
 * replaces the handshake epoch and any stale binding/page token fails.
 */
export function attachPiHostCommandCenter(deps: PiHostCommandCenterDeps): PiHostCommandCenter | undefined {
  if (!deps.config.commandCenter) return undefined;
  if (!deps.hostId) throw new RacpError("HOST_BOOTSTRAP_FAILED", "command-center requires the installation host id", { retriable: false });

  const transport: HostRpcPort = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      const host = deps.getHost();
      if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
      return host.call<T>(method, params);
    },
  };
  const hostIdentity = (): CommandCenterBinding => {
    const epoch = deps.getHostEpoch();
    if (!deps.getHost() || !epoch) {
      throw new RacpError("AGENT_UNAVAILABLE", "command-center host is not connected", { retriable: true });
    }
    return { hostId: deps.hostId, hostEpoch: epoch };
  };

  const host = createCommandCenterHost({
    transport,
    hostIdentity,
    authorizer: authorize,
    mutationsClosed: deps.maintenanceClosed,
    clock: { now: () => Date.now() },
    createDispatch: (control, options) => createCommandCenterDispatch(control, options),
    runtime: createPiHostRuntimeHandoff(deps.runtime),
    runtimeMode: "required",
  });
  const monitorPage = createCommandCenterMonitorRpcPort({
    transport,
    hostIdentity,
    authorize,
    clock: { now: () => Date.now() },
  });

  deps.operations.commandCenter = host.control;
  deps.operations.commandCenterMonitorPage = monitorPage;
  return {
    control: host.control,
    monitorPage,
    async dispose() {
      monitorPage.dispose();
      await host.dispose();
    },
  };
}
