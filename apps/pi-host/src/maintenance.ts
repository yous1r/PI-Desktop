import {
  MaintenanceFailure,
  type MaintenanceBusyState,
  type MaintenanceLease,
} from "@pi-desktop/agent-host";

export const MAINTENANCE_PROTOCOL = 1;
export const MAINTENANCE_MAX_BYTES = 1024;
export const MAINTENANCE_REQUEST_OPS = ["status", "acquire", "release"] as const;
export type MaintenanceOp = (typeof MAINTENANCE_REQUEST_OPS)[number];
export type MaintenanceRequest = { op: MaintenanceOp; expectedHostId: string; leaseId?: string };

export type MaintenanceStatus = {
  ok: true;
  hostId: string;
  version: string;
  protocol: typeof MAINTENANCE_PROTOCOL;
  busy: boolean;
};
export type MaintenanceFailureResponse = { ok: false; code: MaintenanceFailure["code"] };
export type MaintenanceResponse = MaintenanceStatus | (MaintenanceStatus & MaintenanceLease) | MaintenanceFailureResponse;

const LEASE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Strict parse of the bounded JSON the installer writes on stdin. */
export function parseMaintenanceRequest(raw: string): MaintenanceRequest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new MaintenanceFailure("INVALID_REQUEST"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceFailure("INVALID_REQUEST");
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.some((key) => !["op", "leaseId", "expectedHostId"].includes(key))) throw new MaintenanceFailure("INVALID_REQUEST");
  const op = request.op;
  if (typeof op !== "string" || !(MAINTENANCE_REQUEST_OPS as readonly string[]).includes(op)) throw new MaintenanceFailure("INVALID_REQUEST");
  if (typeof request.expectedHostId !== "string" || !HOST_ID.test(request.expectedHostId)) throw new MaintenanceFailure("INVALID_REQUEST");
  if (request.leaseId !== undefined && (typeof request.leaseId !== "string" || !LEASE_ID.test(request.leaseId))) throw new MaintenanceFailure("INVALID_REQUEST");
  if (op === "acquire" && typeof request.leaseId !== "string") throw new MaintenanceFailure("INVALID_REQUEST");
  if (op === "release" && typeof request.leaseId !== "string") throw new MaintenanceFailure("INVALID_REQUEST");
  return {
    op: op as MaintenanceOp,
    expectedHostId: request.expectedHostId,
    ...(typeof request.leaseId === "string" ? { leaseId: request.leaseId } : {}),
  };
}

export type MaintenanceCoordinator = {
  hostId: string;
  version: string;
  gate: { isClosed(): boolean; acquire(leaseId: string, inspect: () => Promise<MaintenanceBusyState>): Promise<MaintenanceLease>; release(leaseId: string): void };
  /** Independent owners report their own live resource counts; nothing is copied. */
  inspect(): Promise<MaintenanceBusyState>;
};

/** One admission surface for status, lease acquisition and release. */
export async function handleMaintenanceRequest(
  coordinator: MaintenanceCoordinator,
  request: MaintenanceRequest,
): Promise<MaintenanceResponse> {
  if (request.expectedHostId !== coordinator.hostId) return { ok: false, code: "HOST_AUTH_FAILED" };
  const status = (busy: boolean): MaintenanceStatus => ({
    ok: true,
    hostId: coordinator.hostId,
    version: coordinator.version,
    protocol: MAINTENANCE_PROTOCOL,
    busy,
  });
  try {
    // `busy` answers "would acquire succeed now": a held lease or any live work.
    const busyNow = async () => coordinator.gate.isClosed() || !isIdle(await coordinator.inspect());
    if (request.op === "status") return status(await busyNow());
    if (request.op === "acquire") {
      const lease = await coordinator.gate.acquire(request.leaseId!, () => coordinator.inspect());
      return { ...status(true), ...lease };
    }
    coordinator.gate.release(request.leaseId!);
    return status(!isIdle(await coordinator.inspect()));
  } catch (error) {
    if (error instanceof MaintenanceFailure) return { ok: false, code: error.code };
    return { ok: false, code: "HOST_MAINTENANCE_UNAVAILABLE" };
  }
}

/** Always one stdout line: success or a classified refusal, never a raw exception. */
export function maintenanceLine(response: MaintenanceResponse): string {
  return `PI_HOST_MAINTENANCE ${JSON.stringify(response)}`;
}

function isIdle(state: MaintenanceBusyState): boolean {
  return state.clients === 0 && state.turns === 0 && state.queuedTurns === 0 && state.plans === 0 &&
    state.tools === 0 && state.processes === 0 && state.terminals === 0 && state.plugins === 0;
}
