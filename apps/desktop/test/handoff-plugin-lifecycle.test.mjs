import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function outcome(promise) { return promise.then(value => ({ value }), error => ({ error })); }
function processFixture(block = () => false) {
  let message = () => {}, exit = () => {};
  const sent = [], waiting = new Map();
  let kills = 0;
  return {
    sent, waiting,
    get kills() { return kills; },
    postMessage(value) {
      sent.push(value);
      if (value.t !== "init" && value.t !== "call") return;
      if (block(value)) { waiting.set(value.method ?? value.t, value); return; }
      queueMicrotask(() => this.reply(value));
    },
    reply(value, result = null) { message({ t: "res", id: value.id, ok: true, value: result }); },
    onMessage(handler) { message = handler; },
    onExit(handler) { exit = handler; },
    kill() { kills += 1; exit(0); },
    emitExit(code) { exit(code); },
  };
}
function setup(t, options = {}) {
  const directory = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-handoff-"));
  const id = "test.handoff-lifecycle";
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id,
    name: "Handoff fixture", version: "1.0.0", main: "main.js", permissions: ["background.service"],
    contributes: { services: options.services ?? [] } }));
  writeFileSync(join(directory, "main.js"), "module.exports = {};\n");
  let closed = false;
  const children = [], changes = [];
  const runtime = new PluginRuntime({ isAdmissionClosed: () => closed,
    spawnProcess: () => { const child = processFixture(); children.push(child); return child; },
    onServiceChange: status => changes.push(status), ...options.host });
  t.after(async () => { await runtime.disposeAll(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, id, runtime, children, changes, close: () => { closed = true; } };
}

test("closed admission rejects plugin load before spawning", async t => {
  const f = setup(t);
  f.close();
  await assert.rejects(f.runtime.loadFromPath(f.directory), { code: "HOST_BUSY" });
  assert.equal(f.children.length, 0);
});

test("shutdown seals pending process startup and cleans only its late child", async t => {
  const started = deferred(), spawn = deferred(), child = processFixture();
  const f = setup(t, { host: { spawnProcess: () => { started.resolve(); return spawn.promise; } } });
  const loading = outcome(f.runtime.loadFromPath(f.directory));
  await started.promise;
  await f.runtime.disposeAll();
  spawn.resolve(child);
  const result = await loading;
  assert.equal(result.error?.code, "PLUGIN_UNLOADED");
  assert.equal(child.kills, 1);
  assert.equal(child.sent.some(item => item.t === "init"), false);
  assert.deepEqual(f.runtime.listLoaded(), []);
  await assert.rejects(f.runtime.loadFromPath(f.directory), { code: "PLUGIN_UNLOADED" });
});

test("unload invalidates a startup that has not returned a process yet", async t => {
  const started = deferred(), spawn = deferred(), child = processFixture();
  const f = setup(t, { host: { spawnProcess: () => { started.resolve(); return spawn.promise; } } });
  const loading = outcome(f.runtime.loadFromPath(f.directory));
  await started.promise;
  await f.runtime.unload(f.id);
  spawn.resolve(child);
  const result = await loading;
  assert.equal(result.error?.code, "PLUGIN_UNLOADED");
  assert.equal(child.kills, 1);
  assert.deepEqual(f.runtime.listLoaded(), []);
});

test("a superseded spawn cannot replace or unload a newer loaded plugin", async t => {
  const started = deferred(), spawn = deferred(), first = processFixture(), second = processFixture();
  let count = 0;
  const f = setup(t, { host: { spawnProcess: () => { if (++count === 1) { started.resolve(); return spawn.promise; } return second; } } });
  const old = outcome(f.runtime.loadFromPath(f.directory));
  await started.promise;
  await f.runtime.loadFromPath(f.directory);
  const current = f.runtime.getLoaded(f.id);
  spawn.resolve(first);
  assert.equal((await old).error?.code, "PLUGIN_UNLOADED");
  assert.equal(f.runtime.getLoaded(f.id), current);
  assert.equal(current.child, second);
  assert.equal(first.kills, 1);
  assert.equal(second.kills, 0);
});

test("admission closing during process creation prevents initialization", async t => {
  const started = deferred(), spawn = deferred(), child = processFixture();
  const f = setup(t, { host: { spawnProcess: () => { started.resolve(); return spawn.promise; } } });
  const loading = outcome(f.runtime.loadFromPath(f.directory));
  await started.promise;
  f.close();
  spawn.resolve(child);
  assert.equal((await loading).error?.code, "HOST_BUSY");
  assert.equal(child.kills, 1);
  assert.equal(child.sent.length, 0);
});

test("a late service start cannot publish running or start its sibling after unload", async t => {
  const started = deferred();
  const child = processFixture(value => { if (value.method === "service.start") { started.resolve(); return true; } return false; });
  const f = setup(t, { services: [{ id: "first" }, { id: "second" }], host: { spawnProcess: () => child } });
  const loading = outcome(f.runtime.loadFromPath(f.directory));
  await started.promise;
  const pending = child.waiting.get("service.start");
  const unloading = f.runtime.unload(f.id);
  child.reply(pending);
  await unloading;
  const result = await loading;
  assert.equal(result.error?.code, "PLUGIN_UNLOADED");
  assert.equal(child.sent.filter(item => item.method === "service.start").length, 1);
  assert.equal(f.changes.some(status => status.state === "running"), false);
  assert.deepEqual(f.runtime.getServiceStates(), []);
});

test("pending startup remains counted after shutdown until its original promise settles", async t => {
  const started = deferred(), spawn = deferred(), child = processFixture();
  const f = setup(t, { host: { spawnProcess: () => { started.resolve(); return spawn.promise; } } });
  const loading = outcome(f.runtime.loadFromPath(f.directory));
  await started.promise;
  try {
    await f.runtime.disposeAll();
    assert.ok(f.runtime.getHandoffActivity().operations > 0);
    assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
  } finally { spawn.resolve(child); await loading; }
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
});

test("a later load waits for the original pre-load cleanup", async t => {
  const entered = deferred(), close = deferred();
  let calls = 0, staleNotifications = 0;
  const f = setup(t, { host: {
    closePanel: async () => { if (++calls === 1) { entered.resolve(); await close.promise; } },
    onPluginUnload: () => { if (f.runtime.listLoaded().length) staleNotifications += 1; },
  } });
  const first = outcome(f.runtime.loadFromPath(f.directory));
  await entered.promise;
  const second = outcome(f.runtime.loadFromPath(f.directory));
  await new Promise(resolve => setImmediate(resolve));
  const spawnedBeforeCleanup = f.children.length;
  close.resolve();
  await Promise.all([first, second]);
  assert.equal(spawnedBeforeCleanup, 0);
  assert.equal(staleNotifications, 0);
  assert.equal(f.runtime.listLoaded().length, 1);
});

test("concurrent unloads join one original hook and preserve late-load isolation", async t => {
  const stopping = deferred();
  const child = processFixture(value => { if (value.method === "lifecycle.unload") { stopping.resolve(); return true; } return false; });
  const replacement = processFixture();
  let count = 0;
  const f = setup(t, { host: { spawnProcess: () => ++count === 1 ? child : replacement } });
  await f.runtime.loadFromPath(f.directory);
  const first = f.runtime.unload(f.id), second = f.runtime.unload(f.id);
  await stopping.promise;
  const loading = f.runtime.loadFromPath(f.directory);
  child.reply(child.waiting.get("lifecycle.unload"));
  await Promise.all([first, second, loading]);
  assert.equal(child.sent.filter(value => value.method === "lifecycle.unload").length, 1);
  assert.equal(child.kills, 1);
  assert.equal(f.runtime.getLoaded(f.id).child, replacement);
});

for (const action of ["unload", "shutdown", "gate"]) {
  test(`${action} prevents a pending crash restart from creating another process`, async t => {
    const f = setup(t, { services: [{ id: "worker" }] });
    await f.runtime.loadFromPath(f.directory);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.children[0].emitExit(7);
    assert.equal(f.runtime.getHandoffActivity().schedules, 1);
    if (action === "unload") await f.runtime.unload(f.id);
    if (action === "shutdown") await f.runtime.disposeAll();
    if (action === "gate") f.close();
    t.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.children.length, 1);
    assert.equal(f.runtime.getHandoffActivity().schedules, 0);
  });
}

test("ordinary unload allows a later explicit load but shutdown remains sealed", async t => {
  const f = setup(t);
  await f.runtime.loadFromPath(f.directory);
  await f.runtime.unload(f.id);
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.equal(f.runtime.getHandoffActivity().plugins, 0);
  assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
  await f.runtime.loadFromPath(f.directory);
  assert.equal(f.children.length, 2);
  await f.runtime.disposeAll();
  await assert.rejects(f.runtime.loadFromPath(f.directory), { code: "PLUGIN_UNLOADED" });
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
});

test("a failed native process attempt retains refusal evidence without a loaded entry", async t => {
  const f = setup(t, { host: { spawnProcess: () => { throw new Error("fixture startup failure"); } } });
  await assert.rejects(f.runtime.loadFromPath(f.directory), /fixture startup failure/);
  await f.runtime.disposeAll();
  assert.deepEqual(f.runtime.getHandoffActivity(), { operations: 0, plugins: 0, schedules: 0, uncontainedResources: 1 });
});

test("shutdown budget does not erase an original unload still awaiting panel cleanup", async t => {
  const entered = deferred(), close = deferred();
  let armed = false;
  const f = setup(t, { host: { closePanel: async () => {
    if (armed) { entered.resolve(); await close.promise; }
  } } });
  await f.runtime.loadFromPath(f.directory);
  armed = true;
  const unloading = f.runtime.unload(f.id);
  await entered.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shutdown = f.runtime.disposeAll();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await shutdown;
  assert.ok(f.runtime.getHandoffActivity().operations > 0);
  assert.deepEqual(f.runtime.listLoaded(), []);
  close.resolve();
  await unloading;
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
});

test("closed admission still reports a crash but schedules no replacement", async t => {
  const f = setup(t, { services: [{ id: "worker" }] });
  await f.runtime.loadFromPath(f.directory);
  f.close();
  f.children[0].emitExit(7);
  assert.equal(f.runtime.getServiceStates()[0].state, "failed");
  assert.equal(f.runtime.getHandoffActivity().schedules, 0);
});

test("a superseded crash restart cannot overwrite the replacement service state", async t => {
  const entered = deferred(), spawn = deferred(), original = processFixture(), late = processFixture(), replacement = processFixture();
  let calls = 0;
  const f = setup(t, { services: [{ id: "worker" }], host: { spawnProcess: () => {
    calls += 1;
    if (calls === 1) return original;
    if (calls === 2) { entered.resolve(); return spawn.promise; }
    return replacement;
  } } });
  await f.runtime.loadFromPath(f.directory);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  original.emitExit(7);
  t.mock.timers.tick(1000);
  await entered.promise;
  await f.runtime.loadFromPath(f.directory);
  spawn.resolve(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.kills, 1);
  assert.equal(f.runtime.getLoaded(f.id).child, replacement);
  assert.equal(f.runtime.getServiceStates()[0].state, "running");
});

test("shutdown marks loaded children before any asynchronous cleanup callback", async t => {
  const crashes = [];
  const f = setup(t, { host: { onPluginCrash: value => crashes.push(value) } });
  await f.runtime.loadFromPath(f.directory);
  const shutdown = f.runtime.disposeAll();
  f.children[0].emitExit(7);
  await shutdown;
  assert.deepEqual(crashes, []);
});
