import { createHash } from "node:crypto";
import {
  COMMAND_CENTER_ADMISSION_LIMITS, commandCenterAdmissionHoldsCapacity,
  commandCenterCanonicalPayload, commandCenterConsumptionBindsReceipt, commandCenterExecutionKey,
  commandCenterReceiptBindsRequest, commandCenterReceiptCanTransition, commandCenterWithinBytes,
  parseCommandCenterAdmissionSnapshot, rolesAllowOperation,
  type CommandCenterAdmissionSnapshot, type CommandCenterAdmissionState,
  type CommandCenterExecutionTarget,
  type CommandCenterInterventionRequest, type CommandCenterOperation, type CommandCenterReceipt,
} from "@pi-desktop/shared";
import { RacpError } from "./errors.js";
import type { Principal } from "./ports.js";
import type {
  CommandCenterAdmissionAuth,
  CommandCenterAdmissionPort,
  CommandCenterAdmissionReservation,
} from "./command-center-control/admission.js";
import {
  COMMAND_CENTER_METHODS, commandCenterMutation, hostId,
  parseCommandCenterAdmissionHoldRequest, parseCommandCenterAdmissionReleaseRequest,
  parseCommandCenterAdmissionRequest, parseCommandCenterConsumptionRequest,
  parseCommandCenterRequest, invalid, record, strictKeys, text, uuid,
  type CommandCenterAccess, type CommandCenterBinding,
  type CommandCenterMethod, type CommandCenterReceiptEntry,
  type CommandCenterRepository, type CommandCenterRepositoryContext, type CommandCenterRepositoryMethod,
  type CommandCenterRepositoryRequests, type CommandCenterRepositoryResults, type CommandCenterRequests,
  type CommandCenterResults,
} from "./command-center-control/contracts.js";
export * from "./command-center-control/contracts.js";
export * from "./command-center-control/admission.js";
export { parseCommandCenterRepositoryResult } from "./command-center-control/results.js";

/** Default window the exact-target consumer gets to report an acknowledgement. */
export const COMMAND_CENTER_DISPATCH_TIMEOUT_MS = 30_000;

/** Injected clock reading around one dispatch; the consumer may use it to fence. */
export type CommandCenterRuntimeDispatchMetadata = {
  startedAt: number;
  deadlineAt: number;
};

/**
 * The acknowledgement a qualified runtime consumer returns for one dispatch.
 * `recorded` is not a legal acknowledgement: that state is the durable claim.
 * Consumption is a later, separately evidenced boundary acknowledgement via
 * `CommandCenterControl.acknowledgeConsumption`; a dispatch itself never claims
 * that a revision was consumed.
 */
export type CommandCenterRuntimeAcknowledgement =
  | { status: "accepted" | "completed" | "interrupted"; effectiveGoalRevision?: number }
  | { status: "rejected" | "conflicted"; error: { code: string; message: string } }
  | { status: "outcome_unknown"; error?: { code: string; message: string } };

/** C4 supplies a consumer only after its exact-target integration exists.
 * `dispatch` is optional so a Host that only records receipts keeps the C3
 * behavior; when present, one durable claim drives at most one dispatch and one
 * receipt transition through the C2 repository. `createCommandCenterHost`
 * callers that require dispatch opt in explicitly and fail closed without it. */
export interface CommandCenterRuntimeHandoff {
  canRecord(binding: CommandCenterBinding, target: CommandCenterExecutionTarget, operation: CommandCenterOperation): boolean;
  dispatch?(
    binding: CommandCenterBinding,
    request: CommandCenterInterventionRequest,
    metadata: CommandCenterRuntimeDispatchMetadata,
  ): Promise<CommandCenterRuntimeAcknowledgement>;
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
  /**
   * Shared admission/reservation authority every entry point must consult.
   * Required by `createCommandCenterHost` when `runtimeMode` is `required`;
   * without it the control service fails closed for admission requests.
   */
  admission?: CommandCenterAdmissionPort;
  /** Injected clock for dispatch deadlines; deterministic tests must pass one. */
  now?: () => number;
  dispatchTimeoutMs?: number;
};
type PublicResults = Omit<CommandCenterResults, "intervention/record" | "receipt/get" | "receipt/list"> & {
  "intervention/record": { receipt: CommandCenterReceipt; replayed: boolean };
  "receipt/get": CommandCenterReceipt | null;
  "receipt/list": { receipts: CommandCenterReceipt[]; nextAfterSequence: number | null };
};

/** One RACP turn asking for admission by its durable session/turn identity. */
export type CommandCenterSessionAdmissionRef = {
  version: 1;
  hostId: string;
  expectedHostEpoch: string;
  sessionId: string;
  turnId: string;
};
export type CommandCenterSessionHoldRequest = CommandCenterSessionAdmissionRef & {
  state: "outcome_unknown";
  evidence: string;
};
export type CommandCenterSessionReleaseRequest = CommandCenterSessionAdmissionRef & {
  to: "completed" | "aborted" | "failed" | "launch_failed";
  evidence: string;
};

function sessionRefFields(value: unknown): CommandCenterSessionAdmissionRef {
  if (!commandCenterWithinBytes(value, 16 * 1024)) invalid();
  const input = record(JSON.parse(JSON.stringify(value)));
  if (input.version !== 1) invalid();
  hostId(input.hostId); uuid(input.expectedHostEpoch); text(input.sessionId, 128); text(input.turnId, 256);
  return {
    version: 1,
    hostId: hostId(input.hostId),
    expectedHostEpoch: uuid(input.expectedHostEpoch),
    sessionId: text(input.sessionId, 128),
    turnId: text(input.turnId, 256),
  };
}

function parseSessionAdmissionRef(value: unknown): CommandCenterSessionAdmissionRef {
  const ref = sessionRefFields(value);
  strictKeys(record(JSON.parse(JSON.stringify(value))), ["version", "hostId", "expectedHostEpoch", "sessionId", "turnId"]);
  return ref;
}

function parseSessionHold(value: unknown): CommandCenterSessionHoldRequest {
  const ref = sessionRefFields(value);
  const input = record(JSON.parse(JSON.stringify(value)));
  if (input.state !== "outcome_unknown") invalid();
  strictKeys(input, ["version", "hostId", "expectedHostEpoch", "sessionId", "turnId", "state", "evidence"]);
  return { ...ref, state: "outcome_unknown", evidence: text(input.evidence, 128) };
}

function parseSessionRelease(value: unknown): CommandCenterSessionReleaseRequest {
  const ref = sessionRefFields(value);
  const input = record(JSON.parse(JSON.stringify(value)));
  if (!["completed", "aborted", "failed", "launch_failed"].includes(String(input.to))) invalid();
  strictKeys(input, ["version", "hostId", "expectedHostEpoch", "sessionId", "turnId", "to", "evidence"]);
  return {
    ...ref,
    to: input.to as CommandCenterSessionReleaseRequest["to"],
    evidence: text(input.evidence, 128),
  };
}
/** Repository failures that prove the request was never applied. */
const PROVEN_REPOSITORY_REFUSALS: ReadonlySet<string> = new Set([
  "FORBIDDEN", "INVALID_ARGUMENT", "CAPABILITY_UNAVAILABLE", "HOST_BUSY", "RESOURCE_EXHAUSTED", "NOT_FOUND",
]);
/** Dispatch failures that are an explicit refusal rather than an unknown outcome. */
const PROVEN_DISPATCH_REFUSALS: ReadonlySet<string> = new Set([
  "FORBIDDEN", "INVALID_ARGUMENT", "CAPABILITY_UNAVAILABLE", "CONFLICT", "NOT_FOUND", "HOST_BUSY",
]);
const RECEIPT_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function forbidden(): never { throw new RacpError("FORBIDDEN", "command-center access denied"); }
function conflict(): never { throw new RacpError("CONFLICT", "command-center owner changed; reconcile before retrying", { retriable: false }); }
function sessionId(target: CommandCenterExecutionTarget): string {
  return target.kind === "session" ? target.sessionId : target.parentSessionId;
}
function receiptError(code: string, message: string): { code: string; message: string } {
  const normalizedCode = RECEIPT_ERROR_CODE.test(code) ? code : "INTERNAL";
  const normalizedMessage = (message.trim() || "command-center dispatch failed").slice(0, 512);
  return { code: normalizedCode, message: normalizedMessage };
}
/** A runtime rejection is an explicit outcome; anything else stays unknown. */
function acknowledgementFromDispatchFailure(error: unknown): CommandCenterRuntimeAcknowledgement {
  if (error instanceof RacpError && PROVEN_DISPATCH_REFUSALS.has(error.code)) {
    return {
      status: error.code === "CONFLICT" ? "conflicted" : "rejected",
      error: receiptError(error.code, error.message),
    };
  }
  const code = error instanceof RacpError && RECEIPT_ERROR_CODE.test(error.code) ? error.code : "AGENT_UNAVAILABLE";
  return { status: "outcome_unknown", error: receiptError(code, "dispatch outcome is unknown") };
}
function acknowledgementIsValid(value: unknown): value is CommandCenterRuntimeAcknowledgement {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const status = String(record.status);
  const error = record.error as { code?: unknown; message?: unknown } | undefined;
  if (!["accepted", "completed", "rejected", "conflicted", "interrupted", "outcome_unknown"].includes(status)) return false;
  if (record.effectiveGoalRevision !== undefined &&
      (typeof record.effectiveGoalRevision !== "number" || !Number.isSafeInteger(record.effectiveGoalRevision) || record.effectiveGoalRevision < 0)) {
    return false;
  }
  if (error !== undefined && (typeof error !== "object" || error === null ||
      typeof error.code !== "string" || typeof error.message !== "string" || !error.message.length)) {
    return false;
  }
  if ((status === "rejected" || status === "conflicted") && error === undefined) return false;
  if ((status === "accepted" || status === "completed") && error !== undefined) return false;
  return true;
}

/** Shared application service for authenticated IPC and RACP. Never construct a
 * principal from params. Only the private repository adapter serializes auth. */
export class CommandCenterControl {
  private readonly now: () => number;
  private readonly dispatchTimeoutMs: number;

  constructor(private readonly options: CommandCenterControlOptions) {
    this.now = options.now ?? (() => Date.now());
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? COMMAND_CENTER_DISPATCH_TIMEOUT_MS;
  }

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
    const repository = async <K extends CommandCenterMethod>(
      operation: K, request: CommandCenterRequests[K],
    ): Promise<CommandCenterResults[K]> => {
      assertCurrent();
      const result = await this.options.repository.call(operation, request as CommandCenterRepositoryRequests[K], context);
      assertCurrent();
      return result;
    };
    /** Private C2 transitions (`intervention/ack`) share the same fenced adapter. */
    const repositoryOperation = async <K extends CommandCenterRepositoryMethod>(
      operation: K, request: CommandCenterRepositoryRequests[K],
    ): Promise<CommandCenterRepositoryResults[K]> => {
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
      const fingerprint = createHash("sha256").update(commandCenterCanonicalPayload(request)).digest("hex");
      /** True only for the exact receipt this request may own. */
      const binds = (entry: CommandCenterReceiptEntry) =>
        entry.hostId === binding.hostId &&
        entry.hostEpoch === binding.hostEpoch &&
        entry.commandWorkspaceId === request.commandWorkspaceId &&
        entry.membershipRevision === request.expectedMembershipRevision &&
        entry.receipt.fingerprint === fingerprint &&
        commandCenterReceiptBindsRequest(entry.receipt, request);
      const findReceipt = async (): Promise<CommandCenterReceiptEntry | null> => {
        assertCurrent();
        let entry: CommandCenterReceiptEntry | null;
        try {
          entry = await repository("receipt/get", { version: 1, hostId: binding.hostId, requestId: request.requestId });
        } catch {
          throw new RacpError("INTERNAL", "command-center receipt reconciliation failed", { retriable: false });
        }
        if (!entry) return null;
        if (!binds(entry)) throw new RacpError("CONFLICT", "request ID already names a different intervention", { retriable: false });
        if (!await canReadReceipt(entry)) forbidden();
        return entry;
      };
      result = await (async (): Promise<{ receipt: CommandCenterReceipt; replayed: boolean }> => {
        const previous = await repository("receipt/get", { version: 1, hostId: binding.hostId, requestId: request.requestId });
        if (previous) {
          // Lost-reply reconciliation: the committed receipt is the answer; a
          // repeat never dispatches a second time.
          if (!await canReadReceipt(previous)) forbidden();
          if (!binds(previous)) {
            throw new RacpError("CONFLICT", "request ID already names a different intervention", { retriable: false });
          }
          return { receipt: previous.receipt, replayed: true };
        }
        assertOpen();
        if (!this.options.runtime?.canRecord(binding, request.target, request.intent.kind)) {
          throw new RacpError("CAPABILITY_UNAVAILABLE", "this execution has no qualified command-center consumer");
        }
        assertOpen();
        // The receipt journal row committed here is the durable dispatch claim;
        // there is intentionally no second claim store or local receipt cache.
        let recorded: CommandCenterRepositoryResults["intervention/record"];
        try {
          recorded = await repository("intervention/record", request);
        } catch (error) {
          if (error instanceof RacpError && PROVEN_REPOSITORY_REFUSALS.has(error.code)) throw error;
          const reconciled = await findReceipt();
          if (reconciled) return { receipt: reconciled.receipt, replayed: true };
          throw new RacpError("AGENT_UNAVAILABLE", "command-center intent outcome is unknown; reconcile the receipt before retrying", { retriable: false });
        }
        const dispatch = this.options.runtime?.dispatch;
        if (!dispatch) return { receipt: recorded.entry.receipt, replayed: recorded.replayed };
        if (recorded.replayed || recorded.entry.receipt.status !== "recorded") {
          // A racing duplicate or an already-acknowledged receipt owns the
          // single effect; this caller only observes it.
          return { receipt: recorded.entry.receipt, replayed: true };
        }
        const startedAt = this.now();
        let acknowledgement: CommandCenterRuntimeAcknowledgement;
        try {
          const returned = await dispatch(binding, request, { startedAt, deadlineAt: startedAt + this.dispatchTimeoutMs });
          acknowledgement = acknowledgementIsValid(returned)
            ? returned
            : { status: "outcome_unknown", error: receiptError("INTERNAL", "runtime returned an invalid acknowledgement") };
        } catch (error) {
          acknowledgement = acknowledgementFromDispatchFailure(error);
        }
        // The owner epoch/role set is rechecked after the I/O; an owner change
        // denies the acknowledgement rather than writing it under a stale epoch.
        assertCurrent();
        return await this.persistAcknowledgement(binding, context, request, recorded.entry, acknowledgement, fingerprint, repositoryOperation);
      })();
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

  /**
   * Persist one execution-boundary consumption acknowledgement.
   *
   * This is the in-process seam a qualified runtime consumer calls after it
   * actually reaches the named scheduling boundary. It never dispatches and
   * never invents a revision: the exact target, consumed revision and boundary
   * must match the committed receipt, and C2 performs the accepted -> consumed
   * transition (idempotently for a duplicate boundary event).
   */
  async acknowledgeConsumption(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<{ receipt: CommandCenterReceipt; replayed: boolean }> {
    const principal = { ...authenticatedPrincipal, roles: [...authenticatedPrincipal.roles] };
    text(principal.subject, 256);
    if (principal.roles.some((role) => !["viewer", "controller", "approver", "owner"].includes(role))) forbidden();
    // Consumption is a control mutation; viewer/approver roles cannot report it.
    if (!rolesAllowOperation(principal.roles, "turn/start")) forbidden();
    const input = parseCommandCenterConsumptionRequest(value);
    const binding = { ...this.options.hostIdentity() };
    hostId(binding.hostId); uuid(binding.hostEpoch);
    if (input.hostId !== binding.hostId || input.expectedHostEpoch !== binding.hostEpoch) conflict();
    const context: CommandCenterRepositoryContext = {
      binding, auth: { subject: principal.subject, roles: principal.roles, sessionIds: [], workspaceIds: [] },
    };
    const assertCurrent = () => {
      const current = this.options.hostIdentity();
      if (current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) conflict();
    };
    const requireControl = async (kind: "session" | "workspace", id: string) => {
      const allowed = await this.options.authorize(principal, { kind, id, permission: "control" });
      assertCurrent();
      if (!allowed) forbidden();
      const grants = kind === "session" ? context.auth.sessionIds : context.auth.workspaceIds;
      if (!grants.includes(id)) grants.push(id);
    };
    const repository = async <K extends CommandCenterRepositoryMethod>(
      operation: K, request: CommandCenterRepositoryRequests[K],
    ): Promise<CommandCenterRepositoryResults[K]> => {
      assertCurrent();
      const result = await this.options.repository.call(operation, request, context);
      assertCurrent();
      return result;
    };
    const entry = await repository("receipt/get", { version: 1, hostId: binding.hostId, requestId: input.requestId });
    if (!entry) throw new RacpError("NOT_FOUND", `request ${input.requestId} has no durable receipt`, { retriable: false });
    if (entry.hostId !== binding.hostId || entry.hostEpoch !== binding.hostEpoch) conflict();
    if (entry.receipt.requestId !== input.requestId) {
      throw new RacpError("INTERNAL", "command-center repository returned an unrelated receipt", { retriable: false });
    }
    await requireControl("session", sessionId(entry.receipt.target));
    await requireControl("workspace", entry.commandWorkspaceId);
    if (input.expectedRevision !== entry.receipt.revision) {
      throw new RacpError("CONFLICT", "command-center receipt revision changed; reconcile before retrying", { retriable: false });
    }
    if (entry.receipt.status !== "accepted" && entry.receipt.status !== "consumed") {
      throw new RacpError("CONFLICT", `the command-center receipt is ${entry.receipt.status} and cannot be consumed`, { retriable: false });
    }
    if (!commandCenterConsumptionBindsReceipt(input.consumption, entry.receipt)) {
      throw new RacpError("CONFLICT", "consumption acknowledgement does not match the committed receipt", { retriable: false });
    }
    const ack = {
      version: 1 as const,
      hostId: binding.hostId,
      expectedHostEpoch: binding.hostEpoch,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      status: "consumed" as const,
      effectiveGoalRevision: input.consumption.consumedRevision,
      consumption: input.consumption,
    };
    let outcome: CommandCenterRepositoryResults["intervention/ack"];
    try {
      outcome = await repository("intervention/ack", ack);
    } catch (error) {
      if (error instanceof RacpError && PROVEN_REPOSITORY_REFUSALS.has(error.code)) throw error;
      const reconciled = await this.reconcileConsumptionEntry(context, binding, input.requestId).catch((reconcileError: unknown) => {
        if (reconcileError instanceof RacpError && reconcileError.code === "CONFLICT") throw reconcileError;
        return null;
      });
      if (reconciled?.receipt.status === "consumed" &&
          reconciled.receipt.effectiveGoalRevision === input.consumption.consumedRevision) {
        return { receipt: reconciled.receipt, replayed: true };
      }
      throw new RacpError("AGENT_UNAVAILABLE", "command-center consumption outcome is unknown; reconcile before retrying", { retriable: false });
    }
    if (outcome.entry.hostId !== binding.hostId || outcome.entry.hostEpoch !== binding.hostEpoch ||
        outcome.entry.commandWorkspaceId !== entry.commandWorkspaceId ||
        outcome.entry.receipt.status !== "consumed" ||
        !commandCenterConsumptionBindsReceipt(input.consumption, outcome.entry.receipt)) {
      throw new RacpError("INTERNAL", "command-center repository returned an unexpected consumption receipt", { retriable: false });
    }
    return { receipt: outcome.entry.receipt, replayed: outcome.replayed };
  }

  /** True when a shared admission authority is bound to this control service. */
  hasAdmission(): boolean {
    return this.options.admission !== undefined;
  }

  /**
   * Reserve one live execution slot through the C2 admission authority.
   *
   * This is the single control-level seam every entry point must consult. The
   * control service keeps no counts: 12-per-workspace / 36-per-Host, duplicate
   * admission and terminal release are decided by the injected port.
   */
  async admitExecution(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<CommandCenterAdmissionReservation> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, true);
    const input = parseCommandCenterAdmissionRequest(value);
    const binding = this.admissionBinding(input.hostId, input.expectedHostEpoch);
    this.assertAdmissionOpen(binding);
    const auth = this.admissionAuth(principal);
    await this.requireAdmissionControl(principal, binding, auth, "workspace", input.commandWorkspaceId);
    await this.requireAdmissionControl(principal, binding, auth, "session", sessionId(input.target));
    const port = this.admissionPort();
    this.assertAdmissionOpen(binding);
    const reservation = await port.reserve({
      binding,
      auth,
      workspaceId: input.commandWorkspaceId,
      membershipRevision: input.expectedMembershipRevision,
      execution: input.target,
    });
    this.assertOwnerCurrent(binding);
    this.assertReservation(reservation, input.target, input.commandWorkspaceId, input.expectedMembershipRevision);
    await this.assertAdmissionStillAllowed(principal, binding, "workspace", input.commandWorkspaceId);
    await this.assertAdmissionStillAllowed(principal, binding, "session", sessionId(input.target));
    return reservation;
  }

  /** Move a reserve to a still-capacity state (stopping/outcome_unknown). */
  async holdExecution(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<CommandCenterAdmissionReservation> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, true);
    const input = parseCommandCenterAdmissionHoldRequest(value);
    const binding = this.admissionBinding(input.hostId, input.expectedHostEpoch);
    const auth = this.admissionAuth(principal);
    await this.requireAdmissionControl(principal, binding, auth, "workspace", input.commandWorkspaceId);
    await this.requireAdmissionControl(principal, binding, auth, "session", sessionId(input.target));
    const port = this.admissionPort();
    this.assertOwnerCurrent(binding);
    const reservation = await port.hold({
      binding,
      auth,
      workspaceId: input.commandWorkspaceId,
      execution: input.target,
      from: input.from,
      to: input.to,
      evidence: input.evidence,
    });
    this.assertOwnerCurrent(binding);
    this.assertReservation(reservation, input.target, null, null);
    if (!commandCenterAdmissionHoldsCapacity(reservation.state)) {
      throw new RacpError("INTERNAL", "command-center admission returned a terminal hold state", { retriable: false });
    }
    await this.assertAdmissionStillAllowed(principal, binding, "workspace", input.commandWorkspaceId);
    await this.assertAdmissionStillAllowed(principal, binding, "session", sessionId(input.target));
    return reservation;
  }

  /** Release a terminal slot exactly once; a duplicate release returns false. */
  async releaseExecution(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<{ released: boolean }> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, true);
    const input = parseCommandCenterAdmissionReleaseRequest(value);
    const binding = this.admissionBinding(input.hostId, input.expectedHostEpoch);
    const auth = this.admissionAuth(principal);
    await this.requireAdmissionControl(principal, binding, auth, "workspace", input.commandWorkspaceId);
    await this.requireAdmissionControl(principal, binding, auth, "session", sessionId(input.target));
    const port = this.admissionPort();
    this.assertOwnerCurrent(binding);
    const outcome = await port.release({
      binding,
      auth,
      workspaceId: input.commandWorkspaceId,
      execution: input.target,
      to: input.to,
      evidence: input.evidence,
    });
    this.assertOwnerCurrent(binding);
    if (!outcome || typeof outcome.released !== "boolean") {
      throw new RacpError("INTERNAL", "command-center admission returned an invalid release", { retriable: false });
    }
    await this.assertAdmissionStillAllowed(principal, binding, "workspace", input.commandWorkspaceId);
    await this.assertAdmissionStillAllowed(principal, binding, "session", sessionId(input.target));
    return outcome;
  }

  /**
   * Admit one RACP turn by its durable session/turn identity.
   *
   * The command workspace and its revision come only from the C2 membership
   * record; a missing membership or disabled workspace is an explicit refusal,
   * never a guessed default workspace. The actual quota decision reuses
   * `admitExecution` and the same C2 reservation transaction.
   */
  async admitSessionTurn(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<CommandCenterAdmissionReservation> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, true);
    const input = parseSessionAdmissionRef(value);
    const resolved = await this.resolveSessionAdmission(principal, input);
    return this.admitExecution(principal, {
      version: input.version,
      hostId: input.hostId,
      expectedHostEpoch: input.expectedHostEpoch,
      commandWorkspaceId: resolved.workspaceId,
      expectedMembershipRevision: resolved.revision,
      target: { kind: "session", sessionId: input.sessionId, turnId: input.turnId },
    });
  }

  /** Retain a turn's slot while its terminal outcome is unknown. */
  async holdSessionTurn(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<CommandCenterAdmissionReservation> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, true);
    const input = parseSessionHold(value);
    const resolved = await this.resolveSessionAdmission(principal, input);
    const base = {
      version: input.version,
      hostId: input.hostId,
      expectedHostEpoch: input.expectedHostEpoch,
      commandWorkspaceId: resolved.workspaceId,
      target: { kind: "session" as const, sessionId: input.sessionId, turnId: input.turnId },
      evidence: input.evidence,
    };
    // A reserved turn holds capacity already; C2 only allows `reserved` to move
    // to `starting`, so advance it first, then record the uncertain outcome.
    await this.holdExecution(principal, { ...base, from: "reserved", to: "starting" })
      .catch((error: unknown) => {
        if (!(error instanceof RacpError && error.code === "CONFLICT")) throw error;
      });
    return this.holdExecution(principal, { ...base, from: "starting", to: input.state });
  }

  /** Release a finished turn's slot; terminal state comes from its outcome. */
  async releaseSessionTurn(
    authenticatedPrincipal: Principal,
    value: unknown,
  ): Promise<{ released: boolean }> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, true);
    const input = parseSessionRelease(value);
    const resolved = await this.resolveSessionAdmission(principal, input);
    return this.releaseExecution(principal, {
      version: input.version,
      hostId: input.hostId,
      expectedHostEpoch: input.expectedHostEpoch,
      commandWorkspaceId: resolved.workspaceId,
      target: { kind: "session", sessionId: input.sessionId, turnId: input.turnId },
      to: input.to,
      evidence: input.evidence,
    });
  }

  private async resolveSessionAdmission(
    principal: Principal,
    input: CommandCenterSessionAdmissionRef,
  ): Promise<{ workspaceId: string; revision: number }> {
    const binding = this.admissionBinding(input.hostId, input.expectedHostEpoch);
    const auth = this.admissionAuth(principal);
    await this.requireAdmissionControl(principal, binding, auth, "session", input.sessionId);
    this.assertAdmissionOpen(binding);
    const context: CommandCenterRepositoryContext = { binding, auth };
    const membership = await this.options.repository.call(
      "membership/get", { version: 1, hostId: binding.hostId, sessionId: input.sessionId }, context,
    );
    this.assertAdmissionOpen(binding);
    if (!membership) {
      throw new RacpError("NOT_FOUND", `session ${input.sessionId} is not bound to a command workspace`, { retriable: false });
    }
    await this.requireAdmissionControl(principal, binding, auth, "workspace", membership.commandWorkspaceId);
    this.assertAdmissionOpen(binding);
    const workspace = await this.options.repository.call(
      "workspace/get", { version: 1, hostId: binding.hostId, commandWorkspaceId: membership.commandWorkspaceId }, context,
    );
    this.assertAdmissionOpen(binding);
    if (!workspace) {
      throw new RacpError("NOT_FOUND", `command workspace ${membership.commandWorkspaceId} is unknown`, { retriable: false });
    }
    if (!workspace.enabled) {
      // C2 would refuse the reservation; fail before any turn-side effect with
      // the same error family the repository adapter maps for CC_WORKSPACE_DISABLED.
      throw new RacpError("CONFLICT", `command workspace ${membership.commandWorkspaceId} is not enabled`, { retriable: false });
    }
    return { workspaceId: membership.commandWorkspaceId, revision: membership.revision };
  }

  /**
   * Current live counts and frozen limits for the Host, read-only.
   *
   * The global quota count is always visible; workspace rows are only returned
   * for the explicit ids the caller is authorized to read. The C2 adapter
   * applies the same filter on its side, so a scope cannot be widened by the
   * request.
   */
  async admissionState(
    authenticatedPrincipal: Principal,
    workspaceIds: readonly string[] = [],
  ): Promise<CommandCenterAdmissionSnapshot> {
    const principal = this.admissionPrincipal(authenticatedPrincipal, false);
    const binding = { ...this.options.hostIdentity() };
    hostId(binding.hostId); uuid(binding.hostEpoch);
    const auth = this.admissionAuth(principal);
    for (const workspaceId of workspaceIds) {
      uuid(workspaceId);
      const allowed = await this.options.authorize(principal, { kind: "workspace", id: workspaceId, permission: "read" });
      this.assertOwnerCurrent(binding);
      if (!allowed) forbidden();
      if (!auth.workspaceIds.includes(workspaceId)) auth.workspaceIds.push(workspaceId);
    }
    const port = this.admissionPort();
    this.assertOwnerCurrent(binding);
    const snapshot = await port.snapshot({ binding, auth });
    this.assertOwnerCurrent(binding);
    try {
      return parseCommandCenterAdmissionSnapshot(snapshot);
    } catch {
      throw new RacpError("INTERNAL", "command-center admission returned an invalid state", { retriable: false });
    }
  }

  private admissionAuth(principal: Principal): CommandCenterAdmissionAuth {
    return {
      subject: principal.subject,
      roles: [...principal.roles],
      sessionIds: [],
      workspaceIds: [],
    };
  }

  private async requireAdmissionControl(
    principal: Principal,
    binding: CommandCenterBinding,
    auth: CommandCenterAdmissionAuth,
    kind: "session" | "workspace",
    id: string,
  ): Promise<void> {
    const allowed = await this.options.authorize(principal, { kind, id, permission: "control" });
    this.assertOwnerCurrent(binding);
    if (!allowed) forbidden();
    const grants = kind === "session" ? auth.sessionIds : auth.workspaceIds;
    if (!grants.includes(id)) grants.push(id);
  }

  /**
   * Re-check the same scope after the transport await. A permission revocation
   * during the C2 call cannot be hidden by publishing the reservation result.
   */
  private async assertAdmissionStillAllowed(
    principal: Principal,
    binding: CommandCenterBinding,
    kind: "session" | "workspace",
    id: string,
  ): Promise<void> {
    const allowed = await this.options.authorize(principal, { kind, id, permission: "control" });
    this.assertOwnerCurrent(binding);
    if (!allowed) forbidden();
  }

  private admissionPrincipal(source: Principal, mutation: boolean): Principal {
    const principal = { ...source, roles: [...source.roles] };
    text(principal.subject, 256);
    if (principal.roles.some((role) => !["viewer", "controller", "approver", "owner"].includes(role))) forbidden();
    if (!rolesAllowOperation(principal.roles, mutation ? "turn/start" : "session/get")) forbidden();
    return principal;
  }

  private admissionBinding(expectedHostId: string, expectedEpoch: string): CommandCenterBinding {
    const binding = { ...this.options.hostIdentity() };
    hostId(binding.hostId); uuid(binding.hostEpoch);
    if (binding.hostId !== expectedHostId || binding.hostEpoch !== expectedEpoch) conflict();
    return binding;
  }

  private admissionPort(): CommandCenterAdmissionPort {
    const port = this.options.admission;
    if (!port) {
      throw new RacpError("CAPABILITY_UNAVAILABLE", "command-center admission is not bound", { retriable: false });
    }
    return port;
  }

  private assertOwnerCurrent(binding: CommandCenterBinding): void {
    const current = this.options.hostIdentity();
    if (current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) conflict();
  }

  private assertAdmissionOpen(binding: CommandCenterBinding): void {
    this.assertOwnerCurrent(binding);
    if (this.options.mutationsClosed()) {
      throw new RacpError("HOST_BUSY", "command-center admission is closed for owner handoff", { retriable: false });
    }
  }

  private assertReservation(
    reservation: CommandCenterAdmissionReservation,
    target: CommandCenterExecutionTarget,
    workspaceId: string | null,
    membershipRevision: number | null,
  ): void {
    if (!reservation ||
        reservation.executionKey !== commandCenterExecutionKey(target) ||
        (workspaceId !== null && reservation.workspaceId !== workspaceId) ||
        (membershipRevision !== null && reservation.membershipRevision !== membershipRevision) ||
        !commandCenterAdmissionHoldsCapacity(reservation.state) ||
        !Number.isSafeInteger(reservation.hostLive) || reservation.hostLive < 0 ||
        reservation.hostLive > COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerHost ||
        !Number.isSafeInteger(reservation.workspaceLive) || reservation.workspaceLive < 0 ||
        reservation.workspaceLive > COMMAND_CENTER_ADMISSION_LIMITS.maxLivePerWorkspace) {
      throw new RacpError("INTERNAL", "command-center admission returned an invalid reservation", { retriable: false });
    }
  }

  private async reconcileConsumptionEntry(
    context: CommandCenterRepositoryContext,
    binding: CommandCenterBinding,
    requestId: string,
  ): Promise<CommandCenterReceiptEntry | null> {
    const assertCurrent = () => {
      const current = this.options.hostIdentity();
      if (current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) conflict();
    };
    assertCurrent();
    const entry = await this.options.repository.call(
      "receipt/get", { version: 1, hostId: binding.hostId, requestId }, context,
    ).catch(() => null);
    assertCurrent();
    if (!entry) return null;
    if (entry.hostId !== binding.hostId || entry.hostEpoch !== binding.hostEpoch) conflict();
    if (entry.receipt.requestId !== requestId) {
      throw new RacpError("INTERNAL", "command-center repository returned an unrelated receipt", { retriable: false });
    }
    return entry;
  }

  /**
   * Persist the single acknowledgement transition for a dispatched intent.
   *
   * The expected receipt revision makes a repeated or racing acknowledgement a
   * no-op. When the reply is lost, the same receipt row is re-read and returned
   * instead of issuing a second transition or a second dispatch.
   */
  private async persistAcknowledgement(
    binding: CommandCenterBinding,
    context: CommandCenterRepositoryContext,
    request: CommandCenterInterventionRequest,
    previous: CommandCenterReceiptEntry,
    acknowledgement: CommandCenterRuntimeAcknowledgement,
    fingerprint: string,
    repository: <K extends CommandCenterRepositoryMethod>(
      operation: K, request: CommandCenterRepositoryRequests[K],
    ) => Promise<CommandCenterRepositoryResults[K]>,
  ): Promise<{ receipt: CommandCenterReceipt; replayed: boolean }> {
    if (!commandCenterReceiptCanTransition(previous.receipt.status, acknowledgement.status)) {
      // The claim is already terminal; observe the authoritative receipt instead
      // of forcing a second effect.
      const entry = await this.reconcileEntry(context, binding, request.requestId, fingerprint);
      if (entry) return { receipt: entry.receipt, replayed: true };
      throw new RacpError("CONFLICT", "the command-center receipt is already terminal", { retriable: false });
    }
    const ack = {
      version: 1 as const,
      hostId: binding.hostId,
      expectedHostEpoch: binding.hostEpoch,
      requestId: request.requestId,
      expectedRevision: previous.receipt.revision,
      status: acknowledgement.status,
      ...("effectiveGoalRevision" in acknowledgement && acknowledgement.effectiveGoalRevision !== undefined
        ? { effectiveGoalRevision: acknowledgement.effectiveGoalRevision }
        : {}),
      ...("error" in acknowledgement && acknowledgement.error ? { error: acknowledgement.error } : {}),
    };
    let outcome: CommandCenterRepositoryResults["intervention/ack"];
    try {
      outcome = await repository("intervention/ack", ack);
    } catch (error) {
      if (error instanceof RacpError && PROVEN_REPOSITORY_REFUSALS.has(error.code)) throw error;
      const entry = await this.reconcileEntry(context, binding, request.requestId, fingerprint).catch((reconcileError: unknown) => {
        if (reconcileError instanceof RacpError && reconcileError.code === "CONFLICT") throw reconcileError;
        return null;
      });
      if (entry) return { receipt: entry.receipt, replayed: true };
      throw new RacpError("AGENT_UNAVAILABLE", "command-center receipt outcome is unknown; reconcile before retrying", { retriable: false });
    }
    this.assertAcknowledgement(binding, request, previous, acknowledgement, outcome.entry, fingerprint);
    return { receipt: outcome.entry.receipt, replayed: outcome.replayed };
  }

  private async reconcileEntry(
    context: CommandCenterRepositoryContext,
    binding: CommandCenterBinding,
    requestId: string,
    fingerprint: string,
  ): Promise<CommandCenterReceiptEntry | null> {
    const assertCurrent = () => {
      const current = this.options.hostIdentity();
      if (current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) conflict();
    };
    assertCurrent();
    const entry = await this.options.repository.call(
      "receipt/get", { version: 1, hostId: binding.hostId, requestId }, context,
    ).catch(() => null);
    assertCurrent();
    if (!entry) return null;
    if (entry.hostId !== binding.hostId || entry.hostEpoch !== binding.hostEpoch) {
      throw new RacpError("CONFLICT", "command-center owner changed; reconcile before retrying", { retriable: false });
    }
    if (entry.receipt.requestId !== requestId || entry.receipt.fingerprint !== fingerprint) {
      throw new RacpError("CONFLICT", "request ID already names a different intervention", { retriable: false });
    }
    return entry;
  }

  private assertAcknowledgement(
    binding: CommandCenterBinding,
    request: CommandCenterInterventionRequest,
    previous: CommandCenterReceiptEntry,
    acknowledgement: CommandCenterRuntimeAcknowledgement,
    entry: CommandCenterReceiptEntry,
    fingerprint: string,
  ): void {
    if (entry.hostId !== binding.hostId || entry.hostEpoch !== binding.hostEpoch) conflict();
    if (entry.commandWorkspaceId !== request.commandWorkspaceId || entry.membershipRevision !== request.expectedMembershipRevision) {
      throw new RacpError("INTERNAL", "command-center repository returned an unrelated receipt", { retriable: false });
    }
    if (entry.receipt.requestId !== request.requestId || entry.receipt.fingerprint !== fingerprint ||
        !commandCenterReceiptBindsRequest(entry.receipt, request)) {
      throw new RacpError("INTERNAL", "command-center repository returned an unrelated receipt", { retriable: false });
    }
    if (entry.receipt.status !== acknowledgement.status ||
        !commandCenterReceiptCanTransition(previous.receipt.status, entry.receipt.status) ||
        ("effectiveGoalRevision" in acknowledgement && acknowledgement.effectiveGoalRevision !== undefined &&
          entry.receipt.effectiveGoalRevision !== acknowledgement.effectiveGoalRevision)) {
      throw new RacpError("INTERNAL", "command-center repository returned an unexpected receipt transition", { retriable: false });
    }
  }
}
