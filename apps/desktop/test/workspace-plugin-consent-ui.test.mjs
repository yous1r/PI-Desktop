import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const renderer = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { WorkspacePluginConsentDialog } from "../../apps/desktop/src/components/plugins/WorkspacePluginConsentDialog";
import { isBlockingOverlayActive } from "../../apps/desktop/src/lib/blocking-overlay";
await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<><button id="prior">Prior focus</button><WorkspacePluginConsentDialog /></>));
document.getElementById("prior").focus();
const frame = () => new Promise(requestAnimationFrame);
function check(value, message) { if (!value) throw new Error(message); }
async function until(fn) { for(let n=0;n<180;n++) { if(fn())return; await frame(); } throw new Error("UI condition timed out: "+document.body.textContent); }
const get = () => document.querySelector('[role="alertdialog"]');
const buttons = () => [...get().querySelectorAll("button")];
window.consentProbe = {
  async visible(name) { await until(()=>get()?.textContent.includes(name)); await frame(); await frame();
    check(get().getAttribute("aria-modal")==="true", "Missing modal semantics");
    check(get().getAttribute("aria-labelledby") && get().getAttribute("aria-describedby"), "Missing accessible text");
    check(isBlockingOverlayActive(), "Embedded plugin view was not blocked");
    await until(()=>document.activeElement===buttons()[0]);
  },
  async gone() { await until(()=>!get()); check(!isBlockingOverlayActive(),"Overlay owner leaked");
    check(document.activeElement===document.getElementById("prior"),"Prior focus was not restored"); },
  async themes() {
    const samples={};
    for(const theme of ["dark","light"]) {
      document.documentElement.dataset.theme=theme; await frame();
      const computed=getComputedStyle(get());
      const sample=document.createElement("div"); sample.style.background="var(--ds-bg-elevated-opaque)";
      document.body.append(sample);
      check(computed.backgroundColor===getComputedStyle(sample).backgroundColor,"Dialog ignored theme surface");
      samples[theme]=computed.backgroundColor; sample.remove();
    }
    check(samples.dark!==samples.light,"Theme switch did not repaint");
    document.documentElement.style.setProperty("--ds-bg-elevated-opaque","rgb(28, 44, 61)");
    await frame(); check(getComputedStyle(get()).backgroundColor==="rgb(28, 44, 61)","Custom theme surface ignored");
    document.documentElement.style.removeProperty("--ds-bg-elevated-opaque");
    document.documentElement.dataset.theme="dark";
    return samples;
  },
  keyboard() {
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true}));
    check(document.activeElement===buttons()[1],"Shift Tab did not wrap");
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));
    check(document.activeElement===buttons()[0],"Tab did not wrap to Deny");
  },
  escape() { window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})); },
  click(allowed) { const button=buttons()[allowed?1:0]; flushSync(()=>{button.click();button.click();}); },
  backdrop() {
    const overlay=document.querySelector(".workspace-plugin-consent-overlay");
    for(const type of ["pointerdown","pointerup"])overlay.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,isPrimary:true}));
    overlay.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
  },
  narrow() {
    const rect=get().getBoundingClientRect();
    check(rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight,"Dialog overflowed viewport");
    check(get().scrollWidth<=get().clientWidth,"Long text caused horizontal overflow");
    check(!get().querySelector("img"),"Plugin label was interpreted as HTML");
    return {width:innerWidth,dialogWidth:rect.width};
  },
  unmount() {flushSync(()=>root.unmount());},
};
`;
const main = String.raw`
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { IPC } from "@pi-desktop/shared";
import { createWorkspacePluginConsent } from "../../apps/desktop/electron/main/services/workspace-plugin-consent";
import { registerWorkspacePluginConsentIpc } from "../../apps/desktop/electron/main/ipc/workspace-plugin-consent-ipc";
const check=(v,m)=>{if(!v)throw Error(m);};
app.setPath("userData",join(__dirname,"profile"));
await app.whenReady();
const window=new BrowserWindow({show:false,width:720,height:560,webPreferences:{preload:join(__dirname,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
const consent=createWorkspacePluginConsent({getWindow:()=>window});
let ready=false;
const registrar={
  handle(){throw Error("Consent exposed through internal invoke map");},ipcMain,
  assertMainWindowSender(event){if(event.sender!==window.webContents)throw Error("PERMISSION_DENIED");},
  handleWithEvent(channel,handler){ipcMain.handle(channel,async(event,...args)=>{
    try {const data=await handler(event,...args);if(channel===IPC.invoke.pluginWorkspaceConsentReady)ready=data.ready;return {ok:true,data};}
    catch(error){return {ok:false,error:{code:error.errorCode||"PERMISSION_DENIED",message:error.message}};}
  });},
};
registerWorkspacePluginConsentIpc(registrar,consent);
const js=(code)=>{console.log("probe",code.slice(0,100));return window.webContents.executeJavaScript(code);};
const input=(name="IDEA Git")=>({pluginId:"test.git",pluginName:name,hostKey:"ssh-test-host"});
try {
  window.webContents.on("console-message",(_event,...args)=>console.log("renderer",...args));
  await window.loadFile(join(__dirname,"index.html"));
  console.log("consent renderer loaded");
  await js('new Promise(resolve=>{const poll=()=>window.consentProbe?resolve():requestAnimationFrame(poll);poll();})');
  check(ready,"Main renderer did not acknowledge readiness");
  let decision=consent.request(input());
  await js('window.consentProbe.visible("IDEA Git")');
  const themes=await js('window.consentProbe.themes()');
  await js('window.consentProbe.keyboard()');
  await js('window.consentProbe.escape()');check(await decision===false,"Escape granted execution");
  await js('window.consentProbe.gone()');

  decision=consent.request(input("Enter denies"));
  await js('window.consentProbe.visible("Enter denies")');
  await js('document.activeElement.click()');
  check(await decision===false,"Initially focused button granted execution");await js('window.consentProbe.gone()');

  const first=consent.request(input("First"));const second=consent.request({...input("Second"),pluginId:"test.second"});
  await js('window.consentProbe.visible("First")');
  check(await js('document.querySelectorAll("[role=alertdialog]").length')===1,"Overlapping consent dialogs");
  const foreign=new BrowserWindow({show:false,webPreferences:{preload:join(__dirname,"preload.cjs"),sandbox:true,contextIsolation:true}});
  await foreign.loadURL("about:blank");
  const forged=await foreign.webContents.executeJavaScript('window.piDesktop.invoke("pi-desktop/plugin/workspaceConsent/respond",{requestId:"forged",allowed:true})');
  check(forged.ok===false,"Foreign renderer bypassed consent gate");foreign.destroy();
  const stale=await js('window.piDesktop.invoke("pi-desktop/plugin/workspaceConsent/respond",{requestId:"stale",allowed:true})');
  check(stale.data.accepted===false,"Stale response accepted");
  await js('window.consentProbe.click(true)');check(await first===true,"Explicit Allow was lost");
  await js('window.consentProbe.visible("Second")');
  await js('window.consentProbe.backdrop()');check(await second===false,"Backdrop granted execution");await js('window.consentProbe.gone()');

  window.setSize(360,540);
  decision=consent.request(input("<img src=x>远程插件"+"长主机名".repeat(30)));
  await js('window.consentProbe.visible("<img src=x>")');
  const narrow=await js('window.consentProbe.narrow()');
  await js('window.consentProbe.click(false)');check(await decision===false,"Deny was lost");

  decision=consent.request(input("Reload"));await js('window.consentProbe.visible("Reload")');
  const loaded=new Promise(resolve=>window.webContents.once("did-finish-load",resolve));window.reload();
  check(await decision===false,"Reload retained pending authorization");await loaded;
  await js('new Promise(resolve=>{const poll=()=>window.consentProbe?resolve():requestAnimationFrame(poll);poll();})');
  decision=consent.request(input("Unmount"));await js('window.consentProbe.visible("Unmount")');
  await js('window.consentProbe.unmount()');check(await decision===false,"Unmount retained pending authorization");
  consent.dispose();window.destroy();console.log("WORKSPACE_CONSENT_PROBE "+JSON.stringify({passed:true,themes,narrow}));app.exit(0);
} catch(error) {console.error(error.stack);consent.dispose();app.exit(1);}
`;

test("workspace consent follows themes and returns only explicit main-window decisions", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "workspace-consent-ui-"));
  const alias = {
    "@pi-desktop/shared": join(root, "packages/shared/src"),
    "@pi-desktop/i18n": join(root, "packages/i18n/src"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    i18next: join(root, "apps/desktop/node_modules/i18next"),
    "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
  };
  try {
    await build({stdin:{contents:renderer,resolveDir:join(root,"scripts/e2e"),loader:"tsx"},outfile:join(temp,"renderer.js"),bundle:true,platform:"browser",format:"esm",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'},alias,nodePaths:[join(root,"apps/desktop/node_modules")]});
    await build({entryPoints:[join(root,"apps/desktop/electron/preload/index.ts")],outfile:join(temp,"preload.cjs"),bundle:true,platform:"node",format:"cjs",external:["electron"],alias});
    // Keep the real main/renderer bridge; only the test driver is bundled here.
    await build({stdin:{contents:main.replace("const check=", "async function run() { console.log('consent main started'); const check=")+`
}
run().catch(error=>{console.error(error);app.exit(1);});`,resolveDir:join(root,"scripts/e2e"),loader:"ts"},outfile:join(temp,"main.cjs"),bundle:true,platform:"node",format:"cjs",external:["electron"],alias});
    const css = await Promise.all(["tokens.css","ui-kit.css","overlays.css"].map(name=>readFile(join(root,"apps/desktop/src/styles",name),"utf8")));
    await writeFile(join(temp,"styles.css"),css.join("\n").replace("@theme {",":root {"));
    await writeFile(join(temp,"index.html"),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(resolveElectronBinary(root).electronBinary,[join(temp,"main.cjs")],{env,stdio:["ignore","pipe","pipe"]});
    let output="";for(const stream of [child.stdout,child.stderr]){stream.setEncoding("utf8");stream.on("data",chunk=>{output+=chunk;});}
    const timer=setTimeout(()=>child.kill("SIGKILL"),45_000);
    let code;try{code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});}finally{clearTimeout(timer);}
    assert.equal(code,0,output.slice(-8000));
    const line=output.split(/\r?\n/).find(line=>line.startsWith("WORKSPACE_CONSENT_PROBE "));
    assert.ok(line,output);const result=JSON.parse(line.slice("WORKSPACE_CONSENT_PROBE ".length));
    assert.equal(result.passed,true);assert.notEqual(result.themes.dark,result.themes.light);
  } finally {await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
