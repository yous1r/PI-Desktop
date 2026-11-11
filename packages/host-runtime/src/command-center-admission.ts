import {
  RacpError,
  type CommandCenterAdmissionHoldPortRequest,
  type CommandCenterAdmissionPort,
  type CommandCenterAdmissionReleasePortRequest,
  type CommandCenterAdmissionReservation,
  type CommandCenterAdmissionReservePortRequest,
  type CommandCenterAdmissionStatePortRequest,
  type CommandCenterBinding,
  type HostRpcPort,
} from "@pi-desktop/agent-host";
import {
  COMMAND_CENTER_ADMISSION_LIMITS, COMMAND_CENTER_ADMISSION_STATES,
  commandCenterAdmissionHoldsCapacity, commandCenterExecutionKey,
  parseCommandCenterAdmissionSnapshot,
  type CommandCenterAdmissionSnapshot,
  type CommandCenterAdmissionState,
  type CommandCenterExecutionTarget,
} from "@pi-desktop/shared";

/** Private C2 reservation transport methods (same `{binding, auth, input}`
 * envelope as the receipt repository). */
export const COMMAND_CENTER_RESERVATION_METHODS = {
  reserve: "commandCenter.reservation.reserve",
  hold: "commandCenter.reservation.hold",
  release: "commandCenter.reservation.release",
  state: "commandCenter.reservation.state",
} as const;

function invalid(): never {
  throw new RacpError("INTERNAL", "command-center admission returned an invalid response", { retriable: false });
}

function mapHostFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  const code = /\bCC_([A-Z_]+):/.exec(message)?.[1];
  if (!code) throw error;
  const family = code.startsWith("INVALID") ? "INVALID_ARGUMENT"
    : code === "FORBIDDEN" ? "FORBIDDEN"
    : code === "CAPABILITY_UNAVAILABLE" ? "CAPABILITY_UNAVAILABLE"
    : code === "HOST_BUSY" ? "HOST_BUSY"
    : code.includes("QUOTA") || code.includes("LIMIT") ? "RESOURCE_EXHAUSTED"
    : code.includes("NOT_FOUND") ? "NOT_FOUND"
    : code.includes("CONFLICT") || code.includes("STALE") || code.includes("LIVE") || code.includes("DISABLED") || code.includes("EXISTS") ? "CONFLICT"
    : code === "EPOCH_UNAVAILABLE" ? "AGENT_UNAVAILABLE"
    : "INTERNAL";
  throw new RacpError(family, "command-center admission refused the operation", { retriable: false });
}

function state(value: unknown): CommandCenterAdmissionState {
  if (typeof value !== "string" || !(COMMAND_CENTER_ADMISSION_STATES as readonly string[]).includes(value)) invalid();
  return value as CommandCenterAdmissionState;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}

function reservation(
  value: unknown,
  execution: CommandCenterExecutionTarget,
  workspaceId: string,
  membershipRevision: number | null,
): CommandCenterAdmissionReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = ["executionKey", "workspaceId", "membershipRevision", "state", "hostLive", "workspaceLive"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) invalid();
  if (record.executionKey !== commandCenterExecutionKey(execution) || record.workspaceId !== workspaceId) invalid();
  const revision = integer(record.membershipRevision, Number.MAX_SAFE_INTEGER);
  if (revision < 1 || (membershipRevision !== null && revision !== membershipRevision)) invalid();
  const resultState = state(record.state);
  if (!commandCenterAdmissionHoldsCapacity(resultState)) invalid();
  return {
    executionKey: record.executionKey as string,
    workspaceId: record.workspaceId as string,
    membershipRevision: revision,
    state: resultState,
    hostLive: integer(record.hostLive, COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerHost),
    workspaceLive: integer(record.workspaceLive, COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerWorkspace),
  };
}

/**
 * Real `HostRpcPort` -> Rust C2 reservation adapter.
 *
 * Every mutation is one private stdio call: no retry, no local counter, and no
 * synthesized counts. The returned reservation and capacity snapshot are
 * validated against the strict shared contract before they reach the control
 * service.
 */
export function createRustCommandCenterAdmissionPort(
  transport: HostRpcPort,
  hostIdentity: () => CommandCenterBinding,
): CommandCenterAdmissionPort {
  if (!transport || typeof transport.call !== "function") {
    throw new Error("command-center admission requires a HostRpcPort transport");
  }
  if (typeof hostIdentity !== "function") {
    throw new Error("command-center admission requires a hostIdentity port");
  }

  const bind = (expected: CommandCenterBinding): CommandCenterBinding => {
    const current = { ...hostIdentity() };
    if (current.hostId !== expected.hostId || current.hostEpoch !== expected.hostEpoch) {
      throw new RacpError("CONFLICT", "command-center owner changed; reconcile before retrying", { retriable: false });
    }
    return current;
  };

  const call = async (method: string, request: { binding: CommandCenterBinding; auth: unknown; input: unknown }) => {
    const binding = bind(request.binding);
    let value: unknown;
    let failure: unknown;
    try {
      // One attempt only: a lost response may follow a durable mutation and is
      // reconciled by the caller, never resent blindly.
      value = await transport.call(method, {
        binding: { hostId: binding.hostId, hostEpoch: binding.hostEpoch },
        auth: JSON.parse(JSON.stringify(request.auth)),
        input: request.input,
      });
    } catch (error) {
      failure = error;
    }
    // Re-check after the await and before publishing either a value or a
    // failure: a stale result must never be attributed to a replaced owner.
    bind(request.binding);
    if (failure !== undefined) mapHostFailure(failure);
    return value;
  };

  return {
    async reserve(request: CommandCenterAdmissionReservePortRequest): Promise<CommandCenterAdmissionReservation> {
      const binding = bind(request.binding);
      const value = await call(COMMAND_CENTER_RESERVATION_METHODS.reserve, {
        binding,
        auth: request.auth,
        input: {
          version: 1,
          hostId: binding.hostId,
          expectedHostEpoch: binding.hostEpoch,
          commandWorkspaceId: request.workspaceId,
          expectedMembershipRevision: request.membershipRevision,
          target: request.execution,
        },
      });
      return reservation(value, request.execution, request.workspaceId, request.membershipRevision);
    },

    async hold(request: CommandCenterAdmissionHoldPortRequest): Promise<CommandCenterAdmissionReservation> {
      const binding = bind(request.binding);
      const value = await call(COMMAND_CENTER_RESERVATION_METHODS.hold, {
        binding,
        auth: request.auth,
        input: {
          version: 1,
          hostId: binding.hostId,
          expectedHostEpoch: binding.hostEpoch,
          commandWorkspaceId: request.workspaceId,
          target: request.execution,
          from: request.from,
          to: request.to,
          evidence: request.evidence,
        },
      });
      return reservation(value, request.execution, request.workspaceId, null);
    },

    async release(request: CommandCenterAdmissionReleasePortRequest): Promise<{ released: boolean }> {
      const binding = bind(request.binding);
      const value = await call(COMMAND_CENTER_RESERVATION_METHODS.release, {
        binding,
        auth: request.auth,
        input: {
          version: 1,
          hostId: binding.hostId,
          expectedHostEpoch: binding.hostEpoch,
          commandWorkspaceId: request.workspaceId,
          target: request.execution,
          to: request.to,
          evidence: request.evidence,
        },
      });
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || typeof record.released !== "boolean") invalid();
      return { released: record.released };
    },

    async snapshot(request: CommandCenterAdmissionStatePortRequest): Promise<CommandCenterAdmissionSnapshot> {
      const binding = bind(request.binding);
      const value = await call(COMMAND_CENTER_RESERVATION_METHODS.state, {
        binding,
        auth: request.auth,
        input: { version: 1, hostId: binding.hostId },
      });
      try {
        return parseCommandCenterAdmissionSnapshot(value);
      } catch {
        return invalid();
      }
    },
  };
}
