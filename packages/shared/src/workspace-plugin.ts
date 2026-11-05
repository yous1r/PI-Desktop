import { Type, type Static } from "typebox";
import { WorkspaceExecutionContextSchema } from "./workspace-execution.js";

const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const PluginWireFrameSchema = Type.Object({
  id, index: Type.Integer({ minimum: 0, maximum: 2047 }),
  total: Type.Integer({ minimum: 1, maximum: 2048 }),
  data: Type.String({ maxLength: 87384, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
}, { additionalProperties: false });
export type PluginWireFrame = Static<typeof PluginWireFrameSchema>;
export const WorkspacePluginRequestSchema = Type.Union([
  Type.Object({ action: Type.Literal("describe") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("packageBegin"), digest, bytes: Type.Integer({ minimum: 1, maximum: 75497472 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("packageChunk"), uploadId: id, offset: Type.Integer({ minimum: 0, maximum: 75497472 }), data: Type.String({ maxLength: 87384, pattern: "^[A-Za-z0-9+/]*={0,2}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("packageCommit"), uploadId: id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("open"), instanceId: id, digest, context: WorkspaceExecutionContextSchema,
    entry: Type.String({ minLength: 1, maxLength: 1024 }), permissions: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 128 }),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("message"), instanceId: id, frame: PluginWireFrameSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("close"), instanceId: id }, { additionalProperties: false }),
]);
export type WorkspacePluginRequest = Static<typeof WorkspacePluginRequestSchema>;
export const WorkspacePluginEventSchema = Type.Union([
  Type.Object({ instanceId: id, frame: PluginWireFrameSchema }, { additionalProperties: false }),
  Type.Object({ instanceId: id, exitCode: Type.Integer() }, { additionalProperties: false }),
]);
export type WorkspacePluginEvent = Static<typeof WorkspacePluginEventSchema>;
export type WorkspacePluginOwner = { deviceId: string; connectionId: string };
