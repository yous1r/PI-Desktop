import { type Static, Type } from "typebox";

const uuid = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
/** Private stdio response. Never log or persist this one-use capability. */
export const ExecutionFenceTicketSchema = Type.Object({
  version: Type.Literal(1), generation: uuid, capability: uuid,
  address: Type.String({ minLength: 1, maxLength: 128 }),
  ownerPid: Type.Integer({ minimum: 1, maximum: 0xffff_ffff }),
  ownerCreatedAt: Type.String({ pattern: "^[0-9]{1,20}$" }),
}, { additionalProperties: false });
export const ExecutionFenceStatusSchema = Type.Object({
  generation: uuid,
  state: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("stopping"), Type.Literal("closed"), Type.Literal("failed")]),
  activeProcesses: Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
  rootExited: Type.Boolean(), confirmed: Type.Boolean(),
}, { additionalProperties: false });
export type ExecutionFenceTicket = Static<typeof ExecutionFenceTicketSchema>;
export type ExecutionFenceStatus = Static<typeof ExecutionFenceStatusSchema>;
