import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspacePluginService } from "@pi-desktop/host-runtime";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { RemoteWorkspacePlugins } = await import("../electron/main/remote/remote-workspace-plugins.ts");

test("Desktop broker runs a workspace plugin remotely, keeps callbacks gated, and isolates concurrent projects", async () => {
  const root = await mkdtemp(join(tmpdir(),"desktop-workspace-plugin-"));
  const pkg = join(root,"package"); const workA = join(root,"a"); const workB = join(root,"b");
  await mkdir(pkg); await mkdir(workA); await mkdir(workB);
  await writeFile(join(pkg,"manifest.json"),JSON.stringify({schemaVersion:1,id:"test.workspace",name:"Test",version:"1.0.0",main:"main.cjs",execution:{main:"workspace"},permissions:["clipboard.write","agent.tool.register","fs.read","fs.write","workspace.exec"],fs:{read:{scope:["**"]},write:{scope:["sdk.txt"]}},contributes:{commands:[{id:"test.refresh",title:"Refresh"}]}}));
  await writeFile(join(pkg,"main.cjs"),`
    const fs=require('node:fs');
    module.exports={
      onLoad:async()=>{
        await pi.commands.register({id:'test.refresh',title:'Refresh',run:async()=>{}});
        await pi.agent.registerTool({name:'where',description:'Workspace',schema:{type:'object'},execute:async()=>({text:(await pi.workspace.get()).path})});
      },
      onPanelInvoke:async(channel,payload)=>{
        const workspace=await pi.workspace.get();
        if(channel==='write')fs.appendFileSync('result.txt',payload.text);
        if(channel==='clipboard')await pi.clipboard.writeText(workspace.path);
        if(channel==='forbidden')return await pi.clipboard.readText();
        if(channel==='sdk'){
          await pi.fs.writeText('sdk.txt',payload.text);
          const range=await pi.fs.readRange('sdk.txt',0,4);
          return {text:await pi.fs.readText('sdk.txt'),bytes:Array.from(range.bytes),size:range.totalSize};
        }
        if(channel==='exec')return await pi.workspace.exec({command:process.execPath,args:['-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),stdin:s})));",'a b','$(literal)'],stdin:'输入🙂'});
        if(channel==='terminalDenied')return await pi.workspace.terminal.list();
        if(channel==='active')return await pi.session.getActive();
        if(channel==='secret')return await pi.fs.readText('.env');
        return {path:workspace.path,context:await pi.workspace.getContext(),cwd:process.cwd()};
      }
    };
  `);
  const owner={deviceId:"desktop",connectionId:"test"}; const handlers=new Map(); const stateListeners=new Set();
  const service=new WorkspacePluginService({dataDir:join(root,"host"),runner:fileURLToPath(new URL("../../../packages/host-runtime/plugin-host-process.mjs",import.meta.url))});
  let state="connected";let selected="a";let localSpawns=0;let approvals=0;let authorized=true;const clipboard=[];
  const contexts=Object.fromEntries([["a",workA],["b",workB]].map(([id,path])=>[id,{workspaceId:id,projectId:id,authority:{kind:"remote",hostKey:"host"},roots:[{path,name:id,primary:true}],platform:"linux",connectionState:"connected",generation:1}]));
  const client={state:()=>state,generation:()=>1,handleServerRequest:(method,handler)=>{handlers.set(method,handler);return()=>handlers.delete(method);},subscribeState:listener=>{stateListeners.add(listener);return()=>stateListeners.delete(listener);},request:async(method,input)=>{
    assert.equal(method,"workspace/plugin");if(state!=="connected")throw Error("offline");
    return service.handle(input,owner,event=>handlers.get("workspace/pluginEvent")(event));
  }};
  const remote=new RemoteWorkspacePlugins({client:()=>client,authorize:async()=>{approvals++;},isAuthorized:async()=>authorized});
  const runtime=new PluginRuntime({hostEntry:fileURLToPath(new URL("../electron/main/plugin-host-process.mjs",import.meta.url)),getWorkspacePath:()=>`remote-project:${selected}`,
    isAdmissionClosed: () => false,
    resolveWorkspaceExecution:async(input={})=>{
      const context=contexts[input.sessionId??input.context?.workspaceId??selected];
      if(input.context && context!==input.context)throw Object.assign(Error("rebound"),{code:"WORKSPACE_CHANGED"});
      return context;
    },spawnWorkspaceProcess:remote.spawn.bind(remote),
    isPluginActiveInProject:()=>true,getActiveSession:()=>({sessionId:selected,projectPath:contexts[selected].roots[0].path,activeTurn:null}),
    spawnProcess:()=>{localSpawns++;throw Error("must not spawn locally");},writeClipboard:async text=>clipboard.push(text),showToast:()=>{}});
  try {
    await runtime.loadFromPath(pkg);
    assert.equal(localSpawns,0);assert.equal(approvals,0);
    const tools=await runtime.getToolsForSession("a",()=>true);
    assert.equal(tools.length,1);
    selected="b";
    const tool=await tools[0].execute({}, {sessionId:"a",mode:"agent"});
    assert.equal(tool.text,workA);
    const a=await runtime.invokePanelBridge("test.workspace","write",{text:"A"},{sessionId:"a"});
    selected="b";
    const [again,b]=await Promise.all([runtime.invokePanelBridge("test.workspace","clipboard",{}, {sessionId:"a"}),runtime.invokePanelBridge("test.workspace","write",{text:"B"},{sessionId:"b"})]);
    assert.equal(a.path,workA);assert.equal(a.cwd,workA);assert.equal(again.path,workA);assert.equal(b.path,workB);
    assert.equal(await readFile(join(workA,"result.txt"),"utf8"),"A");assert.equal(await readFile(join(workB,"result.txt"),"utf8"),"B");
    assert.deepEqual(clipboard,[workA]);assert.equal(approvals,2);assert.equal(localSpawns,0);
    await assert.rejects(runtime.invokePanelBridge("test.workspace","forbidden",{}, {sessionId:"a"}),{code:"PERMISSION_DENIED"});
    const text='SDK:字'.repeat(20000);
    const sdk=await runtime.invokePanelBridge("test.workspace","sdk",{text},{context:contexts.a});
    assert.equal(sdk.text,text);assert.deepEqual(sdk.bytes,[83,68,75,58]);assert.equal(sdk.size,Buffer.byteLength(text));
    assert.equal(await readFile(join(workA,"sdk.txt"),"utf8"),text);
    await assert.rejects(runtime.invokePanelBridge("test.workspace","fs.writeText",{path:"outside-scope.txt",content:"bad"},{context:contexts.a}),{code:"PERMISSION_DENIED"});
    await assert.rejects(runtime.invokePanelBridge("test.workspace","secret",{},{context:contexts.a}),{code:"PERMISSION_DENIED"});
    const command=await runtime.invokePanelBridge("test.workspace","exec",{},{sessionId:"a",context:contexts.a});
    assert.equal(command.code,0);
    assert.deepEqual(JSON.parse(command.stdout),{cwd:workA,args:['a b','$(literal)'],stdin:'输入🙂'});
    await assert.rejects(runtime.invokePanelBridge("test.workspace","terminalDenied",{},{sessionId:"a"}),{code:"PERMISSION_DENIED"});
    assert.equal(await runtime.invokePanelBridge("test.workspace","active",{},{sessionId:"a"}),null);
    runtime.setServices({getSessionSnapshot:async(_pluginId,sessionId)=>({sessionId,projectPath:contexts[sessionId].roots[0].path,activeTurn:null})});
    assert.equal((await runtime.invokePanelBridge("test.workspace","active",{},{sessionId:"a"})).sessionId,"a");
    assert.equal((await runtime.invokePanelBridge("test.workspace","active",{},{sessionId:"b"})).sessionId,"b");
    const pinned=contexts.b; contexts.b={...contexts.b,generation:2};
    await assert.rejects(runtime.invokePanelBridge("test.workspace","write",{text:"wrong"},{context:pinned}),{code:"WORKSPACE_CHANGED"});
    authorized=false;
    await assert.rejects(runtime.invokePanelBridge("test.workspace","write",{text:"revoked"},{sessionId:"a"}));
    assert.equal(await readFile(join(workA,"result.txt"),"utf8"),"A");
    state="disconnected";service.disconnect(owner.connectionId);for(const listener of stateListeners)listener(state);
    await assert.rejects(runtime.invokePanelBridge("test.workspace","write",{text:"bad"},{sessionId:"a"}));
    assert.equal(await readFile(join(workA,"result.txt"),"utf8"),"A");
  } finally {await runtime.disposeAll();remote.dispose();service.dispose();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
