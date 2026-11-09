import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const deferred = () => Promise.withResolvers();
const job = { role: "synthesize", binding: { protocol: "fixture.speech" } };
const descriptor = { protocol: "fixture.speech", label: "Fixture", roles: ["synthesize"] };
async function fixture(t) {
  const root = await mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR || tmpdir()), "speech-plugin-"));
  const id = "fixture.speech-owner", children = [], entered = deferred(); let hold = false, closed = false;
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: id, version: "1.0.0", main: "main.js", permissions: ["speech.adapter.register", "clipboard.write"] }));
  await writeFile(join(root, "main.js"), "module.exports = {};\n");
  const runtime = new PluginRuntime({ isAdmissionClosed: () => closed, spawnProcess: () => {
    let receive, exit, next = 0; const answers = new Map(), sent = [];
    const child = { sent, postMessage(message) {
      sent.push(message);
      if (message.t === "res") { answers.get(message.id)?.resolve(message); answers.delete(message.id); return; }
      if (message.t !== "init" && message.t !== "call") return;
      if (message.method === "speech.handle" && hold) { entered.resolve({ message, child }); return; }
      queueMicrotask(() => child.reply(message));
    }, reply(message) { receive({ t: "res", id: message.id, ok: true, value: message.method === "speech.handle" ? { kind: "text", text: "fixture result" } : null }); },
    request(api, args, context = {}) { const pending = deferred(), requestId = `p${++next}`; answers.set(requestId, pending); receive({ t: "call", id: requestId, api, args, ...context }); return pending.promise; },
    onMessage(fn) { receive = fn; }, onExit(fn) { exit = fn; }, kill() { exit?.(0); } };
    children.push(child); return child;
  } });
  t.after(async () => { await runtime.disposeAll(); await rm(root, { recursive: true, force: true }); });
  await runtime.loadFromPath(root);
  const registerAdapter = async () => assert.equal((await children.at(-1).request("speech.registerAdapter", [descriptor])).ok, true);
  await registerAdapter();
  return { root, id, runtime, children, entered, registerAdapter, hold: () => { hold = true; }, close: () => { closed = true; } };
}

test("captured Speech adapter rejects same-plugin registration replacement", async t => {
  const f = await fixture(t), original = f.runtime.captureSpeechAdapter("fixture.speech");
  await f.registerAdapter();
  await assert.rejects(original.run(job, {}), { code: "PLUGIN_UNLOADED" });
  assert.equal(f.children[0].sent.some(message => message.method === "speech.handle"), false);
  assert.equal((await f.runtime.runSpeechAdapter(job, {})).text, "fixture result");
});
test("captured Speech adapter never dispatches into a replacement plugin installation", async t => {
  const f = await fixture(t), original = f.runtime.captureSpeechAdapter("fixture.speech");
  await f.runtime.loadFromPath(f.root); await f.registerAdapter();
  await assert.rejects(original.run(job, {}), { code: "PLUGIN_UNLOADED" });
  assert.equal(f.children[1].sent.some(message => message.method === "speech.handle"), false);
});
test("an original adapter reply cannot publish after its registration changes", async t => {
  const f = await fixture(t); f.hold();
  const work = f.runtime.runSpeechAdapter(job, {}); await f.entered.promise; await f.registerAdapter();
  const { message, child } = await f.entered.promise; child.reply(message);
  await assert.rejects(work, { code: "PLUGIN_UNLOADED" }); assert.equal(f.runtime.getHandoffActivity().operations, 0);
});
test("adapter calls retain the original owner check across their child reply", async t => {
  const f = await fixture(t); f.hold(); let current = true;
  const work = f.runtime.captureSpeechAdapter("fixture.speech").run(job, {}, () => {
    if (!current) throw Object.assign(new Error("Host changed"), { errorCode: "HOST_UNAVAILABLE" });
  });
  const { message, child } = await f.entered.promise; current = false; child.reply(message);
  await assert.rejects(work, { errorCode: "HOST_UNAVAILABLE" });
});
test("unloading a pending Speech adapter preserves uncertain original completion", async t => {
  const f = await fixture(t); f.hold();
  const work = f.runtime.runSpeechAdapter(job, {}), rejected = assert.rejects(work, { code: "PLUGIN_UNLOADED" });
  await f.entered.promise; assert.ok(f.runtime.getHandoffActivity().operations > 0);
  await f.runtime.unload(f.id); await rejected;
  assert.equal(f.runtime.getHandoffActivity().operations, 0); assert.ok(f.runtime.getHandoffActivity().uncontainedResources >= 2);
});

test("Speech adapter callbacks retain the originating Host authority before side effects", async t => {
  const f = await fixture(t); f.hold(); let current = true, writes = 0;
  f.runtime.setServices({ writeClipboard: async () => { writes++; } });
  const work = f.runtime.captureSpeechAdapter("fixture.speech").run(job, {}, () => {
    if (!current) throw Object.assign(new Error("Host changed"), { errorCode: "HOST_UNAVAILABLE" });
  });
  const rejected = assert.rejects(work, { errorCode: "HOST_UNAVAILABLE" });
  const { message, child } = await f.entered.promise; current = false;
  const callback = await child.request("clipboard.writeText", ["stale"], { parentCallId: message.id });
  child.reply(message); await rejected;
  assert.equal(callback.error?.code, "HOST_UNAVAILABLE"); assert.equal(writes, 0);
});
