import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";
const root=repositoryRoot();
const {build}=createRequire(join(root,"packages/agent-runtime/package.json"))("esbuild");
const temp=await mkdtemp(join(tmpdir(),"pi-todo-window-"));
const originalUrl=process.env.ELECTRON_RENDERER_URL;
process.env.ELECTRON_RENDERER_URL="http://127.0.0.1:4011/";
after(async()=>{if(originalUrl===undefined)delete process.env.ELECTRON_RENDERER_URL;else process.env.ELECTRON_RENDERER_URL=originalUrl;await rm(temp,{recursive:true,force:true});});
const stub=join(temp,"electron.mjs");
await writeFile(stub,`
import {EventEmitter} from 'node:events';
export const windows=[];
export const app={getLocale:()=> 'en'};
export const clipboard={value:'',writeText(value){this.value=value;}};
export const dialog={response:0,async showMessageBox(){return {response:this.response};}};
export const screen=Object.assign(new EventEmitter(),{getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}})});
export class BrowserWindow extends EventEmitter {
 constructor(options={}){super();this.options=options;this.visible=false;this.dead=false;this.pinned=options.alwaysOnTop;this.bounds={x:options.x??0,y:options.y??0,width:options.width??360,height:options.height??480};
 this.webContents=Object.assign(new EventEmitter(),{id:windows.length+1,mainFrame:{url:''},sent:[],isDestroyed:()=>this.dead,isCrashed:()=>false,send:(channel,payload)=>{this.webContents.sent.push({channel,payload});this.onSend?.(channel,payload);},setWindowOpenHandler:(handler)=>{this.openHandler=handler;}});windows.push(this);}
 async loadURL(url){if(BrowserWindow.loadGate)await BrowserWindow.loadGate;this.url=url;this.webContents.mainFrame.url=url;this.webContents.emit('did-finish-load');}
 setMenu(){} setVisibleOnAllWorkspaces(){} setMinimumSize(){} setResizable(value){this.resizable=value;} setBounds(bounds){this.setBoundsCalls=(this.setBoundsCalls??0)+1;this.bounds={...bounds};} getBounds(){return {...this.bounds};}
 isDestroyed(){return this.dead;} show(){this.visible=true;} showInactive(){this.visible=true;this.inactive=true;} hide(){this.visible=false;} focus(){this.focused=true;} setAlwaysOnTop(value){this.pinned=value;}
 destroy(){this.dead=true;this.emit('closed');}
 close(){let prevented=false;this.emit('close',{preventDefault(){prevented=true;}});if(!prevented)this.destroy();}
}
`);
const out=join(temp,"runtime.mjs");
await build({entryPoints:[join(root,"apps/desktop/electron/main/personal-todos/runtime.ts")],outfile:out,bundle:true,platform:"node",format:"esm",
 alias:{electron:stub,"@pi-desktop/shared":join(root,"packages/shared/src"),"@pi-desktop/i18n":join(root,"packages/i18n/src")},
 plugins:[{name:"external-test-electron",setup(b){b.onResolve({filter:/^electron$/},()=>({path:pathToFileURL(stub).href,external:true}));}}]});
const {createPersonalTodos}=await import(pathToFileURL(out).href);
const {BrowserWindow,windows,clipboard,screen}=await import(pathToFileURL(stub).href);
const channel=(name)=>`pi-desktop/personalTodos/${name}`;
let counter=0;
function fixture(){
 const main=new BrowserWindow();const handlers=new Map();const writes=[];
 let doc={schemaVersion:1,revision:0,updatedAt:null,items:[]};let fail=false;
 const runtime=createPersonalTodos({dataDir:join(temp,`profile-${++counter}`),getMainWindow:()=>main,log(){},getHost:()=>({call:async(method,input)=>{
 if(method==='settings.get')return {theme:'dark',language:'en'};
 if(method==='personalTodos.get')return doc;
 if(fail)throw Error('storage unavailable');
 doc={schemaVersion:1,revision:doc.revision+1,updatedAt:1,items:input.items};writes.push(doc);return doc;
 }})});
 runtime.register({handleWithEvent:(c,h)=>handlers.set(c,h)});
 const invoke=(name,sender,raw,frame=sender.webContents.mainFrame)=>handlers.get(channel(name))({sender:sender.webContents,senderFrame:frame},raw);
 return {main,runtime,invoke,writes,setFail:value=>{fail=value;}};
}
test('singleton native window is independent, pinned by default, and its close collapses',async()=>{
 const f=fixture();const before=windows.length;await Promise.all([f.runtime.open(false),f.runtime.open(false)]);
 const widget=windows.at(-1);assert.equal(windows.length,before+1);assert.equal(widget.pinned,true);assert.equal(widget.inactive,true);
 assert.equal(widget.options.webPreferences.sandbox,true);assert.equal(widget.options.webPreferences.contextIsolation,true);assert.equal(widget.options.webPreferences.nodeIntegration,false);
 assert.match(widget.options.webPreferences.preload,/personal-todos\.cjs$/);assert.equal(widget.options.parent,undefined);
 f.main.hide();assert.equal(widget.visible,true);
 widget.close();assert.equal(widget.dead,false);assert.equal(widget.visible,true);
 assert.equal((await f.invoke('get',widget)).collapsed,true);
 await f.invoke('window',f.main,{action:'open'});assert.equal(widget.visible,true);
 await f.invoke('window',widget,{action:'pin',value:false});assert.equal(widget.pinned,false);
 assert.deepEqual(widget.openHandler({url:'https://example.com'}),{action:'deny'});
 let denied=false;widget.webContents.emit('will-navigate',{preventDefault(){denied=true;}},'https://example.com');assert.equal(denied,true);
 f.runtime.dispose();assert.equal(widget.dead,true);assert.equal(screen.listenerCount('display-removed'),0);
});
test('only the widget main frame may edit, copy, collapse and pin',async()=>{
 const f=fixture();await f.runtime.open();const widget=windows.at(-1);const foreign=new BrowserWindow();
 const draft={items:[{id:'a',title:'ä¸­æ–‡',note:'line 1\nline 2',completed:false}],expectedEditVersion:0};
 for(const sender of [f.main,foreign])await assert.rejects(f.invoke('edit',sender,draft),{errorCode:'PERMISSION_DENIED'});
 await assert.rejects(f.invoke('edit',widget,draft,{url:widget.url}),{errorCode:'PERMISSION_DENIED'});
 await assert.rejects(f.invoke('copy',f.main,{title:'x',note:''}),{errorCode:'PERMISSION_DENIED'});
 await f.invoke('edit',widget,draft);
 await f.invoke('copy',widget,{title:'new unsaved title',note:'first\nsecond'});assert.equal(clipboard.value,'new unsaved title\n\nfirst\nsecond');
 await f.invoke('copy',widget,{title:'only title',note:''});assert.equal(clipboard.value,'only title');
 await f.invoke('flush',widget);assert.equal(f.writes.at(-1).items[0].note,'line 1\nline 2');
 widget.webContents.mainFrame.url='https://example.com';await assert.rejects(f.invoke('get',widget),{errorCode:'PERMISSION_DENIED'});
 f.runtime.dispose();
});
test('quit drains renderer edits before freezing and saving; a failed flush cancels quit',async()=>{
 const f=fixture();await f.runtime.open();const widget=windows.at(-1);
 widget.onSend=(name,payload)=>{if(name===channel('event/prepareQuit')&&payload.requestId!==null)void f.invoke('quitReady',widget,payload);};
 await f.invoke('edit',widget,{items:[{id:'a',title:'last edit',note:'note',completed:false}],expectedEditVersion:0});
 f.setFail(true);assert.equal(await f.runtime.prepareQuit(),false);
 assert.equal(widget.webContents.sent.findLast(e=>e.channel===channel('event/prepareQuit')).payload.requestId,null);
 await f.invoke('edit',widget,{items:[{id:'a',title:'retained',note:'note',completed:false}],expectedEditVersion:1});
 f.setFail(false);assert.equal(await f.runtime.prepareQuit(),true);
 assert.equal(f.writes.at(-1).items[0].title,'retained');
 await assert.rejects(f.invoke('edit',widget,{items:[],expectedEditVersion:2}),{errorCode:'HOST_UNAVAILABLE'});
 widget.close();assert.equal(widget.dead,true,'successful quit must allow the native close event');
 f.runtime.dispose();
});

test('concurrent opens wait for renderer loading before displaying the singleton',async()=>{
 const f=fixture();let release;let opens=[];
 BrowserWindow.loadGate=new Promise(resolve=>{release=resolve;});
 try {
  const first=f.runtime.open(false);const second=f.runtime.open(false);
  opens=[first,second];
  await new Promise(resolve=>setImmediate(resolve));
  const widget=windows.at(-1);
  assert.equal(widget.visible,false);
  release();await Promise.all([first,second]);
  assert.equal(widget.visible,true);
 } finally {release();await Promise.allSettled(opens);BrowserWindow.loadGate=null;f.runtime.dispose();}
});

test('repeated titlebar opens preserve expanded geometry without native resize feedback',async()=>{
 const f=fixture();
 try {
  await f.runtime.open();const widget=windows.at(-1);const bounds=widget.getBounds();
  const calls=widget.setBoundsCalls??0;
  for(let i=0;i<25;i++)await f.invoke('window',f.main,{action:'open'});
  assert.deepEqual(widget.getBounds(),bounds);
  assert.equal(widget.setBoundsCalls??0,calls,'opening an already visible board must not round-trip native bounds');
 }finally{f.runtime.dispose();}
});

test('startup docks a compact strip and collapse restores the independently remembered editor',async()=>{
 const f=fixture();
 try {
  await f.runtime.open(false);const widget=windows.at(-1);
  assert.equal((await f.invoke('get',widget)).collapsed,true);
  assert.equal(widget.getBounds().y,0);assert.ok(widget.getBounds().height<=100);
  assert.equal(widget.options.transparent,true);assert.equal(widget.options.hasShadow,false);
  await f.invoke('window',widget,{action:'open'});
  widget.bounds={x:800,y:240,width:440,height:560};
  const expanded=widget.getBounds();
  for(let i=0;i<5;i++){
   await f.invoke('window',widget,{action:'collapse'});
   assert.equal(widget.visible,true);assert.equal(widget.getBounds().y,0);
   assert.ok(widget.getBounds().height<=100);
   screen.emit('display-metrics-changed');
   assert.ok(widget.getBounds().height<=100);
   await f.invoke('window',widget,{action:'open'});
   assert.deepEqual(widget.getBounds(),expanded);
   assert.equal((await f.invoke('get',widget)).collapsed,false);
  }
 }finally{f.runtime.dispose();}
});

test('fractional-DPI native rounding does not accumulate across collapse and reopen',async()=>{
 const f=fixture();
 try {
  await f.runtime.open(false);const widget=windows.at(-1);
  widget.setBounds=function(bounds){this.bounds={...bounds,width:bounds.width+1,height:bounds.height+1};};
  await f.invoke('window',widget,{action:'open'});
  const expanded=widget.getBounds();
  for(let i=0;i<10;i++){
   await f.invoke('window',widget,{action:'collapse'});
   await f.invoke('window',widget,{action:'open'});
   assert.deepEqual(widget.getBounds(),expanded);
  }
 }finally{f.runtime.dispose();}
});
