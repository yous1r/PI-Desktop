import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTerminalService } from "@pi-desktop/host-runtime";
import { harness, OWNER_TOKEN, VIEWER_TOKEN, flush } from "@pi-desktop/racp/test-harness";

describe("workspace terminals over RACP",()=>{
  it("uses the workspace without a remote Agent session and reconnects without duplicate input",async()=>{
    const root=await mkdtemp(join(tmpdir(),"racp-workspace-term-"));const writes:string[]=[];let kills=0;
    let output=(_data:string)=>{};
    const service=new WorkspaceTerminalService({shells:()=>[{id:"test",label:"Test",family:"custom",path:process.execPath}],pty:{spawn:()=>({pid:1,write:data=>{writes.push(data);},resize:()=>{},kill:()=>{kills++;},onData:handler=>{output=handler;return{dispose(){}};},onExit:()=>({dispose(){}})})}});
    const h=await harness({operations:{workspaceTerminal:service}});
    const delivered:unknown[]=[];
    const onServerRequest=async(method:string,params:unknown)=>{expect(method).toBe("workspace/terminalEvent");delivered.push(params);return{ok:true};};
    const owner=await h.connect(OWNER_TOKEN,{onServerRequest});
    const viewer=await h.connect(VIEWER_TOKEN,{onServerRequest});
    const binding={workspaceId:"desktop-owned-project",path:root};
    try{
      expect(owner.client.initialized?.capabilities.workspaceTerminal).toBe(true);
      const request={action:"create",...binding,tabId:"tab",shellId:"test",cols:80,rows:24};
      await expect(viewer.client.request("workspace/terminal",request)).rejects.toMatchObject({code:"FORBIDDEN"});
      const opened=await owner.client.request<{terminalId:string}>("workspace/terminal",request);
      await owner.client.request("workspace/terminal",{action:"write",...binding,terminalId:opened.terminalId,data:"pwd\r"});
      output("first\n");await flush();expect(delivered.length).toBe(1);
      owner.link().drop();await flush();output("offline\n");
      await owner.client.connect();
      const replay=await owner.client.request<{data:string}>("workspace/terminal",{action:"replay",...binding,terminalId:opened.terminalId});
      expect(Buffer.from(replay.data,"base64").toString()).toBe("first\noffline\n");
      expect(writes).toEqual(["pwd\r"]);
      expect(h.runtime.prompts).toHaveLength(0);
      await owner.client.request("workspace/terminal",{action:"close",...binding,terminalId:opened.terminalId});expect(kills).toBe(1);
    }finally{await owner.client.close();await viewer.client.close();h.server.close();service.dispose();await rm(root,{recursive:true,force:true});}
  });
});
