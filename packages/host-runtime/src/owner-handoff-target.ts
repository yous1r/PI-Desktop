import { randomUUID } from "node:crypto";
import {
  OWNER_HANDOFF_REVISION_MAX,
  OwnerHandoffBuildSchema,
  parseOwnerHandoffBootstrapCommand,
  parseOwnerHandoffReady,
  parseOwnerHandoffResponse,
  type OwnerHandoffBootstrapCommand,
  type OwnerHandoffBuild,
  type OwnerHandoffReady,
  type OwnerHandoffRecord,
  type OwnerHandoffResponse,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";

/**
 * Supervisor phases for one restricted successor launch. `spawned` means the
 * original child exists but no claim frame has been written. Every terminal
 * path except `ready` is `ready-refused`; admission and execution stay closed
 * and the original child is disposed before the refusal is reported.
 */
export const OWNER_HANDOFF_TARGET_STATES = [
  "spawned",
  "claim-sent",
  "claimed",
  "ready",
  "ready-refused",
] as const;
export type OwnerHandoffTargetState = (typeof OWNER_HANDOFF_TARGET_STATES)[number];

export const HANDOFF_TARGET_READY_UNAVAILABLE = "HANDOFF_TARGET_READY_UNAVAILABLE";
export const HANDOFF_TARGET_READY_REFUSED = "HANDOFF_TARGET_READY_REFUSED";
export const HANDOFF_TARGET_READY_TIMEOUT = "HANDOFF_TARGET_READY_TIMEOUT";
export const HANDOFF_TARGET_SIDECAR_UNAVAILABLE = "HANDOFF_TARGET_SIDECAR_UNAVAILABLE";
export const HANDOFF_TARGET_SIDECAR_TIMEOUT = "HANDOFF_TARGET_SIDECAR_TIMEOUT";
export const HANDOFF_TARGET_SIDECAR_DISPOSE_FAILED = "HANDOFF_TARGET_SIDECAR_DISPOSE_FAILED";
export const HANDOFF_TARGET_EVENT_EPOCH_UNAVAILABLE = "HANDOFF_TARGET_EVENT_EPOCH_UNAVAILABLE";
export const HANDOFF_TARGET_LAUNCH_TIMEOUT = "HANDOFF_TARGET_LAUNCH_TIMEOUT";
export const HANDOFF_CANCELLED = "HANDOFF_CANCELLED";
export const HANDOFF_DISPOSED = "HANDOFF_DISPOSED";
export const HANDOFF_INVALID_STATE = "HANDOFF_INVALID_STATE";

export type OwnerHandoffTargetClaim = Omit<
  Extract<OwnerHandoffBootstrapCommand, { request_id: string }>,
  "operation"
> & { operation: "claim" };

/** The committed shared bootstrap envelope; never a public wire message. */
export type OwnerHandoffTargetEnvelope = {
  version: 1;
  profileId: string;
  targetBuild: OwnerHandoffBuild;
  command: OwnerHandoffTargetClaim;
};

/** Second and final private command; all readiness facts are re-read in Rust. */
export type OwnerHandoffTargetReadyRequest = {
  version: 1;
  operation: "ready";
  requestId: string;
  transferId: string;
  targetEpoch: string;
  expectedRevision: number;
};

/** One-use execution-fence ticket created for the prepared target generation. */
export type OwnerHandoffTargetTicket = {
  version: 1;
  generation: string;
  address: string;
  capability: string;
  ownerPid: number;
  ownerCreatedAt: string;
};

/** Rust -> Node launch frame; the sidecar runner must consume this ticket. */
export type OwnerHandoffTargetLaunch = {
  version: 1;
  operation: "launch-sidecar";
  transferId: string;
  targetEpoch: string;
  ticket: OwnerHandoffTargetTicket;
};

/** Node -> Rust frame carrying the live host-hub event epoch. */
export type OwnerHandoffTargetAttachEpoch = {
  version: 1;
  operation: "attachEpoch";
  requestId: string;
  transferId: string;
  targetEpoch: string;
  expectedRevision: number;
  eventEpoch: string;
};

/** Owned sidecar process/resource. The supervisor disposes it on every exit. */
export interface OwnerHandoffTargetSidecarResource {
  dispose(): Promise<void> | void;
}

/** Injected sidecar start + live hub epoch provider for the target root join. */
export interface OwnerHandoffTargetSidecar {
  launch(ticket: OwnerHandoffTargetTicket): Promise<OwnerHandoffTargetSidecarResource | void> |
    OwnerHandoffTargetSidecarResource | void;
  eventEpoch(): Promise<string> | string;
}

/** Mirrors the Rust ReadyOutcome: the authoritative record plus its publication. */
export type OwnerHandoffReadyOutcome = {
  record: OwnerHandoffRecord;
  ready: OwnerHandoffReady;
};

/**
 * Trusted process-local seam implemented by the owner of the original
 * AppState/recovery completion, closed Rust and Node admission holds, the idle
 * sidecar, capability publication and live event stream. When the transport
 * implements `ready`, the same-process Rust ReadyOutcome is authoritative and
 * this provider is not consulted; the provider remains for in-process tests
 * and compositions that do not own the framed child.
 *
 * `publishReady` must complete those checks and refuse on incomplete
 * initialization, uncertainty, pending work or disposal. A returned value is
 * validated strictly; the supervisor never invents or repairs a Ready
 * publication.
 */
export interface OwnerHandoffTargetReadyResources {
  publishReady(claim: {
    request: OwnerHandoffTargetClaim;
    receipt: OwnerHandoffRecord;
  }): Promise<OwnerHandoffReadyOutcome> | OwnerHandoffReadyOutcome;
}

/** A server-initiated JSON-RPC notification on the post-Ready framed channel. */
export type OwnerHandoffTargetNotification = {
  method: string;
  params: unknown;
};
export type OwnerHandoffTargetNotificationHandler = (notification: OwnerHandoffTargetNotification) => void;

/**
 * Framed private transport to the original `--owner-target` child. Disposal
 * must end stdin, wait for the original child exit and must not adopt or look
 * up any PID that does not belong to this transport.
 */
export interface OwnerHandoffTargetTransport {
  call(request: OwnerHandoffTargetEnvelope, timeoutMs: number): Promise<OwnerHandoffResponse>;
  /** Read the bounded launch-sidecar frame sent after the claim receipt. */
  receiveLaunch?(timeoutMs: number): Promise<OwnerHandoffTargetLaunch>;
  /** Send the live hub epoch and receive the committed ReadyOutcome. */
  attachEpoch?(request: OwnerHandoffTargetAttachEpoch, timeoutMs: number): Promise<OwnerHandoffReadyOutcome>;
  /** Ask the same claimed Rust process to commit and return ReadyOutcome. */
  ready?(request: OwnerHandoffTargetReadyRequest, timeoutMs: number): Promise<OwnerHandoffReadyOutcome>;
  /** Post-Ready ordinary JSON-RPC over the same framed channel. */
  rpcCall?<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /** Bounded server notifications after Ready; the returned function unsubscribes. */
  onTargetNotification?(handler: OwnerHandoffTargetNotificationHandler): () => void;
  /** Drop buffered notifications and observers without ending the child. */
  closeTargetNotifications?(): void;
  confirmExit(timeoutMs: number): Promise<boolean>;
  /** False when a failed spawn never produced an original child to wait for. */
  hasProcess?(): boolean;
  dispose(): Promise<void>;
}

export type OwnerHandoffTargetSupervisorOptions = {
  transport: OwnerHandoffTargetTransport;
  profileId: string;
  targetBuild: OwnerHandoffBuild;
  claim: OwnerHandoffTargetClaim;
  /** Absent means the supervisor must report `HANDOFF_TARGET_READY_UNAVAILABLE`. */
  readyResources?: OwnerHandoffTargetReadyResources;
  /** Required when the transport exposes the launch frame/attach epoch path. */
  sidecar?: OwnerHandoffTargetSidecar;
  claimTimeoutMs?: number;
  readyTimeoutMs?: number;
  sidecarTimeoutMs?: number;
  epochTimeoutMs?: number;
  onState?: (state: OwnerHandoffTargetState) => void;
};

type HandoffError = Error & { errorCode: string };
type AbortSlot = { promise: Promise<never>; reject: (error: Error) => void };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function failure(errorCode: string, cause?: unknown): HandoffError {
  const error = new Error(errorCode, cause === undefined ? undefined : { cause });
  return Object.assign(error, { errorCode });
}
function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("errorCode" in error && typeof error.errorCode === "string") return error.errorCode;
  // Shared parsers throw classified HANDOFF_* messages; preserve them instead
  // of flattening a malformed receipt into a generic readiness refusal.
  if (error instanceof Error && /^HANDOFF_[A-Z0-9_]{1,120}$/.test(error.message)) return error.message;
  return undefined;
}
function classify(error: unknown, fallback: string): HandoffError {
  const code = codeOf(error);
  if (!code) return failure(fallback, error);
  if (error && typeof error === "object" && "errorCode" in error) return error as HandoffError;
  return failure(code, error);
}
function checkTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw failure("HANDOFF_INVALID_REQUEST");
  }
  return timeout;
}
function sameBuild(a: OwnerHandoffBuild, b: OwnerHandoffBuild): boolean {
  return a.sha256 === b.sha256 && a.schema === b.schema && a.protocol === b.protocol;
}
function sameRequester(a: OwnerHandoffRecord["requester"], b: OwnerHandoffRecord["requester"]): boolean {
  return a.pid === b.pid && a.createdAt === b.createdAt && a.sid === b.sid && a.image === b.image;
}
function deferred(): AbortSlot {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_, fail) => {
    reject = fail;
  });
  // The race may no longer be attached after terminal cleanup; keep rejection
  // handled so cancellation cannot surface as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, reject };
}

/**
 * Validate the claim reply against the exact launch envelope. Serialization is
 * already strict (`deny_unknown_fields` shape and bounded size in shared), so
 * this binds the semantic identity the supervisor must never derive from the
 * child: transfer, profile, epochs, next revision and build.
 */
export function validateOwnerHandoffTargetClaimReceipt(
  value: OwnerHandoffResponse,
  request: OwnerHandoffTargetEnvelope,
): OwnerHandoffRecord {
  const response = parseOwnerHandoffResponse(value);
  if ("error" in response) throw failure(response.error.code);
  const record = response.record;
  const command = request.command;
  if (
    record.id !== command.transfer_id ||
    record.profile !== request.profileId ||
    record.sourceEpoch !== command.source_epoch ||
    record.targetEpoch !== command.target_epoch ||
    record.revision !== command.expected_revision + 1 ||
    record.phase !== "target_claimed" ||
    !sameBuild(record.targetBuild, request.targetBuild)
  ) {
    throw failure("HANDOFF_RESPONSE_MISMATCH");
  }
  return record;
}

/**
 * Validate a Ready publication returned by the injected resource owner. The
 * record must be the exact claimed record advanced once to `ready`, and the
 * publication must bind that record and event epoch. Any drift is a refusal;
 * there is no permissive repair path.
 */
export function validateOwnerHandoffTargetReadyOutcome(
  value: OwnerHandoffReadyOutcome,
  claimed: OwnerHandoffRecord,
): OwnerHandoffReadyOutcome {
  if (!value || typeof value !== "object") throw failure("HANDOFF_INVALID_READY");
  let parsed: OwnerHandoffResponse;
  try {
    parsed = parseOwnerHandoffResponse({ version: 1, record: value.record });
  } catch {
    throw failure("HANDOFF_INVALID_READY");
  }
  if ("error" in parsed) throw failure("HANDOFF_INVALID_READY");
  const record = parsed.record;
  if (
    record.phase !== "ready" ||
    record.id !== claimed.id ||
    record.profile !== claimed.profile ||
    record.sourceEpoch !== claimed.sourceEpoch ||
    record.targetEpoch !== claimed.targetEpoch ||
    record.revision !== claimed.revision + 1 ||
    record.lastFailure !== null ||
    record.capabilityHash !== claimed.capabilityHash ||
    record.recoveryAttempt !== claimed.recoveryAttempt ||
    !sameRequester(record.requester, claimed.requester) ||
    !sameBuild(record.sourceBuild, claimed.sourceBuild) ||
    !sameBuild(record.targetBuild, claimed.targetBuild)
  ) {
    throw failure("HANDOFF_INVALID_READY");
  }
  parseOwnerHandoffReady(value.ready, record);
  return { record, ready: value.ready };
}

/**
 * Build the one Ready command for a validated claim receipt. The request ID is
 * generated once by the supervisor and retained across an ambiguous output; a
 * new supervisor instance is a new explicit attempt, never an automatic retry.
 */
export function createOwnerHandoffTargetReadyRequest(
  receipt: OwnerHandoffRecord,
  requestId: string,
): OwnerHandoffTargetReadyRequest {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId) ||
      receipt.revision < 1 || receipt.revision >= OWNER_HANDOFF_REVISION_MAX) {
    throw failure("HANDOFF_INVALID_REQUEST");
  }
  return {
    version: 1,
    operation: "ready",
    requestId,
    transferId: receipt.id,
    targetEpoch: receipt.targetEpoch,
    expectedRevision: receipt.revision,
  };
}

/**
 * Strict launch frame from Rust. Bound to the exact claim and one-use ticket;
 * unknown fields, wrong versions and non-UUID identities are refused before any
 * sidecar launcher sees the ticket.
 */
export function validateOwnerHandoffTargetLaunch(
  value: unknown,
  claim: OwnerHandoffTargetClaim,
): OwnerHandoffTargetLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  const launch = value as Record<string, unknown>;
  const keys = Object.keys(launch).sort().join(",");
  if (keys !== "operation,targetEpoch,ticket,transferId,version" || launch.version !== 1 ||
      launch.operation !== "launch-sidecar" || launch.transferId !== claim.transfer_id ||
      launch.targetEpoch !== claim.target_epoch) {
    throw failure("HANDOFF_RESPONSE_MISMATCH");
  }
  const ticket = launch.ticket;
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  const raw = ticket as Record<string, unknown>;
  const addressPrefix = "\\\\.\\pipe\\pi-execution-v1-";
  if (Object.keys(raw).sort().join(",") !==
        "address,capability,generation,ownerCreatedAt,ownerPid,version" ||
      raw.version !== 1 || typeof raw.address !== "string" ||
      typeof raw.capability !== "string" || !UUID.test(raw.capability) ||
      typeof raw.generation !== "string" || !UUID.test(raw.generation) ||
      raw.address !== `${addressPrefix}${raw.generation}` ||
      !Number.isInteger(raw.ownerPid) || (raw.ownerPid as number) < 1 ||
      typeof raw.ownerCreatedAt !== "string" || !/^[1-9][0-9]{0,19}$/.test(raw.ownerCreatedAt)) {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  return {
    version: 1,
    operation: "launch-sidecar",
    transferId: launch.transferId as string,
    targetEpoch: launch.targetEpoch as string,
    ticket: {
      version: 1,
      generation: raw.generation as string,
      address: raw.address as string,
      capability: raw.capability as string,
      ownerPid: raw.ownerPid as number,
      ownerCreatedAt: raw.ownerCreatedAt as string,
    },
  };
}

/** Build the one attach-epoch command bound to the validated claim receipt. */
export function createOwnerHandoffTargetAttachEpoch(
  receipt: OwnerHandoffRecord,
  requestId: string,
  eventEpoch: string,
): OwnerHandoffTargetAttachEpoch {
  if (!UUID.test(requestId) || receipt.revision < 1 ||
      receipt.revision >= OWNER_HANDOFF_REVISION_MAX ||
      eventEpoch.length === 0 || eventEpoch.length > 256 || eventEpoch.includes("\0")) {
    throw failure(HANDOFF_TARGET_EVENT_EPOCH_UNAVAILABLE);
  }
  return {
    version: 1,
    operation: "attachEpoch",
    requestId,
    transferId: receipt.id,
    targetEpoch: receipt.targetEpoch,
    expectedRevision: receipt.revision,
    eventEpoch,
  };
}

/**
 * Launch-side supervisor for the restricted successor. It owns only the
 * process lifecycle and the readiness gate: it never opens admission, never
 * starts AppState, never serves a request and never retries a claim. A child
 * that exits, a missing/malformed receipt, a timeout, cancellation or disposal
 * all end in `ready-refused` after the child exit is confirmed.
 */
export class OwnerHandoffTargetSupervisor {
  private readonly envelope: OwnerHandoffTargetEnvelope;
  private readonly claimTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly sidecarTimeoutMs: number;
  private readonly epochTimeoutMs: number;
  private readonly readyRequestId = randomUUID();
  private stateValue: OwnerHandoffTargetState = "spawned";
  private claimedValue?: OwnerHandoffRecord;
  private readyValue?: OwnerHandoffReadyOutcome;
  private failureValue?: HandoffError;
  private observerFailure?: HandoffError;
  private cleanupValue?: HandoffError;
  private abort?: AbortSlot;
  private started = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private cleanupPromise?: Promise<void>;
  private sidecarResource?: OwnerHandoffTargetSidecarResource;

  constructor(private readonly options: OwnerHandoffTargetSupervisorOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.profileId)) throw failure("HANDOFF_INVALID_IDENTITY");
    if (!Value.Check(OwnerHandoffBuildSchema, options.targetBuild)) throw failure("HANDOFF_INVALID_REQUEST");
    const parsed = parseOwnerHandoffBootstrapCommand(options.claim);
    if (parsed.operation !== "claim") throw failure("HANDOFF_CLAIM_REQUIRED");
    const command: OwnerHandoffTargetClaim = { ...parsed, operation: "claim" };
    if (command.expected_revision >= OWNER_HANDOFF_REVISION_MAX) throw failure("HANDOFF_INVALID_REVISION");
    this.claimTimeoutMs = checkTimeout(options.claimTimeoutMs, 15_000);
    this.readyTimeoutMs = checkTimeout(options.readyTimeoutMs, 30_000);
    this.sidecarTimeoutMs = checkTimeout(options.sidecarTimeoutMs, 15_000);
    this.epochTimeoutMs = checkTimeout(options.epochTimeoutMs, 5_000);
    // Copy once; no later caller mutation can retarget the private frame.
    this.envelope = Object.freeze({
      version: 1,
      profileId: options.profileId,
      targetBuild: Object.freeze({ ...options.targetBuild }),
      command: Object.freeze({ ...command }),
    });
  }

  get state(): OwnerHandoffTargetState {
    return this.stateValue;
  }
  get claimed(): OwnerHandoffRecord | undefined {
    return this.claimedValue;
  }
  get ready(): OwnerHandoffReadyOutcome | undefined {
    return this.readyValue;
  }
  get failure(): HandoffError | undefined {
    return this.failureValue;
  }
  /** A throwing state observer cannot corrupt the protocol; it is retained here. */
  get observerError(): HandoffError | undefined {
    return this.observerFailure;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Send exactly one claim frame. Resolves only after an injected ReadyResources
   * owner returns a valid Ready publication; otherwise rejects after the child
   * is gone and the state is `ready-refused`.
   */
  async start(): Promise<OwnerHandoffReadyOutcome> {
    if (this.started) throw failure(HANDOFF_INVALID_STATE);
    this.started = true;
    if (this.stateValue !== "spawned") throw failure(HANDOFF_INVALID_STATE);
    const abort = deferred();
    this.abort = abort;
    try {
      this.transition("claim-sent");
      const response = await this.race(
        this.options.transport.call(this.envelope, this.claimTimeoutMs),
        this.claimTimeoutMs,
        "HANDOFF_IO_TIMEOUT",
        abort,
      );
      const receipt = validateOwnerHandoffTargetClaimReceipt(response, this.envelope);
      this.claimedValue = receipt;
      this.transition("claimed");
      const resources = this.options.readyResources;
      let outcome: OwnerHandoffReadyOutcome;
      if (this.options.transport.receiveLaunch && this.options.transport.attachEpoch) {
        const sidecar = this.options.sidecar;
        if (!sidecar) throw failure(HANDOFF_TARGET_SIDECAR_UNAVAILABLE);
        const launch = validateOwnerHandoffTargetLaunch(
          await this.race(
            this.options.transport.receiveLaunch(this.readyTimeoutMs),
            this.readyTimeoutMs,
            HANDOFF_TARGET_LAUNCH_TIMEOUT,
            abort,
          ),
          this.envelope.command,
        );
        await this.race(
          Promise.resolve().then(() => sidecar.launch(launch.ticket)).then((resource) => {
            if (!resource) return;
            // A late launch after cancel/dispose must not leave an owned child.
            if (this.disposed || this.stateValue === "ready-refused") {
              return Promise.resolve(resource.dispose()).then(() => undefined);
            }
            this.sidecarResource = resource;
          }),
          this.sidecarTimeoutMs,
          HANDOFF_TARGET_SIDECAR_TIMEOUT,
          abort,
        );
        const eventEpoch = await this.race(
          Promise.resolve().then(() => sidecar.eventEpoch()),
          this.epochTimeoutMs,
          HANDOFF_TARGET_EVENT_EPOCH_UNAVAILABLE,
          abort,
        );
        const attach = createOwnerHandoffTargetAttachEpoch(receipt, this.readyRequestId, eventEpoch);
        outcome = await this.race(
          this.options.transport.attachEpoch(attach, this.readyTimeoutMs),
          this.readyTimeoutMs,
          HANDOFF_TARGET_READY_TIMEOUT,
          abort,
        );
      } else if (this.options.transport.ready) {
        outcome = await this.race(
          this.options.transport.ready(
            createOwnerHandoffTargetReadyRequest(receipt, this.readyRequestId),
            this.readyTimeoutMs,
          ),
          this.readyTimeoutMs,
          "HANDOFF_IO_TIMEOUT",
          abort,
        );
      } else if (resources) {
        outcome = await this.race(
          Promise.resolve().then(() => resources.publishReady({
            request: this.envelope.command,
            receipt,
          })),
          this.readyTimeoutMs,
          HANDOFF_TARGET_READY_TIMEOUT,
          abort,
        );
      } else {
        throw failure(HANDOFF_TARGET_READY_UNAVAILABLE);
      }
      this.readyValue = validateOwnerHandoffTargetReadyOutcome(outcome, receipt);
      this.transition("ready");
      return this.readyValue;
    } catch (error) {
      const classified = classify(error, HANDOFF_TARGET_READY_REFUSED);
      this.failureValue = classified;
      this.settleRefused();
      const cleanup = await this.disposeTransport();
      if (cleanup) attachCleanup(classified, cleanup);
      throw classified;
    } finally {
      this.abort = undefined;
    }
  }

  /** Fail closed and dispose the original child. Safe to call before `start`. */
  async cancel(reason: string = HANDOFF_CANCELLED): Promise<void> {
    if (!/^HANDOFF_[A-Z0-9_]{1,120}$/.test(reason)) throw failure("HANDOFF_INVALID_REQUEST");
    this.disposed = true;
    if (this.stateValue === "ready" || this.stateValue === "ready-refused") {
      const cleanup = await this.disposeTransport();
      if (cleanup) throw cleanup;
      return;
    }
    const cancelled = failure(reason);
    this.failureValue = cancelled;
    this.settleRefused();
    this.abort?.reject(cancelled);
    const cleanup = await this.disposeTransport();
    if (cleanup) throw cleanup;
  }

  /**
   * End the child on every path. Before `ready` this is a refusal; after
   * `ready` it only releases the retained process, never the publication.
   */
  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (this.stateValue !== "ready" && this.stateValue !== "ready-refused") {
      const disposed = failure(HANDOFF_DISPOSED);
      this.failureValue ??= disposed;
      this.settleRefused();
      this.abort?.reject(this.failureValue);
    }
    this.disposal = (async () => {
      const cleanup = await this.disposeTransport();
      if (cleanup) throw cleanup;
    })();
    return this.disposal;
  }

  private transition(next: OwnerHandoffTargetState): void {
    const allowed: Record<OwnerHandoffTargetState, readonly OwnerHandoffTargetState[]> = {
      spawned: ["claim-sent", "ready-refused"],
      "claim-sent": ["claimed", "ready-refused"],
      claimed: ["ready", "ready-refused"],
      ready: [],
      "ready-refused": [],
    };
    if (!allowed[this.stateValue].includes(next)) throw failure(HANDOFF_INVALID_STATE);
    this.stateValue = next;
    try {
      this.options.onState?.(next);
    } catch (error) {
      this.observerFailure = classify(error, HANDOFF_INVALID_STATE);
    }
  }
  private settleRefused(): void {
    if (this.stateValue !== "ready" && this.stateValue !== "ready-refused") this.transition("ready-refused");
  }

  private async race<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutCode: string,
    abort: AbortSlot,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      };
      timer = setTimeout(() => finish(failure(timeoutCode)), timeoutMs);
      timer.unref?.();
      operation.then(
        (value) => finish(undefined, value),
        (error) => finish(classify(error, HANDOFF_TARGET_READY_REFUSED)),
      );
      abort.promise.then(
        (error) => finish(error),
        () => finish(this.failureValue ?? failure(HANDOFF_CANCELLED)),
      );
    });
  }

  private async disposeTransport(): Promise<HandoffError | undefined> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = (async () => {
        const resource = this.sidecarResource;
        this.sidecarResource = undefined;
        if (resource) {
          try {
            await resource.dispose();
          } catch (error) {
            this.cleanupValue = classify(error, HANDOFF_TARGET_SIDECAR_DISPOSE_FAILED);
          }
        }
        const hadProcess = this.options.transport.hasProcess?.() ?? true;
        try {
          await this.options.transport.dispose();
          if (hadProcess && !(await this.options.transport.confirmExit(0))) {
            this.cleanupValue ??= failure("HANDOFF_EXIT_UNCONFIRMED");
          }
        } catch (error) {
          this.cleanupValue ??= classify(error, "HANDOFF_EXIT_UNCONFIRMED");
        }
      })();
    }
    await this.cleanupPromise;
    return this.cleanupValue;
  }
}

function attachCleanup(error: HandoffError, cleanup: HandoffError): void {
  Object.defineProperty(error, "cleanupError", {
    value: cleanup,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
