import { parseOwnerHandoffBootstrapCommand, parseOwnerHandoffReady, type OwnerHandoffBuild,
  type OwnerHandoffReady, type OwnerHandoffRecord } from "@pi-desktop/shared";
import type { OwnerAttachmentIdentity, OwnerAttachmentTarget } from "./attachment/ports.js";
import {
  HANDOFF_TARGET_READY_UNAVAILABLE,
  OwnerHandoffTargetSupervisor,
  type OwnerHandoffReadyOutcome,
  type OwnerHandoffTargetClaim,
} from "./owner-handoff-target.js";

/** Host protocol version bound into the authenticated target claim. */
export const OWNER_HANDOFF_TARGET_PROTOCOL_VERSION = 11;

export const HANDOFF_RECORD_UNAVAILABLE = "HANDOFF_RECORD_UNAVAILABLE";
export const HANDOFF_RECORD_NOT_READY = "HANDOFF_RECORD_NOT_READY";
export const HANDOFF_RECORD_MISMATCH = "HANDOFF_RECORD_MISMATCH";
export const HANDOFF_TARGET_MISMATCH = "HANDOFF_TARGET_MISMATCH";
export const HANDOFF_EVENT_EPOCH_UNAVAILABLE = "HANDOFF_EVENT_EPOCH_UNAVAILABLE";
export const HANDOFF_EVENT_EPOCH_MISMATCH = "HANDOFF_EVENT_EPOCH_MISMATCH";
export const HANDOFF_SUCCESSOR_DISPOSED = "HANDOFF_SUCCESSOR_DISPOSED";

export type OwnerHandoffSuccessorState = "idle" | "starting" | "ready" | "error" | "disposed";

type HandoffError = Error & { code: string; errorCode: string };

function failure(code: string, cause?: unknown): HandoffError {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  return Object.assign(error, { code, errorCode: code });
}
function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const key of ["code", "errorCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && /^HANDOFF_[A-Z0-9_]{1,120}$/.test(value)) return value;
  }
  if (error instanceof Error && /^HANDOFF_[A-Z0-9_]{1,120}$/.test(error.message)) return error.message;
  return undefined;
}
function classify(error: unknown, fallback: string): HandoffError {
  const code = codeOf(error);
  if (!code) return failure(fallback, error);
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return error as HandoffError;
  }
  return failure(code, error);
}
function sameTarget(left: OwnerAttachmentTarget, right: OwnerAttachmentTarget): boolean {
  return left.transferId === right.transferId && left.sourceEpoch === right.sourceEpoch && left.profileId === right.profileId;
}
function matchesRecord(record: OwnerHandoffRecord, target: OwnerAttachmentTarget): boolean {
  return record.id === target.transferId && record.profile === target.profileId && record.sourceEpoch === target.sourceEpoch;
}
function sameBuild(left: OwnerHandoffBuild, right: OwnerHandoffBuild): boolean {
  return left.sha256 === right.sha256 && left.schema === right.schema && left.protocol === right.protocol;
}

export type OwnerHandoffSuccessorLaunchContext = {
  target: OwnerAttachmentTarget;
  profileId: string;
  targetBuild: OwnerHandoffBuild;
  claim: OwnerHandoffTargetClaim;
};
/** Production passes `launchOwnerHandoffTarget`; tests inject a fake transport. */
export type OwnerHandoffSuccessorLaunch = (context: OwnerHandoffSuccessorLaunchContext) => OwnerHandoffTargetSupervisor;

export type OwnerHandoffSuccessorOptions = {
  /** Durable transfer identity this successor was prepared for. */
  target: OwnerAttachmentTarget;
  /** Exact prepared claim from the handoff coordinator (never rebuilt here). */
  claim: OwnerHandoffTargetClaim;
  /** Target build committed by the prepared transfer. */
  targetBuild: OwnerHandoffBuild;
  /** Read the original-host record; null when no durable record exists. */
  readOriginal(target: OwnerAttachmentTarget, signal: AbortSignal): Promise<{ version: 1; record: OwnerHandoffRecord } | null>;
  /** Current live host event-stream epoch of the target, or null while it has none. */
  eventEpoch(signal: AbortSignal): Promise<string | null>;
  launch: OwnerHandoffSuccessorLaunch;
};

/**
 * Production composition for one prepared successor target.
 *
 * It owns the restricted target child through the supervisor: `ensureStarted()`
 * verifies the original-host record is still the prepared `release_pending`
 * revision, launches the target with the pre-committed claim and retains the
 * validated Ready outcome. `identity()` comes from the claim (profile + target
 * epoch), never from Ready. `readStatus()` re-reads the original record, binds
 * it to the retained Ready outcome and refuses unless the target's live event
 * stream epoch is the one Ready published.
 *
 * Observation only: no RACP operation, admission, execution or turn is started
 * here. Disposal ends the original child and is idempotent.
 */
export class OwnerHandoffSuccessor {
  readonly target: OwnerAttachmentTarget;
  private readonly options: OwnerHandoffSuccessorOptions;
  private readonly claimValue: OwnerHandoffTargetClaim;
  private stateValue: OwnerHandoffSuccessorState = "idle";
  private supervisorValue?: OwnerHandoffTargetSupervisor;
  private outcomeValue?: OwnerHandoffReadyOutcome;
  private failureValue?: HandoffError;
  private startPromise?: Promise<OwnerHandoffReadyOutcome>;
  private disposing?: Promise<void>;
  private disposed = false;

  constructor(options: OwnerHandoffSuccessorOptions) {
    if (!options || typeof options !== "object") throw failure("HANDOFF_INVALID_REQUEST");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.target?.transferId ?? "") ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.target?.sourceEpoch ?? "") ||
        !/^[0-9a-f]{64}$/.test(options.target?.profileId ?? "")) {
      throw failure("HANDOFF_INVALID_IDENTITY");
    }
    if (typeof options.readOriginal !== "function" || typeof options.eventEpoch !== "function" || typeof options.launch !== "function") {
      throw failure("HANDOFF_INVALID_REQUEST");
    }
    const parsed = parseOwnerHandoffBootstrapCommand(options.claim);
    if (parsed.operation !== "claim" || parsed.transfer_id !== options.target.transferId ||
        parsed.source_epoch !== options.target.sourceEpoch) {
      throw failure("HANDOFF_INVALID_REQUEST");
    }
    this.options = options;
    this.target = Object.freeze({ ...options.target });
    this.claimValue = Object.freeze({ ...parsed }) as OwnerHandoffTargetClaim;
  }

  get state(): OwnerHandoffSuccessorState { return this.stateValue; }
  get ready(): OwnerHandoffReadyOutcome | undefined { return this.outcomeValue; }
  get failure(): HandoffError | undefined { return this.failureValue; }

  /** Authenticated claim identity, available once the target is ready. Never read from Ready. */
  identity(): OwnerAttachmentIdentity {
    if (this.disposed) throw failure(HANDOFF_SUCCESSOR_DISPOSED);
    if (!this.outcomeValue) throw failure(HANDOFF_TARGET_READY_UNAVAILABLE);
    return Object.freeze({
      profileId: this.target.profileId,
      ownerEpoch: this.claimValue.target_epoch,
      protocolVersion: OWNER_HANDOFF_TARGET_PROTOCOL_VERSION,
    });
  }

  /** Idempotent one-shot launch: verify the prepared record, claim, wait for Ready. */
  ensureStarted(): Promise<OwnerHandoffReadyOutcome> {
    if (this.disposed) return Promise.reject(failure(HANDOFF_SUCCESSOR_DISPOSED));
    if (this.outcomeValue) return Promise.resolve(this.outcomeValue);
    if (!this.startPromise) {
      this.stateValue = "starting";
      this.startPromise = this.start().catch(error => {
        this.failureValue = classify(error, "HANDOFF_TARGET_READY_REFUSED");
        this.stateValue = "error";
        throw this.failureValue;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<OwnerHandoffReadyOutcome> {
    const record = await this.readOriginal();
    if (record.phase !== "release_pending") throw failure(HANDOFF_RECORD_NOT_READY);
    const claim = this.claimValue;
    if (record.revision !== claim.expected_revision || record.targetEpoch !== claim.target_epoch ||
        !matchesRecord(record, this.target) || !sameBuild(record.targetBuild, this.options.targetBuild)) {
      throw failure(HANDOFF_RECORD_MISMATCH);
    }
    const supervisor = this.options.launch({
      target: this.target,
      profileId: record.profile,
      targetBuild: this.options.targetBuild,
      claim,
    });
    this.supervisorValue = supervisor;
    const outcome = await supervisor.start();
    if (outcome.record.targetEpoch !== claim.target_epoch || outcome.record.profile !== this.target.profileId ||
        outcome.record.revision !== claim.expected_revision + 2) {
      throw failure(HANDOFF_RECORD_MISMATCH);
    }
    this.outcomeValue = outcome;
    this.stateValue = "ready";
    return outcome;
  }

  /**
   * Strict status for the attachment: original-host record plus the retained
   * target Ready publication. Every missing/drifted input fails closed.
   */
  async readStatus(target: OwnerAttachmentTarget, signal: AbortSignal): Promise<{ response: { version: 1; record: OwnerHandoffRecord }; ready?: OwnerHandoffReady }> {
    if (this.disposed) throw failure(HANDOFF_SUCCESSOR_DISPOSED);
    if (!sameTarget(target, this.target)) throw failure(HANDOFF_TARGET_MISMATCH);
    const outcome = this.outcomeValue;
    if (!outcome) throw failure(HANDOFF_TARGET_READY_UNAVAILABLE);
    const record = await this.readOriginal(signal);
    if (record.phase !== "ready") throw failure(HANDOFF_RECORD_NOT_READY);
    if (!matchesRecord(record, this.target) ||
        record.targetEpoch !== outcome.record.targetEpoch ||
        record.revision !== outcome.record.revision ||
        record.capabilityHash !== outcome.record.capabilityHash) {
      throw failure(HANDOFF_RECORD_MISMATCH);
    }
    try { parseOwnerHandoffReady(outcome.ready, record); }
    catch (error) { throw failure("HANDOFF_INVALID_READY", error); }
    let epoch: string | null;
    try { epoch = await this.options.eventEpoch(signal); }
    catch (error) { throw classify(error, HANDOFF_EVENT_EPOCH_UNAVAILABLE); }
    if (typeof epoch !== "string" || epoch.length === 0) throw failure(HANDOFF_EVENT_EPOCH_UNAVAILABLE);
    if (epoch !== outcome.ready.eventEpoch) throw failure(HANDOFF_EVENT_EPOCH_MISMATCH);
    return { response: { version: 1, record }, ready: outcome.ready };
  }

  /** End the original child and retain cleanup failure as an explicit refusal. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.stateValue = "disposed";
    this.disposing = (async () => {
      const supervisor = this.supervisorValue;
      try { await supervisor?.dispose(); }
      finally { await this.startPromise?.catch(() => undefined); }
    })();
    return this.disposing;
  }

  private async readOriginal(signal?: AbortSignal): Promise<OwnerHandoffRecord> {
    let value: { version: 1; record: OwnerHandoffRecord } | null;
    try {
      value = await this.options.readOriginal(this.target, signal ?? new AbortController().signal);
    } catch (error) {
      throw classify(error, HANDOFF_RECORD_UNAVAILABLE);
    }
    if (!value) throw failure(HANDOFF_RECORD_UNAVAILABLE);
    if (!matchesRecord(value.record, this.target)) throw failure(HANDOFF_RECORD_MISMATCH);
    return value.record;
  }
}
