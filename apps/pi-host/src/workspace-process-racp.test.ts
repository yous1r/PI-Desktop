import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceProcessService } from "@pi-desktop/host-runtime";
import type { WorkspaceProcessRead } from "@pi-desktop/shared";
import { harness, OWNER_TOKEN, VIEWER_TOKEN, flush } from "@pi-desktop/racp/test-harness";
describe("structured processes over RACP",()=>{
  it("requires an owner, executes argv without an Agent session, and invalidates handles on disconnect",async()=>{
    const root=await mkdtemp(join(tmpdir(),"process-racp-"));const service=new WorkspaceProcessService();
    const h=await harness({operations:{workspaceProcesses:service}});const owner=await h.connect(OWNER_TOKEN);const viewer=await h.connect(VIEWER_TOKEN);
    try{
      expect(owner.client.initialized?.capabilities.workspaceProcesses).toBe(1);
      const launch={action:"start",processId:"once",workspaceId:"work",path:root,input:{command:process.execPath,args:["-e","require('node:fs').appendFileSync('marker.txt','once');console.log(process.argv[1]);","a; $(literal)"]}};
      await expect(viewer.client.request("workspace/process",launch)).rejects.toMatchObject({code:"FORBIDDEN"});
      await expect(owner.client.request("workspace/process",{action:"start"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
      await owner.client.request("workspace/process",launch);
      let stdout="",sequence=0;
      for(let n=0;n<20;n++){
        const output=await owner.client.request<WorkspaceProcessRead>("workspace/process",{action:"read",processId:"once",afterSequence:sequence,waitMs:1000});
        for(const chunk of output.chunks){sequence=chunk.sequence;if(chunk.stream==="stdout")stdout+=chunk.text;}
        if(output.exit && !output.more){expect(output.exit.code).toBe(0);break;}
      }
      expect(stdout.trim()).toBe("a; $(literal)");expect(await readFile(join(root,"marker.txt"),"utf8")).toBe("once");
      owner.link().drop();await flush();await owner.client.connect();
      await expect(owner.client.request("workspace/process",{action:"read",processId:"once"})).rejects.toMatchObject({code:"PROCESS_GONE"});
      expect(await readFile(join(root,"marker.txt"),"utf8")).toBe("once");expect(h.runtime.prompts).toHaveLength(0);
    }finally{await owner.client.close();await viewer.client.close();h.server.close();service.dispose();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
});
