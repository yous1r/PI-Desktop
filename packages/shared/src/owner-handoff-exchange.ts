import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES, OwnerHandoffQuiescenceRequestSchema, OwnerHandoffQuiescenceReportSchema,
  parseOwnerHandoffQuiescenceReport,
} from "./owner-handoff.js";

export const OWNER_HANDOFF_EXCHANGE_METHOD = "ownerHandoff.quiescence";
export const OWNER_HANDOFF_COMPLETE_METHOD = "ownerHandoff.completeQuiescence";
export const OWNER_HANDOFF_EXCHANGE_TIMEOUT_MS = 30_000;
const fields = { version: Type.Literal(1), profileId: Type.String({ pattern: "^[0-9a-f]{64}$" }), request: OwnerHandoffQuiescenceRequestSchema };
export const OwnerHandoffExchangeSchema = Type.Object(fields, { additionalProperties: false });
export const OwnerHandoffCompletionSchema = Type.Object({ ...fields, outcome: Type.Union([
  Type.Object({ report: OwnerHandoffQuiescenceReportSchema }, { additionalProperties: false }),
  Type.Object({ error: Type.Object({ code: Type.Union([
    Type.Literal("HANDOFF_BUSY"), Type.Literal("HANDOFF_OWNER_CHANGED"), Type.Literal("HANDOFF_UNAVAILABLE"),
  ]) }, { additionalProperties: false }) }, { additionalProperties: false }),
]) }, { additionalProperties: false });
const ackSchema = Type.Object({ version: Type.Literal(1), exchangeId: Type.String(), accepted: Type.Literal(true) }, { additionalProperties: false });
export type OwnerHandoffExchange = Static<typeof OwnerHandoffExchangeSchema>;
export type OwnerHandoffCompletion = Static<typeof OwnerHandoffCompletionSchema>;

function bounded(value: unknown): boolean {
  try { const text = JSON.stringify(value); return typeof text === "string" && new TextEncoder().encode(text).byteLength <= OWNER_HANDOFF_MAX_RECORD_BYTES; }
  catch { return false; }
}
export function parseOwnerHandoffExchange(value: unknown): OwnerHandoffExchange {
  if (!Value.Check(OwnerHandoffExchangeSchema, value) || !bounded(value)) throw new Error("HANDOFF_INVALID_EXCHANGE");
  return value;
}
export function parseOwnerHandoffCompletion(value: unknown, expected: OwnerHandoffExchange): OwnerHandoffCompletion {
  parseOwnerHandoffExchange(expected);
  if (!Value.Check(OwnerHandoffCompletionSchema, value) || !bounded(value)) throw new Error("HANDOFF_INVALID_COMPLETION");
  const a = value.request, b = expected.request;
  if (value.profileId !== expected.profileId || a.exchangeId !== b.exchangeId || a.transferId !== b.transferId ||
      a.sourceEpoch !== b.sourceEpoch || a.revision !== b.revision || a.operation !== b.operation ||
      ("holdId" in a && (!('holdId' in b) || a.holdId !== b.holdId))) throw new Error("HANDOFF_INVALID_COMPLETION");
  if ("report" in value.outcome) parseOwnerHandoffQuiescenceReport(value.outcome.report, b);
  return value;
}
export function parseOwnerHandoffCompletionAck(value: unknown, expected: OwnerHandoffExchange): Static<typeof ackSchema> {
  if (!Value.Check(ackSchema, value) || !bounded(value) || value.exchangeId !== expected.request.exchangeId) throw new Error("HANDOFF_INVALID_COMPLETION_ACK");
  return value;
}
