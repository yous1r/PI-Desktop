import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import { ExecutionFenceStatusSchema } from "./execution-fence.js";
import { OWNER_HANDOFF_MAX_RECORD_BYTES } from "./owner-handoff.js";

const uuid = Type.String({ pattern: "^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const identity = { version: Type.Literal(1), requestId: uuid, sourceEpoch: uuid,
  profileId: Type.String({ pattern: "^[0-9a-f]{64}$" }), generation: uuid };
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const OwnerHandoffInspectionRequestSchema = Type.Object(identity, { additionalProperties: false });
/** Rust-owned facts only. Native coverage explicitly excludes other Desktop/Host resources. */
export const OwnerHandoffInspectionSchema = Type.Object({
  ...identity,
  activity: Type.Object({ requests: count, backgroundTasks: count, writes: count, uncertain: Type.Boolean() }, { additionalProperties: false }),
  durable: Type.Object({ turns: Type.Boolean(), queuedTurns: Type.Boolean(), plans: Type.Boolean(), approvals: Type.Boolean(),
    scheduledRuns: Type.Boolean(), modeClaims: Type.Boolean(), modeWaits: Type.Boolean(), worktrees: Type.Boolean() }, { additionalProperties: false }),
  runtime: Type.Object({ tools: Type.Boolean(), backgroundProcesses: Type.Boolean(), remoteExecutions: Type.Boolean(),
    pluginExecutions: Type.Boolean(), permissions: Type.Boolean(), configSync: Type.Boolean() }, { additionalProperties: false }),
  nativeCoverage: Type.Literal("execution_generation_only"), native: ExecutionFenceStatusSchema,
}, { additionalProperties: false });
export type OwnerHandoffInspectionRequest = Static<typeof OwnerHandoffInspectionRequestSchema>;
export type OwnerHandoffInspection = Static<typeof OwnerHandoffInspectionSchema>;

function bounded(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= OWNER_HANDOFF_MAX_RECORD_BYTES; }
  catch { return false; }
}
export function parseOwnerHandoffInspectionRequest(value: unknown): OwnerHandoffInspectionRequest {
  if (!Value.Check(OwnerHandoffInspectionRequestSchema, value) || !bounded(value)) throw new Error("HANDOFF_INVALID_REQUEST");
  return value;
}
export function parseOwnerHandoffInspection(value: unknown, request: OwnerHandoffInspectionRequest): OwnerHandoffInspection {
  parseOwnerHandoffInspectionRequest(request);
  if (!Value.Check(OwnerHandoffInspectionSchema, value) || !bounded(value) ||
      value.requestId !== request.requestId || value.sourceEpoch !== request.sourceEpoch ||
      value.profileId !== request.profileId || value.generation !== request.generation || value.native.generation !== request.generation ||
      (value.native.confirmed && (value.native.state !== "closed" || value.native.activeProcesses !== 0)) ||
      (value.native.state === "running" && (value.native.rootExited || value.native.activeProcesses === 0))) {
    throw new Error("HANDOFF_INVALID_INSPECTION");
  }
  return value;
}
