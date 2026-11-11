import {
  commandCenterWithinBytes, parseCommandCenterInterventionRequest,
  type CommandCenterInterventionRequest, type CommandCenterReceipt, type CommandCenterWorkspace,
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
export interface CommandCenterRepository {
  call<M extends CommandCenterMethod>(
    method: M, input: CommandCenterRequests[M], context: CommandCenterRepositoryContext,
  ): Promise<CommandCenterResults[M]>;
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
