import { createHash } from "node:crypto";
import {
  commandCenterCanonicalPayload, commandCenterConsumptionBindsReceipt, commandCenterReceiptBindsRequest,
  commandCenterReceiptCanTransition, commandCenterWithinBytes, rolesAllowOperation,
  type CommandCenterExecutionTarget, type CommandCenterInterventionRequest, type CommandCenterOperation,
  type CommandCenterReceipt,
} from "@pi-desktop/shared";
import { RacpError } from "./errors.js";
import type { Principal } from "./ports.js";
import {
  COMMAND_CENTER_METHODS, commandCenterMutation, hostId, parseCommandCenterConsumptionRequest,
  parseCommandCenterRequest, text, uuid,
  type CommandCenterAccess, type CommandCenterBinding,
  type CommandCenterMethod, type CommandCenterReceiptEntry,
  type CommandCenterRepository, type CommandCenterRepositoryContext, type CommandCenterRepositoryMethod,
  type CommandCenterRepositoryRequests, type CommandCenterRepositoryResults, type CommandCenterRequests,
  type CommandCenterResults,
} from "./command-center-control/contracts.js";
export * from "./command-center-control/contracts.js";
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
  /** Injected clock for dispatch deadlines; deterministic tests must pass one. */
  now?: () => number;
  dispatchTimeoutMs?: number;
};
type PublicResults = Omit<CommandCenterResults, "intervention/record" | "receipt/get" | "receipt/list"> & {
  "intervention/record": { receipt: CommandCenterReceipt; replayed: boolean };
  "receipt/get": CommandCenterReceipt | null;
  "receipt/list": { receipts: CommandCenterReceipt[]; nextAfterSequence: number | null };
};
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
