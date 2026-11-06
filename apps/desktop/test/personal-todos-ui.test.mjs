import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { PersonalTodosWidget } from "../src/features/personal-todos/PersonalTodosWidget";

await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
let view = { document: {schemaVersion:1,revision:0,updatedAt:null,items:[]}, items: [], editVersion: 0, savedEditVersion: 0, saveStatus: "saved", error: null, alwaysOnTop: true, visible: true, appearance: { language: "en", theme: "dark", fontFamily: "" } };
const copies = [], edits = [], acknowledgements = [];
let failNextEdit = false, deferNextEdit = false, failStorage = false;
let releaseEdit;
let diskItems = [];
const listeners = new Map();
const publish = () => listeners.get(IPC.event.personalTodosChanged)?.(structuredClone(view));
const bridge = {
 platform: "linux", locale: "en-US",
 on(channel, callback) { listeners.set(channel, callback); return () => listeners.delete(channel); },
 invoke(channel, payload) {
  if (channel === IPC.invoke.personalTodosGet) return Promise.resolve({ ok: true, data: structuredClone(view) });
  if (channel === IPC.invoke.personalTodosFlush) {
   if(failStorage) return Promise.resolve({ok:false,error:{code:"INTERNAL",message:"disk unavailable"}});
   diskItems=structuredClone(view.items);
   view={...view,document:{schemaVersion:1,revision:view.document.revision+1,updatedAt:1,items:diskItems},savedEditVersion:view.editVersion,saveStatus:"saved",error:null};
   publish();return Promise.resolve({ok:true,data:structuredClone(view)});
  }
  if (channel === IPC.invoke.personalTodosQuitReady) {acknowledgements.push(payload.requestId);return Promise.resolve({ok:true,data:{accepted:true}});}
  if (channel === IPC.invoke.personalTodosCopy) { copies.push(payload); return Promise.resolve({ ok: true, data: undefined }); }
  if (channel === IPC.invoke.personalTodosWindow) {
   if (payload.action === "pin") view = { ...view, alwaysOnTop: payload.value };
   if (payload.action === "collapse") view = { ...view, visible: false };
   return Promise.resolve({ ok: true, data: structuredClone(view) });
  }
  if (channel === IPC.invoke.personalTodosEdit) {
   if (failNextEdit) { failNextEdit = false; return Promise.resolve({ ok: false, error: { code: "TEMPORARY", message: "temporary" } }); }
   const accept = () => {
    if(payload.expectedEditVersion!==view.editVersion)return {ok:false,error:{code:"CONFLICT",message:"draft changed"}};
    edits.push(payload);
    view = { ...view, items: structuredClone(payload.items), editVersion: view.editVersion + 1, saveStatus: failStorage?"error":"pending",error:failStorage?{code:"INTERNAL",message:"disk unavailable"}:null };
    publish();return {ok:true,data:structuredClone(view)};
   };
   if(deferNextEdit){deferNextEdit=false;return new Promise(resolve=>{releaseEdit=()=>resolve(accept());});}
   return Promise.resolve(accept());
  }
  return Promise.resolve({ ok: false, error: { code: "UNEXPECTED", message: channel } });
 }
};
window.piDesktop = bridge;
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(PersonalTodosWidget))));
const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const findButton = (label) => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label || button.textContent.trim() === label);
const input = (node, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value); node.dispatchEvent(new InputEvent("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); };
const textarea = (node, value) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(node, value); node.dispatchEvent(new InputEvent("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); };
const copyButton=()=>document.querySelector('.personal-todo-actions button:first-child');
window.todoProbe = async () => {
 await settle();
 check(document.querySelector('[aria-pressed="true"]'), "pin state is visible");
 findButton("Add todo").click(); await settle();
 let title = document.querySelector(".personal-todo-title");
 check(title, "blank draft row is rendered");
 input(title, "Plan launch"); await settle();
 copyButton().click(); await settle();
 check(copies.at(-1)?.title === "Plan launch" && copies.at(-1)?.note === "", "copy without a note contains only the title");
 document.querySelector(".personal-todo-note-toggle").click(); await settle();
 textarea(document.querySelector(".personal-todo-note"), "first line\nsecond line"); await settle();
 document.querySelector(".personal-todo-note-toggle").click(); await settle();
 copyButton().click(); await settle();
 check(copies.at(-1)?.note === "first line\nsecond line", "collapsed full note is copied");
 for(const button of document.querySelectorAll('.personal-todos-icon'))check(button.textContent.trim()===''&&button.getAttribute('aria-label'), 'icon controls have accessible names and no text');
 document.querySelector(".personal-todo-check input").click(); await settle();
 check(view.items[0].completed, "completion toggle persisted");
 document.querySelector('[aria-pressed="true"]').click(); await settle();
 check(!view.alwaysOnTop, "pin toolbar toggles host view state");
 document.querySelector('[aria-label="Delete todo"]').click(); await settle();
 check(view.items.length === 0, "delete removes row from the board");
 findButton("Add todo").click(); await settle();
 title = document.querySelector(".personal-todo-title");
 failNextEdit = true; input(title, "Retry this draft"); await settle();
 check(document.querySelector(".personal-todos-status").textContent.includes("Could not save changes"), "save errors are visible");
 document.querySelector(".personal-todos-retry").click(); await settle();
 check(view.items[0]?.title === "Retry this draft", "retry recovers the retained draft");
 failStorage=true;input(title,"Retry the disk write");await settle();
 check(document.querySelector('.personal-todos-retry'),"disk failure has a retry action");
 failStorage=false;document.querySelector('.personal-todos-retry').click();await settle();
 check(diskItems[0]?.title==='Retry the disk write',"retry flushes Main's retained draft to disk");
 title = document.querySelector(".personal-todo-title"); input(title, "Newer local draft");
 listeners.get(IPC.event.personalTodosChanged)({ ...view, editVersion: -1, items: [{ id: "stale", title: "stale", note: "", completed: false }] });
 await settle();
 check(document.querySelector(".personal-todo-title").value === "Newer local draft", "stale event did not overwrite typing");
 deferNextEdit=true;input(title,'First queued edit');input(title,'Last queued edit');
 const prepare=listeners.get(IPC.event.personalTodosPrepareQuit);
 prepare({requestId:'quit-1'});await settle();
 check(document.querySelector('main').inert,'quit preparation pauses editing');
 check(acknowledgements.length===0,'quit waits for the pending edit');
 releaseEdit();await settle();
 check(view.items[0].title==='Last queued edit','quit drains the newest queued input');
 check(acknowledgements.at(-1)==='quit-1','quit acknowledges only after draft acceptance');
 prepare({requestId:null});await settle();
 check(!document.querySelector('main').inert,'cancelled quit restores editing');
 input(title,'Editing resumed');await settle();check(view.items[0].title==='Editing resumed','input works after quit cancellation');
 findButton("Collapse personal todos").click(); await settle();
 check(view.visible === false, "collapse flushes and requests runtime collapse");
 root.unmount();
 return { passed: true };
};
`;

test("personal todo widget completes the user path without losing local edits", { skip: !existsSync(join(root, "apps/desktop/node_modules/electron/dist/electron.exe")) ? "Prepared Electron binary unavailable" : process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false }, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.personal-todos-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "apps/desktop/test"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      loader: { ".css": "empty" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `const { app, BrowserWindow } = require("electron"); const path = require("node:path"); app.setPath("userData", path.join(__dirname,"profile")); app.whenReady().then(async()=>{ const win=new BrowserWindow({show:false,width:480,height:640,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}); try { await win.loadFile(path.join(__dirname,"index.html")); console.log("TODO_PROBE "+JSON.stringify(await win.webContents.executeJavaScript("window.todoProbe()"))); app.exit(0); } catch(error) { console.error(error?.stack??error); app.exit(1); } });`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new
 Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("TODO_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("TODO_PROBE ".length)), { passed: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("personal todo surface is routed before main app store startup and owns safe widget appearance", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(join(root, "apps/desktop/src/main.tsx"), "utf8");
  const widget = await readFile(join(root, "apps/desktop/src/features/personal-todos/PersonalTodosWidget.tsx"), "utf8");
  const locales = await Promise.all(["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"].map((locale) => readFile(join(root, "packages/i18n/src/locales", locale, "index.ts"), "utf8")));
  assert.match(main, /rendererSurface === "personal-todos"/);
  assert.match(main, /rendererSurface !== "personal-todos"\) await initLanguageSync/);
  assert.match(widget, /personalTodosPrepareQuit/);
  assert.match(widget, /personalTodosQuitReady/);
  for (const [index, locale] of locales.entries()) {
    const id = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"][index];
    const start = locale.indexOf("personalTodos:");
    const personal = locale.slice(start, locale.indexOf("},", start));
    for (const key of ["open", "title", "add", "copy", "delete", "pin", "collapse", "retry", "quitSaveFailed", "cancelQuit", "retryQuit", "editTitle", "editNote"]) {
      assert.match(personal, new RegExp(key + ":"), `${id} missing ${key}`);
    }
  }
});
