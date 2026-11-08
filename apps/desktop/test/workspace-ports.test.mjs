import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs",import.meta.url));
const {WorkspacePorts,forwardWorkspacePort}=await import("../electron/main/remote/workspace-ports.ts");
const context={workspaceId:'w',projectId:'p',authority:{kind:'remote',hostKey:'host'},roots:[{path:'/work',name:'work',primary:true}],platform:'linux',connectionState:'connected',generation:1};
test('workspace port previews keep session ownership and close the exact forward on unload',async()=>{
 let closed=0;const opened=[];
 const ports=new WorkspacePorts({isAdmissionClosed:()=>false,connect:async(ctx,port)=>{assert.equal(ctx,context);assert.equal(port,3000);return{url:'http://127.0.0.1:43123',close:async()=>{closed++;}};},openBrowser:async(url,session)=>{opened.push({url,session});}});
 const input={ownerId:'plugin',context,sessionId:'origin',port:3000,path:'/app?q=1',validate:async()=>{}};
 try{
  const result=await ports.open(input);assert.deepEqual(opened,[{url:'http://127.0.0.1:43123/app?q=1',session:'origin'}]);assert.equal(result.url,opened[0].url);
  for(const path of ['//evil.invalid','/\\evil.invalid','relative'])await assert.rejects(ports.open({...input,path}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(ports.open({...input,port:22}),{code:'INVALID_ARGUMENT'});
  ports.closeOwner('plugin');assert.equal(closed,1);
 }finally{ports.dispose();}
});
test('a cancelled forward admission closes the late result and never opens a browser',async()=>{
 let admit;let closed=0;let opened=0;
 const ports=new WorkspacePorts({isAdmissionClosed:()=>false,connect:()=>new Promise(resolve=>{admit=resolve;}),openBrowser:async()=>{opened++;}});
 const pending=ports.open({ownerId:'plugin',context,sessionId:'origin',port:3000,validate:async()=>{}});const failed=assert.rejects(pending,{code:'PLUGIN_GONE'});
 await new Promise(resolve=>setImmediate(resolve));ports.closeOwner('plugin');admit({url:'http://127.0.0.1:40000',close:async()=>{closed++;}});await failed;
 assert.equal(closed,1);assert.equal(opened,0);ports.dispose();
});
test('direct peers and the paired Host control port cannot become workspace previews',async()=>{
 const client={state:()=>"connected",generation:()=>1};
 const boot={workspaceClient:()=>client,registry:{list:async()=>[{hostKey:'host'}]}};
 const owner={assertCurrent:()=>{},nativeAttempt:()=>{}};
 await assert.rejects(forwardWorkspacePort(boot,context,3000,owner),{code:'CAPABILITY_UNAVAILABLE'});
 boot.registry.list=async()=>[{hostKey:'host',metadata:{transport:'ssh',ssh:{host:'test.invalid',remotePort:3000,version:'test'}}}];
 await assert.rejects(forwardWorkspacePort(boot,context,3000,owner),{code:'PERMISSION_DENIED'});
});
