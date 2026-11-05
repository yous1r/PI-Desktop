import * as Value from "typebox/value";
import { WorkspaceProcessRequestSchema, type WorkspaceExecutionContext, type WorkspaceProcessRequest } from "@pi-desktop/shared";
import type { WorkspaceInvocationOwner } from "../workspace-execution-context";
import type { RemoteHostClient } from "./remote-host-connection";
const fail=(code:string,message:string)=>Object.assign(new Error(message),{code,errorCode:code});
type Binding={sessionId:string;extensionId:string;processId:string;cancelled:boolean;opening:boolean;context?:WorkspaceExecutionContext;client?:RemoteHostClient;generation?:number};
export class ExtensionWorkspaceProcesses {
  private readonly bindings=new Map<string,Binding>();
  private sealed=false;
  private checking=false;
  private readonly idle: ReturnType<typeof setInterval>;
  private readonly options:{resolve(owner:WorkspaceInvocationOwner):Promise<WorkspaceExecutionContext|null>;client(hostKey:string):RemoteHostClient;allowed(extensionId:string,context:WorkspaceExecutionContext):boolean;current():boolean};
  constructor(options:ExtensionWorkspaceProcesses["options"]){
    this.options=options;
    this.idle=setInterval(()=>{void this.revalidate();},5000);this.idle.unref();
  }
  /** Also revoke idle commands after disable, removal or Host replacement. */
  async revalidate():Promise<void>{
    if(this.sealed || this.checking)return;this.checking=true;
    try{await Promise.all([...this.bindings.values()].map(async binding=>{
      if(binding.opening)return;
      try{
        if(!this.options.current())throw fail("HOST_UNAVAILABLE","Extension owner changed");
        await this.options.resolve({sessionId:binding.sessionId,context:binding.context});
        this.authorize(binding);this.connected(binding);
      }catch{await this.close(binding);}
    }));}finally{this.checking=false;}
  }
  async handle(raw:Record<string,unknown>):Promise<unknown> {
    if(this.sealed || !this.options.current())throw fail("HOST_UNAVAILABLE","Extension execution owner is unavailable");
    const sessionId=typeof raw.sessionId==="string"?raw.sessionId:"";
    const extensionId=typeof raw.extensionId==="string"?raw.extensionId:"";
    if(!sessionId || sessionId.length>128 || !extensionId || extensionId.length>4096)throw fail("INVALID_ARGUMENT","Extension and session identity are required");
    const input=raw.request;
    if(!input || typeof input!=="object" || Array.isArray(input))throw fail("INVALID_ARGUMENT","Process request must be an object");
    const request=input as Record<string,unknown>;
    const processId=typeof request.processId==="string"?request.processId:"";
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(processId))throw fail("INVALID_ARGUMENT","Invalid process identity");
    let binding=this.bindings.get(processId);
    if(request.action==="start") {
      if(binding)throw fail("CONFLICT","Process was already requested");
      if(this.bindings.size>=64)throw fail("LIMIT_EXCEEDED","Extension process limit reached");
      binding={sessionId,extensionId,processId,cancelled:false,opening:true};this.bindings.set(processId,binding);
      try {
        const context=await this.options.resolve({sessionId});
        if(!context || context.authority.kind!=="remote")throw fail("WORKSPACE_CHANGED","The extension session is no longer remote");
        const expected=raw.workspace as {hostKey?:unknown;path?:unknown}|undefined;
        const root=context.roots.find(item=>item.primary)!.path;
        if(expected?.hostKey!==context.authority.hostKey || expected.path!==root)throw fail("WORKSPACE_CHANGED","The extension workspace changed since launch");
        binding.context=context;
        this.authorize(binding);
        if(binding.cancelled || this.sealed || !this.options.current())throw fail("TOOL_ABORTED","Extension process was cancelled before launch");
        const client=this.options.client(context.authority.hostKey);binding.client=client;binding.generation=client.generation?.()??1;
        this.connected(binding);
        const start={...request,workspaceId:context.workspaceId,path:root};
        if(!Value.Check(WorkspaceProcessRequestSchema,start) || start.action!=="start")throw fail("INVALID_ARGUMENT","Invalid structured process launch");
        if(binding.cancelled || this.sealed || !this.options.current())throw fail("TOOL_ABORTED","Extension process was cancelled before launch");
        const opened=await client.request("workspace/process",start);
        if(binding.cancelled || this.sealed || !this.options.current())throw fail("TOOL_ABORTED","Extension process was cancelled during launch");
        this.connected(binding);return opened;
      } catch(error){await this.close(binding);throw error;}
      finally {binding.opening=false;if(binding.cancelled && this.bindings.get(processId)===binding)this.bindings.delete(processId);}
    }
    if(!Value.Check(WorkspaceProcessRequestSchema,request))throw fail("INVALID_ARGUMENT","Invalid structured process request");
    if(!binding) {
      if(request.action==="close" || request.action==="cancel")return{ok:true};
      throw fail("PROCESS_GONE","Extension process is unavailable");
    }
    if(binding.sessionId!==sessionId || binding.extensionId!==extensionId)throw fail("FORBIDDEN","Process belongs to another extension invocation");
    if(request.action==="close" || request.action==="cancel") {
      binding.cancelled=true;
      if(!binding.client)return{ok:true};
      if(request.action==="close"){await this.close(binding);return{ok:true};}
    }
    try {
      this.connected(binding);
      if(request.action!=="cancel") {
        await this.options.resolve({sessionId,context:binding.context});this.authorize(binding);
      }
      if(!this.options.current() || this.sealed)throw fail("HOST_UNAVAILABLE","Extension owner was replaced");
      this.connected(binding);
      const result=await binding.client!.request("workspace/process",request as WorkspaceProcessRequest);
      this.connected(binding);return result;
    } catch(error){await this.close(binding);throw error;}
  }
  private authorize(binding:Binding) {
    if(!binding.context || !this.options.allowed(binding.extensionId,binding.context))throw fail("PERMISSION_DENIED","Extension is not enabled for the originating project");
  }
  private connected(binding:Binding) {
    if(binding.context?.authority.kind!=="remote" || !binding.client || binding.client.state?.()!=="connected" || (binding.client.generation?.()??1)!==binding.generation || this.options.client(binding.context.authority.hostKey)!==binding.client)throw fail("HOST_UNAVAILABLE","Original workspace connection is unavailable; command was not replayed");
  }
  private async close(binding:Binding) {
    binding.cancelled=true;
    if(binding.client?.state?.()==="connected" && (binding.client.generation?.()??1)===binding.generation) {
      await binding.client.request("workspace/process",{action:"close",processId:binding.processId}).catch(()=>undefined);
    }
    if(!binding.opening && this.bindings.get(binding.processId)===binding)this.bindings.delete(binding.processId);
  }
  dispose(){this.sealed=true;clearInterval(this.idle);for(const binding of this.bindings.values()){binding.cancelled=true;if(binding.client)void this.close(binding);}}
}
