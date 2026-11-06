import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { IPC } from "../../../packages/shared/dist/protocol.js";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";
const root=repositoryRoot();
const {build}=createRequire(join(root,"packages/agent-runtime/package.json"))("esbuild");
test("sandbox preload only exposes the personal todo capability set and cleans subscriptions",async()=>{
 const result=await build({entryPoints:[join(root,"apps/desktop/electron/preload/personal-todos.ts")],bundle:true,write:false,format:"cjs",platform:"node",external:["electron"]});
 let bridge;const listeners=new Map(),calls=[];
 const electron={contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,"piDesktop");bridge=value;}},ipcRenderer:{
 invoke:async(...args)=>{calls.push(args);return {ok:true,data:{}};},on:(channel,fn)=>listeners.set(channel,fn),removeListener:(channel,fn)=>{assert.equal(listeners.get(channel),fn);listeners.delete(channel);}}};
 vm.runInNewContext(result.outputFiles[0].text,{require:(name)=>{assert.equal(name,"electron","no secondary CommonJS chunks in a sandbox");return electron;},process:{platform:"win32",argv:["--pi-desktop-locale=zh-CN"]}});
 for(const [name,value] of Object.entries(IPC.invoke).filter(([key])=>key.startsWith("personalTodos")))await bridge.invoke(value,{test:name});
 assert.equal(calls.length,6);
 for(const channel of [IPC.invoke.settingsGet,IPC.invoke.fsRead,IPC.invoke.browserNavigate,'electron/unsafe'])assert.throws(()=>bridge.invoke(channel));
 let observed;const remove=bridge.on(IPC.event.personalTodosChanged,value=>{observed=value;});
 listeners.get(IPC.event.personalTodosChanged)({sender:"hidden"},{revision:1});assert.deepEqual(observed,{revision:1});remove();assert.equal(listeners.size,0);
 assert.throws(()=>bridge.on(IPC.event.agentMessage,()=>{}));assert.equal(bridge.platform,"win32");assert.equal(bridge.locale,"zh-CN");
});
