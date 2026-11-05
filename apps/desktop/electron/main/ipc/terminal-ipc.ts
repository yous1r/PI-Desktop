import { IPC, isTerminalTargetContext, type TerminalTargetContext } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import type { WorkspaceTerminalRouter } from "../terminal/workspace-terminal-router";
const invalid = (message: string) => Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Terminal request must be an object");
  return value as Record<string, unknown>;
}
function target(value: unknown): TerminalTargetContext {
  if (!isTerminalTargetContext(value) || value.tabId.length > 256 || value.workspaceId === "" || value.sessionId === "") throw invalid("Invalid terminal target");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw invalid("Invalid terminal ID");
  return value;
}
function size(input: Record<string, unknown>) {
  if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || Number(input.cols) < 2 || Number(input.cols) > 500 || Number(input.rows) < 2 || Number(input.rows) > 300) throw invalid("Invalid terminal size");
  return { cols: Number(input.cols), rows: Number(input.rows) };
}
export function registerTerminalIpc({ registrar, router }: {registrar:IpcRegistrar;router:()=>WorkspaceTerminalRouter}) {
  const handle = (channel: string, action: (input: Record<string,unknown>)=>Promise<unknown>) => {
    registrar.handleWithEvent(channel, async(event, payload:unknown) => { registrar.assertMainWindowSender(event);return action(object(payload)); });
  };
  handle(IPC.invoke.terminalListShells, input => router().listShells(target(input.target), input.refresh === true));
  handle(IPC.invoke.terminalCreate, input => {
    if (typeof input.shellId !== "string" || !input.shellId || input.shellId.length > 128 || (input.cwd !== undefined && typeof input.cwd !== "string")) throw invalid("Invalid shell or working directory");
    return router().create({target:target(input.target),shellId:input.shellId,...size(input),...(typeof input.cwd === "string" ? {cwd:input.cwd} : {})});
  });
  handle(IPC.invoke.terminalWrite,input=>{
    if (typeof input.data !== "string" || Buffer.byteLength(input.data,"utf8")>65536) throw invalid("Invalid terminal input");
    return router().action("write",id(input.terminalId),{data:input.data});
  });
  handle(IPC.invoke.terminalResize,input=>router().action("resize",id(input.terminalId),size(input)));
  handle(IPC.invoke.terminalClose,input=>router().action("close",id(input.terminalId)));
  for (const [channel, action] of [[IPC.invoke.terminalReplay,"replay"],[IPC.invoke.terminalGetBuffer,"buffer"]] as const) {
    handle(channel,input=>{
      if (input.maxBytes !== undefined && (!Number.isInteger(input.maxBytes) || Number(input.maxBytes)<1 || Number(input.maxBytes)>262144)) throw invalid("Invalid terminal buffer limit");
      return router().action(action,id(input.terminalId),input.maxBytes === undefined ? {} : {maxBytes:Number(input.maxBytes)});
    });
  }
}
