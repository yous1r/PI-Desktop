import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WorkspaceResources } = await import("../electron/main/remote/workspace-resources.ts");
const { WorkspacePluginFiles } = await import("../../../packages/host-runtime/src/workspace-plugin-files.ts");

async function setup() {
 const root=await mkdtemp(join(tmpdir(),"workspace-resource-"));const workspace=join(root,"remote");await mkdir(workspace);
 const context={workspaceId:"a",projectId:"a",authority:{kind:"remote",hostKey:"host-a"},roots:[{path:workspace,primary:true,name:"a"}],platform:process.platform,generation:1,connectionState:"connected"};
 let connected=true;let url;let opened;let revealed;let picker;let transfer;
 const files=new WorkspacePluginFiles({root:workspace,protectedRoot:join(root,"host"),permissions:["fs.read"],manifest:{permissions:["fs.read"],fs:{read:{scope:["**"]}}},active:()=>connected});
 const resources=new WorkspaceResources({isAdmissionClosed:()=>false,chooseCopy:async input=>{picker=input;return join(root,input.name);},openCopy:async path=>{opened=path;},openBrowser:async(value,session)=>{assert.equal(session,"session-a");url=value;},reveal:async(path,session)=>{revealed={path,session};}});
 const input={ownerId:"plugin-a",pluginName:"Files",context,sessionId:"session-a",validate:async()=>{if(!connected)throw Error("disconnected");},read:async(api,args)=>{const value=await files.call(api,args);await transfer?.(api,args);return value;}};
 return {root,workspace,resources,input,get url(){return url;},get opened(){return opened;},get revealed(){return revealed;},get picker(){return picker;},disconnect:()=>{connected=false;},onRead:fn=>{transfer=fn;},dispose:async()=>{resources.dispose();await rm(root,{recursive:true,force:true});}};
}

test("remote HTML and relative resources stay inside a bounded, owner-scoped HTTP preview",async()=>{
 const state=await setup();
 try{
  await writeFile(join(state.workspace,"index.html"),'<link href="style.css" rel="stylesheet"><h1>Remote</h1>');
  await writeFile(join(state.workspace,"style.css"),'body { color: green; }');
  await writeFile(join(state.workspace,".env"),'secret');
  await state.resources.open({...state.input,path:"index.html",api:"fs.openInBrowser"});
  const response=await fetch(state.url);assert.equal(response.status,200);assert.match(await response.text(),/Remote/);
  assert.equal(response.headers.get("cache-control"),"no-store");assert.match(response.headers.get("content-security-policy"),/connect-src 'self'/);
  assert.match(await (await fetch(new URL("style.css",state.url))).text(),/green/);
  assert.equal((await fetch(new URL(".env",state.url))).status,404);
  assert.equal((await fetch(new URL("%2e%2e%2foutside",state.url))).status,404);
  assert.equal(await new Promise((resolve,reject)=>{const req=request(state.url,{headers:{Host:"attacker.invalid"}},res=>{res.resume();resolve(res.statusCode);});req.on("error",reject);req.end();}),404);
  assert.equal((await fetch(state.url,{method:"POST"})).status,404);
  await state.resources.open({...state.input,path:"index.html",api:"fs.reveal"});
  assert.deepEqual(state.revealed,{path:join(state.workspace,"index.html"),session:"session-a"});
  state.disconnect();assert.equal((await fetch(state.url)).status,404);
  state.resources.closeOwner("plugin-a");await assert.rejects(fetch(state.url));
 }finally{await state.dispose();}
});

test("downloaded copies use bounded ranges, preserve remote content and never overwrite Desktop files",async()=>{
 const state=await setup();
 try{
  const content=Buffer.alloc(2*1024*1024+11,255);await writeFile(join(state.workspace,"image.bin"),content);
  const lengths=[];state.onRead((api,args)=>{if(api==='fs.readRange')lengths.push(args[2]);});
  await state.resources.open({...state.input,path:"image.bin",api:"fs.openDefault"});
  assert.deepEqual(await readFile(state.opened),content);assert.equal(state.picker.hostKey,"host-a");assert.equal(lengths.length,3);assert.ok(lengths.every(n=>n<=1024*1024));
  await writeFile(state.opened,"local edit");await assert.rejects(state.resources.open({...state.input,path:"image.bin",api:"fs.openDefault"}),{code:"EEXIST"});
  assert.equal(await readFile(state.opened,"utf8"),"local edit");assert.deepEqual(await readFile(join(state.workspace,"image.bin")),content);
  state.resources.closeOwner("plugin-a");assert.equal(await readFile(state.opened,"utf8"),"local edit");
 }finally{await state.dispose();}
});

test("disconnect, changed content and revoked admission never expose a partial local copy",async()=>{
 for(const mode of ['disconnect','changed','revoked']){
  const state=await setup();
  try{
   await writeFile(join(state.workspace,"sample.txt"),"original");
   state.onRead(async(api)=>{if(api!=="fs.readRange")return;state.onRead(null);if(mode==='disconnect')state.disconnect();else if(mode==='revoked')state.resources.closeOwner("plugin-a");else await writeFile(join(state.workspace,"sample.txt"),"different length");});
   await assert.rejects(state.resources.open({...state.input,path:"sample.txt",api:"fs.openDefault"}));
   assert.equal(state.opened,undefined);await assert.rejects(access(join(state.root,"sample.txt")));
  }finally{await state.dispose();}
 }
});
