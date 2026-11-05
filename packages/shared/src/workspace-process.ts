import Type from "typebox";
const text = (maxLength: number) => Type.String({maxLength, pattern:"^[^\\u0000]*$"});
const handle = {processId:Type.String({minLength:1,maxLength:128,pattern:"^[A-Za-z0-9._:-]+$"})};
export const WorkspaceProcessStartSchema = Type.Object({
  command:Type.String({minLength:1,maxLength:4096,pattern:"^[^\\u0000]*$"}),
  args:Type.Array(text(32768),{maxItems:256}),
  cwd:Type.Optional(text(4096)),
  env:Type.Optional(Type.Record(Type.String({pattern:"^[A-Za-z_][A-Za-z0-9_]{0,127}$"}),text(32768),{maxProperties:128})),
  timeoutMs:Type.Optional(Type.Integer({minimum:1,maximum:600000})),
}, {additionalProperties:false});
export type WorkspaceProcessStart = Type.Static<typeof WorkspaceProcessStartSchema>;
export const WorkspaceProcessRequestSchema = Type.Union([
  Type.Object({action:Type.Literal("start"),...handle,workspaceId:Type.String({minLength:1,maxLength:4096}),path:Type.String({minLength:1,maxLength:4096}),input:WorkspaceProcessStartSchema},{additionalProperties:false}),
  Type.Object({action:Type.Literal("read"),...handle,afterSequence:Type.Optional(Type.Integer({minimum:0})),waitMs:Type.Optional(Type.Integer({minimum:0,maximum:20000}))},{additionalProperties:false}),
  Type.Object({action:Type.Literal("write"),...handle,data:text(65536)},{additionalProperties:false}),
  Type.Object({action:Type.Literal("end"),...handle},{additionalProperties:false}),
  Type.Object({action:Type.Literal("cancel"),...handle},{additionalProperties:false}),
  Type.Object({action:Type.Literal("close"),...handle},{additionalProperties:false}),
]);
export type WorkspaceProcessRequest = Type.Static<typeof WorkspaceProcessRequestSchema>;
export type WorkspaceProcessOwner = {deviceId:string;connectionId:string};
export type WorkspaceProcessChunk = {stream:"stdout"|"stderr";text:string;sequence:number};
export type WorkspaceProcessExit = {code:number|null;signal:string|null;reason?:"cancelled"|"timeout"|"output-limit"|"spawn-error"};
export type WorkspaceProcessRead = {chunks:WorkspaceProcessChunk[];more:boolean;exit?:WorkspaceProcessExit};
