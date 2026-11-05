import { describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceProcessService } from "./workspace-process-service.js";
import type { WorkspaceProcessRead, WorkspaceProcessRequest } from "@pi-desktop/shared";
const owner={deviceId:"desktop",connectionId:"one"};
async function drain(service:WorkspaceProcessService,id:string) {
  let sequence=0,stdout="",stderr="";
  for(let count=0;count<100;count++) {
    const result=await service.handle({action:"read",processId:id,afterSequence:sequence,waitMs:1000},owner) as WorkspaceProcessRead;
    for(const chunk of result.chunks){sequence=chunk.sequence;if(chunk.stream==="stdout")stdout+=chunk.text;else stderr+=chunk.text;}
    if(result.exit && !result.more)return{...result.exit,stdout,stderr};
  }
  throw Error("Process never exited");
}
describe("structured workspace processes",()=>{
  it("keeps argv literal, routes stdin and Unicode streams, and filters host secrets",async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),"workspace-exec-")));const service=new WorkspaceProcessService({env:{...process.env,PROVIDER_API_KEY:"secret"}});
    try{
      const values=['a b','$(no-shell)','a;echo bad','"quoted"','字'];
      await service.handle({action:"start",processId:"one",workspaceId:"work",path:root,input:{command:process.execPath,args:['-e',`let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>data+=v);process.stdin.on('end',()=>{console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),data,secret:process.env.PROVIDER_API_KEY??null,custom:process.env.CUSTOM}));process.stderr.write('错误');});`,...values],env:{CUSTOM:"kept"}}},owner);
      await service.handle({action:"write",processId:"one",data:"输入🙂"},owner);await service.handle({action:"end",processId:"one"},owner);
      const result=await drain(service,"one");expect(result.code).toBe(0);expect(result.stderr).toBe("错误");
      expect(JSON.parse(result.stdout)).toEqual({argv:values,cwd:root,data:"输入🙂",secret:null,custom:"kept"});
      await expect(service.handle({action:"read",processId:"one"},{...owner,deviceId:"other"})).rejects.toMatchObject({code:"FORBIDDEN"});
      await service.handle({action:"close",processId:"one"},owner);
      await expect(service.handle({action:"read",processId:"one"},owner)).rejects.toMatchObject({code:"PROCESS_GONE"});
    }finally{service.dispose();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("enforces root, environment, timeout, cancellation and output bounds",async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),"workspace-exec-bounds-")));const workspace=join(root,"work");await mkdir(workspace);const service=new WorkspaceProcessService();
    const start=(id:string,extra:Record<string,unknown>={})=>service.handle({action:"start",processId:id,workspaceId:"work",path:workspace,input:{command:process.execPath,args:['-e','setInterval(()=>{},1000)'],...extra}} as WorkspaceProcessRequest,owner);
    try{
      await expect(start("escape",{cwd:".."})).rejects.toMatchObject({code:"PERMISSION_DENIED"});
      await expect(start("env",{env:{NODE_OPTIONS:"--inspect"}})).rejects.toMatchObject({code:"PERMISSION_DENIED"});
      await start("timeout",{timeoutMs:30});expect((await drain(service,"timeout")).reason).toBe("timeout");
      await start("cancel");await service.handle({action:"cancel",processId:"cancel"},owner);expect((await drain(service,"cancel")).reason).toBe("cancelled");
      await start("flood",{args:['-e',"process.stdout.write('x'.repeat(2*1024*1024));"]});
      // Wait for exit without acknowledging output, exercising bounded retained data.
      let result:WorkspaceProcessRead={chunks:[],more:false};
      const deadline=Date.now()+5000;
      while(!result.exit && Date.now()<deadline){
        result=await service.handle({action:"read",processId:"flood",afterSequence:0,waitMs:50},owner) as WorkspaceProcessRead;
        await setImmediate();
      }
      expect(result.exit?.reason).toBe("output-limit");
      const flood=await drain(service,"flood");expect(Buffer.byteLength(flood.stdout)).toBeLessThanOrEqual(1024*1024);
      expect(flood.reason).toBe("output-limit");
      const pending=start("pending");service.disconnect(owner.connectionId);await expect(pending).rejects.toMatchObject({code:"HOST_UNAVAILABLE"});
      await expect(service.handle({action:"read",processId:"cancel"},{...owner,connectionId:"two"})).rejects.toMatchObject({code:"PROCESS_GONE"});
    }finally{service.dispose();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  },15000);
});
