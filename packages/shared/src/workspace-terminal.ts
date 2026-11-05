import Type from "typebox";

const identity = {
  workspaceId: Type.String({ minLength: 1, maxLength: 4096 }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
};
const handle = { ...identity, terminalId: Type.String({ minLength: 1, maxLength: 128 }) };
const size = { cols: Type.Integer({ minimum: 2, maximum: 500 }), rows: Type.Integer({ minimum: 2, maximum: 300 }) };
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 }));
export const WorkspaceTerminalRequestSchema = Type.Union([
  Type.Object({ action: Type.Literal("list"), ...identity, refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("create"), ...identity, tabId: Type.String({ minLength: 1, maxLength: 256 }), shellId: Type.String({ minLength: 1, maxLength: 128 }), ...size, cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("write"), ...handle, data: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resize"), ...handle, ...size }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("close"), ...handle }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("replay"), ...handle, maxBytes: limit }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("buffer"), ...handle, maxBytes: limit }, { additionalProperties: false }),
]);
export type WorkspaceTerminalRequest = Type.Static<typeof WorkspaceTerminalRequestSchema>;
export type WorkspaceTerminalEvent = { terminalId: string; data: string; sequence?: number } | { terminalId: string; exitCode: number | null };
export const WorkspaceTerminalEventSchema = Type.Union([
  Type.Object({ terminalId: Type.String({ minLength: 1, maxLength: 128 }), data: Type.String({ maxLength: 65536 }), sequence: Type.Optional(Type.Integer({minimum:1})) }, { additionalProperties: false }),
  Type.Object({ terminalId: Type.String({ minLength: 1, maxLength: 128 }), exitCode: Type.Union([Type.Integer(), Type.Null()]) }, { additionalProperties: false }),
]);
export type WorkspaceTerminalOwner = { deviceId: string; connectionId: string };
