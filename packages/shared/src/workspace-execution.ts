import Type from "typebox";

export const WorkspaceAuthoritySchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("remote"), hostKey: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
]);
export type WorkspaceAuthority = Type.Static<typeof WorkspaceAuthoritySchema>;

/** Issued by the owning Host, never reconstructed from a pathname by a plugin. */
export const WorkspaceExecutionContextSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 4096 }),
  projectId: Type.String({ minLength: 1, maxLength: 4096 }),
  authority: WorkspaceAuthoritySchema,
  roots: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    name: Type.String({ maxLength: 512 }),
    primary: Type.Boolean(),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  platform: Type.Union([Type.Literal("win32"), Type.Literal("darwin"), Type.Literal("linux")]),
  connectionState: Type.Union([Type.Literal("connected"), Type.Literal("disconnected")]),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });
export type WorkspaceExecutionContext = Type.Static<typeof WorkspaceExecutionContextSchema>;

/** Resource identity stays stable when the selected Desktop project changes. */
export function workspaceExecutionKey(context: Pick<WorkspaceExecutionContext, "authority" | "workspaceId">): string {
  return JSON.stringify([context.authority.kind, context.authority.kind === "remote" ? context.authority.hostKey : "", context.workspaceId]);
}

export type WorkspaceResourceRef = {
  workspaceId: string;
  authority: WorkspaceAuthority;
  generation: number;
  rootIndex: number;
  path: string;
};
