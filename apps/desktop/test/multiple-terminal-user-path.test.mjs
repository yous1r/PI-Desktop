import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, terminalWorkspaceId } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { terminalWorkPanelTab } from "../../apps/desktop/src/lib/work-panel-tabs";
import { terminalHandleFor, forgetAllTerminalHandles } from "../../apps/desktop/src/lib/terminal-sessions";
import { switchWorkPanelSession } from "../../apps/desktop/src/stores/slices/work-panel-slice";
import { remoteEn } from "../../apps/desktop/src/locales/remote";
await i18n.use(initReactI18next).init({lng:"en",keySeparator:false,
 resources:{en:{translation:flattenCatalog(catalogs.en),remote:remoteEn}},interpolation:{escapeValue:false}});
const calls=[], unexpected=[], listeners=new Map(), live=new Map();
let sequence=0, holdNext=false, releaseCreate;
window.piDesktop={platform:"win32",channels:IPC,on(channel,handler){
 const handlers=listeners.get(channel)??new Set();handlers.add(handler);listeners.set(channel,handlers);return()=>handlers.delete(handler);
},async invoke(channel,input){
 calls.push({channel,input});let data;
 switch(channel){
 case IPC.invoke.terminalListShells:data={shells:[{id:"bash",label:"Bash",family:"bash",isDefault:true}]};break;
 case IPC.invoke.terminalCreate:{
  if(input.target.sessionId?.startsWith("remote:")&&live.size>=2)return{ok:false,error:{code:"RATE_LIMITED",message:"terminal limit reached for this session"}};
  const terminalId="shell-"+(++sequence);live.set(terminalId,input.target);
  if(holdNext){holdNext=false;await new Promise(resolve=>{releaseCreate=resolve;});}
  data={terminalId,shellId:input.shellId,cols:input.cols,rows:input.rows};break;
 }
 case IPC.invoke.terminalReplay:data={data:live.has(input.terminalId)?btoa("ready "+input.terminalId+"\r\n"):null,sequence:1};break;
 case IPC.invoke.terminalClose:live.delete(input.terminalId);data={ok:true};break;
 case IPC.invoke.terminalWrite:case IPC.invoke.terminalResize:data={ok:true};break;
 case IPC.invoke.fsList:data={entries:[]};break;
 case IPC.invoke.workspaceDiff:data={files:[],truncated:false};break;
 default:unexpected.push(channel);throw Error("Unexpected IPC "+channel);
 }return{ok:true,data};
}};
const view=createRoot(document.getElementById("root"));
const check=(value,message)=>{if(!value)throw Error(message);};
const frame=()=>new Promise(requestAnimationFrame);
const until=async(predicate,message)=>{for(let n=0;n<240;n++){if(predicate())return;await frame();}throw Error(message+" body="+document.body.textContent);};
const button=label=>[...document.querySelectorAll("button")].find(node=>node.getAttribute("aria-label")===label);
const click=node=>{check(node,"Button missing");flushSync(()=>node.click());};
const state=()=>useAppStore.getState();
const tabs=()=>state().workPanelTabs.filter(tab=>tab.kind==="terminal");
const ready=()=>until(()=>{
 const tab=tabs().find(tab=>tab.id===state().activeWorkPanelTabId);
 return tab&&terminalHandleFor(tab.id)&&document.querySelector(".terminal-tab__status")?.textContent==="";
},"terminal never became ready");
const render=()=>flushSync(()=>view.render(<WorkPanel containerWidth={900} />));
const hide=()=>flushSync(()=>view.render(null));
const activate=id=>click([...document.querySelectorAll('[role="tab"]')].find(node=>node.id.endsWith(id)));
window.multiTerminalProbe=async()=>{
 const results=[];
 for(const kind of ["local","ssh-workspace","remote-session"]){
  hide();forgetAllTerminalHandles();live.clear();calls.length=0;
  const id=kind==="remote-session"?"remote:host:chat":kind;
  const workspace=kind==="local"?{path:"C:/repo",name:"Repo"}:{path:"remote-project:project",name:"Repo",remote:{hostKey:"host",path:"/repo"}};
  const session={id,title:"Test",mode:"agent",status:"idle",permissionMode:"ask",...(kind==="remote-session"?{source:"remote",remoteHostKey:"host",remoteHostLabel:"Server",remoteWorkspace:{hostKey:"host",path:"/repo"},capabilities:{canReadWorkspace:true}}:{projectPath:workspace.path})};
  useAppStore.setState({sessions:[session],activeSessionId:id,workspace,workPanelOpen:true,workPanelTabs:[],activeWorkPanelTabId:null,workPanelContexts:{},workPanelWidth:380,workPanelFileRequest:null,pluginViews:[]});
  if(kind!=="remote-session")state().openWorkPanelTab(terminalWorkPanelTab({sessionId:id,workspaceId:terminalWorkspaceId({hostKey:workspace.remote?.hostKey,path:workspace.path})}));
  render();
  if(kind==="remote-session")click([...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="Terminal"));
  await ready();const first=tabs()[0];const firstShell=terminalHandleFor(first.id).terminalId;
  click(button("New terminal"));await ready();const second=tabs()[1];const secondShell=terminalHandleFor(second.id).terminalId;
  click(button("New terminal"));let thirdShell;
  if(kind==="remote-session"){
   await until(()=>document.querySelector(".terminal-tab__status")?.textContent.includes("terminal limit reached"),"Host limit was not shown");
   check(live.size===2,"Failed creation changed live terminals");click(button("Close terminal"));await ready();
  }else{
   await ready();thirdShell=terminalHandleFor(tabs()[2].id).terminalId;
   check(new Set([firstShell,secondShell,thirdShell]).size===3,"Terminals reused one shell");
   check(live.size===3,"Switching tabs ended a shell");
  }
  const remaining=thirdShell?2:1;
  await Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})));
  for(const label of ["New terminal","Close terminal"]){const rect=button(label).getBoundingClientRect();check(rect.width>0&&rect.left>=0&&rect.right<=innerWidth,"Terminal action clipped: "+kind+" "+label+" "+JSON.stringify(rect.toJSON()));}
  activate(first.id);await ready();
  check(terminalHandleFor(first.id).terminalId===firstShell,"Switching recreated a shell");
  if(kind==="remote-session"){
   document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));
   await ready();check(state().activeWorkPanelTabId===second.id,"Keyboard did not switch remote terminals");activate(first.id);await ready();
  }
  const textarea=document.querySelector(".xterm-helper-textarea");textarea.focus();
  textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"x",code:"KeyX",keyCode:88,which:88,bubbles:true,cancelable:true}));
  await until(()=>calls.some(call=>call.channel===IPC.invoke.terminalWrite&&call.input.terminalId===firstShell&&call.input.data==="x"),"Input missed its active shell");
  const closeSecond=[...document.querySelectorAll("button")].find(node=>node.getAttribute("aria-label")==="Close Terminal 2");
  click(closeSecond);
  await until(()=>!live.has(secondShell),"Closing inactive terminal did not close its process");
  check(live.has(firstShell)&&(!thirdShell||live.has(thirdShell)),"Closing one terminal affected another");
  check(state().activeWorkPanelTabId===first.id,"Closing inactive terminal changed selection");
  hide();render();
  if(kind==="remote-session")click([...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="Terminal"));
  await ready();check(tabs().length===remaining&&live.size===remaining,"Panel remount lost terminal tabs");
  const other={id:"other",title:"Other",mode:"agent",status:"idle",permissionMode:"ask"};
  hide();useAppStore.setState(current=>({...switchWorkPanelSession(current,other.id),activeSessionId:other.id,sessions:[session,other]}));
  useAppStore.setState(current=>({...switchWorkPanelSession(current,id),activeSessionId:id}));render();
  if(kind==="remote-session")click([...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="Terminal"));
  await ready();check(tabs().length===remaining&&live.size===remaining,"Session switch discarded a terminal");
  for(const terminal of [...tabs()]){activate(terminal.id);await ready();click(button("Close terminal"));}
  await until(()=>live.size===0,"Closing all terminals leaked a process");
  check(tabs().length===0,"Last closed terminal stayed in the panel");
  hide();render();
  if(kind==="remote-session"){
   click([...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="Terminal"));await frame();await frame();
   check(tabs().length===0&&live.size===0,"Empty terminal panel reopened a shell automatically");
   click(button("New terminal"));
  }else{
   click([...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="Terminal"));
  }
  await ready();
  holdNext=true;releaseCreate=undefined;click(button("New terminal"));
  await until(()=>releaseCreate,"Delayed terminal creation was not requested");
  const pendingShell="shell-"+sequence;click(button("Close terminal"));releaseCreate();
  await until(()=>!live.has(pendingShell),"Late creation leaked the closed terminal");
  await ready();click(button("Close terminal"));await until(()=>live.size===0,"Final shell leaked");
  check(calls.filter(call=>call.channel===IPC.invoke.terminalCreate).every(call=>call.input.target.sessionId===id),"Terminal escaped owning session");
  check(unexpected.length===0,"Unexpected IPC: "+unexpected.join(","));
  results.push(kind);
 }
 hide();return{passed:true,paths:results};
};
`;

test("users create, switch and individually close local and remote terminals", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "multiple-terminal-ui-"));
  try {
    await build({stdin:{contents:fixture,resolveDir:join(root,"scripts/e2e"),loader:"tsx"},
      plugins:[{name:"url-assets",setup(plugin){plugin.onResolve({filter:/\?url$/},({path})=>({path,namespace:"asset"}));plugin.onLoad({filter:/.*/,namespace:"asset"},()=>({contents:'export default "fixture-asset"',loader:"js"}));}}],
      loader:{".css":"empty",".png":"dataurl",".gif":"dataurl"},
      outfile:join(temp,"renderer.js"),bundle:true,platform:"browser",format:"esm",jsx:"automatic",
      define:{"process.env.NODE_ENV":'"production"',"import.meta.env.DEV":"false"},
      alias:{"@pi-desktop/shared":join(root,"packages/shared/src"),"@pi-desktop/i18n":join(root,"packages/i18n/src"),
        react:join(root,"apps/desktop/node_modules/react"),"react-dom":join(root,"apps/desktop/node_modules/react-dom"),
        i18next:join(root,"apps/desktop/node_modules/i18next"),"react-i18next":join(root,"apps/desktop/node_modules/react-i18next")},
      nodePaths:[join(root,"apps/desktop/node_modules")]});
    const xtermCss=await readFile(join(root,"apps/desktop/node_modules/@xterm/xterm/css/xterm.css"),"utf8");
    const remoteCss=await readFile(join(root,"apps/desktop/src/styles/remote-mvp.css"),"utf8");
    await writeFile(join(temp,"styles.css"),(await loadStyles()).replace(/@theme(?: inline)?\s*\{/g,":root {")+remoteCss+xtermCss+'\nhtml,body,#root{height:100%;margin:0}#root{display:flex;justify-content:flex-end}');
    await writeFile(join(temp,"index.html"),'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp,"main.cjs"),`
const {app,BrowserWindow,session}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_d,done)=>done({cancel:true}));
 const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(...args)=>console.log('RENDERER',args[0].message??args[2]??''));
 try{await win.loadFile(path.join(__dirname,'index.html'));console.log('MULTI_TERMINAL '+JSON.stringify(await win.webContents.executeJavaScript('window.multiTerminalProbe()')));app.exit(0);}
 catch(error){console.error(error.stack);app.exit(1);}
});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(resolveElectronBinary(root).electronBinary,[join(temp,"main.cjs")],{env,stdio:["ignore","pipe","pipe"]});
    let output="";for(const stream of [child.stdout,child.stderr]){stream.setEncoding("utf8");stream.on("data",chunk=>output+=chunk);}
    const timer=setTimeout(()=>child.kill("SIGKILL"),45_000);
    let code;try{code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});}finally{clearTimeout(timer);}
    assert.equal(code,0,output.slice(-10000));
    assert.match(output,/MULTI_TERMINAL .*"passed":true/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
