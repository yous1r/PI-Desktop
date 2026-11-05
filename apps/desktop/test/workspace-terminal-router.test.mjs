import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WorkspaceTerminalRouter } = await import("../electron/main/terminal/workspace-terminal-router.ts");

test("remote terminal stays bound across project switches and never falls back locally",async()=>{
  let selected="remote-project:p"; let state="connected"; let generation=1; let localSpawns=0;
  const calls=[]; const handlers=new Map(); const events=[];
  const host={call:async(method)=>{
    if(method==="session.get") return {session:{projectPath:"remote-project:p"}};
    if(method==="project.groups.list") return {groups:[{id:"p",name:"Remote",primaryPath:"remote-project:p",roots:[{path:"remote-project:p",name:"Remote",position:0}],remote:{hostKey:"a",path:"/repo"}}]};
    throw Error(method);
  }};
  const client={state:()=>state,generation:()=>generation,subscribe:()=>()=>{},handleServerRequest:(method,handler)=>{handlers.set(method,handler);return()=>handlers.delete(method);},request:async(method,input)=>{
    calls.push({method,input});
    if(input.action==="list")return{shells:[{id:"bash",label:"Bash",family:"bash"}]};
    if(input.action==="create")return{terminalId:"remote-term",shellId:"bash",cols:80,rows:24};
    if(input.action==="replay")return{data:Buffer.from("history").toString("base64")};
    return {ok:true};
  }};
  const router=new WorkspaceTerminalRouter({getHost:()=>host,currentWorkspacePath:()=>selected,remoteClient:key=>{assert.equal(key,"a");return client;},emit:event=>events.push(event),loadPty:()=>{localSpawns++;return null;}});
  try {
    const target={sessionId:"s",workspaceId:"ssh:a:remote-project:p",tabId:"tab"};
    assert.equal((await router.listShells(target)).shells[0].id,"bash");
    const opened=await router.create({target,shellId:"bash",cols:80,rows:24});
    selected="C:/unrelated";
    await router.action("write",opened.terminalId,{data:"pwd\r"});
    assert.deepEqual(calls.at(-1).input,{action:"write",workspaceId:"p",path:"/repo",terminalId:"remote-term",data:"pwd\r"});
    await handlers.get("workspace/terminalEvent")({terminalId:"remote-term",data:"aGk="});
    assert.equal(events[0].terminalId,opened.terminalId);
    state="disconnected";
    await assert.rejects(router.action("write",opened.terminalId,{data:"bad"}),{errorCode:"TERMINAL_HOST_OFFLINE"});
    assert.equal(localSpawns,0);
    state="connected"; generation++;
    await assert.rejects(router.action("write",opened.terminalId,{data:"not-reattached"}),{code:"WORKSPACE_CHANGED"});
    assert.deepEqual(await router.action("replay",opened.terminalId),{data:Buffer.from("history").toString("base64")});
    assert.equal(calls.filter(call=>call.input.action==="create").length,1);
    assert.equal(calls.filter(call=>call.input.action==="write").length,1);
    await assert.rejects(router.create({target:{...target,workspaceId:"ssh:other:/repo"},shellId:"bash",cols:80,rows:24}),{code:"WORKSPACE_CHANGED"});
    await router.action("close",opened.terminalId);
    assert.equal(calls.at(-1).input.action,"close");
  }finally{await router.dispose();}
});

test("local terminal runs in its admitted directory and closes its real service record",async()=>{
  const root=await mkdtemp(join(tmpdir(),"local-terminal-router-"));let killed=0;const writes=[];
  const host={call:async(method)=>method==="session.get"?{session:{projectPath:root}}:{groups:[]}};
  const router=new WorkspaceTerminalRouter({getHost:()=>host,currentWorkspacePath:()=>root,remoteClient:()=>{throw Error("unexpected remote lookup");},emit:()=>{},loadPty:()=>({spawn:(_file,_args,options)=>{
    assert.ok(options.cwd.includes("local-terminal-router-"));
    return{pid:1,write:data=>writes.push(data),resize:()=>{},kill:()=>{killed++;},onData:()=>({dispose(){}}),onExit:()=>({dispose(){}})};
  }})});
  try {
    const target={sessionId:"s",workspaceId:`local:${root}`,tabId:"tab"};
    const {shells}=await router.listShells(target);assert.ok(shells.length);
    const opened=await router.create({target,shellId:shells[0].id,cols:80,rows:24});
    await router.action("write",opened.terminalId,{data:"test\r"});
    assert.deepEqual(writes,["test\r"]);
    await router.action("close",opened.terminalId);assert.equal(killed,1);
  }finally{await router.dispose();await rm(root,{recursive:true,force:true});}
});
