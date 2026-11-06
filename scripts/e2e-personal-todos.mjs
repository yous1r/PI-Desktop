#!/usr/bin/env node
/** Real production Desktop, narrow preload and Host against a disposable profile. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
const root=repositoryRoot();
const {appDir,mainPath}=assertDesktopBuild(root);
const {electronBinary}=resolveElectronBinary(root);
const binary=resolveHostBinary();
const temp=await mkdtemp(join(process.env.PI_SCRATCH_DIR||tmpdir(),"pi-todo-e2e-"));
const dataDir=join(temp,"data"),profile=join(temp,"profile"),testHome=join(temp,"home");
await mkdir(testHome,{recursive:true});
await mkdir(profile,{recursive:true});
const fixture=join(temp,"main.cjs");
let child, output="", connections=[];
let expectedTitle="",expectedNote="";
async function waitFor(fn,label,timeout=20000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const result=await fn();if(result)return result;await delay(30);}
 throw Error(`Timed out: ${label}; ${output.slice(-1500)}`);
}
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
await writeFile(fixture,`
const {app,BrowserWindow,clipboard,screen}=require('electron');
app.setPath('appData',${JSON.stringify(profile)});
app.setPath('home',${JSON.stringify(testHome)});
app.setPath('userData',${JSON.stringify(profile)});
process.on('message',async message=>{
 try {
  const windows=BrowserWindow.getAllWindows();
  const todo=windows.find(w=>w.webContents.getURL().includes('surface=personal-todos'));
  const main=windows.find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.getURL().includes('surface='));
  let value;
  if(message.action==='inspect')value={count:windows.filter(w=>w.webContents.getURL().includes('surface=personal-todos')).length,visible:todo?.isVisible(),pinned:todo?.isAlwaysOnTop(),bounds:todo?.getBounds(),workArea:todo?screen.getDisplayMatching(todo.getBounds()).workArea:null,clipboard:clipboard.readText()};
  else if(message.action==='hideMain'){main?.hide();value=true;}
  else if(message.action==='closeTodo'){todo?.close();value=true;}
  else if(message.action==='forceExit'){value=true;setImmediate(()=>app.exit(1));}
  else if(message.action==='quit'){value=true;process.env.PI_DESKTOP_CAPTURE='1';setImmediate(()=>app.quit());}
  else throw Error('Unknown fixture action');
  process.send?.({id:message.id,value});
 }catch(error){process.send?.({id:message.id,error:String(error)});}
});
import(${JSON.stringify(pathToFileURL(mainPath).href)}).catch(error=>{console.error(error);app.exit(1);});
`);
let requestId=0;
function command(action){const id=++requestId;return new Promise((resolve,reject)=>{
 const listener=message=>{if(message.id!==id)return;clearTimeout(timer);child.off('message',listener);message.error?reject(Error(message.error)):resolve(message.value);};
 const timer=setTimeout(()=>{child.off('message',listener);reject(Error(`Fixture timeout ${action}`));},10000);
 child.on('message',listener);child.send({id,action});
});}
async function connect(url){
 const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 const pending=new Map();let id=0;
 ws.onmessage=event=>{const m=JSON.parse(event.data);const entry=pending.get(m.id);if(!entry)return;pending.delete(m.id);clearTimeout(entry.timer);m.error?entry.reject(Error(JSON.stringify(m.error))):entry.resolve(m.result);};
 function send(method,params={}){return new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error(`CDP timeout ${method}`));},10000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});}
 const api={close:()=>ws.close(),send,async eval(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;},
 async click(selector){await send("Page.bringToFront");const point=await api.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!e.contains(hit))throw Error('Covered target '+JSON.stringify({selector:${JSON.stringify(selector)},x,y,hit:hit?.outerHTML,body:document.body.innerText}));return {x,y};})()`);for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});},
 async fill(selector,text){
  await api.click(selector);
  await api.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();})()`);
  await send('Input.insertText',{text});
},
 async view(){return api.eval(`window.piDesktop.invoke('pi-desktop/personalTodos/get').then(r=>{if(!r.ok)throw Error(r.error.message);return r.data;})`);}};
 connections.push(api);return api;
}
async function launch(){
 const port=await freePort();const env={...process.env,PI_DESKTOP_DATA_DIR:dataDir,PI_DESKTOP_HOST_BIN:binary,PI_DESKTOP_CAPTURE:'0',PI_DESKTOP_BOOT_PROBE:'0',PI_DESKTOP_SUPERVISION_PROBE:'0',USERPROFILE:testHome,PI_DESKTOP_AGENTS_DIR:join(testHome,'.agents'),PI_DESKTOP_MCP_CONTROL:'0',ELECTRON_RENDERER_URL:'',PI_DESKTOP_START_MAXIMIZED:'0'};delete env.ELECTRON_RUN_AS_NODE;
 output='';child=spawn(electronBinary,[`--remote-debugging-port=${port}`,fixture],{cwd:appDir,env,stdio:['ignore','pipe','pipe','ipc']});
 child.once('error',error=>{output+=String(error);});
 child.stdout.on('data',d=>{output=(output+d).slice(-12000);});child.stderr.on('data',d=>{output=(output+d).slice(-12000);});
 const targets=await waitFor(async()=>{try{const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(500)});const list=await response.json();return list.some(t=>t.url.includes('surface=personal-todos'))&&list.some(t=>t.url.includes('renderer/index.html')&&!t.url.includes('surface='))?list:null;}catch{return null;}},'both production windows',45000);
 const widget=await connect(targets.find(t=>t.url.includes('surface=personal-todos')).webSocketDebuggerUrl);
 const main=await connect(targets.find(t=>t.url.includes('renderer/index.html')&&!t.url.includes('surface=')).webSocketDebuggerUrl);
 await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-expand'))`),'compact widget ready');
 return {widget,main};
}
async function quit(){const exited=once(child,'exit');await command('quit');await Promise.race([exited.then(([code])=>assert.equal(code,0)),delay(45000,undefined,{ref:false}).then(()=>{throw Error('Normal quit timed out');})]);for(const c of connections)c.close();connections=[];child=null;}
async function readDisk(){const host=new Host(binary,dataDir,{quiet:true,env:{PI_DESKTOP_AGENTS_DIR:join(testHome,'.agents')}});try{await host.start();return await host.call('personalTodos.get',{});}finally{await host.stop();}}
try{
 const seed=new Host(binary,dataDir,{quiet:true,env:{PI_DESKTOP_AGENTS_DIR:join(testHome,'.agents')}});try{await seed.start();await seed.call('settings.set',{language:'en',theme:'dark',updatePreference:'manual'});await seed.call('session.create',{title:'Todo toolbar layout',mode:'agent'});}finally{await seed.stop();}
 let {widget,main}=await launch();
 let native=await command('inspect');assert.equal(native.count,1);assert.equal(native.visible,true);assert.equal(native.pinned,true);
 assert.ok(native.bounds.height<=100);assert.equal(native.bounds.y,native.workArea.y);
 await widget.click('.personal-todos-expand');
 await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-add:not(:disabled)'))`),'expanded editor ready');
 const expandedBounds=(await command('inspect')).bounds;
 await waitFor(()=>main.eval(`Boolean(document.querySelector('.app-personal-todos-toggle'))`),'titlebar entry');
 await waitFor(()=>main.eval(`Boolean(document.querySelector('[data-sidebar-session-row]'))`),'test session row');
 await main.click('[data-sidebar-session-row]');
 await waitFor(()=>main.eval(`Boolean(document.querySelector('.app-work-panel-toggle:not(:disabled)'))`),'session toolbar');
 if(await main.eval(`Boolean(document.querySelector('.conversation-topbar.ct-work-panel-open'))`)){
  await main.click('.app-work-panel-toggle');
  await waitFor(()=>main.eval(`!document.querySelector('.conversation-topbar.ct-work-panel-open')`),'initial panel closed');
 }
 const toolbarGeometry=()=>main.eval(`(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);const entry=document.querySelector('.ct-actions .app-personal-todos-toggle');if(!entry)throw Error('Todo entry is outside the toolbar');const buttons=[...entry.parentElement.querySelectorAll('button')],prior=buttons[buttons.indexOf(entry)-1];return {entry:entry.getBoundingClientRect().x,prior:prior.getBoundingClientRect().x};})()`);
 const closedToolbar=await toolbarGeometry();
 await main.click('.app-work-panel-toggle');
 await waitFor(()=>main.eval(`Boolean(document.querySelector('.conversation-topbar.ct-work-panel-open'))`),'work panel opened');
 await waitFor(()=>main.eval(`Boolean(document.querySelector('.work-panel-header'))`),'work panel content ready');
 const openToolbar=await waitFor(async()=>{const position=await toolbarGeometry();return position.entry<closedToolbar.entry-50?position:null;},'toolbar follows resized chat pane');
 assert.ok(openToolbar.entry<closedToolbar.entry-50,'todo entry moves left with the toolbar when the panel opens: '+JSON.stringify({closedToolbar,openToolbar}));
 assert.ok(Math.abs((openToolbar.entry-closedToolbar.entry)-(openToolbar.prior-closedToolbar.prior))<=1,'toolbar neighbors move together');
 await main.click('.app-work-panel-toggle');
 await waitFor(()=>main.eval(`!document.querySelector('.conversation-topbar.ct-work-panel-open')`),'work panel closed');
 await toolbarGeometry();
 await main.click('[data-nav="settings"]');
 await waitFor(()=>main.eval(`Boolean(document.querySelector('.settings-mode')&&document.querySelector('[data-nav="back-to-app"]')?.checkVisibility())`),'settings route ready');
 assert.equal(await main.eval(`[...document.querySelectorAll('.app-personal-todos-toggle')].some(e=>e.checkVisibility())`),false,'settings does not leave a floating todo entry');
 await main.click('[data-nav="back-to-app"]');
 await waitFor(()=>main.eval(`Boolean(document.querySelector('.ct-actions .app-personal-todos-toggle')?.checkVisibility())`),'toolbar restored');
 for(let i=0;i<20;i++)await main.click('.app-personal-todos-toggle');
 assert.deepEqual((await command('inspect')).bounds,expandedBounds,'repeated titlebar clicks must not grow the window');
 const colors=[];
 for(const theme of ['light','dark']){
  const result=await main.eval(`window.piDesktop.invoke('pi-desktop/settings/set',{theme:${JSON.stringify(theme)}})`);
  assert.equal(result.ok,true);
  await waitFor(()=>widget.eval(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`),'widget theme '+theme);
  const style=await widget.eval(`(()=>{const s=getComputedStyle(document.querySelector('.personal-todos'));return {background:s.backgroundColor,border:s.borderTopWidth,radius:s.borderRadius,shadow:s.boxShadow,body:getComputedStyle(document.body).backgroundColor};})()`);
  assert.equal(style.border,'1px');assert.notEqual(style.radius,'0px');assert.notEqual(style.shadow,'none');assert.equal(style.body,'rgba(0, 0, 0, 0)');colors.push(style.background);
 }
 assert.notEqual(colors[0],colors[1]);
 await widget.click('.personal-todos-add');await waitFor(()=>widget.eval(`document.querySelectorAll('.personal-todo-row').length===1`),'added row');
 expectedTitle='计划与验收';expectedNote='单条备注第一行\n第二行：完整复制';
 await widget.fill('.personal-todo-title',expectedTitle);await widget.click('.personal-todo-note-toggle');await widget.fill('.personal-todo-note',expectedNote);
 await widget.click('.personal-todo-actions button:first-child');await waitFor(async()=>(await command('inspect')).clipboard===`${expectedTitle}\n\n${expectedNote}`,'native clipboard');
 const start=Date.now();await waitFor(async()=>{const v=await widget.view();return v.saveStatus==='saved'&&v.document.items[0]?.note===expectedNote;},'durable save within 5 seconds',5000);assert.ok(Date.now()-start<5000);
 // Input is paced only to simulate continued typing; commits are awaited by state.
 await widget.click('.personal-todo-title');let firstRevision=(await widget.view()).document.revision;
 for(let i=0;i<20;i++){await widget.send('Input.insertText',{text:'文'});await delay(200);}
 await waitFor(async()=>(await widget.view()).document.revision>firstRevision,'continued typing committed',1000);
 expectedTitle=await widget.eval(`document.querySelector('.personal-todo-title').value`);
 await widget.click('.personal-todo-note-toggle');await widget.click('.personal-todo-actions button:first-child');
 await waitFor(async()=>(await command('inspect')).clipboard===`${expectedTitle}\n\n${expectedNote}`,'collapsed note copy');
 await widget.click('.personal-todo-check input');await waitFor(async()=>(await widget.view()).items[0]?.completed===true,'complete row');
 await widget.click('.personal-todos-add');await waitFor(()=>widget.eval(`document.querySelectorAll('.personal-todo-row').length===2`),'second row');
 await widget.click('.personal-todo-row:last-child .personal-todo-delete');await waitFor(()=>widget.eval(`document.querySelectorAll('.personal-todo-row').length===1`),'delete row');
 await widget.click('.personal-todos-toolbar button:last-child');
 await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-summary'))`),'collapse to strip');
 native=await command('inspect');assert.equal(native.visible,true);assert.ok(native.bounds.height<=100);assert.equal(native.bounds.y,native.workArea.y);
 const summary=await widget.eval(`(()=>{const e=document.querySelector('.personal-todos-summary');const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {text:e.textContent,width:r.width,height:r.height,lineHeight:parseFloat(s.lineHeight),overflow:s.textOverflow,whiteSpace:s.whiteSpace,scrollWidth:e.scrollWidth};})()`);
 assert.equal(summary.text,expectedTitle);assert.ok(summary.width<=100);assert.ok(summary.height<=summary.lineHeight+1);assert.equal(summary.overflow,'ellipsis');assert.equal(summary.whiteSpace,'nowrap');assert.ok(summary.scrollWidth>summary.width);
 await widget.click('.personal-todos-expand');
 await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-add'))`),'reopen via strip');
 for(let i=0;i<5;i++){
  await widget.click('.personal-todos-toolbar button:last-child');
  await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-expand'))`),'compact cycle');
  await main.click('.app-personal-todos-toggle');
  await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-add'))`),'expanded cycle');
  assert.deepEqual((await command('inspect')).bounds,expandedBounds,'collapse/open must restore the same expanded geometry');
 }
 await command('hideMain');native=await command('inspect');assert.equal(native.visible,true);assert.equal(native.pinned,true);
 await widget.click('.personal-todos-toolbar button:first-child');await waitFor(async()=>!(await command('inspect')).pinned,'unpin');
 expectedTitle='退出前最后一次编辑';await widget.fill('.personal-todo-title',expectedTitle);await quit();
 let disk=await readDisk();assert.equal(disk.items.length,1);assert.equal(disk.items[0].title,expectedTitle);assert.equal(disk.items[0].note,expectedNote);assert.equal(disk.items[0].completed,true);
 ({widget,main}=await launch());native=await command('inspect');assert.equal(native.visible,true);assert.equal(native.pinned,false);assert.equal(native.count,1);
 assert.ok(native.bounds.height<=100);
 await widget.click('.personal-todos-expand');
 await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todo-title'))`),'restored editor');
 assert.deepEqual((await command('inspect')).bounds,expandedBounds,'restart preserves expanded geometry');
 assert.equal(await widget.eval(`document.querySelector('.personal-todo-title').value`),expectedTitle);
 await command('closeTodo');await waitFor(()=>widget.eval(`Boolean(document.querySelector('.personal-todos-expand'))`),'native close docks strip');await quit();
 ({widget}=await launch());assert.equal((await command('inspect')).visible,true);await quit();
 console.log('PASS: real Electron/Host personal todos: compact startup, stable repeated opens/collapse/restart, one-line summary, light/dark surface, edit, notes, clipboard, continuous save, complete/delete, pin, immediate quit.');
} catch(error){console.error(error);console.error(output.slice(-6000));process.exitCode=1;}
finally{for(const c of connections)c.close();if(child&&child.exitCode===null){const exited=once(child,'exit');await command('forceExit').catch(()=>child.kill());await Promise.race([exited,delay(5000,undefined,{ref:false})]);}await rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:250});}
