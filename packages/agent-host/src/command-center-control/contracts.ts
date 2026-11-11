import {
  COMMAND_CENTER_MAX_RECEIPT_BYTES, commandCenterWithinBytes, parseCommandCenterInterventionRequest,
  type CommandCenterInterventionRequest, type CommandCenterReceipt, type CommandCenterReceiptStatus,
  type CommandCenterWorkspace,
} from "@pi-desktop/shared";
import { RacpError } from "../errors.js";
import type { Principal } from "../ports.js";

export type CommandCenterBinding = Readonly<{ hostId: string; hostEpoch: string }>;
type ReadRequest = { version: 1; hostId: string };
type Mutation = ReadRequest & { expectedHostEpoch: string };
type WorkspaceCas = Mutation & { commandWorkspaceId: string; expectedRevision: number };
export type CommandCenterRequests = {
  "workspace/list": ReadRequest;
  "workspace/get": ReadRequest & { commandWorkspaceId: string };
  "workspace/create": Mutation & { commandWorkspaceId: string; name: string; enabled: boolean };
  "workspace/rename": WorkspaceCas & { name: string };
  "workspace/setEnabled": WorkspaceCas & { enabled: boolean };
  "workspace/delete": WorkspaceCas;
  "membership/get": ReadRequest & { sessionId: string };
  "membership/list": ReadRequest & { commandWorkspaceId: string; afterSessionId?: string; limit: number };
  "membership/bind": Mutation & { sessionId: string; commandWorkspaceId: string; expectedRevision: number | null };
  /** Removal remains unavailable until C2 can preserve revision tombstones. */
  "membership/remove": Mutation & { sessionId: string; commandWorkspaceId: string; expectedRevision: number };
  "intervention/record": CommandCenterInterventionRequest;
  "receipt/get": ReadRequest & { requestId: string };
  "receipt/list": ReadRequest & { afterSequence: number; limit: number };
};
export type CommandCenterMethod = keyof CommandCenterRequests;
export const COMMAND_CENTER_METHODS: readonly CommandCenterMethod[] = [
  "workspace/list", "workspace/get", "workspace/create", "workspace/rename", "workspace/setEnabled", "workspace/delete",
  "membership/get", "membership/list", "membership/bind", "membership/remove",
  "intervention/record", "receipt/get", "receipt/list",
];
export type CommandCenterMembership = { sessionId: string; commandWorkspaceId: string; revision: number };
/** Private stdio response metadata: principal is deliberately never returned. */
export type CommandCenterReceiptEntry = {
  receipt: CommandCenterReceipt;
  hostId: string;
  hostEpoch: string;
  commandWorkspaceId: string;
  membershipRevision: number;
  sequence: number;
};
export type CommandCenterResults = {
  "workspace/list": { workspaces: CommandCenterWorkspace[] };
  "workspace/get": CommandCenterWorkspace | null;
  "workspace/create": CommandCenterWorkspace;
  "workspace/rename": CommandCenterWorkspace;
  "workspace/setEnabled": CommandCenterWorkspace;
  "workspace/delete": { deleted: true };
  "membership/get": CommandCenterMembership | null;
  "membership/list": { memberships: CommandCenterMembership[]; nextAfterSessionId: string | null };
  "membership/bind": CommandCenterMembership;
  "membership/remove": never;
  "intervention/record": { entry: CommandCenterReceiptEntry; replayed: boolean };
  "receipt/get": CommandCenterReceiptEntry | null;
  "receipt/list": { entries: CommandCenterReceiptEntry[]; nextAfterSequence: number | null };
};
/** Created by the service, never decoded from external JSON. Private Rust stdio only. */
export type CommandCenterRepositoryContext = {
  binding: CommandCenterBinding;
  auth: { subject: string; roles: Principal["roles"]; sessionIds: string[]; workspaceIds: string[] };
};

/**
 * Receipt states the C4 dispatch path may acknowledge. `recorded` is the durable
 * dispatch claim itself, so it is never an acknowledgement target.
 */
export const COMMAND_CENTER_ACK_STATUSES = [
  "accepted", "consumed", "completed", "rejected", "conflicted", "interrupted", "outcome_unknown",
] as const;
export type CommandCenterAckStatus = (typeof COMMAND_CENTER_ACK_STATUSES)[number];
export type CommandCenterReceiptError = { code: string; message: string };

/**
 * Private receipt transition request. It is the only dispatch/ACK persistence
 * path: the C2 receipt journal stays the single store, and the expected revision
 * makes a repeated or racing acknowledgement a no-op instead of a second effect.
 */
export type CommandCenterAckRequest = Mutation & {
  requestId: string;
  expectedRevision: number;
  status: CommandCenterAckStatus;
  effectiveGoalRevision?: number;
  error?: CommandCenterReceiptError;
};

/** Public control operations plus the private C2 receipt transition. */
export type CommandCenterRepositoryRequests = CommandCenterRequests & {
  "intervention/ack": CommandCenterAckRequest;
};
export type CommandCenterRepositoryMethod = keyof CommandCenterRepositoryRequests;
export type CommandCenterRepositoryResults = CommandCenterResults & {
  "intervention/ack": { entry: CommandCenterReceiptEntry; replayed: boolean };
};

export interface CommandCenterRepository {
  call<M extends CommandCenterRepositoryMethod>(
    method: M, input: CommandCenterRepositoryRequests[M], context: CommandCenterRepositoryContext,
  ): Promise<CommandCenterRepositoryResults[M]>;
}
export type CommandCenterAccess = { kind: "session" | "workspace"; id: string; permission: "read" | "control" };

export function commandCenterMutation(method: CommandCenterMethod): boolean {
  return !["workspace/list", "workspace/get", "membership/get", "membership/list", "receipt/get", "receipt/list"].includes(method);
}
export function invalid(): never { throw new RacpError("INVALID_ARGUMENT", "invalid command-center request"); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function strictKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || [...value].length > max || value.includes("\0")) return invalid();
  return value;
}
export function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result)) invalid();
  return result;
}
export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
export function hostId(value: unknown): string {
  const result = text(value, 128);
  if (/[\s/\\]/u.test(result)) invalid();
  return result;
}
export function parseCommandCenterRequest<M extends CommandCenterMethod>(method: M, value: unknown): CommandCenterRequests[M] {
  if (!commandCenterWithinBytes(value, 256 * 1024)) invalid();
  // Own the request across awaits: caller mutation cannot replace a validated target.
  const input = record(JSON.parse(JSON.stringify(value)));
  if (method === "intervention/record") {
    try { return parseCommandCenterInterventionRequest(input) as CommandCenterRequests[M]; }
    catch { return invalid(); }
  }
  const keys = ["version", "hostId"];
  const optional: string[] = [];
  if (input.version !== 1) invalid();
  hostId(input.hostId);
  if (commandCenterMutation(method)) { keys.push("expectedHostEpoch"); uuid(input.expectedHostEpoch); }
  if (method.startsWith("workspace/") && method !== "workspace/list" || method === "membership/list" || method === "membership/bind" || method === "membership/remove") {
    keys.push("commandWorkspaceId"); uuid(input.commandWorkspaceId);
  }
  if (["workspace/rename", "workspace/setEnabled", "workspace/delete", "membership/remove"].includes(method)) {
    keys.push("expectedRevision"); integer(input.expectedRevision, 1);
  }
  if (method === "workspace/create" || method === "workspace/rename") { keys.push("name"); text(input.name, 256); }
  if (method === "workspace/create" || method === "workspace/setEnabled") {
    keys.push("enabled"); if (typeof input.enabled !== "boolean") invalid();
  }
  if (method === "membership/get" || method === "membership/bind" || method === "membership/remove") {
    keys.push("sessionId"); text(input.sessionId, 128);
  }
  if (method === "membership/bind") {
    keys.push("expectedRevision"); if (input.expectedRevision !== null) integer(input.expectedRevision, 1);
  }
  if (method === "membership/list") {
    keys.push("limit"); integer(input.limit, 1, 100); optional.push("afterSessionId");
    if (input.afterSessionId !== undefined) text(input.afterSessionId, 128);
  }
  if (method === "receipt/get") { keys.push("requestId"); uuid(input.requestId); }
  if (method === "receipt/list") { keys.push("afterSequence", "limit"); integer(input.afterSequence, 0); integer(input.limit, 1, 100); }
  strictKeys(input, keys, optional);
  return input as CommandCenterRequests[M];
}

const RECEIPT_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function receiptError(value: unknown): CommandCenterReceiptError {
  const error = record(value);
  strictKeys(error, ["code", "message"]);
  if (typeof error.code !== "string" || !RECEIPT_ERROR_CODE.test(error.code)) invalid();
  if (typeof error.message !== "string" || !error.message.length || [...error.message].length > 512 || error.message.includes("\0")) invalid();
  return { code: error.code, message: error.message };
}

/**
 * Validate the private ACK request built by `CommandCenterControl`. It mirrors
 * the shared receipt rules the contract can enforce without a previous entry:
 * `recorded` is not acknowledgeable, rejected/conflicted require an error, and
 * accepted/consumed/completed must not carry one.
 */
export function parseCommandCenterAckRequest(value: unknown): CommandCenterAckRequest {
  if (!commandCenterWithinBytes(value, COMMAND_CENTER_MAX_RECEIPT_BYTES)) invalid();
  const input = record(JSON.parse(JSON.stringify(value)));
  if (input.version !== 1) invalid();
  hostId(input.hostId); uuid(input.expectedHostEpoch); uuid(input.requestId); integer(input.expectedRevision, 1);
  if (typeof input.status !== "string" || !(COMMAND_CENTER_ACK_STATUSES as readonly string[]).includes(input.status)) invalid();
  strictKeys(
    input,
    ["version", "hostId", "expectedHostEpoch", "requestId", "expectedRevision", "status"],
    ["effectiveGoalRevision", "error"],
  );
  if (input.effectiveGoalRevision !== undefined) integer(input.effectiveGoalRevision, 0);
  const status = input.status as CommandCenterReceiptStatus;
  const error = input.error === undefined ? undefined : receiptError(input.error);
  if ((status === "rejected" || status === "conflicted") && error === undefined) invalid();
  if ((status === "accepted" || status === "consumed" || status === "completed") && error !== undefined) invalid();
  return { ...(input as CommandCenterAckRequest), ...(error ? { error } : {}) };
}

/** Repository-side request parsing: public control requests plus the private ACK. */
export function parseCommandCenterRepositoryRequest<M extends CommandCenterRepositoryMethod>(
  method: M, value: unknown,
): CommandCenterRepositoryRequests[M] {
  if (method === "intervention/ack") return parseCommandCenterAckRequest(value) as CommandCenterRepositoryRequests[M];
  return parseCommandCenterRequest(method, value) as CommandCenterRepositoryRequests[M];
}
