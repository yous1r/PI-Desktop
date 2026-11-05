import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as Value from "typebox/value";
import { WorkspaceProcessRequestSchema, type WorkspaceProcessRequest, type WorkspaceProcessOwner, type WorkspaceProcessChunk, type WorkspaceProcessExit, type WorkspaceProcessRead } from "@pi-desktop/shared";
import { workspaceShellEnvironment } from "./workspace-terminal-service.js";

const fail = (code:string,message:string) => Object.assign(new Error(message),{code,errorCode:code});
const MAX_QUEUE = 1024 * 1024;
const inside = (root:string,path:string) => { const rel=relative(root,path);return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
type ProcessRecord = {
  owner:WorkspaceProcessOwner; child:ChildProcessWithoutNullStreams; sequence:number;
  chunks:WorkspaceProcessChunk[]; bytes:number; waiters:Set<()=>void>; exit?:WorkspaceProcessExit;
  reason?:WorkspaceProcessExit["reason"]; timer:ReturnType<typeof setTimeout>; expiry?:ReturnType<typeof setTimeout>;
};
/** Structured argv execution. Handles belong to one connection and are never replayed. */
export class WorkspaceProcessService {
  private readonly records = new Map<string,ProcessRecord>();
  private readonly admissions = new Set<{owner:WorkspaceProcessOwner;cancelled:boolean}>();
  private sealed=false;
  private readonly env:NodeJS.ProcessEnv;
  constructor(options:{env?:NodeJS.ProcessEnv}={}) { this.env=workspaceShellEnvironment(options.env); }

  async handle(input:WorkspaceProcessRequest,owner:WorkspaceProcessOwner):Promise<unknown> {
    if (!Value.Check(WorkspaceProcessRequestSchema,input)) throw fail("INVALID_ARGUMENT","Invalid workspace process request");
    if (this.sealed || !owner.deviceId || !owner.connectionId) throw fail("HOST_UNAVAILABLE","Workspace process service is unavailable");
    if(input.action==="start") return this.start(input,owner);
    const record=this.records.get(input.processId);
    if(!record) {
      if(input.action==="close") return {ok:true};
      throw fail("PROCESS_GONE","Workspace process is unavailable");
    }
    if(record.owner.deviceId!==owner.deviceId || record.owner.connectionId!==owner.connectionId) throw fail("FORBIDDEN","Workspace process belongs to another connection");
    switch(input.action) {
      case "read": return this.read(record,input.afterSequence??0,input.waitMs??0);
      case "write": {
        if(record.exit || record.reason || record.child.stdin.writableEnded) throw fail("PROCESS_GONE","Process input is closed");
        if(record.child.stdin.writableLength+Buffer.byteLength(input.data)>MAX_QUEUE) throw fail("LIMIT_EXCEEDED","Process input queue is full");
        await new Promise<void>((done,reject)=>record.child.stdin.write(input.data,error=>error?reject(error):done()));
        return {ok:true};
      }
      case "end": record.child.stdin.end();return {ok:true};
      case "cancel": this.stop(record,"cancelled");return {ok:true};
      case "close": this.remove(input.processId,record);return {ok:true};
    }
  }

  private async start(input:Extract<WorkspaceProcessRequest,{action:"start"}>,owner:WorkspaceProcessOwner) {
    const token={owner,cancelled:false};this.admissions.add(token);
    try {
      if(!isAbsolute(input.path) || /[\u0000-\u001f]/.test(input.path)) throw fail("INVALID_ARGUMENT","Invalid workspace root");
      const root=await realpath(input.path);
      const cwd=await realpath(resolve(root,input.input.cwd??"."));
      if(!inside(root,cwd) || !(await stat(cwd)).isDirectory()) throw fail("PERMISSION_DENIED","Process cwd must remain inside its workspace");
      const env={...this.env};
      for(const [key,value] of Object.entries(input.input.env??{})) {
        if(/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(key)) throw fail("PERMISSION_DENIED","Process environment contains an injection variable");
        env[key]=value;
      }
      if(token.cancelled || this.sealed) throw fail("HOST_UNAVAILABLE","Process connection closed during admission");
      if(this.records.has(input.processId)) throw fail("CONFLICT","Process handle already exists");
      if(this.records.size>=64 || [...this.records.values()].filter(item=>item.owner.deviceId===owner.deviceId).length>=16) throw fail("LIMIT_EXCEEDED","Workspace process limit reached");
      const child=spawn(input.input.command,input.input.args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=="win32",stdio:"pipe"});
      const record:ProcessRecord={owner:{...owner},child,sequence:0,chunks:[],bytes:0,waiters:new Set(),timer:setTimeout(()=>this.stop(record,"timeout"),input.input.timeoutMs??120000)};
      record.timer.unref();this.records.set(input.processId,record);
      const decoders={stdout:new StringDecoder("utf8"),stderr:new StringDecoder("utf8")};
      for(const stream of ["stdout","stderr"] as const) {
        child[stream].on("data",(data:Buffer)=>this.output(record,stream,decoders[stream].write(data)));
        child[stream].on("end",()=>this.output(record,stream,decoders[stream].end()));
      }
      child.stdin.on("error",()=>{ /* Writes report their errors; an unobserved closed pipe is not a host failure. */ });
      child.on("error",()=>{record.reason??="spawn-error";});
      child.once("close",(code,signal)=>{
        clearTimeout(record.timer);
        record.exit={code,signal,...(record.reason?{reason:record.reason}:{})};this.wake(record);
        if(this.records.get(input.processId)===record) {record.expiry=setTimeout(()=>this.remove(input.processId,record),60000);record.expiry.unref();}
      });
      return {processId:input.processId};
    } finally {this.admissions.delete(token);}
  }

  private output(record:ProcessRecord,stream:"stdout"|"stderr",text:string) {
    if(!text || record.reason==="output-limit") return;
    // JS slices preserve code points at each bounded output frame.
    while(text) {
      let end=Math.min(text.length,8192);
      if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
      const part=text.slice(0,end);text=text.slice(end);const bytes=Buffer.byteLength(part);
      if(record.bytes+bytes>MAX_QUEUE) {this.stop(record,"output-limit");break;}
      record.chunks.push({stream,text:part,sequence:++record.sequence});record.bytes+=bytes;
    }
    this.wake(record);
  }
  private async read(record:ProcessRecord,after:number,waitMs:number):Promise<WorkspaceProcessRead> {
    if(after>record.sequence) throw fail("INVALID_ARGUMENT","Process output cursor is ahead of the process");
    while(record.chunks.length && record.chunks[0].sequence<=after) record.bytes-=Buffer.byteLength(record.chunks.shift()!.text);
    if(!record.chunks.length && !record.exit && waitMs) {
      if(record.waiters.size>=4) throw fail("LIMIT_EXCEEDED","Too many pending process reads");
      await new Promise<void>(done=>{
        const finish=()=>{clearTimeout(timer);record.waiters.delete(finish);done();};
        const timer=setTimeout(finish,waitMs);record.waiters.add(finish);
      });
    }
    const chunks:WorkspaceProcessChunk[]=[];let bytes=0;
    for(const chunk of record.chunks) {
      if(chunk.sequence<=after)continue;
      bytes+=Buffer.byteLength(chunk.text);if(bytes>256*1024)break;chunks.push(chunk);
    }
    const complete=!record.chunks.length || chunks.at(-1)?.sequence===record.chunks.at(-1)?.sequence;
    return {chunks,more:!complete,...(record.exit?{exit:record.exit}:{})};
  }
  private wake(record:ProcessRecord) {for(const wake of [...record.waiters])wake();}
  private stop(record:ProcessRecord,reason:WorkspaceProcessExit["reason"]) {
    if(record.exit || record.reason)return;record.reason=reason;clearTimeout(record.timer);
    const pid=record.child.pid;
    if(pid && process.platform==="win32") {
      const killer=spawn("taskkill.exe",["/PID",String(pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.on("error",()=>record.child.kill());
      killer.on("exit",code=>{if(code)record.child.kill();});
    } else if(pid) {
      try {process.kill(-pid,"SIGKILL");} catch {record.child.kill("SIGKILL");}
    } else record.child.kill();
  }
  private remove(id:string,record:ProcessRecord) {
    if(this.records.get(id)===record)this.records.delete(id);
    this.stop(record,"cancelled");clearTimeout(record.timer);clearTimeout(record.expiry);
    record.exit??={code:null,signal:null,reason:record.reason??"cancelled"};this.wake(record);
  }
  disconnect(connectionId:string) {
    for(const token of this.admissions)if(token.owner.connectionId===connectionId)token.cancelled=true;
    for(const [id,record] of this.records)if(record.owner.connectionId===connectionId)this.remove(id,record);
  }
  revoke(deviceId:string) {
    for(const token of this.admissions)if(token.owner.deviceId===deviceId)token.cancelled=true;
    for(const [id,record] of this.records)if(record.owner.deviceId===deviceId)this.remove(id,record);
  }
  dispose() {this.sealed=true;for(const token of this.admissions)token.cancelled=true;for(const [id,record] of this.records)this.remove(id,record);}
}
