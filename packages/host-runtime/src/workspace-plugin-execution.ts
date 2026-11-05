import { randomUUID } from "node:crypto";
import * as Value from "typebox/value";
import { WorkspaceProcessRequestSchema, WorkspaceTerminalRequestSchema, type WorkspaceExecutionContext, type WorkspaceProcessRequest } from "@pi-desktop/shared";
import { WorkspaceProcessService } from "./workspace-process-service.js";
import { WorkspaceTerminalService, type WorkspacePtyModule } from "./workspace-terminal-service.js";
import { ShellRegistry } from "./terminal-shell-registry.js";
import { pluginFailure } from "./plugin-wire.js";

/** Execution resources owned by exactly one admitted plugin instance. */
export class WorkspacePluginExecution {
  private readonly processes = new WorkspaceProcessService();
  private terminal?: WorkspaceTerminalService;
  private readonly owner = {deviceId:"plugin",connectionId:randomUUID()};
  private readonly context:WorkspaceExecutionContext;
  private readonly permissions:Set<string>;
  private readonly pty?:()=>WorkspacePtyModule|null;
  private sealed=false;
  constructor(input:{context:WorkspaceExecutionContext;permissions:string[];manifestPermissions:string[];pty?:()=>WorkspacePtyModule|null}) {
    this.context=input.context;this.permissions=new Set(input.permissions.filter(value=>input.manifestPermissions.includes(value)));this.pty=input.pty;
  }
  async call(api:string,args:unknown[]):Promise<unknown> {
    if(this.sealed)throw pluginFailure("PLUGIN_GONE","Plugin execution resources have closed");
    const permission=api==="workspace.process"?"workspace.exec":api==="workspace.terminal"?"workspace.terminal":null;
    if(!permission || !this.permissions.has(permission))throw pluginFailure("PERMISSION_DENIED",`Missing ${permission??"workspace execution"} permission`);
    const input=args[0];
    if(!input || typeof input!=="object" || Array.isArray(input))throw pluginFailure("INVALID_ARGUMENT","Execution request must be an object");
    const raw=input as Record<string,unknown>;
    const root=this.context.roots.find(item=>item.primary)!.path;
    if(api==="workspace.process") {
      const request=raw.action==="start"?{...raw,processId:randomUUID(),workspaceId:this.context.workspaceId,path:root}:raw;
      if(!Value.Check(WorkspaceProcessRequestSchema,request))throw pluginFailure("INVALID_ARGUMENT","Invalid plugin process request");
      return this.processes.handle(request as WorkspaceProcessRequest,this.owner);
    }
    const request={...raw,workspaceId:this.context.workspaceId,path:root,...(raw.action==="create"?{tabId:`plugin:${randomUUID()}`}:{})};
    if(!Value.Check(WorkspaceTerminalRequestSchema,request))throw pluginFailure("INVALID_ARGUMENT","Invalid plugin terminal request");
    if(!this.terminal) {
      const pty=this.pty?.();if(!pty)throw pluginFailure("CAPABILITY_UNAVAILABLE","This Host does not provide a PTY");
      const shells=new ShellRegistry();this.terminal=new WorkspaceTerminalService({pty,shells:refresh=>shells.listShells(refresh)});
    }
    // Plugins read a bounded replay with sequence numbers; no terminal input is replayed.
    return this.terminal.handle(request,this.owner,async()=>{});
  }
  dispose() {this.sealed=true;this.processes.dispose();this.terminal?.dispose();}
}
