import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTerminalService, ShellRegistry, type WorkspacePtyModule } from "@pi-desktop/host-runtime";

it("a real PTY starts the selected shell inside the temporary workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"real-workspace-pty-"));
  const registry=new ShellRegistry();
  const profiles=registry.listShells();
  const shell=profiles.find(item=>item.id===(process.platform==="win32"?"cmd":"bash")) ?? profiles[0];
  expect(shell).toBeDefined();
  const pty=createRequire(import.meta.url)("node-pty") as WorkspacePtyModule;
  const service=new WorkspaceTerminalService({pty,shells:()=>profiles});
  const owner={deviceId:"test",connectionId:"real"};const binding={workspaceId:"real",path:root};
  let output="";let resolveOutput:()=>void=()=>{};
  const complete=new Promise<void>(resolve=>{resolveOutput=resolve;});
  const sink=async(event:import("@pi-desktop/shared").WorkspaceTerminalEvent)=>{
    if("data" in event) output+=Buffer.from(event.data,"base64").toString("utf8");
    const plain=output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,"").replace(/\r/g,"");
    if(/(?:^|\n)PI_WORKSPACE_PTY_OK(?:\n|$)/.test(plain))resolveOutput();
  };
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{
    const opened=await service.handle({action:"create",...binding,tabId:"tab",shellId:shell.id,cols:500,rows:30},owner,sink) as {terminalId:string};
    const command=process.platform==="win32"?"cd\recho PI_WORKSPACE_PTY_OK\r":"pwd\recho PI_WORKSPACE_PTY_OK\r";
    await service.handle({action:"write",...binding,terminalId:opened.terminalId,data:command},owner,sink);
    await Promise.race([complete,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error("PTY did not produce the command marker")),10000);})]);
    const actual=await realpath(root);
    expect(output.replaceAll("\\","/").toLowerCase()).toContain(actual.replaceAll("\\","/").toLowerCase());
    await service.handle({action:"close",...binding,terminalId:opened.terminalId},owner,sink);
  }finally{clearTimeout(deadline);service.dispose();await rm(root,{recursive:true,force:true});}
},15000);
