import { type Static, Type } from "typebox";

const uuid = Type.String({ pattern: "^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const identity = {
  version: Type.Literal(1), transferId: uuid, sourceEpoch: uuid,
  // Binds the quiescence exchange; it does not advance the Rust journal.
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
export const SidecarHandoffIdentitySchema = Type.Object(identity, { additionalProperties: false });
export const RuntimeHandoffActivitySchema = Type.Object({
  turns: count, children: count, tools: count, inputs: count, settlements: count, unqualifiedResources: count,
}, { additionalProperties: false });
export const SidecarHandoffActivitySchema = Type.Object({
  ...RuntimeHandoffActivitySchema.properties, nativeSessions: count,
}, { additionalProperties: false });
export const SidecarHandoffCountsSchema = Type.Object({
  ...SidecarHandoffActivitySchema.properties, requests: count, executions: count,
}, { additionalProperties: false });
export const SidecarHandoffRequestSchema = Type.Union([
  Type.Object({ ...identity, operation: Type.Literal("acquire") }, { additionalProperties: false }),
  Type.Object({ ...identity, operation: Type.Literal("status"), holdId: Type.Optional(uuid) }, { additionalProperties: false }),
  Type.Object({ ...identity, holdId: uuid,
    operation: Type.Union([Type.Literal("cancel"), Type.Literal("seal")]),
  }, { additionalProperties: false }),
]);
export const SidecarHandoffStatusSchema = Type.Object({
  ...identity, holdId: uuid,
  state: Type.Union([Type.Literal("held"), Type.Literal("sealed"), Type.Literal("cancelled")]),
  counts: SidecarHandoffCountsSchema,
}, { additionalProperties: false });
export type RuntimeHandoffActivity = Static<typeof RuntimeHandoffActivitySchema>;
export type SidecarHandoffActivity = Static<typeof SidecarHandoffActivitySchema>;
export type SidecarHandoffCounts = Static<typeof SidecarHandoffCountsSchema>;
export type SidecarHandoffIdentity = Static<typeof SidecarHandoffIdentitySchema>;
export type SidecarHandoffRequest = Static<typeof SidecarHandoffRequestSchema>;
export type SidecarHandoffStatus = Static<typeof SidecarHandoffStatusSchema>;
