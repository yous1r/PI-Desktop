import { randomUUID } from "node:crypto";
import type { WorkspaceProcessRead } from "@pi-desktop/shared";
import type { ExtensionExecOptions, ExtensionExecResult } from "./runner.js";

/** A trusted extension's structured process call through the owning Desktop. */
export async function remoteExtensionExec(
  request:(input:Record<string,unknown>)=>Promise<unknown>,command:string,args:string[],
  owner:AbortSignal,options?:ExtensionExecOptions,
):Promise<ExtensionExecResult> {
  const signal=options?.signal?AbortSignal.any([owner,options.signal]):owner;signal.throwIfAborted();
  const processId=randomUUID();
  const call=(action:string,extra:Record<string,unknown>={})=>request({action,processId,...extra});
  const abort=()=>{void call("cancel").catch(()=>undefined);};
  let stdout="",stderr="",sequence=0,bytes=0;
  const maxBuffer=options?.maxBuffer??8*1024*1024;
  if(!Number.isSafeInteger(maxBuffer) || maxBuffer<1 || maxBuffer>8*1024*1024)throw Object.assign(new Error("Extension output limit must be between 1 byte and 8 MiB"),{errorCode:"INVALID_ARGUMENT"});
  signal.addEventListener("abort",abort,{once:true});
  try {
    const opened=await call("start",{input:{command,args,...(options?.cwd?{cwd:options.cwd}:{}),...(options?.env?{env:options.env}:{}),...(options?.timeout?{timeoutMs:options.timeout}:{})}});
    if(!opened || typeof opened!=="object" || !("processId" in opened) || opened.processId!==processId)throw Object.assign(new Error("Workspace process service is unavailable"),{errorCode:"CAPABILITY_UNAVAILABLE"});
    if(signal.aborted)await call("cancel");
    signal.throwIfAborted();await call("end");
    while(true) {
      signal.throwIfAborted();
      const result=await call("read",{afterSequence:sequence,waitMs:1000}) as WorkspaceProcessRead;
      for(const chunk of result.chunks) {
        sequence=chunk.sequence;bytes+=Buffer.byteLength(chunk.text);
        if(bytes>maxBuffer)throw Object.assign(new Error("Extension process output limit exceeded"),{errorCode:"LIMIT_EXCEEDED"});
        if(chunk.stream==="stdout")stdout+=chunk.text;else stderr+=chunk.text;
      }
      if(result.exit && !result.more)return{stdout,stderr,code:result.exit.code??143,killed:Boolean(result.exit.reason || result.exit.signal)};
    }
  } finally {signal.removeEventListener("abort",abort);await call("close").catch(()=>undefined);}
}
