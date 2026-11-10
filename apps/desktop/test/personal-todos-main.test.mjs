import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-personal-todo-main-"));
after(() => rm(temp, { recursive: true, force: true }));
async function module(name) {
  const out = join(temp, `${name}.mjs`);
  await build({ entryPoints: [join(root, `apps/desktop/electron/main/personal-todos/${name}.ts`)],
    outfile: out, bundle: true, platform: "node", format: "esm",
    alias: { "@pi-desktop/shared": join(root, "packages/shared/src") } });
  return import(pathToFileURL(out).href);
}
const { createTodoCoordinator } = await module("coordinator");
const { createTodoActivity } = await module("activity");
const { parseItems } = await module("validation");
const { clampTodoBounds, parseTodoPreferences } = await module("geometry");
const empty = () => ({ schemaVersion: 1, revision: 0, updatedAt: null, items: [] });
const row = (title = "draft", note = "note") => ({ id: "a", title, note, completed: false });
const microtasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    set: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clear: (key) => timers.delete(key),
    async advance(ms) {
      const end = now + ms;
      await microtasks();
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await microtasks();
      }
      now = end; await microtasks();
    },
    count: () => timers.size,
  };
}
function fixture(overrides = {}) {
  const clock = fakeClock(), writes = [], events = [], gate = { closed: false };
  const activity = createTodoActivity({ isAdmissionClosed: () => gate.closed });
  let doc = empty();
  // The runtime counts every Host RPC from entry to settlement; persistence is
  // that RPC boundary here.
  const persistence = {
    get: async () => structuredClone(doc),
    replace: async (request) => {
      writes.push({ at: clock.now(), request: structuredClone(request) });
      doc = { schemaVersion: 1, revision: doc.revision + 1, updatedAt: clock.now(), items: request.items };
      return structuredClone(doc);
    }, ...overrides,
  };
  const service = createTodoCoordinator({ clock, activity, publish: (v) => events.push(v), persistence: {
    get: () => activity.track(() => persistence.get()),
    replace: (request) => activity.track(() => persistence.replace(request)),
  } });
  const edit = (items) => service.edit({ items, expectedEditVersion: service.view().editVersion });
  return { service, clock, writes, events, edit, activity, gate };
}

test("continuous typing saves within the max wait without waiting for typing to stop", async () => {
  const f = fixture(); await f.service.get();
  for (let i=0; i<120; i++) { f.edit([row(`中文草稿 ${i}`)]); await f.clock.advance(250); }
  await f.service.flush();
  assert.ok(f.writes.length >= 15);
  assert.ok(f.writes[0].at <= 2000);
  for(let i=1;i<f.writes.length;i++) assert.ok(f.writes[i].at-f.writes[i-1].at<=2000);
  assert.equal(f.service.view().document.items[0].title, "中文草稿 119");
  assert.equal(f.service.view().saveStatus, "saved");
  f.service.dispose(); assert.equal(f.clock.count(), 0);
});
test("idle saves after 500ms and immediate flush preserves blank titles and multiline notes", async () => {
  const f=fixture(); await f.service.get(); f.edit([row("", "第一行\n第二行")]);
  await f.clock.advance(499); assert.equal(f.writes.length,0);
  await f.clock.advance(1); assert.equal(f.writes.length,1);
  f.edit([row("latest")]); await f.service.flush();
  assert.equal(f.service.view().document.items[0].title,"latest");
  f.edit([]); await f.service.flush(); assert.deepEqual(f.service.view().document.items,[]);
  f.service.dispose();
});
test("an old in-flight response never marks newer edits saved", async () => {
  let release; let calls=0;
  const f=fixture({replace: async(request)=>{
    if(++calls===1) await new Promise(resolve=>{release=resolve;});
    return {schemaVersion:1,revision:calls,updatedAt:1,items:request.items};
  }});
  await f.service.get();f.edit([row("first")]);
  const flush=f.service.flush();await microtasks();
  f.edit([row("newer","unsaved latest note")]);release();await flush;
  assert.equal(calls,2);
  assert.equal(f.service.view().document.items[0].title,"newer");
  assert.ok(!f.events.some(v=>v.saveStatus==="saved" && v.savedEditVersion<v.editVersion));
  f.service.dispose();
});
test("retry keeps a failed write identity before submitting newer input",async()=>{
  const requests=[];let fail=true;
  const f=fixture({replace:async request=>{
    requests.push(structuredClone(request));
    if(fail){fail=false;throw Error("response lost");}
    return {schemaVersion:1,revision:request.expectedRevision+1,updatedAt:1,items:request.items};
  }});
  await f.service.get();f.edit([row("first")]);
  await assert.rejects(f.service.flush());
  f.edit([row("second")]);await f.service.flush();
  assert.deepEqual(requests[0],requests[1]);
  assert.notEqual(requests[1].mutationId,requests[2].mutationId);
  assert.equal(requests[2].expectedRevision,1);
  assert.equal(f.service.view().document.items[0].title,"second");f.service.dispose();
});
test("failed reads never permit an empty draft to overwrite stored content",async()=>{
  let fail=true,writes=0;
  const f=fixture({get:async()=>{if(fail)throw Error("unreadable");return {...empty(),revision:4,items:[row("stored")]};},
    replace:async()=>{writes++;return empty();}});
  await assert.rejects(f.service.get());
  assert.equal(f.service.view().saveStatus,"error");
  assert.throws(()=>f.edit([]),{errorCode:"HOST_UNAVAILABLE"});assert.equal(writes,0);
  fail=false;await f.service.get();assert.equal(f.service.view().items[0].title,"stored");f.service.dispose();
});
test("stalled storage becomes an error; stale edits and frozen quit edits are rejected",async()=>{
  const f=fixture({replace:()=>new Promise(()=>{})});await f.service.get();f.edit([row()]);
  const outcome=f.service.flush().catch(e=>e);await f.clock.advance(4000);
  assert.equal((await outcome).errorCode,"TIMEOUT");
  assert.equal(f.service.view().savedEditVersion,0);
  assert.throws(()=>f.service.edit({items:[],expectedEditVersion:0}),{errorCode:"CONFLICT"});
  f.service.freeze(true);assert.throws(()=>f.edit([]),{errorCode:"HOST_UNAVAILABLE"});
  f.service.freeze(false);f.edit([row("retained")]);f.service.dispose();
  assert.equal(f.clock.count(),0);
});
test("item validation rejects invalid identities and bounds text without discarding legal drafts",()=>{
  assert.deepEqual(parseItems([row("","中\n文")]),[row("","中\n文")]);
  for(const bad of [[row(),row()], [{...row(),completed:1}], [{...row(),extra:true}], [row("a\0")], [row("a".repeat(2001))],new Array(201).fill(row())])
    assert.throws(()=>parseItems(bad),{errorCode:"INVALID_ARGUMENT"});
});
test("saved placement stays visible after display removal and first use defaults to pin",()=>{
  assert.equal(parseTodoPreferences("{}").alwaysOnTop,true);
  assert.equal(parseTodoPreferences('{"alwaysOnTop":false}').alwaysOnTop,false);
  assert.deepEqual(clampTodoBounds({x:4000,y:-500,width:360,height:480},{x:0,y:0,width:1920,height:1080}),
    {x:1560,y:0,width:360,height:480});
  assert.deepEqual(clampTodoBounds({x:10,y:10,width:360,height:480},{x:0,y:0,width:240,height:200}),
    {x:0,y:0,width:240,height:200});
});

test("malformed response cannot enable edits over an unreadable board",async()=>{
 const f=fixture({get:async()=>({...empty(),items:[{id:"broken"}]})});
 await assert.rejects(f.service.get());
 assert.equal(f.service.view().document,null);
 assert.throws(()=>f.edit([]),{errorCode:"HOST_UNAVAILABLE"});
 f.service.dispose();
});

test("serialized size validation reserves the persisted document envelope",()=>{
 const items=Array.from({length:200},(_,i)=>({...row(),id:String(i),note:""}));
 let remaining=1048576-Buffer.byteLength(JSON.stringify(items));
 for(const item of items){const size=Math.min(remaining,20000);item.note="x".repeat(size);remaining-=size;}
 assert.equal(remaining,0);
 assert.equal(Buffer.byteLength(JSON.stringify(items)),1048576);
 assert.throws(()=>parseItems(items),{errorCode:"INVALID_ARGUMENT"});
 items[0].note=items[0].note.slice(128);
 assert.equal(parseItems(items).length,200);
});

test("a closed gate refuses the debounce write and retains the draft for the next admitted flush",async()=>{
 const f=fixture();await f.service.get();f.edit([row("gate draft")]);
 f.gate.closed=true;
 await f.clock.advance(2000);
 assert.equal(f.writes.length,0,"a closed gate must not start a Host write");
 assert.deepEqual(f.service.view().items,[row("gate draft")]);
 // One held draft plus the still-armed 5s save deadline; no Host RPC was issued.
 assert.deepEqual(f.activity.snapshot(),{operations:1,resources:1,uncontainedResources:0});
 f.gate.closed=false;
 await f.service.flush();
 assert.equal(f.writes.length,1);
 assert.equal(f.service.view().saveStatus,"saved");
 assert.deepEqual(f.activity.snapshot(),{operations:0,resources:0,uncontainedResources:0});
 f.service.dispose();
});
test("a late Host reply stays counted to settlement after the caller deadline and retries the same token",async()=>{
 const requests=[];let settle;
 const f=fixture({replace:(request)=>{
  requests.push(structuredClone(request));
  if(requests.length>1)return Promise.resolve({schemaVersion:1,revision:request.expectedRevision+1,updatedAt:1,items:request.items});
  return new Promise(resolve=>{settle=()=>resolve({schemaVersion:1,revision:request.expectedRevision+1,updatedAt:1,items:request.items});});
 }});
 await f.service.get();f.edit([row("late")]);
 const flush=f.service.flush().catch(error=>error);
 await f.clock.advance(4000);
 assert.equal((await flush).errorCode,"TIMEOUT");
 // The waiter gave up; the original RPC did not and stays counted.
 assert.deepEqual(f.activity.snapshot(),{operations:2,resources:1,uncontainedResources:0});
 settle();await microtasks();
 assert.deepEqual(f.activity.snapshot(),{operations:1,resources:1,uncontainedResources:0});
 await f.service.flush();
 assert.equal(requests.length,2);
 assert.equal(requests[1].mutationId,requests[0].mutationId,"a retry must keep its idempotency token");
 assert.equal(requests[1].expectedRevision,requests[0].expectedRevision);
 assert.deepEqual(requests[1].items,requests[0].items);
 assert.equal(f.service.view().saveStatus,"saved");
 assert.deepEqual(f.activity.snapshot(),{operations:0,resources:0,uncontainedResources:0});
 f.service.dispose();
});
test("an admitted write still settles after the gate closes while the RPC is in flight",async()=>{
 let release;
 const f=fixture({replace:request=>new Promise(resolve=>{
  release=()=>resolve({schemaVersion:1,revision:request.expectedRevision+1,updatedAt:1,items:request.items});
 })});
 await f.service.get();f.edit([row("in flight")]);
 const flush=f.service.flush();await microtasks();
 f.gate.closed=true;
 assert.deepEqual(f.activity.snapshot(),{operations:2,resources:1,uncontainedResources:0});
 release();await flush;
 assert.equal(f.service.view().saveStatus,"saved");
 assert.equal(f.service.view().document.items[0].title,"in flight");
 assert.deepEqual(f.activity.snapshot(),{operations:0,resources:0,uncontainedResources:0});
 f.service.dispose();
});
test("dispose keeps an unpersisted draft, never reports success and records the uncertainty",async()=>{
 const f=fixture();await f.service.get();f.edit([row("never written")]);
 f.service.dispose();
 assert.equal(f.service.view().saveStatus,"pending");
 assert.deepEqual(f.service.view().items,[row("never written")]);
 assert.deepEqual(f.activity.snapshot(),{operations:0,resources:0,uncontainedResources:1});
 assert.equal(f.clock.count(),0);
});
test("one flush sequence captures its owner once and uses that binding for its own read and write",async()=>{
 const clock=fakeClock(),activity=createTodoActivity({});const captured=[];const used=[];
 let revision=0;
 const base={
  get:async()=>{used.push("base.get");return {schemaVersion:1,revision,updatedAt:null,items:[]};},
  replace:async request=>{used.push("base.replace");revision=request.expectedRevision+1;
   return {schemaVersion:1,revision,updatedAt:1,items:request.items};},
  capture(){const id=captured.length;captured.push(id);
   const bound={get:async()=>{used.push(`captured${id}.get`);return {schemaVersion:1,revision,updatedAt:null,items:[]};},
    replace:async request=>{used.push(`captured${id}.replace`);revision=request.expectedRevision+1;
     return {schemaVersion:1,revision,updatedAt:1,items:request.items};},
    capture:()=>bound};
   return bound;},
 };
 const service=createTodoCoordinator({clock,activity,publish(){},persistence:base});
 await service.get();
 assert.equal(captured.length,1,"a read sequence captures exactly one owner");
 assert.equal(captured[0],0);
 service.edit({items:[row("captured")],expectedEditVersion:0});
 await service.flush();
 assert.equal(captured.length,2,"a flush sequence captures exactly one owner");
 assert.deepEqual(used,["captured0.get","captured1.replace"],
  "a sequence never falls back to the shared binding for its own I/O");
 // A queued flush that waits for the in-flight writer keeps its own capture.
 service.edit({items:[row("queued")],expectedEditVersion:1});
 const first=service.flush();
 const queued=service.flush();
 await Promise.all([first,queued]);
 // The in-flight writer picks the new edit up in its own loop iteration and
 // still uses the binding it captured; the queued sequence captured an owner
 // before awaiting and issued no I/O of its own.
 assert.deepEqual(used.slice(2),["captured2.replace"]);
 assert.equal(captured.length,4,"every public sequence captures exactly once");
 assert.equal(service.view().saveStatus,"saved");
 assert.equal(service.view().document.items[0].title,"queued");
 service.dispose();
});
