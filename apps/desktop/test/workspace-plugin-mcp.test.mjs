import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { register, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspacePluginService } from "@pi-desktop/host-runtime";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { RemoteWorkspacePlugins } = await import("../electron/main/remote/remote-workspace-plugins.ts");
const runner = fileURLToPath(new URL("../../../packages/host-runtime/plugin-host-process.mjs", import.meta.url));
const server = `
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PI_WORKSPACE_ROOT;
fs.appendFileSync(path.join(root, 'starts'), String(process.pid)+'\\n');
const send = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 buffer+=chunk;
 let end;
 while((end=buffer.indexOf('\\n'))>=0){
  const msg=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
  if(msg.method==='initialize')send(msg.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}});
  if(msg.method==='tools/list')send(msg.id,{tools:[{name:'run',inputSchema:{type:'object'}},{name:path.basename(root),inputSchema:{type:'object'}}]});
  if(msg.method==='tools/call'){
   fs.appendFileSync(path.join(root,'calls'), '1');
   if(msg.params.arguments.wait)fs.writeFileSync(path.join(root,'waiting'),'1');
   else send(msg.id,{content:[{type:'text',text:JSON.stringify({root,cwd:process.cwd(),argv:process.argv.slice(2),token:process.env.TOKEN,secret:process.env.PI_UNDECLARED_SECRET})}]});
  }
  if(msg.method==='notifications/cancelled')fs.writeFileSync(path.join(root,'cancelled'),'1');
 }
});
`;
async function eventually(check) {
 const end=Date.now()+5000;
 let last;
 while(Date.now()<end){try {return await check();}catch(error){last=error;await new Promise(resolve=>setTimeout(resolve,10));}}
 throw last;
}

for (const placement of ["local", "remote"]) for (const companion of [false,true]) test(`${placement} ${companion?"companion":"workspace"} MCP isolates catalogs, SDK execution and cancellation`, async () => {
 const root=await mkdtemp(join(tmpdir(),'workspace-mcp-'));
 const pkg=join(root,'package'); const a=join(root,'a');const b=join(root,'b');
 await Promise.all([mkdir(pkg),mkdir(a),mkdir(b)]);
 await writeFile(join(pkg,'manifest.json'),JSON.stringify({schemaVersion:1,id:'test.workspace-mcp',name:'MCP',version:'1.0.0',main:'main.cjs',execution:companion?{main:'desktop',workspaceMain:'worker.cjs'}:{main:'workspace'},permissions:['mcp.server.local','workspace.exec','workspace.terminal','agent.tool.register'],contributes:{settings:[{key:'token',type:'string',title:'Token',default:'declared-token'}],mcpServers:[{id:'files',execution:'workspace',transport:'stdio',command:'node',args:['server.cjs','${workspaceRoot}','literal $(arg)'],env:{TOKEN:{setting:'token'}}}]}}));
 const pluginSource = `
 module.exports={onLoad:async()=>{
  await pi.agent.registerTool({name:'slow',description:'Cancellable process',schema:{type:'object'},execute:async()=>pi.workspace.exec({command:process.execPath,args:['-e',"require('node:fs').writeFileSync('slow.pid',String(process.pid));setInterval(()=>{},1000)"]})});
 },onPanelInvoke:async(channel)=>{
   if(channel==='side')return {side:'desktop',cwd:process.cwd()};
   if(channel==='forward')return pi.workspace.invoke('where');
   if(channel==='exec')return pi.workspace.exec({command:process.execPath,args:['-e','console.log(process.cwd())']});
   if(channel==='terminal'){
    const {shells}=await pi.workspace.terminal.list();
    const shell=shells.find(item=>item.id===(process.platform==='win32'?'cmd':'bash'))??shells[0];
    const opened=await pi.workspace.terminal.create({shellId:shell.id,cols:500,rows:30});
    try{
     await pi.workspace.terminal.write(opened.terminalId,(process.platform==='win32'?'set /a 734000+19':'echo $((734000+19))')+String.fromCharCode(13));
     const deadline=Date.now()+8000; let lastText='';
     while(Date.now()<deadline){
      const replay=await pi.workspace.terminal.replay(opened.terminalId,65536);
      const text=require('node:util').stripVTControlCharacters(Buffer.from(replay.data??'', 'base64').toString('utf8')).replaceAll(String.fromCharCode(13),'');
      lastText=text;
      if(text.includes('734019'))return {text,sequence:replay.sequence};
      await new Promise(resolve=>setTimeout(resolve,20));
     }
     throw Error('PTY command output did not arrive: '+JSON.stringify(lastText));
    }finally{await pi.workspace.terminal.close(opened.terminalId);}
   }
 },onWorkspaceInvoke:async()=>({side:'workspace',cwd:process.cwd(),context:await pi.workspace.getContext()})};
 `;
 await writeFile(join(pkg,'main.cjs'),pluginSource);
 await writeFile(join(pkg,'worker.cjs'),"module.exports={onWorkspaceInvoke:async()=>({side:'workspace',cwd:process.cwd(),context:await pi.workspace.getContext()})};");
 await writeFile(join(pkg,'server.cjs'),server);
 const contexts=Object.fromEntries([['a',a],['b',b]].map(([id,path])=>[id,{workspaceId:id,projectId:id,authority:placement==='remote'?{kind:'remote',hostKey:'host'}:{kind:'local'},roots:[{path,name:id,primary:true}],platform:process.platform,connectionState:'connected',generation:1}]));
 const owner={deviceId:'desktop',connectionId:'test'};const handlers=new Map();const listeners=new Set();
 const service=new WorkspacePluginService({dataDir:join(root,'host'),runner,pty:()=>createRequire(import.meta.url)('node-pty')});
 let state='connected', selected='b', localSpawns=0, nativeApprovals=0;
 const client={state:()=>state,generation:()=>1,handleServerRequest:(name,handler)=>{handlers.set(name,handler);return()=>handlers.delete(name);},subscribeState:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},request:async(method,input)=>{
  assert.equal(method,'workspace/plugin');assert.equal(state,'connected');
  return service.handle(input,owner,event=>handlers.get('workspace/pluginEvent')(event));
 }};
 const remote=new RemoteWorkspacePlugins({client:()=>client,authorize:async()=>{nativeApprovals++;}});
 const audits=[];
 const runtime=new PluginRuntime({audit:entry=>audits.push(entry),hostEntry:runner,getWorkspacePath:()=>contexts[selected].roots[0].path,spawnWorkspaceProcess:remote.spawn.bind(remote),
    isAdmissionClosed: () => false,
  resolveWorkspaceExecution:async(input={})=>{
   const ctx=contexts[input.sessionId??input.context?.workspaceId??selected];
   if(input.context && input.context!==ctx)throw Object.assign(Error('changed'),{code:'WORKSPACE_CHANGED'});
   if(state!=='connected')throw Object.assign(Error('offline'),{code:'HOST_UNAVAILABLE'});
   return ctx;
  },spawnProcess:({entry,cwd})=>{
   assert.ok(placement==='local'||companion);localSpawns++;
   const child=fork(entry,[],{cwd,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
   return {postMessage:message=>{if(child.connected)child.send(message);},onMessage:fn=>child.on('message',fn),onExit:fn=>child.on('exit',code=>fn(code??0)),kill:()=>child.kill()};
  },showToast:()=>{}});
 const oldSecret=process.env.PI_UNDECLARED_SECRET;process.env.PI_UNDECLARED_SECRET='must-not-cross';
 try {
  await runtime.loadFromPath(pkg);assert.equal(localSpawns,companion?1:0);assert.equal(nativeApprovals,0);
  if(companion){
   const desktop=await runtime.invokePanelBridge('test.workspace-mcp','side',{}, {sessionId:'a'});
   assert.equal(desktop.side,'desktop');assert.notEqual(desktop.cwd,a);
   assert.equal(nativeApprovals,0);
   const forwarded=await runtime.invokePanelBridge('test.workspace-mcp','forward',{}, {sessionId:'a'});
   assert.equal(forwarded.cwd,a);assert.equal(forwarded.context.workspaceId,'a');
  }
  const explicit=await runtime.invokePanelBridge('test.workspace-mcp','workspace.invoke',{channel:'where'},{sessionId:'a'});
  assert.equal(explicit.side,'workspace');assert.equal(explicit.cwd,a);
  const exec=await runtime.invokePanelBridge('test.workspace-mcp','exec',{}, {sessionId:'a'});
  assert.equal(exec.code,0);assert.equal(exec.stdout.trim(),a);
  const terminal=await runtime.invokePanelBridge('test.workspace-mcp','terminal',{}, {sessionId:'a'});
  assert.ok(terminal.sequence>0);
  const toolsA=await runtime.getToolsForSession('a',()=>true);
  assert.equal(toolsA.length,3,JSON.stringify(audits));
  const slow=toolsA.find(tool=>tool.name==='slow');assert.ok(slow);
  const stop=new AbortController();
  const slowCall=assert.rejects(slow.execute({}, {sessionId:'a',signal:stop.signal}));
  const slowPid=Number(await eventually(()=>readFile(join(a,'slow.pid'),'utf8')));
  stop.abort();await slowCall;
  await eventually(async()=>assert.throws(()=>process.kill(slowPid,0)));
  const runA=toolsA.find(tool=>tool.name.endsWith('_run'));assert.ok(runA);
  const first=JSON.parse((await runA.execute({}, {sessionId:'a'})).content[0].text);
  assert.equal(first.root,a);assert.equal(first.token,'declared-token');assert.equal(first.secret,undefined);
  assert.deepEqual(first.argv,[a,'literal $(arg)']);
  assert.equal(placement==='local'?first.cwd===pkg:first.cwd.startsWith(join(root,'host')),true);
  const toolsB=await runtime.getToolsForSession('b',()=>true);
  assert.ok(toolsA.some(tool=>tool.name.endsWith('_a')));assert.ok(!toolsB.some(tool=>tool.name.endsWith('_a')));
  assert.ok(toolsB.some(tool=>tool.name.endsWith('_b')));
  assert.equal(JSON.parse((await runA.execute({}, {sessionId:'b'})).content[0].text).root,b);
  await assert.rejects(runA.execute({},{}),{code:'WORKSPACE_REQUIRED'});
  const controller=new AbortController();
  const pending=runA.execute({wait:true},{sessionId:'a',signal:controller.signal});
  const rejected=assert.rejects(pending);
  await eventually(()=>readFile(join(a,'waiting'),'utf8'));
  controller.abort(); await rejected;
  await eventually(()=>readFile(join(a,'cancelled'),'utf8'));
  assert.equal(await readFile(join(a,'calls'),'utf8'),'11');
  const pids=await Promise.all([a,b].map(async path=>Number((await readFile(join(path,'starts'),'utf8')).trim())));
  if(placement==='remote'){
   state='disconnected';service.disconnect(owner.connectionId);for(const fn of listeners)fn(state);
   await assert.rejects(runA.execute({}, {sessionId:'a'}));
   assert.equal(await readFile(join(a,'calls'),'utf8'),'11');
  }
  await runtime.unload('test.workspace-mcp');
  await eventually(async()=>{for(const pid of pids)assert.throws(()=>process.kill(pid,0));});
  await assert.rejects(runA.execute({}, {sessionId:'a'}));
 } finally {
  if(oldSecret===undefined)delete process.env.PI_UNDECLARED_SECRET;else process.env.PI_UNDECLARED_SECRET=oldSecret;
  await runtime.disposeAll();remote.dispose();service.dispose();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
 }
});
