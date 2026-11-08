import { type Static, Type } from "typebox";
import * as Value from "typebox/value";

export const OWNER_HANDOFF_VERSION = 1;
export const OWNER_HANDOFF_MAX_RECORD_BYTES = 16 * 1024;
export const OWNER_HANDOFF_REVISION_MAX = 9_007_199_254_740_991;
export const OWNER_HANDOFF_PHASES = ["prepared", "source_fencing", "source_fenced", "release_pending", "target_claimed", "ready", "cancelled"] as const;
const uuid = Type.String({ pattern: "^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const revision = Type.Integer({ minimum: 1, maximum: OWNER_HANDOFF_REVISION_MAX });
const filetime = Type.String({ pattern: "^[1-9][0-9]{0,19}$" });
const processIdentity = Type.Object({
  pid: Type.Integer({ minimum: 1, maximum: 0xffff_ffff }), createdAt: filetime,
  sid: Type.String({ pattern: "^S-1-[^\\u0000]*$", maxLength: 184 }),
  image: Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\u0000]+$" }),
}, { additionalProperties: false });
export const OwnerHandoffBuildSchema = Type.Object({ sha256: digest, schema: Type.Literal(28), protocol: Type.Literal(1) }, { additionalProperties: false });
const phase = Type.Union([
  Type.Literal("prepared"), Type.Literal("source_fencing"), Type.Literal("source_fenced"),
  Type.Literal("release_pending"), Type.Literal("target_claimed"), Type.Literal("ready"), Type.Literal("cancelled"),
]);
export const OwnerHandoffRecordSchema = Type.Object({
  version: Type.Literal(OWNER_HANDOFF_VERSION), id: uuid, profile: digest,
  sourceEpoch: uuid, targetEpoch: uuid, sourceBuild: OwnerHandoffBuildSchema, targetBuild: OwnerHandoffBuildSchema,
  requester: processIdentity, capabilityHash: digest, revision, phase,
  recoveryAttempt: Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
  lastFailure: Type.Union([Type.String({ pattern: "^[A-Z0-9_]{1,128}$" }), Type.Null()]),
}, { additionalProperties: false });
const errorCode = Type.String({ pattern: "^HANDOFF_[A-Z0-9_]{1,120}$" });
export const OwnerHandoffResponseSchema = Type.Union([
  Type.Object({ version: Type.Literal(OWNER_HANDOFF_VERSION), record: OwnerHandoffRecordSchema }, { additionalProperties: false }),
  Type.Object({ version: Type.Literal(OWNER_HANDOFF_VERSION), error: Type.Object({ code: errorCode }, { additionalProperties: false }) }, { additionalProperties: false }),
]);
const sourceIdentity = { version: Type.Literal(OWNER_HANDOFF_VERSION), requestId: uuid, sourceEpoch: uuid };
const transferIdentity = { ...sourceIdentity, transferId: uuid };
/** H0 contract only; discovery must not advertise these until H1-H3 are integrated. */
export const OwnerHandoffSourceCommandSchema = Type.Union([
  Type.Object({ ...sourceIdentity, operation: Type.Literal("preflight"), targetBuild: OwnerHandoffBuildSchema }, { additionalProperties: false }),
  Type.Object({ ...transferIdentity, operation: Type.Literal("prepare"), expectedRevision: Type.Literal(0), targetEpoch: uuid, capabilityHash: digest, targetBuild: OwnerHandoffBuildSchema }, { additionalProperties: false }),
  Type.Object({ ...transferIdentity, operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({ ...transferIdentity, operation: Type.Union([Type.Literal("cancel"), Type.Literal("fence"), Type.Literal("release")]), expectedRevision: revision }, { additionalProperties: false }),
]);

/** Advisory compatibility only; never authorizes release or target execution. */
export const OwnerHandoffPreflightSchema = Type.Object({
  ...sourceIdentity, profileId: digest, sourceBuild: OwnerHandoffBuildSchema,
  targetBuild: OwnerHandoffBuildSchema, requiresIdle: Type.Literal(true),
}, { additionalProperties: false });
export type OwnerHandoffPreflight = Static<typeof OwnerHandoffPreflightSchema>;
/** Existing restricted Rust CLI preserves its snake_case command fields. */
export const OwnerHandoffBootstrapCommandSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status"), version: Type.Literal(OWNER_HANDOFF_VERSION), transfer_id: uuid }, { additionalProperties: false }),
  Type.Object({ operation: Type.Union([Type.Literal("claim"), Type.Literal("recover")]), version: Type.Literal(OWNER_HANDOFF_VERSION), request_id: uuid, transfer_id: uuid, source_epoch: uuid, expected_revision: revision, target_epoch: uuid, capability: uuid }, { additionalProperties: false }),
]);
/** Correlates an authenticated ready owner with a fresh event-stream snapshot. */
export const OwnerHandoffReadySchema = Type.Object({
  version: Type.Literal(OWNER_HANDOFF_VERSION), transferId: uuid,
  profileId: digest, ownerEpoch: uuid, recordRevision: revision,
  eventEpoch: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" }),
  protocolVersion: Type.Literal(11), snapshotRequired: Type.Literal(true),
}, { additionalProperties: false });

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Internal owner-report shape. External source commands never accept it. */
export const OwnerHandoffInventorySchema = Type.Object({
  clients: count, turns: count, queuedTurns: count, plans: count, tools: count,
  processes: count, terminals: count, plugins: count, admissions: count,
  finalizations: count, writes: count, children: count, workers: count,
  schedules: count, approvals: count, inputs: count, nativeSessions: count,
  mcp: count, uncontainedResources: count,
}, { additionalProperties: false });
const exchange = { version: Type.Literal(1), exchangeId: uuid, transferId: uuid, sourceEpoch: uuid, revision };
export const OwnerHandoffQuiescenceRequestSchema = Type.Union([
  Type.Object({ ...exchange, operation: Type.Literal("hold") }, { additionalProperties: false }),
  Type.Object({ ...exchange, holdId: uuid, operation: Type.Union([Type.Literal("inspect"), Type.Literal("seal"), Type.Literal("cancel")]) }, { additionalProperties: false }),
]);
export const OwnerHandoffQuiescenceReportSchema = Type.Object({
  ...exchange, holdId: uuid, state: Type.Union([Type.Literal("held"), Type.Literal("sealed"), Type.Literal("cancelled")]),
  counts: OwnerHandoffInventorySchema,
}, { additionalProperties: false });
export type OwnerHandoffInventory = Static<typeof OwnerHandoffInventorySchema>;
export type OwnerHandoffQuiescenceRequest = Static<typeof OwnerHandoffQuiescenceRequestSchema>;
export type OwnerHandoffQuiescenceReport = Static<typeof OwnerHandoffQuiescenceReportSchema>;
export type OwnerHandoffBuild = Static<typeof OwnerHandoffBuildSchema>;
export type OwnerHandoffRecord = Static<typeof OwnerHandoffRecordSchema>;
export type OwnerHandoffResponse = Static<typeof OwnerHandoffResponseSchema>;
export type OwnerHandoffSourceCommand = Static<typeof OwnerHandoffSourceCommandSchema>;
export type OwnerHandoffBootstrapCommand = Static<typeof OwnerHandoffBootstrapCommandSchema>;
export type OwnerHandoffReady = Static<typeof OwnerHandoffReadySchema>;
const encoder = new TextEncoder();

function bounded(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && encoder.encode(text).byteLength <= OWNER_HANDOFF_MAX_RECORD_BYTES;
  } catch { return false; }
}
function validRecord(value: unknown): value is OwnerHandoffRecord {
  return Value.Check(OwnerHandoffRecordSchema, value) && bounded(value) &&
    value.sourceEpoch !== value.targetEpoch && BigInt(value.requester.createdAt) <= 0xffff_ffff_ffff_ffffn &&
    encoder.encode(value.requester.image).byteLength <= 8192 && encoder.encode(value.requester.sid).byteLength <= 184;
}
export function parseOwnerHandoffResponse(value: unknown): OwnerHandoffResponse {
  if (!Value.Check(OwnerHandoffResponseSchema, value) || !bounded(value) || ("record" in value && !validRecord(value.record))) {
    throw new Error("HANDOFF_INVALID_RESPONSE");
  }
  return value;
}
export function parseOwnerHandoffBootstrapCommand(value: unknown): OwnerHandoffBootstrapCommand {
  if (!Value.Check(OwnerHandoffBootstrapCommandSchema, value) || !bounded(value) ||
      (value.operation !== "status" && value.source_epoch === value.target_epoch)) throw new Error("HANDOFF_INVALID_REQUEST");
  return value;
}
export function parseOwnerHandoffSourceCommand(value: unknown): OwnerHandoffSourceCommand {
  if (!Value.Check(OwnerHandoffSourceCommandSchema, value) || !bounded(value) ||
      (value.operation === "prepare" && value.sourceEpoch === value.targetEpoch)) throw new Error("HANDOFF_INVALID_REQUEST");
  return value;
}
export function parseOwnerHandoffPreflight(value: unknown, request: OwnerHandoffSourceCommand): OwnerHandoffPreflight {
  if (request.operation !== "preflight" || !Value.Check(OwnerHandoffSourceCommandSchema, request) ||
      !Value.Check(OwnerHandoffPreflightSchema, value) || !bounded(value) ||
      value.requestId !== request.requestId || value.sourceEpoch !== request.sourceEpoch ||
      value.targetBuild.sha256 !== request.targetBuild.sha256 || value.targetBuild.schema !== request.targetBuild.schema ||
      value.targetBuild.protocol !== request.targetBuild.protocol) throw new Error("HANDOFF_INVALID_PREFLIGHT");
  return value;
}
export function parseOwnerHandoffReady(value: unknown, record: unknown): OwnerHandoffReady {
  if (!Value.Check(OwnerHandoffReadySchema, value) || !bounded(value) || !validRecord(record) ||
      record.phase !== "ready" || value.transferId !== record.id || value.profileId !== record.profile ||
      value.ownerEpoch !== record.targetEpoch || value.recordRevision !== record.revision) throw new Error("HANDOFF_INVALID_READY");
  return value;
}

/** Bind an internal answer to its outstanding original-coordinator exchange. */
export function parseOwnerHandoffQuiescenceReport(value: unknown, request: OwnerHandoffQuiescenceRequest): OwnerHandoffQuiescenceReport {
  if (!Value.Check(OwnerHandoffQuiescenceRequestSchema, request) || !Value.Check(OwnerHandoffQuiescenceReportSchema, value) ||
      !bounded(value) || value.exchangeId !== request.exchangeId || value.transferId !== request.transferId ||
      value.sourceEpoch !== request.sourceEpoch || value.revision !== request.revision ||
      ("holdId" in request && value.holdId !== request.holdId) ||
      (request.operation === "hold" && value.state !== "held") ||
      (request.operation === "seal" && value.state !== "sealed") ||
      (request.operation === "cancel" && value.state !== "cancelled") ||
      ((request.operation === "hold" || request.operation === "seal") && Object.values(value.counts).some(count => count !== 0))) {
    throw new Error("HANDOFF_INVALID_QUIESCENCE");
  }
  return value;
}
/** Client-side phase vocabulary only; the Rust journal remains authoritative. */
export function ownerHandoffNextPhase(current: OwnerHandoffRecord["phase"], operation: "cancel" | "beginFencing" | "confirmFenced" | "release" | "claim" | "ready"): OwnerHandoffRecord["phase"] | undefined {
  const transitions: Record<string, OwnerHandoffRecord["phase"] | undefined> = {
    "prepared:cancel": "cancelled", "prepared:beginFencing": "source_fencing", "source_fencing:confirmFenced": "source_fenced",
    "source_fenced:release": "release_pending", "release_pending:claim": "target_claimed", "target_claimed:ready": "ready",
  };
  return transitions[`${current}:${operation}`];
}
