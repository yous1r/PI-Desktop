import { createHash } from "node:crypto";
import {
  commandCenterCanonicalPayload, commandCenterReceiptBindsRequest, commandCenterWithinBytes,
  rolesAllowOperation, type CommandCenterExecutionTarget, type CommandCenterInterventionRequest,
  type CommandCenterOperation, type CommandCenterReceipt,
} from "@pi-desktop/shared";
import { RacpError } from "./errors.js";
import type { Principal } from "./ports.js";
import {
  COMMAND_CENTER_METHODS, commandCenterMutation, hostId, parseCommandCenterRequest, text, uuid,
  type CommandCenterAccess, type CommandCenterBinding, type CommandCenterMethod, type CommandCenterReceiptEntry,
  type CommandCenterRepository, type CommandCenterRepositoryContext, type CommandCenterRequests, type CommandCenterResults,
} from "./command-center-control/contracts.js";
export * from "./command-center-control/contracts.js";
export { parseCommandCenterRepositoryResult } from "./command-center-control/results.js";

/** C4 supplies availability only after its exact-target consumer is integrated.
 * No dispatch/ACK is inferred here. C4 must persist a dispatch claim before I/O,
 * reconcile uncertainty and persist actual ACKs through the C2 repository. */
export interface CommandCenterRuntimeHandoff {
  canRecord(binding: CommandCenterBinding, target: CommandCenterExecutionTarget, operation: CommandCenterOperation): boolean;
}
export type CommandCenterControlOptions = {
  repository: CommandCenterRepository;
  /** Read current installation/owner identity; never derive it from a request. */
  hostIdentity(): CommandCenterBinding;
  /** Use the same MaintenanceAdmission instance as all execution entry points. */
  mutationsClosed(): boolean;
  /** Current session/workspace ACL policy, independent of membership and readiness. */
  authorize(principal: Principal, access: CommandCenterAccess): Promise<boolean>;
  runtime?: CommandCenterRuntimeHandoff;
};
type PublicResults = Omit<CommandCenterResults, "intervention/record" | "receipt/get" | "receipt/list"> & {
  "intervention/record": { receipt: CommandCenterReceipt; replayed: boolean };
  "receipt/get": CommandCenterReceipt | null;
  "receipt/list": { receipts: CommandCenterReceipt[]; nextAfterSequence: number | null };
};
function forbidden(): never { throw new RacpError("FORBIDDEN", "command-center access denied"); }
function conflict(): never { throw new RacpError("CONFLICT", "command-center owner changed; reconcile before retrying", { retriable: false }); }
function sessionId(target: CommandCenterExecutionTarget): string {
  return target.kind === "session" ? target.sessionId : target.parentSessionId;
}

/** Shared application service for authenticated IPC and RACP. Never construct a
 * principal from params. Only the private repository adapter serializes auth. */
export class CommandCenterControl {
  constructor(private readonly options: CommandCenterControlOptions) {}

  async call<M extends CommandCenterMethod>(method: M, value: unknown, authenticatedPrincipal: Principal): Promise<PublicResults[M]> {
    if (!COMMAND_CENTER_METHODS.includes(method)) throw new RacpError("METHOD_NOT_FOUND", "unknown command-center operation");
    const principal = { ...authenticatedPrincipal, roles: [...authenticatedPrincipal.roles] };
    text(principal.subject, 256);
    if (principal.roles.some((role) => !["viewer", "controller", "approver", "owner"].includes(role))) forbidden();
    const mutation = commandCenterMutation(method);
    const roleOperation = method.startsWith("workspace/") && mutation ? "project/register" : mutation ? "turn/start" : "session/get";
    if (!rolesAllowOperation(principal.roles, roleOperation)) forbidden();
    const input = parseCommandCenterRequest(method, value);
    const binding = { ...this.options.hostIdentity() };
    hostId(binding.hostId); uuid(binding.hostEpoch);
    if (input.hostId !== binding.hostId || ("expectedHostEpoch" in input && input.expectedHostEpoch !== binding.hostEpoch)) conflict();
    const context: CommandCenterRepositoryContext = {
      binding, auth: { subject: principal.subject, roles: principal.roles, sessionIds: [], workspaceIds: [] },
    };
    const assertCurrent = () => {
      const current = this.options.hostIdentity();
      if (current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) conflict();
    };
    const allowed = async (kind: "session" | "workspace", id: string, permission: "read" | "control") => {
      const result = await this.options.authorize(principal, { kind, id, permission });
      assertCurrent();
      return result;
    };
    const requireAccess = async (kind: "session" | "workspace", id: string, permission: "read" | "control") => {
      if (!await allowed(kind, id, permission)) forbidden();
      const grants = kind === "session" ? context.auth.sessionIds : context.auth.workspaceIds;
      if (!grants.includes(id)) grants.push(id);
    };
    const canReadReceipt = async (entry: CommandCenterReceiptEntry) => {
      if (entry.hostId !== binding.hostId) conflict();
      return await allowed("session", sessionId(entry.receipt.target), "read") &&
        await allowed("workspace", entry.commandWorkspaceId, "read");
    };
    const repository = async <K extends CommandCenterMethod>(operation: K, request: CommandCenterRequests[K]) => {
      assertCurrent();
      const result = await this.options.repository.call(operation, request, context);
      assertCurrent();
      return result;
    };
    const assertOpen = () => {
      assertCurrent();
      if (this.options.mutationsClosed()) throw new RacpError("HOST_BUSY", "command-center mutations are closed for owner handoff", { retriable: false });
    };
    if ("commandWorkspaceId" in input && method !== "workspace/create") {
      await requireAccess("workspace", input.commandWorkspaceId, mutation ? "control" : "read");
    }
    if ("sessionId" in input) await requireAccess("session", input.sessionId, mutation ? "control" : "read");
    let result: PublicResults[CommandCenterMethod];
    if (method === "intervention/record") {
      const request = input as CommandCenterInterventionRequest;
      await requireAccess("session", sessionId(request.target), "control");
      const previous = await repository("receipt/get", { version: 1, hostId: binding.hostId, requestId: request.requestId });
      if (previous) {
        if (!await canReadReceipt(previous)) forbidden();
        const fingerprint = createHash("sha256").update(commandCenterCanonicalPayload(request)).digest("hex");
        if (previous.receipt.fingerprint !== fingerprint || !commandCenterReceiptBindsRequest(previous.receipt, request)) {
          throw new RacpError("CONFLICT", "request ID already names a different intervention", { retriable: false });
        }
        result = { receipt: previous.receipt, replayed: true };
      } else {
        assertOpen();
        if (!this.options.runtime?.canRecord(binding, request.target, request.intent.kind)) {
          throw new RacpError("CAPABILITY_UNAVAILABLE", "this execution has no qualified command-center consumer");
        }
        assertOpen();
        const outcome = await repository("intervention/record", request);
        // The repository committed before responding. There is intentionally no
        // runtime call or local receipt cache, including on transport failure.
        result = { receipt: outcome.entry.receipt, replayed: outcome.replayed };
      }
    } else if (method === "receipt/get") {
      const entry = await repository("receipt/get", input as CommandCenterRequests["receipt/get"]);
      if (entry && !await canReadReceipt(entry)) forbidden();
      result = entry?.receipt ?? null;
    } else if (method === "receipt/list") {
      const page = await repository("receipt/list", input as CommandCenterRequests["receipt/list"]);
      const receipts: CommandCenterReceipt[] = [];
      for (const entry of page.entries) if (await canReadReceipt(entry)) receipts.push(entry.receipt);
      result = { receipts, nextAfterSequence: page.nextAfterSequence };
    } else if (method === "workspace/list") {
      const page = await repository("workspace/list", input as CommandCenterRequests["workspace/list"]);
      const workspaces = [];
      for (const workspace of page.workspaces) if (await allowed("workspace", workspace.id, "read")) workspaces.push(workspace);
      result = { workspaces };
    } else if (method === "membership/list") {
      const page = await repository("membership/list", input as CommandCenterRequests["membership/list"]);
      const memberships = [];
      for (const member of page.memberships) if (await allowed("session", member.sessionId, "read")) memberships.push(member);
      result = { memberships, nextAfterSessionId: page.nextAfterSessionId };
    } else {
      if (method === "membership/bind" || method === "membership/remove") {
        const request = input as CommandCenterRequests["membership/bind"];
        const current = await repository("membership/get", { version: 1, hostId: binding.hostId, sessionId: request.sessionId });
        if (current) await requireAccess("workspace", current.commandWorkspaceId, "control");
      }
      if (method === "membership/remove") throw new RacpError("CAPABILITY_UNAVAILABLE", "membership removal requires retained revision tombstones");
      if (mutation) assertOpen();
      result = await repository(method, input) as PublicResults[CommandCenterMethod];
      if (method === "membership/get" && result) {
        const member = result as CommandCenterResults["membership/bind"];
        await requireAccess("workspace", member.commandWorkspaceId, "read");
      }
    }
    assertCurrent();
    if (!commandCenterWithinBytes(result, 256 * 1024)) throw new RacpError("RESOURCE_EXHAUSTED", "command-center response exceeds page budget");
    return result as PublicResults[M];
  }
}
