import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WorkspaceTerminalRouter } = await import("../electron/main/terminal/workspace-terminal-router.ts");
const { terminalWorkspaceId } = await import("@pi-desktop/shared");

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
    const target={sessionId:"s",workspaceId:terminalWorkspaceId({hostKey:"a",path:"remote-project:p"}),tabId:"tab"};
    for (const hint of [target, {...target,sessionId:undefined}, {...target,workspaceId:terminalWorkspaceId({hostKey:"a",path:"/repo"})}]) {
      assert.equal((await router.listShells(hint)).shells[0].id,"bash");
    }
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
    for (const workspaceId of ["ssh:a:/Repo", "ssh:a:/repo/other", "ssh:a:remote-project:other", "local:/repo"]) {
      await assert.rejects(router.listShells({...target,workspaceId}),{code:"WORKSPACE_CHANGED"});
    }
    await router.action("close",opened.terminalId);
    assert.equal(calls.at(-1).input.action,"close");
  }finally{await router.dispose();}
});

for (const sessionId of ["s", undefined]) test(`local terminal accepts native paths ${sessionId ? "with" : "without"} a session`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"local-terminal-router-"));let killed=0;const writes=[];
  // Host workspace snapshots use native separators; durable sessions/groups use '/'.
  const storedRoot = root.replaceAll("\\", "/");
  let selected = root;
  const host={call:async(method)=>method==="session.get"?{session:{projectPath:storedRoot}}:{groups:[{
    id:"local-project",name:"Local",primaryPath:storedRoot,roots:[{path:storedRoot,name:"Local",position:0}],
  }]}};
  const router=new WorkspaceTerminalRouter({getHost:()=>host,currentWorkspacePath:()=>selected,remoteClient:()=>{throw Error("unexpected remote lookup");},emit:()=>{},loadPty:()=>({spawn:(_file,_args,options)=>{
    assert.ok(options.cwd.includes("local-terminal-router-"));
    return{pid:1,write:data=>writes.push(data),resize:()=>{},kill:()=>{killed++;},onData:()=>({dispose(){}}),onExit:()=>({dispose(){}})};
  }})});
  try {
    const target={sessionId,workspaceId:terminalWorkspaceId({path:root}),tabId:"tab"};
    const {shells}=await router.listShells(target);assert.ok(shells.length);
    const opened=await router.create({target,shellId:shells[0].id,cols:80,rows:24});
    selected = join(root, "unrelated");
    await router.action("write",opened.terminalId,{data:"test\r"});
    assert.deepEqual(writes,["test\r"]);
    if (sessionId) for (const workspaceId of [terminalWorkspaceId({path:join(root,"other")}), terminalWorkspaceId({hostKey:"other",path:root})]) {
      await assert.rejects(router.listShells({...target,workspaceId}),{code:"WORKSPACE_CHANGED"});
    }
    await router.action("close",opened.terminalId);assert.equal(killed,1);
  }finally{await router.dispose();await rm(root,{recursive:true,force:true});}
});

test("remote sessions use the owning Host session terminal and close without a local fallback", async () => {
  const calls = [];
  const client = {
    state: () => "connected", subscribe: () => () => {},
    request: async (method, input) => {
      calls.push({method, input});
      if (method === "terminal/open") return {terminalId:"host-terminal",cols:80,rows:24};
      return {ok:true};
    },
  };
  const router = new WorkspaceTerminalRouter({
    getHost: () => { throw Error("Unexpected local Host lookup"); },
    currentWorkspacePath: () => "unrelated",
    remoteClient: key => { assert.equal(key,"host-a");return client; },
    loadPty: () => { throw Error("Unexpected local PTY"); }, emit: () => {},
  });
  try {
    const target = {sessionId:"remote:host-a:session-a",workspaceId:terminalWorkspaceId({hostKey:"host-a"}),tabId:"remote-tab"};
    assert.equal((await router.listShells(target)).shells[0].id,"default");
    const opened = await router.create({target,shellId:"default",cols:80,rows:24});
    await router.action("write",opened.terminalId,{data:"pwd\r"});
    assert.deepEqual(calls.at(-1),{method:"terminal/input",input:{terminalId:"host-terminal",data:Buffer.from("pwd\r").toString("base64")}});
    await router.action("close",opened.terminalId);
    assert.deepEqual(calls.at(-1),{method:"terminal/close",input:{terminalId:"host-terminal"}});
    assert.deepEqual(calls.find(call=>call.method==="terminal/open").input,{sessionId:"session-a",cols:80,rows:24});
  } finally { await router.dispose(); }
});
