import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceProcessService } from "@pi-desktop/host-runtime";
import { DesktopAgentRuntime } from "@pi-desktop/agent-runtime";
register(new URL("./helpers/ts-import-hooks.mjs",import.meta.url));
const { ExtensionWorkspaceProcesses }=await import("../electron/main/remote/extension-workspace-processes.ts");
const { DesktopHandoffAdmission }=await import("../electron/main/runtime/handoff-admission.ts");
function context(path){return{workspaceId:"work",projectId:"work",authority:{kind:"remote",hostKey:"host"},roots:[{path,name:"Work",primary:true}],platform:"linux",connectionState:"connected",generation:1};}
test("trusted extension commands reach the owning Host with literal argv while explicit helpers stay local",async t=>{
  const root=await mkdtemp(join(tmpdir(),"extension-host-"));const work=join(root,"work");await mkdir(work);
  const entry=join(root,"extension.mjs");const key=`__workspace${Date.now()}`;
  await writeFile(entry,`export default pi=>pi.registerCommand('probe',{handler:async()=>{try{
    const remote=await pi.exec(process.execPath,['-e','console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))','a b','$(literal)']);
    const helper=await pi.exec(process.execPath,['-p','process.cwd()'],{target:'local',cwd:${JSON.stringify(root)}});
    globalThis[${JSON.stringify(key)}]={remote,helper};
  }catch(error){globalThis[${JSON.stringify(key)}]={error:{code:error.code??error.errorCode,message:error.message}};}}});`);
  const admission=new DesktopHandoffAdmission();
  const empty={clients:0,turns:0,queuedTurns:0,plans:0,tools:0,processes:0,terminals:0,plugins:0,admissions:0,finalizations:0,writes:0,children:0,workers:0,schedules:0,approvals:0,inputs:0,nativeSessions:0,mcp:0,uncontainedResources:0};
  const service=new WorkspaceProcessService({env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,HOME:root,USERPROFILE:root,TEMP:root,TMP:root}});
  const owner={deviceId:"desktop",connectionId:"one"};let starts=0;const bound=context(work);const exits=[];
  const host={generation:"local",isAvailable:()=>true};const cleanupErrors=[];
  const client={state:()=>"connected",generation:()=>1,request:async(method,input)=>{assert.equal(method,"workspace/process");if(input.action==="start")starts++;const result=await service.handle(input,owner);if(input.action==="read"&&result.exit)exits.push(result.exit);return result;}};
  const router=new ExtensionWorkspaceProcesses({isAdmissionClosed:()=>admission.isClosed(),getHost:()=>host,onCleanupError:()=>cleanupErrors.push("cleanup"),current:()=>true,client:()=>client,allowed:id=>id===entry,resolve:async input=>{assert.equal(input.sessionId,"session");return bound;}});
  const runtime=new DesktopAgentRuntime({
    host:{call:async(method,input)=>method==="extensions.workspaceProcess"?router.handle(input):{},onNotification:()=>()=>{}},
    sessionId:"session",remoteWorkspace:{hostKey:"host",path:work},mode:"agent",thinkingLevel:"off",
    provider:{id:"fixture",name:"Fixture",apiKey:"",authKind:"none",baseUrl:"http://127.0.0.1:1/v1",modelId:"fixture",supportsReasoning:false,supportedThinkingLevels:["off"]},
    commandShell:{id:"bash",label:"Bash",dialect:"posix",available:true,isDefault:true},trustedExtensions:[{id:entry,entry,label:"Test",root,source:"plugin"}],onEvent:()=>{},
  });
  try{
    await runtime.loadTrustedExtensions();const hold=await admission.gate.acquireHandoff("process-user-path",async()=>empty);
    assert.deepEqual(await runtime.runTrustedExtensionCommand("probe",""),{handled:true});assert.equal(globalThis[key].error.code,"HOST_BUSY");assert.equal(starts,0);
    hold.cancel();assert.deepEqual(await runtime.runTrustedExtensionCommand("probe",""),{handled:true});
    const result=globalThis[key];assert.deepEqual(JSON.parse(result.remote.stdout),{cwd:work,args:["a b","$(literal)"]});
    assert.equal(result.remote.code,0);assert.equal(result.helper.code,0);assert.equal(result.helper.stdout.trim(),root);assert.equal(starts,1);
    assert.deepEqual(router.getHandoffActivity(),{operations:0,resources:0,uncontainedResources:1});assert.deepEqual(cleanupErrors,[]);assert.equal(service.inUse(),0);
    assert.ok(exits.length>0);assert.ok(exits.every(exit=>exit.code===0&&!exit.signal));
    await assert.rejects(admission.gate.acquireHandoff("after-process",async()=>({...empty,uncontainedResources:router.getHandoffActivity().uncontainedResources})),{code:"HOST_BUSY"});
    t.diagnostic(JSON.stringify({kind:"extension-process-user-path",gateRefusedBeforeStart:true,starts,workspaceExitConfirmed:true,helperExitCode:result.helper.code,serviceInUse:service.inUse(),activity:router.getHandoffActivity(),nativeFamilyQualified:false}));
  }finally{admission.dispose();await runtime.dispose();router.dispose();service.dispose();delete globalThis[key];await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("extension handles reject other sessions, rebound connections and cancellation during admission",async()=>{
  const bound=context("/work");let resolve;let blocked=true;let generation=1;const sent=[];
  const host={generation:"local",isAvailable:()=>true};const cleanupErrors=[];
  const client={state:()=>"connected",generation:()=>generation,request:async(method,input)=>{sent.push(input);return{processId:input.processId,ok:true};}};
  const router=new ExtensionWorkspaceProcesses({isAdmissionClosed:()=>false,getHost:()=>host,onCleanupError:()=>cleanupErrors.push("cleanup"),current:()=>true,client:()=>client,allowed:()=>true,resolve:()=>blocked?new Promise(done=>resolve=done):Promise.resolve(bound)});
  const base={sessionId:"session",extensionId:"extension",workspace:{hostKey:"host",path:"/work"}};
  const call=request=>router.handle({...base,request});
  try{
    const pending=call({action:"start",processId:"cancelled",input:{command:"node",args:[]}});
    await call({action:"cancel",processId:"cancelled"});resolve(bound);
    await assert.rejects(pending,{code:"TOOL_ABORTED"});assert.equal(sent.length,0);
    blocked=false;await call({action:"start",processId:"active",input:{command:"node",args:[]}});
    await assert.rejects(router.handle({...base,sessionId:"other",request:{action:"read",processId:"active"}}),{code:"FORBIDDEN"});
    generation=2;await assert.rejects(call({action:"write",processId:"active",data:"bad"}),{code:"HOST_UNAVAILABLE"});
    assert.equal(sent.filter(input=>input.action==="write").length,0);
    await assert.rejects(call({action:"read",processId:"active"}),{code:"PROCESS_GONE"});
    assert.deepEqual(cleanupErrors,["cleanup"]);
  }finally{router.dispose();}
});

test("idle extension processes close on disable without replay on a replacement connection",async()=>{
 const bound=context("/work");let allowed=true;const requests=[];const host={generation:"local",isAvailable:()=>true};const cleanupErrors=[];
 const client={state:()=>"connected",generation:()=>1,request:async(_method,input)=>{requests.push(input);return input.action==="start"?{processId:input.processId}:{ok:true};}};
 const router=new ExtensionWorkspaceProcesses({isAdmissionClosed:()=>false,getHost:()=>host,onCleanupError:()=>cleanupErrors.push("cleanup"),current:()=>true,client:()=>client,allowed:()=>allowed,resolve:async()=>bound});
 try{
  await router.handle({sessionId:"s",extensionId:"e",workspace:{hostKey:"host",path:"/work"},request:{action:"start",processId:"idle",input:{command:"node",args:[]}}});
  allowed=false;await router.revalidate();
  assert.deepEqual(requests.map(item=>item.action),["start","close"]);
  assert.deepEqual(cleanupErrors,[]);
 }finally{router.dispose();}
});
