import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, webContents } from "electron";
import { PluginRuntime } from "../../apps/desktop/electron/main/plugin-runtime.ts";
import { PluginPanelHost } from "../../apps/desktop/electron/main/plugin-panel-host.ts";
import { PluginViewHost } from "../../apps/desktop/electron/main/plugin-view-host.ts";
import { PluginShortcutRegistry } from "../../apps/desktop/electron/main/plugin-shortcut-registry.ts";
import { DesktopHandoffAdmission } from "../../apps/desktop/electron/main/runtime/handoff-admission.ts";

const output = process.env.PLUGIN_SURFACES_ARTIFACT_DIR;
assert(output && process.env.PLUGIN_SURFACES_NODE && process.env.PLUGIN_SURFACES_RUNNER);
app.setPath("userData", join(output, "profile")); app.setPath("sessionData", join(output, "profile"));
app.on("window-all-closed", () => {});
async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Original surface fixture did not settle")), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function probe() {
  const id = "test.surface-handoff", root = join(output, "plugin"); mkdirSync(root);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: "Surface fixture", version: "1.0.0", main: "main.js",
    permissions: ["ui.panel", "ui.view", "keyboard.globalShortcut"], ui: { panel: "index.html" },
    contributes: { commands: [{ id: "ping", title: "Ping" }], views: [{ id: "main", title: "Main", entry: "index.html" }] } }));
  writeFileSync(join(root, "main.js"), `let count=0; module.exports={
    async onLoad(){await pi.commands.register({id:'ping',title:'Ping',run:async()=>{count++;}});},
    async onPanelInvoke(channel,payload){if(channel==='echo')return {value:payload.value};if(channel==='count')return count;
      if(channel==='bind')return pi.keyboard.registerGlobalShortcut({id:'ping',accelerator:'Alt+Shift+Space',command:'ping'});}
  };\n`);
  writeFileSync(join(root, "index.html"), `<!doctype html><meta charset="utf-8"><title>Surface fixture</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <input id="value" value="original input"><button id="send">Send</button><output id="reply"></output>
    <script>document.querySelector('#send').onclick=()=>{window.reply=pluginBridge.invoke('echo',{value:document.querySelector('#value').value})
      .then(result=>{document.querySelector('#reply').textContent=result.value;return result.value;});};</script>`);
  const admission = new DesktopHandoffAdmission(), children = [], callbacks = [], triggers = [], errors = [], passed = [];
  const shortcuts = new PluginShortcutRegistry({ isAdmissionClosed: () => admission.isClosed(), platform: "win32",
    register: (_key, handler) => { callbacks.push(handler); return true; }, unregister() {},
    onTrigger: entry => { const pending = runtime.triggerPluginShortcut(entry); triggers.push(pending); return pending; }, onError: error => errors.push(String(error)) });
  const runtime = new PluginRuntime({ isAdmissionClosed: () => admission.isClosed(), pluginShortcuts: shortcuts,
    hostEntry: process.env.PLUGIN_SURFACES_RUNNER,
    openPanel: input => panels.open({ ...input, locale: "en", theme: "light" }), closePanel: pluginId => panels.close(pluginId),
    surfaceActivity: () => {
      const a = panels.getHandoffActivity(), b = views.getHandoffActivity();
      return { operations: a.operations + b.operations, resources: a.resources + b.resources, uncontainedResources: a.uncontainedResources + b.uncontainedResources };
    },
    spawnProcess: ({ entry, assertCurrent }) => {
      assertCurrent?.(); const env = {};
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PI_DESKTOP_DATA_DIR", "PI_DESKTOP_AGENTS_DIR"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = fork(entry, [], { execPath: process.env.PLUGIN_SURFACES_NODE, execArgv: [], cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = { child, closed: Promise.withResolvers(), exited: false, stderr: "" }; children.push(record);
      child.stdout.resume(); child.stderr.on("data", bytes => { record.stderr = (record.stderr + bytes).slice(-8192); });
      child.once("error", record.closed.reject); child.once("exit", () => { record.exited = true; }); child.once("close", record.closed.resolve);
      return { postMessage: message => child.send(message), onMessage: handler => child.on("message", handler),
        onExit: handler => child.on("exit", code => handler(code ?? 0)), kill: () => child.kill() };
    },
  });
  const options = { isAdmissionClosed: () => admission.isClosed(), captureOwner: pluginId => runtime.captureSurfaceOwner(pluginId), onError: error => errors.push(String(error)) };
  const panels = new PluginPanelHost((...args) => runtime.invokePanelBridge(...args), options), views = new PluginViewHost(options);
  panels.addSenderResolver(sender => views.pluginIdForSender(sender), sender => views.assertSenderCurrent(sender));
  panels.addContextResolver(sender => views.contextForSender(sender));
  const input = { pluginId: id, viewId: "main", htmlPath: join(root, "index.html"), title: "Surface fixture", locale: "en", theme: "light", width: 480, height: 360 };
  // Other resource families are absent only in this isolated fixture.
  const inspect = async () => { const activity = runtime.getHandoffActivity(); return {
    clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: activity.plugins,
    admissions: activity.operations, finalizations: 0, writes: 0, children: 0, workers: 0, schedules: activity.schedules,
    approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: activity.uncontainedResources }; };
  let window; const ownedPages = [];
  try {
    const hold = await admission.gate.acquireHandoff(randomUUID(), inspect);
    await assert.rejects(panels.open(input), { code: "HOST_BUSY" }); assert.throws(() => views.open(input), { code: "HOST_BUSY" });
    assert.equal(BrowserWindow.getAllWindows().length, 0); hold.cancel();
    passed.push("closed empty admission prevents native pages; cancellation restores entry");
    await runtime.loadFromPath(root); await panels.open(input);
    window = BrowserWindow.getAllWindows()[0]; ownedPages.push(window.webContents);
    await bounded(window.webContents.executeJavaScript("document.querySelector('#send').click(); window.reply"));
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#reply').textContent"), "original input");
    views.setWindow(window); const surface = views.open(input);
    const view = webContents.getAllWebContents().find(page => page.id !== window.webContents.id && views.pluginIdForSender(page.id) === id);
    assert(view); ownedPages.push(view); if (view.isLoading()) await bounded(once(view, "did-finish-load"));
    views.setBounds({ x: 0, y: 46, width: 480, height: 280 }); views.setVisible(id, "main", true, surface);
    assert.equal(await bounded(view.executeJavaScript("document.querySelector('#value').value='view input';document.querySelector('#send').click();window.reply")), "view input");
    views.setVisible(id, "main", false, surface); assert.equal(views.open(input), surface); views.setVisible(id, "main", true, surface);
    passed.push("real panel and retained embedded view invoke their original plugin through the sandbox preload");
    await runtime.invokePanelBridge(id, "bind"); callbacks[0]();
    await bounded(triggers[0]);
    assert.equal(await runtime.invokePanelBridge(id, "count"), 1);
    await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
    admission.dispose(); callbacks[0]();
    await assert.rejects(panels.open(input), { code: "HOST_BUSY" }); assert.throws(() => views.open(input), { code: "HOST_BUSY" });
    await assert.rejects(view.executeJavaScript("pluginBridge.invoke('echo',{value:'refused'})"), /Host admission is closed/);
    passed.push("busy inventory refuses handoff; closed admission suppresses page and shortcut entry");
    await views.dispose(); await panels.closeAll(); await runtime.unload(id); await bounded(children[0].closed.promise);
    assert(ownedPages.every(page => page.isDestroyed())); assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(runtime.getHandoffActivity().operations, 0); assert.equal(runtime.getHandoffActivity().plugins, 0);
    assert(runtime.getHandoffActivity().uncontainedResources > 0); assert.equal(children[0].stderr, ""); assert.deepEqual(errors, []);
    passed.push("original pages and plugin child exit while unqualified native evidence remains");
    return { status: "PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES", passed, activity: runtime.getHandoffActivity(),
      panelActivity: panels.getHandoffActivity(), viewActivity: views.getHandoffActivity(), shortcutActivity: shortcuts.getHandoffActivity(),
      originalPluginProcesses: children.length, originalPluginExitsObserved: children.every(record => record.exited), originalWebContentsDestroyed: ownedPages.length,
      shortcutPlatform: "deterministic registration edge; no real OS key injection", qualifiedNativeFamilyClosure: false };
  } finally {
    admission.dispose(); await views.dispose(); await panels.closeAll(); await runtime.disposeAll();
    for (const record of children) { if (!record.exited) record.child.kill(); await bounded(record.closed.promise); }
    for (const owned of BrowserWindow.getAllWindows()) owned.destroy();
  }
}
app.whenReady().then(probe).then(result => {
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n"); app.exit(0);
}, error => {
  console.error(error); writeFileSync(join(output, "result.json"), JSON.stringify({ status: "FAIL", error: String(error), qualifiedNativeFamilyClosure: false }, null, 2) + "\n"); app.exit(1);
});
