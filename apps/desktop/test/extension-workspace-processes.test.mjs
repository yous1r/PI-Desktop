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
function context(path){return{workspaceId:"work",projectId:"work",authority:{kind:"remote",hostKey:"host"},roots:[{path,name:"Work",primary:true}],platform:"linux",connectionState:"connected",generation:1};}
test("trusted extension commands reach the owning Host with literal argv while explicit helpers stay local",async()=>{
  const root=await mkdtemp(join(tmpdir(),"extension-host-"));const work=join(root,"work");await mkdir(work);
  const entry=join(root,"extension.mjs");const key=`__workspace${Date.now()}`;
  await writeFile(entry,`export default pi=>pi.registerCommand('probe',{handler:async()=>{
    const remote=await pi.exec(process.execPath,['-e','console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))','a b','$(literal)']);
    const helper=await pi.exec(process.execPath,['-p','process.cwd()'],{target:'local',cwd:${JSON.stringify(root)}});
    globalThis[${JSON.stringify(key)}]={remote,helper};
  }});`);
  const service=new WorkspaceProcessService();const owner={deviceId:"desktop",connectionId:"one"};let starts=0;const bound=context(work);
  const client={state:()=>"connected",generation:()=>1,request:async(method,input)=>{assert.equal(method,"workspace/process");if(input.action==="start")starts++;return service.handle(input,owner);}};
  const router=new ExtensionWorkspaceProcesses({current:()=>true,client:()=>client,allowed:id=>id===entry,resolve:async input=>{assert.equal(input.sessionId,"session");return bound;}});
  const runtime=new DesktopAgentRuntime({
    host:{call:async(method,input)=>method==="extensions.workspaceProcess"?router.handle(input):{},onNotification:()=>()=>{}},
    sessionId:"session",remoteWorkspace:{hostKey:"host",path:work},mode:"agent",thinkingLevel:"off",
    provider:{id:"fixture",name:"Fixture",apiKey:"",authKind:"none",baseUrl:"http://127.0.0.1:1/v1",modelId:"fixture",supportsReasoning:false,supportedThinkingLevels:["off"]},
    commandShell:{id:"bash",label:"Bash",dialect:"posix",available:true,isDefault:true},trustedExtensions:[{id:entry,entry,label:"Test",root,source:"plugin"}],onEvent:()=>{},
  });
  try{
    await runtime.loadTrustedExtensions();assert.deepEqual(await runtime.runTrustedExtensionCommand("probe",""),{handled:true});
    const result=globalThis[key];assert.deepEqual(JSON.parse(result.remote.stdout),{cwd:work,args:["a b","$(literal)"]});
    assert.equal(result.remote.code,0);assert.equal(result.helper.stdout.trim(),root);assert.equal(starts,1);
  }finally{await runtime.dispose();router.dispose();service.dispose();delete globalThis[key];await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("extension handles reject other sessions, rebound connections and cancellation during admission",async()=>{
  const bound=context("/work");let resolve;let blocked=true;let generation=1;const sent=[];
  const client={state:()=>"connected",generation:()=>generation,request:async(method,input)=>{sent.push(input);return{processId:input.processId,ok:true};}};
  const router=new ExtensionWorkspaceProcesses({current:()=>true,client:()=>client,allowed:()=>true,resolve:()=>blocked?new Promise(done=>resolve=done):Promise.resolve(bound)});
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
  }finally{router.dispose();}
});

test("idle extension processes close on disable without replay on a replacement connection",async()=>{
 const bound=context("/work");let allowed=true;const requests=[];
 const client={state:()=>"connected",generation:()=>1,request:async(_method,input)=>{requests.push(input);return{processId:input.processId};}};
 const router=new ExtensionWorkspaceProcesses({current:()=>true,client:()=>client,allowed:()=>allowed,resolve:async()=>bound});
 try{
  await router.handle({sessionId:"s",extensionId:"e",workspace:{hostKey:"host",path:"/work"},request:{action:"start",processId:"idle",input:{command:"node",args:[]}}});
  allowed=false;await router.revalidate();
  assert.deepEqual(requests.map(item=>item.action),["start","close"]);
 }finally{router.dispose();}
});
