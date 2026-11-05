/**
 * Workspace plugin consent: main-owned queue/lifecycle broker, its IPC gate, and
 * the grant persistence performed by the workspace plugin services.
 *
 * The broker/IPC tests use a fake BrowserWindow (only webContents.send and the
 * Electron event emitters are simulated). The persistence tests run the real
 * RemoteWorkspacePlugins against a fake Host client, so only the remote
 * transport (and, implicitly, the Host's workspace/plugin RPCs) is simulated.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { createWorkspacePluginConsent } = await import(
  "../electron/main/services/workspace-plugin-consent.ts"
);
const { registerWorkspacePluginConsentIpc } = await import(
  "../electron/main/ipc/workspace-plugin-consent-ipc.ts"
);
const { createWorkspacePluginServices } = await import(
  "../electron/main/services/workspace-plugin-services.ts"
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Observe settlement without leaving an unhandled rejection behind. */
function settled(promise) {
  const state = { done: false, value: undefined, error: undefined };
  promise.then(
    (value) => { state.done = true; state.value = value; },
    (error) => { state.done = true; state.error = error; },
  );
  return state;
}

function fakeWindow(id = 1) {
  const sent = [];
  const failures = { send: 0 };
  const contentsEvents = new Map();
  const windowEvents = new Map();
  const bag = (map, event) => {
    if (!map.has(event)) map.set(event, new Set());
    return map.get(event);
  };
  const count = (map) => [...map.values()].reduce((total, set) => total + set.size, 0);
  const webContents = {
    id,
    mainFrame: { id: `${id}-main-frame` },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(channel, payload) {
      if (failures.send > 0) { failures.send -= 1; throw new Error("renderer is gone"); }
      if (this.destroyed) throw new Error("WebContents is destroyed");
      sent.push({ channel, payload });
    },
    on(event, listener) { bag(contentsEvents, event).add(listener); },
    removeListener(event, listener) { bag(contentsEvents, event).delete(listener); },
  };
  const window = {
    webContents,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    on(event, listener) { bag(windowEvents, event).add(listener); },
    removeListener(event, listener) { bag(windowEvents, event).delete(listener); },
  };
  const picked = (channel) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload);
  return {
    window,
    webContents,
    sent,
    failures,
    emitContents(event, ...args) { for (const listener of [...bag(contentsEvents, event)]) listener(...args); },
    emitWindow(event, ...args) { for (const listener of [...bag(windowEvents, event)]) listener(...args); },
    listenerCount() { return count(contentsEvents) + count(windowEvents); },
    shown: () => picked(IPC.event.pluginWorkspaceConsentRequest),
    dismissed: () => picked(IPC.event.pluginWorkspaceConsentDismiss),
  };
}

const ask = (consent, pluginId, pluginName = pluginId) =>
  consent.request({ pluginId, pluginName, hostKey: "host-a" });

test("requests wait for renderer readiness and only one prompt is visible at a time", async () => {
  const win = fakeWindow(11);
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  const first = settled(ask(consent, "demo.one", "One"));
  const second = settled(ask(consent, "demo.two", "Two"));
  await flush();
  assert.equal(win.shown().length, 0, "nothing may be displayed before the renderer acknowledges readiness");
  assert.equal(consent.markReady(99, true), false, "a foreign webContents cannot mark the dialog ready");
  assert.equal(consent.markReady(11, true), true);
  assert.equal(win.shown().length, 1, "queued requests are displayed one at a time");

  const request = win.shown()[0];
  assert.deepEqual(Object.keys(request).sort(), ["hostKey", "pluginName", "requestId"]);
  assert.equal(request.pluginName, "One");
  assert.equal(request.hostKey, "host-a");
  assert.equal(typeof request.requestId, "string");

  assert.equal(consent.respond(11, request.requestId, true), true);
  assert.deepEqual(win.dismissed(), [{ requestId: request.requestId }]);
  assert.equal(win.shown().length, 2, "the next queued prompt is displayed as soon as the first is answered");
  await flush();
  assert.equal(first.done, true);
  assert.equal(first.value, true);
  assert.equal(second.done, false, "the second request stays unanswered until it is displayed");

  const next = win.shown()[1];
  assert.notEqual(next.requestId, request.requestId);
  assert.equal(next.pluginName, "Two");
  assert.equal(consent.respond(11, next.requestId, false), true);
  await flush();
  assert.equal(await second.value, false);
  assert.equal(win.dismissed().length, 2);
  consent.dispose();
});

test("stale, duplicate, and foreign responses never settle the visible request", async () => {
  const win = fakeWindow(12);
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  consent.markReady(12, true);
  const pending = settled(ask(consent, "demo.one", "One"));
  await flush();
  const request = win.shown()[0];

  assert.equal(consent.respond(12, "00000000-0000-0000-0000-000000000000", true), false);
  assert.equal(consent.respond(77, request.requestId, true), false, "another window cannot answer");
  assert.equal(consent.respond(12, `${request.requestId}x`, true), false);
  await flush();
  assert.equal(pending.done, false);
  assert.equal(win.dismissed().length, 0, "a rejected answer must not dismiss the visible prompt");

  assert.equal(consent.respond(12, request.requestId, true), true);
  assert.equal(consent.respond(12, request.requestId, false), false, "a repeated answer is ignored");
  await flush();
  assert.equal(pending.value, true);
  assert.equal(win.shown().length, 1, "a duplicate answer cannot advance the queue twice");
  consent.dispose();
});

test("cancelling a plugin ends its visible and queued prompts and advances the queue", async () => {
  const win = fakeWindow(13);
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  consent.markReady(13, true);
  const visible = settled(ask(consent, "plugin.a", "A"));
  const other = settled(ask(consent, "plugin.b", "B"));
  const queued = settled(ask(consent, "plugin.a", "A2"));
  await flush();
  assert.equal(win.shown().length, 1);

  consent.cancelPlugin("plugin.a");
  await flush();
  assert.equal(visible.value, false);
  assert.equal(queued.value, false);
  assert.equal(other.done, false, "other plugins keep waiting");
  assert.deepEqual(win.dismissed(), [{ requestId: win.shown()[0].requestId }]);
  assert.equal(win.shown().length, 2, "the next plugin prompt is displayed immediately");
  assert.equal(win.shown()[1].pluginName, "B");

  consent.cancelPlugin("plugin.unknown");
  assert.equal(other.done, false);
  assert.equal(win.shown().length, 2);
  assert.equal(consent.respond(13, win.shown()[1].requestId, true), true);
  await flush();
  assert.equal(other.value, true);
  consent.dispose();
});

test("main-frame navigation ends every pending request until readiness returns", async () => {
  const win = fakeWindow(14);
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  consent.markReady(14, true);
  const visible = settled(ask(consent, "demo.one", "One"));
  const queued = settled(ask(consent, "demo.two", "Two"));
  await flush();
  assert.equal(win.shown().length, 1);

  win.emitContents("did-start-navigation", {}, "https://app.test/frame", false, false);
  win.emitContents("did-start-navigation", {}, "https://app.test/view#section", true, true);
  await flush();
  assert.equal(visible.done, false, "subframe and same-document navigation keep the prompt");

  win.emitContents("did-start-navigation", {}, "https://app.test/reloaded", false, true);
  await flush();
  assert.equal(visible.value, false);
  assert.equal(queued.value, false);
  assert.equal(win.dismissed().length, 2, "every queued prompt is dismissed with its request id");

  const later = settled(ask(consent, "demo.three", "Three"));
  await flush();
  assert.equal(later.done, false);
  assert.equal(win.shown().length, 1, "a torn-down renderer receives no new prompt");
  assert.equal(consent.markReady(14, true), true);
  assert.equal(win.shown().length, 2);
  consent.dispose();
});

test("render loss keeps the owner, while close and dispose detach every listener", async () => {
  const crashed = fakeWindow(15);
  const crashConsent = createWorkspacePluginConsent({ getWindow: () => crashed.window });
  crashConsent.markReady(15, true);
  const active = settled(ask(crashConsent, "demo.one", "One"));
  await flush();
  assert.equal(crashed.shown().length, 1);
  crashed.emitContents("render-process-gone", {}, { reason: "crashed" });
  await flush();
  assert.equal(active.value, false);
  assert.equal(crashed.listenerCount(), 4, "the owner stays attached so a reloaded renderer can answer");
  const retried = settled(ask(crashConsent, "demo.two", "Two"));
  await flush();
  assert.equal(retried.done, false);
  crashConsent.markReady(15, true);
  assert.equal(crashed.shown().length, 2);
  crashConsent.dispose();
  await flush();
  assert.equal(retried.value, false);
  assert.equal(crashed.listenerCount(), 0);
  const afterDispose = settled(ask(crashConsent, "demo.three", "Three"));
  await flush();
  assert.equal(afterDispose.value, false);

  const closing = fakeWindow(16);
  const closeConsent = createWorkspacePluginConsent({ getWindow: () => closing.window });
  closeConsent.markReady(16, true);
  const open = settled(ask(closeConsent, "demo.one", "One"));
  await flush();
  closing.window.destroyed = true;
  closing.emitWindow("closed");
  await flush();
  assert.equal(open.value, false);
  assert.equal(closing.listenerCount(), 0);
  const orphan = settled(ask(closeConsent, "demo.two", "Two"));
  await flush();
  assert.equal(orphan.value, false, "a closed window refuses new prompts");
  closeConsent.dispose();

  const destroyed = fakeWindow(17);
  const destroyConsent = createWorkspacePluginConsent({ getWindow: () => destroyed.window });
  destroyConsent.markReady(17, true);
  const live = settled(ask(destroyConsent, "demo.one", "One"));
  await flush();
  destroyed.webContents.destroyed = true;
  destroyed.emitContents("destroyed");
  await flush();
  assert.equal(live.value, false);
  assert.equal(destroyed.dismissed().length, 0, "a destroyed renderer receives no dismiss message");
  assert.equal(destroyed.listenerCount(), 0);
  destroyConsent.dispose();
});

test("a failed send rejects that request and shows the next pending one", async () => {
  const win = fakeWindow(18);
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  consent.markReady(18, true);
  win.failures.send = 1;
  const failed = ask(consent, "demo.one", "One");
  const next = settled(ask(consent, "demo.two", "Two"));
  await assert.rejects(failed, /renderer is gone/);
  await flush();
  assert.equal(win.shown().length, 1);
  assert.equal(win.shown()[0].pluginName, "Two");
  assert.equal(next.done, false);
  consent.dispose();
  await flush();
  assert.equal(next.value, false);
});

test("the pending queue refuses work beyond its bound instead of growing without limit", async () => {
  const win = fakeWindow(19);
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  consent.markReady(19, true);
  const accepted = [];
  for (let index = 0; index < 32; index += 1) accepted.push(settled(ask(consent, "demo.queue", `Q${index}`)));
  await flush();
  assert.equal(win.shown().length, 1);
  assert.equal(await ask(consent, "demo.queue", "Q32"), false, "the 33rd request is refused immediately");
  assert.equal(win.shown().length, 1);
  consent.dispose();
  await flush();
  assert.deepEqual(accepted.map((entry) => entry.value), Array(32).fill(false));
  assert.equal(win.listenerCount(), 0);
});

function ipcHarness() {
  const win = fakeWindow(21);
  const handlers = new Map();
  const plainHandles = [];
  const consent = createWorkspacePluginConsent({ getWindow: () => win.window });
  registerWorkspacePluginConsentIpc({
    handle(channel) { plainHandles.push(channel); },
    handleWithEvent(channel, handler) { handlers.set(channel, handler); },
    assertMainWindowSender(event) {
      if (event.sender.id !== win.webContents.id) {
        throw Object.assign(new Error("renderer is not the main window"), { errorCode: "PERMISSION_DENIED" });
      }
    },
  }, consent);
  const event = (sender = win.webContents, senderFrame = win.webContents.mainFrame) => ({ sender, senderFrame });
  return {
    win,
    consent,
    handlers,
    plainHandles,
    event,
    ready: (payload = undefined, args = event()) => handlers.get(IPC.invoke.pluginWorkspaceConsentReady)(args, payload),
    respond: (payload = undefined, args = event()) => handlers.get(IPC.invoke.pluginWorkspaceConsentRespond)(args, payload),
  };
}

test("consent channels go through handleWithEvent and require the main window's top frame", async () => {
  const harness = ipcHarness();
  assert.deepEqual([...harness.handlers.keys()].sort(),
    [IPC.invoke.pluginWorkspaceConsentReady, IPC.invoke.pluginWorkspaceConsentRespond].sort());
  assert.deepEqual(harness.plainHandles, [], "consent never registers a sender-less handler");

  const pending = settled(ask(harness.consent, "demo.one", "One"));
  const foreign = { id: 999, mainFrame: {} };
  await assert.rejects(async () => harness.ready({ ready: true }, harness.event(foreign, foreign.mainFrame)),
    { errorCode: "PERMISSION_DENIED" });
  await assert.rejects(async () => harness.ready({ ready: true }, harness.event(harness.win.webContents, { id: "child-frame" })),
    { errorCode: "PERMISSION_DENIED" });
  await assert.rejects(async () => harness.respond({ requestId: "any", allowed: true }, harness.event(harness.win.webContents, { id: "child-frame" })),
    { errorCode: "PERMISSION_DENIED" });
  await flush();
  assert.equal(harness.win.shown().length, 0, "a rejected sender cannot mark the dialog ready");
  assert.equal(pending.done, false);

  assert.deepEqual(await harness.ready({ ready: true }), { ready: true });
  const request = harness.win.shown()[0];
  assert.deepEqual(await harness.respond({ requestId: request.requestId, allowed: true }), { accepted: true });
  await flush();
  assert.equal(pending.value, true);
  assert.deepEqual(await harness.respond({ requestId: request.requestId, allowed: true }), { accepted: false });
  assert.deepEqual(await harness.ready({ ready: false }), { ready: false });
});

test("invalid consent payloads are rejected without consuming the visible request", async () => {
  const harness = ipcHarness();
  await harness.ready({ ready: true });
  const pending = settled(ask(harness.consent, "demo.one", "One"));
  await flush();
  const request = harness.win.shown()[0];

  for (const payload of [undefined, null, "true", 1, [], {}, { ready: "true" }, { ready: 0 }, { ready: null }]) {
    await assert.rejects(async () => harness.ready(payload), { errorCode: "INVALID_ARGUMENT" });
  }
  for (const payload of [undefined, null, {}, { requestId: "", allowed: true }, { requestId: 7, allowed: true },
    { requestId: "a".repeat(65), allowed: true }, { requestId: request.requestId },
    { requestId: request.requestId, allowed: "yes" }, { requestId: request.requestId, allowed: 1 }]) {
    await assert.rejects(async () => harness.respond(payload), { errorCode: "INVALID_ARGUMENT" });
  }
  await flush();
  assert.equal(pending.done, false);
  assert.equal(harness.win.dismissed().length, 0);
  assert.equal(harness.win.shown().length, 1);

  assert.deepEqual(await harness.respond({ requestId: "a".repeat(64), allowed: true }), { accepted: false });
  assert.deepEqual(await harness.respond({ requestId: request.requestId, allowed: false }), { accepted: true });
  await flush();
  assert.equal(pending.value, false);
});

async function scratch(t) {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-workspace-consent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function pluginPackage(root, name, id = "fixture.remote", body = "") {
  const dir = join(root, name);
  await mkdir(dir);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: "Fixture", version: "1.0.0", main: "main.cjs",
    execution: { main: "workspace" },
  }));
  await writeFile(join(dir, "main.cjs"), `module.exports = {};\n${body}`);
  return dir;
}

/** Stands in for host-core's plugins.workspaceExecution.get/set pair. */
function workspaceHost() {
  const grants = new Map();
  const calls = [];
  const key = (input) => JSON.stringify([input.id, input.hostKey, input.digest]);
  return {
    calls,
    grants,
    async call(method, input) {
      calls.push({ method, input });
      if (method === "plugins.workspaceExecution.set") {
        assert.equal(input.allowed, true, "only approvals are persisted");
        grants.set(key(input), input.allowed);
        return { allowed: input.allowed };
      }
      if (method === "plugins.workspaceExecution.get") return { allowed: grants.get(key(input)) ?? false };
      throw new Error(`unexpected host method: ${method}`);
    },
    sets: () => calls.filter((entry) => entry.method === "plugins.workspaceExecution.set"),
    gets: () => calls.filter((entry) => entry.method === "plugins.workspaceExecution.get"),
  };
}

/** The desktop-side RemoteHostClient surface used by RemoteWorkspacePlugins. */
function remoteClient(log) {
  const requests = [];
  return {
    requests,
    state: () => "connected",
    generation: () => 1,
    handleServerRequest: () => () => {},
    subscribeState: () => () => {},
    async request(method, input) {
      assert.equal(method, "workspace/plugin");
      requests.push(input);
      if (input.action === "describe") return {};
      if (input.action === "packageBegin") return { present: true };
      if (input.action === "open") log.opens.push(input.instanceId);
      return { ok: true };
    },
  };
}

function servicesFixture(t) {
  const log = { opens: [] };
  const state = {
    host: null, prompts: [], clients: new Map(), duringConsent: null, decide: async () => true,
  };
  const services = createWorkspacePluginServices({
    getHost: () => state.host,
    currentWorkspacePath: () => null,
    client(hostKey) {
      if (!state.clients.has(hostKey)) state.clients.set(hostKey, remoteClient(log));
      return state.clients.get(hostKey);
    },
    async requestConsent(input) {
      state.prompts.push(input);
      if (state.duringConsent) await state.duringConsent(input);
      return state.decide(input);
    },
  });
  t.after(() => services.disposeWorkspaceProcesses());
  return { services, state, log };
}

const remoteContext = (hostKey = "host-a") => ({
  workspaceId: "work", projectId: "project", authority: { kind: "remote", hostKey },
  roots: [{ path: "/work", name: "Work", primary: true }],
  platform: "linux", connectionState: "connected", generation: 1,
});

test("one approval is stored per plugin, host, and package digest", async (t) => {
  const root = await scratch(t);
  const firstPackage = await pluginPackage(root, "first");
  const fixture = servicesFixture(t);
  fixture.state.host = workspaceHost();
  const spawn = (pluginPath, hostKey = "host-a") => fixture.services.spawnWorkspaceProcess({
    pluginPath, entry: "main.cjs", context: remoteContext(hostKey), permissions: [],
  });

  await spawn(firstPackage);
  assert.equal(fixture.state.prompts.length, 1);
  const prompt = fixture.state.prompts[0];
  assert.equal(prompt.pluginId, "fixture.remote");
  assert.equal(prompt.pluginName, "Fixture");
  assert.equal(prompt.hostKey, "host-a");
  assert.match(prompt.digest, /^[a-f0-9]{64}$/);
  const sets = fixture.state.host.sets();
  assert.deepEqual(sets.map((entry) => entry.input), [
    { id: "fixture.remote", hostKey: "host-a", digest: prompt.digest, allowed: true },
  ]);

  await spawn(firstPackage);
  assert.equal(fixture.state.prompts.length, 1, "the same binding is not offered twice");
  assert.equal(fixture.state.host.sets().length, 1);
  assert.equal(fixture.log.opens.length, 2);
  assert.equal(await fixture.services.isWorkspaceExecutionAvailable({
    pluginId: "fixture.remote", pluginPath: firstPackage, context: remoteContext(),
  }), true);

  await spawn(firstPackage, "host-b");
  assert.equal(fixture.state.prompts.length, 2, "another Host requires its own approval");
  assert.equal(fixture.state.prompts[1].hostKey, "host-b");
  assert.equal(fixture.state.host.sets().length, 2);

  const changedPackage = await pluginPackage(root, "changed", "fixture.remote", "// changed\n");
  await spawn(changedPackage);
  assert.equal(fixture.state.prompts.length, 3, "a changed package digest requires its own approval");
  assert.notEqual(fixture.state.prompts[2].digest, prompt.digest);
  assert.equal(fixture.state.host.sets().length, 3);
});

test("a declined prompt is never persisted and keeps the package refused", async (t) => {
  const root = await scratch(t);
  const deniedPackage = await pluginPackage(root, "denied", "fixture.denied");
  const fixture = servicesFixture(t);
  fixture.state.host = workspaceHost();
  fixture.state.decide = async () => false;
  const input = { pluginPath: deniedPackage, entry: "main.cjs", context: remoteContext(), permissions: [] };

  await assert.rejects(fixture.services.spawnWorkspaceProcess(input), (error) => error.code === "PERMISSION_DENIED");
  assert.equal(fixture.state.prompts.length, 1);
  assert.equal(fixture.state.host.sets().length, 0, "a refusal must not write a grant");
  assert.equal(fixture.state.host.gets().length, 1);
  assert.equal(fixture.log.opens.length, 0);
  assert.equal(await fixture.services.isWorkspaceExecutionAvailable({
    pluginId: "fixture.denied", pluginPath: deniedPackage, context: remoteContext(),
  }), false, "a declined package stays refused until it is unloaded");

  await assert.rejects(fixture.services.spawnWorkspaceProcess(input), (error) => error.code === "PERMISSION_DENIED");
  assert.equal(fixture.state.prompts.length, 1, "polling cannot repeat the declined prompt");

  fixture.services.forgetWorkspacePluginDecisions("fixture.denied");
  assert.equal(await fixture.services.isWorkspaceExecutionAvailable({
    pluginId: "fixture.denied", pluginPath: deniedPackage, context: remoteContext(),
  }), true);
  fixture.state.decide = async () => true;
  await fixture.services.spawnWorkspaceProcess(input);
  assert.equal(fixture.state.prompts.length, 2);
  assert.deepEqual(fixture.state.host.sets().map((entry) => entry.input.allowed), [true]);
});

test("a replaced workspace owner invalidates an in-flight approval instead of saving it", async (t) => {
  const root = await scratch(t);
  const swapPackage = await pluginPackage(root, "swap", "fixture.swap");
  const fixture = servicesFixture(t);
  const original = workspaceHost();
  const replacement = workspaceHost();
  fixture.state.host = original;
  fixture.state.duringConsent = async () => { fixture.state.host = replacement; };

  await assert.rejects(fixture.services.spawnWorkspaceProcess({
    pluginPath: swapPackage, entry: "main.cjs", context: remoteContext(), permissions: [],
  }), /Plugin authorization owner changed/);
  assert.equal(fixture.state.prompts.length, 1);
  assert.equal(original.sets().length, 0, "the replaced owner never receives a grant");
  assert.equal(replacement.sets().length, 0);
  assert.equal(replacement.calls.length, 0);
  assert.equal(fixture.log.opens.length, 0);
});

test("concurrent identical bindings share a single prompt", async (t) => {
  const root = await scratch(t);
  const sharedPackage = await pluginPackage(root, "shared", "fixture.shared");
  const fixture = servicesFixture(t);
  fixture.state.host = workspaceHost();
  const spawn = () => fixture.services.spawnWorkspaceProcess({
    pluginPath: sharedPackage, entry: "main.cjs", context: remoteContext(), permissions: [],
  });

  let release;
  const prompted = new Promise((resolve) => {
    fixture.state.decide = () => {
      resolve();
      return new Promise((settle) => { release = () => settle(true); });
    };
  });
  const both = Promise.all([spawn(), spawn()]);
  await prompted;
  // Let the second spawn reach the shared approval gate before the answer arrives.
  for (let turn = 0; turn < 20; turn += 1) await flush();
  assert.equal(typeof release, "function");
  release();
  await both;
  assert.equal(fixture.state.prompts.length, 1, "an identical binding joins the pending approval");
  assert.equal(fixture.state.host.sets().length, 1);
  assert.equal(fixture.log.opens.length, 2);
});
