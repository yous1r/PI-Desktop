import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-todo-handoff-"));
const originalUrl = process.env.ELECTRON_RENDERER_URL;
process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:4013/";
after(async () => {
  if (originalUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
  else process.env.ELECTRON_RENDERER_URL = originalUrl;
  await rm(temp, { recursive: true, force: true });
});
const stub = join(temp, "electron.mjs");
await writeFile(stub, `
import {EventEmitter} from 'node:events';
export const windows=[];
export const app={getLocale:()=> 'en'};
export const clipboard={value:'',writeText(value){this.value=value;}};
export const dialog={response:0,calls:0,async showMessageBox(){this.calls++;return {response:this.response};}};
export const screen=Object.assign(new EventEmitter(),{getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}})});
export class BrowserWindow extends EventEmitter {
 constructor(options={}){super();this.options=options;this.visible=false;this.dead=false;this.pinned=options.alwaysOnTop;this.bounds={x:options.x??0,y:options.y??0,width:options.width??360,height:options.height??480};
 this.webContents=Object.assign(new EventEmitter(),{id:windows.length+1,mainFrame:{url:''},sent:[],isDestroyed:()=>this.dead,isCrashed:()=>false,send:(channel,payload)=>{this.webContents.sent.push({channel,payload});this.onSend?.(channel,payload);},setWindowOpenHandler:(handler)=>{this.openHandler=handler;}});windows.push(this);}
 async loadURL(url){if(BrowserWindow.loadGate)await BrowserWindow.loadGate;this.url=url;this.webContents.mainFrame.url=url;this.webContents.emit('did-finish-load');}
 static loadGate=null;
 setMenu(){} setVisibleOnAllWorkspaces(){} setMinimumSize(){} setResizable(value){this.resizable=value;} setBounds(bounds){this.bounds={...bounds};} getBounds(){return {...this.bounds};}
 isDestroyed(){return this.dead;} show(){this.visible=true;} showInactive(){this.visible=true;} hide(){this.visible=false;} focus(){} setAlwaysOnTop(value){this.pinned=value;}
 destroy(){this.dead=true;this.emit('closed');}
 close(){let prevented=false;this.emit('close',{preventDefault(){prevented=true;}});if(!prevented)this.destroy();}
}
`);
const out = join(temp, "runtime.mjs");
await build({ entryPoints: [join(root, "apps/desktop/electron/main/personal-todos/runtime.ts")], outfile: out, bundle: true,
  platform: "node", format: "esm",
  alias: { electron: stub, "@pi-desktop/shared": join(root, "packages/shared/src"), "@pi-desktop/i18n": join(root, "packages/i18n/src") },
  plugins: [{ name: "external-test-electron", setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: pathToFileURL(stub).href, external: true })); } }] });
const { createPersonalTodos } = await import(pathToFileURL(out).href);
const { BrowserWindow, windows, dialog } = await import(pathToFileURL(stub).href);

const channel = (name) => `pi-desktop/personalTodos/${name}`;
const microtasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const empty = () => ({ schemaVersion: 1, revision: 0, updatedAt: null, items: [] });
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
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await microtasks();
      }
      now = end; await microtasks();
    },
    count: () => timers.size,
  };
}
let counter = 0;
function fixture() {
  const main = new BrowserWindow();
  const clock = fakeClock();
  const handlers = new Map();
  const calls = [];
  const gate = { closed: false };
  const policy = { failReplace: false, holdReplace: null, holdSettings: null };
  const docs = new Map();
  const available = { A: true, B: true };
  const mutationLabels = [];
  function makeHost(label) {
    return {
      generation: `generation-${label}`,
      isAvailable: () => available[label],
      async call(method, params) {
        calls.push({ method, host: label, params: params === undefined ? undefined : structuredClone(params) });
        if (method === "settings.get") {
          if (policy.holdSettings) await policy.holdSettings.promise;
          return { theme: "dark", language: "en" };
        }
        if (method === "personalTodos.get") return structuredClone(docs.get(label) ?? empty());
        if (policy.holdReplace) await policy.holdReplace.promise;
        if (policy.failReplace) { policy.failReplace = false; throw Error("response lost"); }
        const current = docs.get(label) ?? empty();
        const document = { schemaVersion: 1, revision: current.revision + 1, updatedAt: clock.now(), items: params.items };
        docs.set(label, document);
        return structuredClone(document);
      },
    };
  }
  const hosts = { A: makeHost("A"), B: makeHost("B") };
  let current = hosts.A;
  const runtime = createPersonalTodos({
    dataDir: join(temp, `profile-${++counter}`), getMainWindow: () => main, log() {},
    isAdmissionClosed: () => gate.closed, getHost: () => current, clock,
    mutationId: () => { const id = `mutation-${mutationLabels.length + 1}`; mutationLabels.push(id); return id; },
  });
  runtime.register({ handleWithEvent: (name, handler) => handlers.set(name, handler) });
  const invoke = (name, sender, raw) => handlers.get(channel(name))({ sender: sender.webContents, senderFrame: sender.webContents.mainFrame }, raw);
  const replaces = () => calls.filter((call) => call.method === "personalTodos.replace");
  return {
    main, runtime, invoke, calls, gate, clock, replaces,
    host: (label) => hosts[label],
    use: (label) => { current = hosts[label]; },
    /** null models a missing Host, as before the first host-core start. */
    setHost: (value) => { current = value; },
    available,
    failNextReplace: () => { policy.failReplace = true; },
    settingsCalls: () => calls.filter((call) => call.method === "settings.get").length,
    /** Reset the shared dialog spy for this fixture's assertions. */
    resetDialogs: () => { dialog.calls = 0; },
    changedEvents: () => main.webContents.sent.filter((entry) => entry.channel === channel("event/changed")).length,
    dialogCalls: () => dialog.calls,
    holdReplace() {
      let release;
      policy.holdReplace = { promise: new Promise((resolve) => { release = resolve; }), release };
      return { release: () => { const held = policy.holdReplace; policy.holdReplace = null; held.release(); } };
    },
    holdSettings() {
      let release;
      policy.holdSettings = { promise: new Promise((resolve) => { release = resolve; }), release };
      return { release: () => { const held = policy.holdSettings; policy.holdSettings = null; held.release(); } };
    },
    /** Hold the editor drain answer so a test can close the gate mid-quit. */
    holdQuit: (widget) => {
      let pending = null;
      widget.onSend = (name, payload) => {
        if (name !== channel("event/prepareQuit") || payload.requestId === null) return;
        pending = payload;
      };
      return { answer: () => { const answer = pending; pending = null; return invoke("quitReady", widget, answer); },
        asked: () => pending !== null };
    },
    answersQuit: (widget) => { widget.onSend = (name, payload) => {
      if (name === channel("event/prepareQuit") && payload.requestId !== null) void invoke("quitReady", widget, payload);
    }; },
  };
}
async function opened(f) {
  await f.runtime.open(false);
  const widget = windows.at(-1);
  await f.invoke("get", widget);
  return widget;
}
const edit = (f, widget, title, version = 0) =>
  f.invoke("edit", widget, { items: [{ id: "a", title, note: "", completed: false }], expectedEditVersion: version });

test("a closed gate performs no Host call, no appearance read and no native window", async () => {
  const f = fixture();
  const before = windows.length;
  f.gate.closed = true;
  await assert.rejects(f.runtime.open(), { errorCode: "HOST_BUSY" });
  assert.deepEqual(f.calls, [], "a closed gate must not read settings, the board or write it");
  assert.equal(windows.length, before, "a closed gate must not allocate a native surface");
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
  f.runtime.dispose();
  assert.equal(f.clock.count(), 0);
});

test("an RPC keeps the Host and generation captured at entry and a replacement receives nothing", async () => {
  const f = fixture();
  const widget = await opened(f);
  await edit(f, widget, "original owner draft");
  const held = f.holdReplace();
  const flush = f.invoke("flush", widget).catch((error) => error);
  await microtasks();
  assert.equal(f.replaces().length, 1);
  assert.equal(f.replaces()[0].host, "A");
  // A new execution generation takes over while the write is in flight.
  f.use("B");
  held.release();
  const failure = await flush;
  assert.equal(failure.errorCode, "HOST_UNAVAILABLE");
  assert.equal(f.calls.filter((call) => call.host === "B").length, 0, "the replacement Host must receive no call");
  const view = await f.invoke("get", widget);
  assert.equal(view.saveStatus, "error");
  assert.equal(view.savedEditVersion, 0);
  assert.equal(view.items[0].title, "original owner draft", "the draft survives a rejected reply");
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, 1, "a reply from a retired owner is uncertainty");
  // The original owner returns: the retained draft retries with its own token.
  f.use("A");
  await f.invoke("flush", widget);
  assert.equal(f.replaces().length, 2);
  assert.deepEqual(f.replaces()[1].params, f.replaces()[0].params, "a retry must resend the identical request");
  assert.equal((await f.invoke("get", widget)).saveStatus, "saved");
  // The open widget still owns its native surface and two display listeners.
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 3, uncontainedResources: 1 });
  f.runtime.dispose();
});

test("an admitted write settles after admission closes and is never reported as success without a reply", async () => {
  const f = fixture();
  const widget = await opened(f);
  await edit(f, widget, "in flight when idle begins");
  const held = f.holdReplace();
  const flush = f.invoke("flush", widget);
  await microtasks();
  f.gate.closed = true;
  assert.equal(f.runtime.getHandoffActivity().operations, 2, "one admitted RPC plus the retained draft stay visible");
  held.release();
  const view = await flush;
  assert.equal(view.saveStatus, "saved");
  assert.equal(view.savedEditVersion, 1);
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 3, uncontainedResources: 0 });
  // Fresh entries are refused and a background blur starts no new write.
  await assert.rejects(f.runtime.open(), { errorCode: "HOST_BUSY" });
  widget.emit("blur");
  await microtasks();
  assert.equal(f.replaces().length, 1, "no background flush starts after admission closed");
  f.runtime.dispose();
});

test("edit, debounce, closed quit refusal and an open-gate quit keep the draft", async () => {
  const f = fixture();
  const widget = await opened(f);
  f.answersQuit(widget);
  f.resetDialogs();
  await edit(f, widget, "typed");
  await f.clock.advance(499);
  assert.equal(f.replaces().length, 0, "the debounce waits for an idle interval");
  await f.clock.advance(1);
  assert.equal(f.replaces().length, 1, "the idle debounce persists the draft");
  assert.equal(f.replaces()[0].params.items[0].title, "typed");
  await f.invoke("edit", widget, { items: [{ id: "a", title: "typed, then idle", note: "unsaved note", completed: false }], expectedEditVersion: 1 });
  f.gate.closed = true;
  await f.clock.advance(2000);
  assert.equal(f.replaces().length, 1, "a timer that fires after admission closed writes nothing");
  assert.equal(f.runtime.getHandoffActivity().operations, 1, "the retained draft stays an obstruction");
  // Shutdown normally runs before the application gate is disposed. A gate that
  // is already closed belongs to an external handoff: refuse without draining,
  // writing, reopening the board or raising the retry dialog.
  assert.equal(await f.runtime.prepareQuit(), false);
  assert.equal(f.replaces().length, 1, "a refused quit starts no write");
  assert.equal(f.dialogCalls(), 0, "a closed gate raises no quit dialog");
  assert.equal(widget.webContents.sent.filter((entry) => entry.channel === channel("event/prepareQuit")).length, 0,
    "a refused quit never asks the editor to drain");
  assert.equal(f.runtime.getHandoffActivity().operations, 1, "the draft is still owned after the refusal");
  // Reopening the gate restores the normal quit path unchanged.
  f.gate.closed = false;
  assert.equal(await f.runtime.prepareQuit(), true);
  assert.equal(f.replaces().length, 2);
  assert.equal(f.replaces()[1].params.items[0].title, "typed, then idle");
  assert.equal(f.replaces()[1].params.items[0].note, "unsaved note");
  assert.equal(f.replaces()[1].params.expectedRevision, 1);
  assert.notEqual(f.replaces()[1].params.mutationId, f.replaces()[0].params.mutationId, "a committed batch gets a new token");
  assert.equal(f.dialogCalls(), 0, "a successful quit raises no dialog");
  widget.close();
  assert.equal(widget.dead, true, "a successful quit allows the native close");
  f.runtime.dispose();
  assert.equal(f.replaces().length, 2, "dispose never starts another write");
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("a gate that closes during the editor drain refuses the quit flush and preserves the draft", async () => {
  const f = fixture();
  const widget = await opened(f);
  const quitAnswer = f.holdQuit(widget);
  f.resetDialogs();
  await edit(f, widget, "unsaved during quit");
  const quit = f.runtime.prepareQuit();
  await microtasks();
  assert.equal(quitAnswer.asked(), true, "the open gate starts the editor drain");
  assert.equal(f.runtime.getHandoffActivity().operations, 2, "the drain and the unsaved draft are both counted");
  f.gate.closed = true;
  await quitAnswer.answer();
  assert.equal(await quit, false, "closure during the drain refuses the quit");
  assert.equal(f.replaces().length, 0, "no fresh write is attempted on the closed gate");
  assert.equal(f.dialogCalls(), 0, "an admission refusal is not a user-resolvable save failure");
  assert.equal(f.runtime.getHandoffActivity().operations, 1, "the draft stays owned");
  // The draft and its token survive; the next admitted quit persists them.
  f.answersQuit(widget);
  f.gate.closed = false;
  assert.equal(await f.runtime.prepareQuit(), true);
  assert.equal(f.replaces().length, 1);
  assert.equal(f.replaces()[0].params.items[0].title, "unsaved during quit");
  f.runtime.dispose();
});

test("a flush iteration that awaits the original writer never adopts a replaced owner", async () => {
  const f = fixture();
  const widget = await opened(f);
  await edit(f, widget, "first");
  const held = f.holdReplace();
  const first = f.invoke("flush", widget).catch((error) => error);
  await microtasks();
  assert.equal(f.replaces().length, 1);
  assert.equal(f.replaces()[0].host, "A");
  // Newer work arrives while the first write is outstanding. The running
  // sequence must finish its own loop on the owner it captured at entry.
  await edit(f, widget, "second", 1);
  const queued = f.invoke("flush", widget).catch((error) => error);
  await microtasks();
  // The same Host object keeps serving, but its execution generation moved on.
  f.host("A").generation = "generation-A2";
  held.release();
  assert.equal((await first).errorCode, "HOST_UNAVAILABLE");
  assert.equal((await queued).errorCode, "HOST_UNAVAILABLE");
  assert.equal(f.replaces().length, 1, "the refused request never reached the wire");
  assert.equal(f.calls.filter((call) => call.method === "personalTodos.replace").length, 1);
  const refused = await f.invoke("get", widget);
  assert.equal(refused.saveStatus, "error");
  assert.deepEqual(refused.items, [{ id: "a", title: "second", note: "", completed: false }],
    "the newest draft survives the refused write");
  // A deliberate new retry captures the restored owner and keeps its token.
  f.host("A").generation = "generation-A";
  const view = await f.invoke("flush", widget);
  assert.equal(view.saveStatus, "saved");
  // The refused in-flight write is replayed with its own token (the Host
  // deduplicates it), and only the newer draft takes a fresh token.
  assert.deepEqual(f.replaces().map((call) => call.params.mutationId),
    ["mutation-1", "mutation-1", "mutation-2"]);
  assert.equal(f.replaces().at(-1).params.items[0].title, "second", "the newest draft is what gets written");
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  f.runtime.dispose();
});

test("a replaced Host object also receives no call from a queued sequence", async () => {
  const f = fixture();
  const widget = await opened(f);
  await edit(f, widget, "queued on the original owner");
  const held = f.holdReplace();
  const inFlight = f.invoke("flush", widget).catch((error) => error);
  await microtasks();
  const queued = f.invoke("flush", widget).catch((error) => error);
  await microtasks();
  f.use("B");
  held.release();
  // Both sequences kept the Host they captured; the reply from the retired
  // owner is not applied, so both report the owner change instead of success.
  assert.equal((await inFlight).errorCode, "HOST_UNAVAILABLE");
  assert.equal((await queued).errorCode, "HOST_UNAVAILABLE");
  assert.equal(f.calls.filter((call) => call.host === "B").length, 0, "the replacement Host receives no call");
  assert.equal(f.replaces().length, 1);
  const preserved = await f.invoke("get", widget);
  assert.equal(preserved.saveStatus, "error");
  assert.deepEqual(preserved.items, [{ id: "a", title: "queued on the original owner", note: "", completed: false }],
    "the draft survives and stays uncertain");
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, 1);
  f.runtime.dispose();
});

test("an appearance read that settles after dispose publishes nothing and stays uncertain", async () => {
  const f = fixture();
  const held = f.holdSettings();
  const widget = await opened(f);
  assert.equal(f.settingsCalls(), 1, "the open sequence starts one appearance read");
  const published = f.changedEvents();
  f.runtime.dispose();
  held.release();
  await microtasks();
  assert.equal(f.changedEvents(), published, "a late appearance reply is not published after dispose");
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 },
    "the late reply is uncertainty, not a silent success");
  assert.equal(widget.dead, true);
});

test("window creation, collapse and dispose release only the handles that actually closed", async () => {
  const f = fixture();
  const widget = await opened(f);
  // One native surface plus the two display listeners installed on first show.
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 3, uncontainedResources: 0 });
  widget.close();
  await microtasks();
  assert.equal(widget.dead, false);
  assert.equal(f.runtime.getHandoffActivity().resources, 3, "a collapsed editor still owns its surface");
  f.runtime.dispose();
  assert.equal(widget.dead, true);
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("a native surface that never reported destruction keeps its handle counted", async () => {
  const f = fixture();
  const widget = await opened(f);
  widget.destroy = () => {};
  f.runtime.dispose();
  assert.equal(widget.isDestroyed(), false);
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 1, uncontainedResources: 1 });
  delete widget.destroy;
  widget.destroy();
  assert.equal(f.runtime.getHandoffActivity().resources, 0, "the surface is released when it really closes");
});

test("a sequence captured before an await issues no request once admission closed", async () => {
  const f = fixture();
  let release;
  BrowserWindow.loadGate = new Promise((resolve) => { release = resolve; });
  try {
    // open() captures its owner, then awaits the native window load.
    const opening = f.runtime.open(false);
    await microtasks();
    assert.equal(f.settingsCalls(), 1, "the appearance read was admitted before closure");
    const boardReads = f.calls.filter((call) => call.method === "personalTodos.get").length;
    f.gate.closed = true;
    release();
    await assert.rejects(opening, { errorCode: "HOST_BUSY" });
    assert.equal(f.calls.filter((call) => call.method === "personalTodos.get").length, boardReads,
      "the captured owner never issues its board read after admission closed");
    const refused = windows.at(-1);
    assert.equal(refused.isDestroyed(), true, "a surface created before closure is destroyed, never displayed");
    assert.notEqual(refused.visible, true, "no surface is displayed for a refused open");
    // The destroyed surface is released; the two display listeners stay owned
    // until dispose, and nothing is reported as unconfirmed.
    assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 2, uncontainedResources: 0 },
      "the refused request is not left counted or uncertain");
    f.runtime.dispose();
    assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
  } finally {
    release();
    BrowserWindow.loadGate = null;
    f.runtime.dispose();
  }
});

test("a quit flush never writes to the Host that replaced it during the editor drain", async () => {
  const f = fixture();
  const widget = await opened(f);
  const quitAnswer = f.holdQuit(widget);
  f.resetDialogs();
  await edit(f, widget, "draft owned by A");
  const quit = f.runtime.prepareQuit();
  await microtasks();
  assert.equal(quitAnswer.asked(), true, "the open gate starts the drain");
  // The execution generation moves on while the editor is still draining.
  f.host("A").generation = "generation-A2";
  f.use("B");
  await quitAnswer.answer();
  assert.equal(await quit, false, "a replaced owner refuses the quit instead of writing elsewhere");
  assert.equal(f.replaces().length, 0, "no write reached the wire");
  assert.equal(f.calls.filter((call) => call.host === "B" && call.method === "personalTodos.replace").length, 0,
    "the replacement Host never receives this attempt's draft");
  assert.equal(f.dialogCalls(), 1, "a replaced owner is a real save failure the user may retry");
  assert.equal(f.dialogCalls(), 1, "a replaced owner is a real save failure the user may retry");
  const kept = await f.invoke("get", widget);
  assert.equal(kept.saveStatus, "error");
  assert.deepEqual(kept.items, [{ id: "a", title: "draft owned by A", note: "", completed: false }],
    "the draft survives the refused quit flush");
  // The next attempt is a new sequence: it captures the current owner.
  f.answersQuit(widget);
  assert.equal(await f.runtime.prepareQuit(), true);
  assert.equal(f.replaces().length, 1);
  assert.equal(f.replaces()[0].host, "B", "a deliberate retry captures the owner that is current now");
  assert.equal(f.replaces()[0].params.items[0].title, "draft owned by A");
  assert.equal((await f.invoke("get", widget)).saveStatus, "saved");
  f.runtime.dispose();
});

test("an open that captured no Host never reads a Host appearing during the window load", async () => {
  const f = fixture();
  let release;
  BrowserWindow.loadGate = new Promise((resolve) => { release = resolve; });
  try {
    f.setHost(null);
    const opening = f.runtime.open(false).catch((error) => error);
    await microtasks();
    // The first host-core start completes while the widget is still loading.
    f.setHost(f.host("A"));
    release();
    assert.equal(await opening, undefined, "a failed board read does not fail the open");
    assert.deepEqual(f.calls, [], "the open sequence issues no request after its capture failed");
    // A later deliberate sequence may capture the Host that is current now.
    const widget = windows.at(-1);
    const view = await f.invoke("get", widget);
    assert.equal(view.saveStatus, "saved");
    assert.equal(view.document.revision, 0);
    assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 3, uncontainedResources: 0 },
      "the refused read is not left counted or uncertain");
    f.runtime.dispose();
  } finally {
    release();
    BrowserWindow.loadGate = null;
  }
});

test("a dirty quit that captured no Host never writes to a Host appearing during the drain", async () => {
  const f = fixture();
  const widget = await opened(f);
  const quitAnswer = f.holdQuit(widget);
  f.resetDialogs();
  await edit(f, widget, "draft with no owner");
  f.setHost(null);
  const quit = f.runtime.prepareQuit();
  await microtasks();
  assert.equal(quitAnswer.asked(), true, "the quit drains before it flushes");
  // host-core restarts during the drain: this attempt must not adopt it.
  f.setHost(f.host("B"));
  await quitAnswer.answer();
  assert.equal(await quit, false, "the retained refusal refuses the quit");
  assert.equal(f.replaces().length, 0, "no write reaches any Host");
  assert.equal(f.calls.filter((call) => call.host === "B" && call.method === "personalTodos.replace").length, 0,
    "the Host appearing during the drain receives no draft");
  assert.equal(f.dialogCalls(), 1, "the user may retry after the owner returns");
  const kept = await f.invoke("get", widget);
  assert.equal(kept.saveStatus, "error");
  assert.deepEqual(kept.items, [{ id: "a", title: "draft with no owner", note: "", completed: false }],
    "the draft survives the refused quit");
  // The retry is a new attempt: it captures the Host current at that time.
  f.answersQuit(widget);
  assert.equal(await f.runtime.prepareQuit(), true);
  assert.equal(f.replaces().length, 1);
  assert.equal(f.replaces()[0].host, "B");
  assert.equal(f.replaces()[0].params.items[0].title, "draft with no owner");
  f.runtime.dispose();
});

test("a clean board still quits while no Host exists", async () => {
  const f = fixture();
  const widget = await opened(f);
  f.answersQuit(widget);
  f.resetDialogs();
  f.setHost(null);
  assert.equal(await f.runtime.prepareQuit(), true, "a clean board never needs the owner to quit");
  assert.equal(f.dialogCalls(), 0);
  assert.equal(f.replaces().length, 0);
  widget.close();
  assert.equal(widget.dead, true, "a successful clean quit allows the native close");
  f.runtime.dispose();
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});
