import type { WorkspaceExecutionContext } from "@pi-desktop/shared";
import { createSystemSshTransport, reserveLocalPort } from "./ssh-transport";
import { sshTargetOf } from "./ssh-tunnel";
import { sshMetadataOf } from "./remote-host-metadata";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
const fail = (code: string, message: string) => Object.assign(new Error(message), {code});
export type WorkspacePortRequest = {
  ownerId: string; context: WorkspaceExecutionContext; sessionId: string; port: number; path?: string;
  validate(): Promise<void>;
};
type Forward = {url: string; close(): Promise<void>};
type Lease = {ownerId:string;closed:boolean;forward?:Forward;timer?:ReturnType<typeof setInterval>;expires:number;checking:boolean};

/** Explicit, bounded preview forwarding; a disconnected binding is never recreated. */
export class WorkspacePorts {
  private readonly leases = new Set<Lease>();
  private disposed=false;
  private readonly options:{connect(context:WorkspaceExecutionContext,port:number):Promise<Forward>;openBrowser(url:string,sessionId:string):Promise<void>};
  constructor(options:WorkspacePorts["options"]){this.options=options;}
  async open(input:WorkspacePortRequest):Promise<{url:string}> {
    if(this.disposed || this.leases.size>=8)throw fail("LIMIT_EXCEEDED","Workspace preview limit reached");
    if(!Number.isInteger(input.port)||input.port<1024||input.port>65535||!input.sessionId)throw fail("INVALID_ARGUMENT","Preview requires a session and a port between 1024 and 65535");
    const path=input.path??"/";
    if(!path.startsWith("/")||path.startsWith("//")||path.length>4096||/[\\\u0000-\u001f]/.test(path))throw fail("INVALID_ARGUMENT","Preview path must be an absolute URL path");
    const lease:Lease={ownerId:input.ownerId,closed:false,expires:Date.now()+30*60_000,checking:false};this.leases.add(lease);
    const check=async()=>{if(lease.closed||this.disposed)throw fail("PLUGIN_GONE","Workspace preview was closed");await input.validate();if(lease.closed||this.disposed)throw fail("PLUGIN_GONE","Workspace preview was closed");};
    try{
      await check();
      const forward=input.context.authority.kind==="remote" ? await this.options.connect(input.context,input.port) : {url:`http://127.0.0.1:${input.port}`,close:async()=>{}};
      lease.forward=forward;await check();
      const url=new URL(path,forward.url).toString();
      if(new URL(url).origin!==new URL(forward.url).origin)throw fail("INVALID_ARGUMENT","Preview must remain on its forwarded origin");
      lease.timer=setInterval(()=>{if(lease.checking)return;lease.checking=true;void (async()=>{try{if(Date.now()>=lease.expires)throw Error("expired");await check();}catch{await this.close(lease);}finally{lease.checking=false;}})();},5000);lease.timer.unref();
      await this.options.openBrowser(url,input.sessionId);await check();return{url};
    }catch(error){await this.close(lease);throw error;}
  }
  private async close(lease:Lease){lease.closed=true;if(lease.timer)clearInterval(lease.timer);this.leases.delete(lease);const forward=lease.forward;lease.forward=undefined;await forward?.close();}
  closeOwner(ownerId:string){for(const lease of this.leases)if(lease.ownerId===ownerId)void this.close(lease).catch(()=>undefined);}
  dispose(){this.disposed=true;for(const lease of this.leases)void this.close(lease).catch(()=>undefined);}
}

/** Reuse paired SSH metadata and transport; never provision or reconnect a Host here. */
export async function forwardWorkspacePort(boot:RemoteHostsBoot,context:WorkspaceExecutionContext,port:number):Promise<Forward>{
  if(context.authority.kind!=="remote")throw fail("INVALID_ARGUMENT","Remote workspace required");
  const hostKey=context.authority.hostKey;
  const client=boot.workspaceClient(hostKey);const generation=client.generation?.()??1;
  const check=()=>{if(boot.workspaceClient(hostKey)!==client||client.state?.()!=="connected"||(client.generation?.()??1)!==generation)throw fail("HOST_UNAVAILABLE","Original workspace connection is unavailable");};
  check();const record=(await boot.registry.list()).find(item=>item.hostKey===hostKey);check();
  const ssh=record&&sshMetadataOf(record);
  if(!ssh)throw fail("CAPABILITY_UNAVAILABLE","Port preview requires an SSH-paired Host");
  if(port===ssh.remotePort)throw fail("PERMISSION_DENIED","The Host control port cannot be exposed as a preview");
  const transport=createSystemSshTransport(sshTargetOf(ssh,record?.sshSecret));
  let unsubscribe:(()=>void)|undefined;
  let stopped=false;const close=async()=>{if(stopped)return;stopped=true;unsubscribe?.();transport.dispose();};
  unsubscribe=client.subscribeState?.(state=>{if(state!=="connected")void close();});
  try{
    const localPort=await reserveLocalPort();check();if(stopped)throw fail("HOST_UNAVAILABLE","Workspace disconnected");
    const forward=await transport.forward({localPort,remoteHost:"127.0.0.1",remotePort:port});check();
    if(stopped){await forward.close();throw fail("HOST_UNAVAILABLE","Workspace disconnected");}
    return{url:`http://127.0.0.1:${forward.localPort}`,close:async()=>{await close();await forward.close();}};
  }catch(error){await close();throw error;}
}
