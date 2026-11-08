import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/plugin-surface-electron-hook.mjs", import.meta.url));
const { PluginPanelHost } = await import("../electron/main/plugin-panel-host.ts");
const { PluginViewHost } = await import("../electron/main/plugin-view-host.ts");
const { PluginShortcutRegistry } = await import("../electron/main/plugin-shortcut-registry.ts");
const { registerPluginUiIpc } = await import("../electron/main/ipc/plugin-ui-ipc.ts");
const { IPC } = await import("../../../packages/shared/src/protocol.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { controls, pages, windows, ipcMain, shell, deferred } = await import("./helpers/plugin-surface-electron.mjs");
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const request = { pluginId: "test.surface", viewId: "main", title: "Fixture", htmlPath: "C:/fixture.html", locale: "en", theme: "light", width: 480, height: 360 };
function fixture(t, bridge = async () => undefined) {
  let closed = false, installation = {};
  const errors = [];
  const options = { isAdmissionClosed: () => closed, captureOwner: () => {
    const original = installation;
    return () => { if (original !== installation) throw Object.assign(new Error("Plugin changed"), { code: "PLUGIN_UNLOADED" }); };
  }, onError: error => errors.push(error) };
  const panels = new PluginPanelHost(bridge, options), views = new PluginViewHost(options);
  t.after(async () => { controls.holdClose = false; controls.holdLoads = false; shell.pending?.resolve(); shell.pending = null;
    for (const page of pages) { for (const load of page.loads) load.resolve(); page.die(); }
    await panels.closeAll(); await views.dispose();
  });
  return { panels, views, errors, options, closeGate: () => { closed = true; }, openGate: () => { closed = false; }, replace: () => { installation = {}; } };
}
function shortcuts(t, extra = {}) {
  let closed = false; const handlers = [], triggered = [], removed = [];
  const registry = new PluginShortcutRegistry({ platform: "win32", isAdmissionClosed: () => closed,
    register: (_key, handler) => { handlers.push(handler); return true; }, unregister: key => removed.push(key),
    onTrigger: entry => { triggered.push(entry); }, ...extra });
  t.after(() => registry.releasePlugin(request.pluginId));
  const bind = () => registry.register({ pluginId: request.pluginId, id: "test", accelerator: "Alt+Shift+Space", command: "test" });
  return { registry, handlers, triggered, removed, bind, closeGate: () => { closed = true; } };
}

test("closed surface admission refuses panel and view allocation", async t => {
  const f = fixture(t); f.closeGate(); const count = pages.length;
  await assert.rejects(f.panels.open(request), { code: "HOST_BUSY" });
  assert.throws(() => f.views.open(request), { code: "HOST_BUSY" }); assert.equal(pages.length, count);
});
test("panel shutdown retires queued opens before native allocation", async t => {
  const f = fixture(t); const count = windows.length;
  const opening = f.panels.open(request); const refused = assert.rejects(opening, { code: "HOST_BUSY" });
  await f.panels.closeAll(); await refused; assert.equal(windows.length, count);
});
test("panel close invalidates an open already queued for the old installation", async t => {
  const f = fixture(t); const count = windows.length;
  const opening = f.panels.open(request); const refused = assert.rejects(opening, { code: "PLUGIN_UNLOADED" });
  await f.panels.close(request.pluginId); await refused; assert.equal(windows.length, count);
  await f.panels.open(request); assert.equal(windows.length, count + 1);
});
test("late panel load cannot show after admission closes", async t => {
  const f = fixture(t); controls.holdLoads = true;
  const opening = f.panels.open(request); const result = opening.then(() => null, error => error);
  await nextTurn(); const window = windows.at(-1); f.closeGate(); window.webContents.loads[0].resolve();
  assert.equal((await result)?.code, "HOST_BUSY"); assert.equal(window.shown, 0); assert.equal(window.destroyed, true);
});
test("late panel load cannot publish through a replacement installation", async t => {
  const f = fixture(t); controls.holdLoads = true;
  const opening = f.panels.open(request); const result = opening.then(() => null, error => error);
  await nextTurn(); const window = windows.at(-1); f.replace(); window.webContents.loads[0].resolve();
  assert.equal((await result)?.code, "PLUGIN_UNLOADED"); assert.equal(window.shown, 0);
});
test("panel load remains owned after its caller deadline and window destruction", async t => {
  const f = fixture(t); controls.holdLoads = true; t.mock.timers.enable({ apis: ["setTimeout"] });
  const opening = f.panels.open(request); const refused = assert.rejects(opening, /PANEL_LOAD_TIMEOUT/);
  await nextTurn(); const page = pages.at(-1); t.mock.timers.tick(15000); await refused;
  assert.equal(page.destroyed, true); assert.ok(f.panels.getHandoffActivity().operations > 0);
  page.loads[0].resolve(); await nextTurn(); assert.equal(f.panels.getHandoffActivity().operations, 0);
  assert.ok(f.panels.getHandoffActivity().uncontainedResources > 0);
});
test("panel bridge retains original work after page closes and rejects old installation senders", async t => {
  const work = deferred(); let calls = 0;
  const f = fixture(t, async () => { calls++; return work.promise; }); await f.panels.open(request);
  const page = pages.at(-1); const invoke = ipcMain.handlers.get("pi-plugin-panel-invoke");
  const running = invoke({ sender: page }, "fixture"); await nextTurn(); page.die();
  try { assert.ok(f.panels.getHandoffActivity().operations > 0); } finally { work.resolve(); await running; }
  await f.panels.open(request); const other = pages.at(-1); f.replace();
  await assert.rejects(invoke({ sender: other }, "fixture"), { code: "PLUGIN_UNLOADED" }); assert.equal(calls, 1);
});
test("view load and closing page survive removal from the live cache", async t => {
  const f = fixture(t); controls.holdLoads = true; controls.holdClose = true;
  const id = f.views.open(request); const page = pages.at(-1); f.views.close(request.pluginId, request.viewId, id);
  assert.equal(f.views.has(request.pluginId, request.viewId, id), false);
  assert.ok(f.views.getHandoffActivity().operations > 0); assert.equal(f.views.getHandoffActivity().resources, 1);
  page.die(); assert.ok(f.views.getHandoffActivity().operations > 0);
  page.loads[0].resolve(); await nextTurn(); assert.equal(f.views.getHandoffActivity().operations, 0);
  assert.equal(f.views.getHandoffActivity().resources, 0); assert.ok(f.views.getHandoffActivity().uncontainedResources > 0);
});
test("view disposal seals creation and removes the original window zoom listener", async t => {
  const f = fixture(t); await f.panels.open(request); const window = windows.at(-1);
  f.views.setWindow(window); assert.equal(window.webContents.listenerCount("zoom-changed"), 1);
  await f.views.dispose(); assert.equal(window.webContents.listenerCount("zoom-changed"), 0);
  assert.throws(() => f.views.open(request), { code: "HOST_BUSY" });
});
test("retired view popup callbacks cannot open external applications", async t => {
  const f = fixture(t); const id = f.views.open(request); const page = pages.at(-1); const count = shell.calls.length;
  f.views.close(request.pluginId, request.viewId, id); page.openWindow({ url: "https://example.com" });
  assert.equal(shell.calls.length, count);
});
test("view popup work retains original completion after disposal", async t => {
  const f = fixture(t); f.views.open(request); shell.pending = deferred();
  pages.at(-1).openWindow({ url: "https://example.com" }); await f.views.dispose();
  assert.ok(f.views.getHandoffActivity().operations > 0); shell.pending.resolve(); await nextTurn();
  assert.equal(f.views.getHandoffActivity().operations, 0);
});
test("closed admission and replaced owners suppress view popup and broadcast", async t => {
  const f = fixture(t); f.views.open(request); const page = pages.at(-1); const count = shell.calls.length;
  f.replace(); page.openWindow({ url: "https://example.com" }); f.views.broadcast("fixture", {});
  assert.equal(shell.calls.length, count); assert.equal(page.sent.length, 0);
  f.closeGate(); assert.throws(() => f.views.open(request), { code: "HOST_BUSY" });
});
test("global shortcut registration refuses closed admission before native registration", t => {
  const f = shortcuts(t); f.closeGate(); assert.throws(f.bind, { code: "HOST_BUSY" }); assert.equal(f.handlers.length, 0);
});
test("retired global shortcut callback cannot invoke a replacement binding", t => {
  const f = shortcuts(t); f.bind(); const old = f.handlers[0]; f.registry.releasePlugin(request.pluginId); f.bind(); old();
  assert.equal(f.triggered.length, 0); f.handlers[1](); assert.equal(f.triggered.length, 1);
});
test("closed admission suppresses native shortcut callbacks while cleanup still works", t => {
  const f = shortcuts(t); f.bind(); f.closeGate(); f.handlers[0](); assert.equal(f.triggered.length, 0);
  f.registry.releasePlugin(request.pluginId); assert.equal(f.removed.length, 1);
});
test("shortcut callback completion remains counted after unregister", async t => {
  const work = deferred(); const f = shortcuts(t, { onTrigger: () => work.promise }); f.bind(); f.handlers[0]();
  f.registry.releasePlugin(request.pluginId);
  try { assert.ok(f.registry.getHandoffActivity().operations > 0); } finally { work.resolve(); await nextTurn(); }
  assert.equal(f.registry.getHandoffActivity().operations, 0); assert.ok(f.registry.getHandoffActivity().uncontainedResources > 0);
});

test("temporary admission closure records view readiness without restarting its document", async t => {
  const f = fixture(t); f.views.open(request); const page = pages.at(-1);
  f.closeGate(); page.emit("did-finish-load"); f.openGate();
  f.views.open({ ...request, location: "/next" });
  assert.equal(page.loads.length, 1); assert.equal(page.sent.at(-1)?.value.path, "/next");
});
test("replacement installation gets a fresh surface while the original retained page stays owned", async t => {
  const f = fixture(t); controls.holdClose = true;
  const first = f.views.open(request); const page = pages.at(-1); f.replace();
  const second = f.views.open(request); assert.notEqual(second, first);
  assert.equal(f.views.getHandoffActivity().resources, 2); assert.equal(page.destroyed, false);
  page.die(); assert.equal(f.views.getHandoffActivity().resources, 1);
});
test("surface asynchronous errors remain observable after their page is closed", async t => {
  const f = fixture(t); f.views.open(request); const page = pages.at(-1); shell.pending = deferred();
  page.openWindow({ url: "https://example.com" }); await f.views.dispose();
  shell.pending.reject(new Error("fixture external failure")); await nextTurn();
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /fixture external failure/);
  assert.equal(f.views.getHandoffActivity().operations, 0);
});
for (const kind of ["panel", "view"]) test(`${kind} IPC rechecks its original plugin after workspace lookup`, async t => {
  const f = fixture(t), lookup = deferred();
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR, "surface-ipc-"));
  writeFileSync(join(root, "index.html"), "<p>fixture</p>"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const loaded = { path: root, permissions: new Set(["ui.panel", "ui.view"]), manifest: { id: request.pluginId,
    name: "Fixture", ui: { panel: "index.html" }, contributes: { views: [{ id: "main", entry: "index.html" }] } } };
  registerPluginUiIpc({ registrar: { handle: (key, handler) => handlers.set(key, handler) },
    plugins: { getLoaded: () => loaded, captureSurfaceOwner: f.options.captureOwner,
      captureWorkspaceContext: () => lookup.promise, createLocalResourceGrant: () => undefined },
    pluginPanels: f.panels, pluginViews: f.views, browserHost: {}, pluginActiveInProject: () => true,
    currentWorkspacePath: () => root, getUpdaterLocale: () => "en", getPluginPanelTheme: () => "light" });
  const count = pages.length;
  const pending = kind === "panel" ? handlers.get(IPC.invoke.pluginOpenPanel)(request.pluginId)
    : handlers.get(IPC.invoke.pluginViewOpen)({ pluginId: request.pluginId, viewId: "main" });
  const result = pending.then(() => null, error => error); f.replace(); lookup.resolve(undefined);
  assert.equal((await result)?.code, "PLUGIN_UNLOADED"); assert.equal(pages.length, count);
});

test("configured surface services without activity reporting refuse an idle inventory", async () => {
  const first = new PluginRuntime({ isAdmissionClosed: () => false, openPanel: async () => {} });
  const second = new PluginRuntime({ isAdmissionClosed: () => false });
  try {
    assert.equal(first.getHandoffActivity().uncontainedResources, 1);
    assert.equal(second.getHandoffActivity().uncontainedResources, 0);
    second.setServices({ openPanel: async () => {} });
    assert.equal(second.getHandoffActivity().uncontainedResources, 1);
  } finally { await first.disposeAll(); await second.disposeAll(); }
});
test("admission closing inside native shortcut registration releases the original attempt", t => {
  const f = shortcuts(t, { register: () => { f.closeGate(); return true; } });
  assert.throws(f.bind, { code: "HOST_BUSY" }); assert.equal(f.removed.length, 1);
  assert.deepEqual(f.registry.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});
