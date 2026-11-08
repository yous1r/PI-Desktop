import assert from "node:assert/strict";
import test from "node:test";
import { fork, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspacePluginService } from "@pi-desktop/host-runtime";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { RemoteWorkspacePlugins } = await import("../electron/main/remote/remote-workspace-plugins.ts");
const { WorkspaceResources } = await import("../electron/main/remote/workspace-resources.ts");
const runner=fileURLToPath(new URL("../../../packages/host-runtime/plugin-host-process.mjs",import.meta.url));
const fm=fileURLToPath(new URL("../resources/plugins/pi.file-manager",import.meta.url));
const gitPlugin=process.env.PI_GIT_PLUGIN_PATH;
const git=(root,...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
async function fixture(placement){
 const root=await mkdtemp(join(tmpdir(),"workspace-user-path-"));const a=join(root,"a");const b=join(root,"b");const data=join(root,"desktop");
 await Promise.all([mkdir(a),mkdir(b),mkdir(join(data,"scratch","a"),{recursive:true})]);
 const oldData=process.env.PI_DESKTOP_DATA_DIR;process.env.PI_DESKTOP_DATA_DIR=data;
 const contexts=Object.fromEntries([['a',a],['b',b]].map(([id,path])=>[id,{workspaceId:id,projectId:id,authority:placement==='remote'?{kind:'remote',hostKey:'host'}:{kind:'local'},roots:[{path,name:id,primary:true}],platform:process.platform,connectionState:'connected',generation:1}]));
 const owner={deviceId:'desktop',connectionId:'test'};const handlers=new Map();const listeners=new Set();let state='connected';let opened;let browser;let revealed;
 const service=new WorkspacePluginService({dataDir:join(root,'host'),runner});
 const client={state:()=>state,generation:()=>1,handleServerRequest:(name,handler)=>{handlers.set(name,handler);return()=>handlers.delete(name);},subscribeState:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},request:async(method,input)=>{assert.equal(method,'workspace/plugin');assert.equal(state,'connected');return service.handle(input,owner,event=>handlers.get('workspace/pluginEvent')(event));}};
 const remote=new RemoteWorkspacePlugins({client:()=>client,authorize:async()=>{}});
 const resources=new WorkspaceResources({chooseCopy:async()=>join(root,'download.txt'),openCopy:async path=>{opened=path;},openBrowser:async(url,sessionId)=>{browser={url,sessionId};},reveal:async(path,sessionId)=>{revealed={path,sessionId};}});
 const runtime=new PluginRuntime({hostEntry:runner,getWorkspacePath:()=>b,spawnWorkspaceProcess:remote.spawn.bind(remote),isWorkspaceExecutionAvailable:remote.available.bind(remote),
    isAdmissionClosed: () => false,
  resolveWorkspaceExecution:async(input={})=>{const context=contexts[input.sessionId??input.context?.workspaceId??'b'];if(state!=='connected')throw Object.assign(Error('offline'),{code:'HOST_UNAVAILABLE'});if(input.context && input.context!==context)throw Object.assign(Error('changed'),{code:'WORKSPACE_CHANGED'});return context;},
  spawnProcess:({entry,cwd})=>{const child=fork(entry,[],{cwd,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});return {postMessage:message=>{if(child.connected)child.send(message);},onMessage:fn=>child.on('message',fn),onExit:fn=>child.on('exit',code=>fn(code??0)),kill:()=>child.kill()};},showToast:()=>{},
  openWorkspaceResource:input=>resources.open(input),closeWorkspaceResources:id=>resources.closeOwner(id),disposeWorkspaceResources:()=>resources.dispose()});
 return {root,a,b,data,runtime,contexts,get opened(){return opened;},get browser(){return browser;},get revealed(){return revealed;},
  invoke:(id,channel,payload={},ctx={sessionId:'a',context:contexts.a})=>runtime.invokePanelBridge(id,channel,payload,ctx),
  disconnect:()=>{state='disconnected';service.disconnect(owner.connectionId);for(const fn of listeners)fn(state);},
  dispose:async()=>{await runtime.disposeAll();remote.dispose();service.dispose();resources.dispose();if(oldData===undefined)delete process.env.PI_DESKTOP_DATA_DIR;else process.env.PI_DESKTOP_DATA_DIR=oldData;await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};
}
for(const placement of ['local','remote'])test(`${placement} bundled File Manager edits its owning workspace and keeps local attachments on Desktop`,{timeout:60000},async()=>{
 const s=await fixture(placement);const call=(channel,payload,ctx)=>s.invoke('pi.file-manager',channel,payload,ctx);
 try{
  await writeFile(join(s.a,'文 件.txt'),'original');await writeFile(join(s.b,'文 件.txt'),'other workspace');await writeFile(join(s.a,'.env'),'secret');
  await s.runtime.loadFromPath(fm);
  const hello=await call('fm.hello');assert.equal(hello.ok,true);assert.equal(hello.root.path,s.a);assert.equal(hello.root.remote,undefined);
  const polled=await call('workspace.get');assert.equal(polled.path,hello.root.path);assert.equal(polled.remote,undefined);
  const read=await call('fm.read',{path:'文 件.txt'});assert.equal(read.text,'original');
  const saved=await call('fm.write',{path:'文 件.txt',text:'saved remotely',expectedMtimeMs:read.mtimeMs,expectedSize:read.size});assert.equal(saved.ok,true,JSON.stringify(saved));
  assert.equal(await readFile(join(s.a,'文 件.txt'),'utf8'),'saved remotely');assert.equal(await readFile(join(s.b,'文 件.txt'),'utf8'),'other workspace');
  const conflict=await call('fm.write',{path:'文 件.txt',text:'bad overwrite',expectedMtimeMs:read.mtimeMs,expectedSize:read.size});assert.equal(conflict.code,'CONFLICT');
  assert.equal((await call('fm.read',{path:'.env'})).ok,false);assert.equal((await call('fm.read',{path:'../b/文 件.txt'})).ok,false);
  for(const name of ['../escape','..','CON','a/b','a\b'])assert.equal((await call('fm.create',{parent:'',name})).code,'INVALID_NAME');
  const created=await call('fm.create',{parent:'',name:'new.txt',kind:'file'});assert.equal(created.ok,true,JSON.stringify(created));
  const renamed=await call('fm.rename',{path:'new.txt',newName:'renamed.txt'});assert.equal(renamed.ok,true,JSON.stringify(renamed));
  assert.ok((await call('fm.search',{query:'renamed'})).matches.some(hit=>hit.path==='renamed.txt'));
  assert.equal((await call('fm.delete',{path:'renamed.txt'})).ok,true);await assert.rejects(access(join(s.a,'renamed.txt')));
  const local=join(s.data,'scratch','a','attachment.txt');await writeFile(local,'local attachment');
  const grant=s.runtime.createLocalResourceGrant(local,'a');assert.ok(grant);
  const ctx={sessionId:'a',context:s.contexts.a,localResource:grant};
  assert.equal((await call('fm.read',{path:local,external:true},ctx)).text,'local attachment');
  assert.equal((await call('fm.write',{path:local,external:true,text:'local saved'},ctx)).ok,true);assert.equal(await readFile(local,'utf8'),'local saved');
  assert.equal((await call('fm.read',{path:join(s.b,'文 件.txt'),external:true},ctx)).ok,false);
  assert.equal((await call('fm.read',{path:local,external:true})).ok,false);
  const remoteExternal=await call('workspace.invoke',{channel:'fm.read',payload:{path:local,external:true}});
  if(placement==='remote')assert.equal(remoteExternal.code,'PERMISSION_DENIED');
  if(placement==='remote'){
   assert.deepEqual((await call('fm.editors')).editors,[]);
   await call('fs.openDefault',{path:'文 件.txt'});assert.equal(await readFile(s.opened,'utf8'),'saved remotely');
   await call('fs.reveal',{path:'文 件.txt'});assert.deepEqual(s.revealed,{path:join(s.a,'文 件.txt'),sessionId:'a'});
   await writeFile(join(s.a,'index.html'),'<h1>remote HTML</h1>');await call('fs.openInBrowser',{path:'index.html'});assert.equal(s.browser.sessionId,'a');assert.match(await (await fetch(s.browser.url)).text(),/remote HTML/);
   s.disconnect();await assert.rejects(call('fm.write',{path:'文 件.txt',text:'must not replay'}));assert.equal(await readFile(join(s.a,'文 件.txt'),'utf8'),'saved remotely');
  }
 }finally{await s.dispose();}
});
for(const placement of ['local','remote'])test(`${placement} actual Git plugin stages a hunk and commits in the originating repository`,{timeout:60000,skip:!gitPlugin&&'Set PI_GIT_PLUGIN_PATH to the candidate Git plugin'},async()=>{
 const s=await fixture(placement);const id='io.github.liushunqiu.pi-idea-git';const call=(channel,payload,ctx)=>s.invoke(id,channel,payload,ctx);
 try{
  for(const root of [s.a,s.b]){git(root,'init','-q','-b','main');git(root,'config','user.name','Workspace Test');git(root,'config','user.email','workspace@example.invalid');git(root,'config','core.autocrlf','false');await writeFile(join(root,'f.txt'),'base\n');git(root,'add','f.txt');git(root,'commit','-qm','base');}
  await writeFile(join(s.a,'f.txt'),'changed\n');await s.runtime.loadFromPath(gitPlugin);
  const diff=await call('git/diff',{path:'f.txt',mode:'worktree'});assert.equal(diff.ok,true,JSON.stringify(diff));assert.equal(diff.root.replaceAll('\\','/'),s.a.replaceAll('\\','/'));
  const wrong=await call('git/apply-patch',{action:'stage',patch:diff.text,root:diff.root,workspaceIdentity:diff.workspaceIdentity},{sessionId:'b',context:s.contexts.b});assert.equal(wrong.code,'STALE_REPOSITORY');assert.equal(git(s.b,'diff','--cached'),'');
  const staged=await call('git/apply-patch',{action:'stage',patch:diff.text,root:diff.root,workspaceIdentity:diff.workspaceIdentity});assert.equal(staged.ok,true,JSON.stringify(staged));assert.match(git(s.a,'diff','--cached'),/changed/);
  const committed=await call('git/commit',{message:'workspace integration'});assert.equal(committed.ok,true,JSON.stringify(committed));assert.equal(git(s.a,'log','-1','--format=%s'),'workspace integration');assert.equal(git(s.b,'log','-1','--format=%s'),'base');
  await writeFile(join(s.a,'new file.txt'),'new');assert.equal((await call('git/stage',{paths:['new file.txt']})).ok,true);assert.match(git(s.a,'diff','--cached','--name-only'),/new file.txt/);
  s.disconnect();await assert.rejects(call('git/commit',{message:'must not replay'}));assert.equal(git(s.a,'log','-1','--format=%s'),'workspace integration');
 }finally{await s.dispose();}
});

for(const companion of [false,true])test(`resident service placement and tool precedence (${companion?'companion':'workspace'})`,async()=>{
 const s=await fixture('local');const pkg=join(s.root,'service-package');const log=join(s.root,'service-events');await mkdir(pkg);
 const id='test.service-placement';
 const source=side=>`const fs=require('node:fs');module.exports={onLoad:async()=>{
  pi.services.register({id:'watcher',start:async()=>fs.appendFileSync(${JSON.stringify(log)},'start:'+${JSON.stringify(side)}+'\\n'),stop:async()=>fs.appendFileSync(${JSON.stringify(log)},'stop:'+${JSON.stringify(side)}+'\\n')});
  await pi.agent.registerTool({name:'same',description:'Placement',schema:{type:'object'},execute:async()=>({side:${JSON.stringify(side)},cwd:process.cwd()})});
 }};`;
 await writeFile(join(pkg,'manifest.json'),JSON.stringify({schemaVersion:1,id,name:'Services',version:'1.0.0',main:'main.cjs',execution:companion?{main:'desktop',workspaceMain:'worker.cjs'}:{main:'workspace'},permissions:['background.service','agent.tool.register'],contributes:{services:[{id:'watcher',label:'Watcher'}]}}));
 await writeFile(join(pkg,'main.cjs'),source(companion?'desktop':'workspace'));await writeFile(join(pkg,'worker.cjs'),source('workspace'));
 try{
  await s.runtime.loadFromPath(pkg);
  const tools=await s.runtime.getToolsForSession('a',()=>true);assert.equal(tools.length,1);assert.equal((await tools[0].execute({},{sessionId:'a'})).side,'workspace');
  await s.runtime.getToolsForSession('b',()=>true);
  const statuses=s.runtime.getServiceStates();assert.equal(statuses.length,companion?1:2);assert.ok(statuses.every(item=>item.state==='running'));
  if(!companion){assert.deepEqual(statuses.map(item=>item.workspaceId).sort(),['a','b']);assert.notEqual(statuses[0].instanceId,statuses[1].instanceId);}
  await s.runtime.unload(id);assert.equal(s.runtime.getServiceStates().length,0);
  const events=(await readFile(log,'utf8')).trim().split('\n');assert.equal(events.filter(line=>line.startsWith('start:')).length,companion?1:2);assert.equal(events.filter(line=>line.startsWith('stop:')).length,companion?1:2);
 }finally{await s.dispose();}
});

for(const mode of ['legacy-host','denied'])test(`File Manager falls back to scoped remote reads for ${mode}`,{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'workspace-fallback-'));const remoteRoot=join(root,'remote');const data=join(root,'desktop');await mkdir(remoteRoot);await mkdir(data);
 await writeFile(join(remoteRoot,'note.txt'),'legacy bytes');const oldData=process.env.PI_DESKTOP_DATA_DIR;process.env.PI_DESKTOP_DATA_DIR=data;
 const context={workspaceId:'p',projectId:'p',authority:{kind:'remote',hostKey:'host'},roots:[{path:remoteRoot,name:'remote',primary:true}],platform:process.platform,connectionState:'connected',generation:1};
 let prompts=0;const workspacePath='remote-project:p';
 const client={state:()=>'connected',generation:()=>1,handleServerRequest:()=>()=>{},subscribeState:()=>()=>{},request:async()=>{if(mode==='legacy-host')throw Object.assign(Error('old'),{code:'CAPABILITY_UNAVAILABLE'});return{ok:true};}};
 const remote=new RemoteWorkspacePlugins({client:()=>client,isAuthorized:async()=>false,authorize:async()=>{prompts++;throw Object.assign(Error('denied'),{code:'PERMISSION_DENIED'});}});
 const runtime=new PluginRuntime({hostEntry:runner,getWorkspacePath:()=>workspacePath,resolveWorkspaceExecution:async()=>context,spawnWorkspaceProcess:remote.spawn.bind(remote),isWorkspaceExecutionAvailable:remote.available.bind(remote),forgetWorkspacePluginDecisions:id=>remote.forget(id),
    isAdmissionClosed: () => false,
  spawnProcess:({entry,cwd})=>{const child=fork(entry,[],{cwd,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});return {postMessage:message=>{if(child.connected)child.send(message);},onMessage:fn=>child.on('message',fn),onExit:fn=>child.on('exit',code=>fn(code??0)),kill:()=>child.kill()};},
  getWorkspaceInfo:()=>({path:workspacePath,name:'remote',projectId:'p',roots:[{path:workspacePath,name:'remote',primary:true}],remote:{hostKey:'host',path:remoteRoot,readOnly:true}}),
  readRemoteWorkspaceFiles:async request=>{assert.equal(request.workspacePath,workspacePath);const {createWorkspacePluginFiles}=await import('../../pi-host/src/plugin-workspace-files.ts');return createWorkspacePluginFiles({browseRoot:root,protectedPaths:[data]}).read({path:remoteRoot,operation:request.operation,ref:request.ref,scope:request.scope});},showToast:()=>{}});
 try{
  await runtime.loadFromPath(fm);const ctx={sessionId:'s',context};
  const page=await runtime.invokePanelBridge('pi.file-manager','workspace.get',{},ctx);assert.equal(page.path,workspacePath);assert.equal(page.remote.readOnly,true);
  for(let i=0;i<3;i++){const read=await runtime.invokePanelBridge('pi.file-manager','fm.read',{path:'note.txt'},ctx);assert.equal(read.text,'legacy bytes');assert.equal(read.readOnly,true);}
  assert.equal((await runtime.invokePanelBridge('pi.file-manager','fm.write',{path:'note.txt',text:'bad'},ctx)).code,'REMOTE_READ_ONLY');
  assert.equal(prompts,mode==='denied'?1:0);assert.equal(await readFile(join(remoteRoot,'note.txt'),'utf8'),'legacy bytes');
 }finally{await runtime.disposeAll();remote.dispose();if(oldData===undefined)delete process.env.PI_DESKTOP_DATA_DIR;else process.env.PI_DESKTOP_DATA_DIR=oldData;await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
