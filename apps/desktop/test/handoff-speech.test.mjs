import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { register, syncBuiltinESMExports } from "node:module";
import test from "node:test";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { createSpeechService } = await import("../electron/main/services/speech-service.ts");
const { executeSpeechHttp } = await import("../../../packages/agent-runtime/src/speech/http.ts");
const deferred = () => Promise.withResolvers();
const code = expected => error => (error.errorCode ?? error.code) === expected;
const audioReply = () => ({ kind: "audio", mimeType: "audio/wav", data: Buffer.from("RIFF fixture").toString("base64") });

async function fixture(t, protocol = "fixture.speech") {
  const dataDir = await fs.mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR || tmpdir()), "speech-owner-"));
  const scratch = join(dataDir, "scratch", "session"); await fs.mkdir(scratch, { recursive: true });
  const input = join(scratch, "input.wav"); await fs.writeFile(input, "RIFF input");
  const calls = [], logs = [], effects = [];
  let closed = false, available = true, handler, adapterRun = async () => audioReply(), currentAdapter = {};
  const settings = { speech: Object.fromEntries(["transcribe", "synthesize"].map(role => [role, { providerId: "provider", modelId: "fixture", protocol }])) };
  const original = { generation: "original", isAvailable: () => available, async call(method, params) {
    calls.push(method); if (handler) await handler(method, params);
    if (method === "settings.get") return settings;
    if (method === "providers.get") return { provider: { id: "provider", baseUrl: "http://127.0.0.1:1/v1", enabled: true } };
    if (method === "providers.getSecret") return { value: "fixture-key" };
    if (method === "session.getScratchPath") return { path: scratch };
    throw new Error(`Unexpected method ${method}`);
  } };
  let host = original;
  const info = { protocol, roles: ["synthesize", "transcribe"], pluginId: "fixture" };
  const plugins = {
    listSpeechAdapters: () => protocol === "fixture.speech" ? [{ id: protocol, label: "Fixture", roles: info.roles, source: "plugin", pluginId: "fixture" }] : [],
    getSpeechAdapter: () => protocol === "fixture.speech" ? currentAdapter : undefined,
    runSpeechAdapter: async (...args) => { effects.push("adapter"); return adapterRun(...args); },
    captureSpeechAdapter() {
      if (protocol !== "fixture.speech") return undefined;
      const originalAdapter = currentAdapter;
      const assertCurrent = () => { if (currentAdapter !== originalAdapter) throw Object.assign(new Error("Adapter retired"), { code: "PLUGIN_UNLOADED" }); };
      return { roles: info.roles, assertCurrent, async run(job, payload, assertOwner) {
        assertCurrent(); assertOwner?.(); const reply = await plugins.runSpeechAdapter(job, payload);
        assertCurrent(); assertOwner?.(); return reply;
      } };
    },
  };
  currentAdapter = info;
  const service = createSpeechService({ dataDir, getHost: () => host, isAdmissionClosed: () => closed, plugins,
    logger: { app: (...args) => logs.push(args) } });
  t.after(async () => { service.dispose?.(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, original, calls, logs, effects, settings, dataDir, scratch, input,
    close: () => { closed = true; }, open: () => { closed = false; }, offline: () => { available = false; },
    replace: () => { host = { ...original, generation: "replacement", call: async () => { effects.push("replacement RPC"); throw new Error("Replacement must not be used"); } }; },
    retireAdapter: () => { currentAdapter = { ...info }; }, onCall: fn => { handler = fn; }, adapter: fn => { adapterRun = fn; },
    synthesize: () => service.synthesize({ sessionId: "session", text: "fixture" }),
    transcribe: () => service.transcribe({ sessionId: "session", path: input }),
  };
}
function pauseHost(f, method) {
  const entered = deferred(), release = deferred();
  f.onCall(async current => { if (current === method) { entered.resolve(); await release.promise; } });
  return { entered, release };
}
function pauseFile(t, name) {
  const entered = deferred(), release = deferred(), original = fs[name];
  t.mock.method(fs, name, async (...args) => { entered.resolve(args); await release.promise; return original(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { entered, release };
}

for (const operation of ["status", "transcribe", "synthesize"]) test(`closed admission refuses Speech ${operation} before Host lookup`, async t => {
  const f = await fixture(t); f.close();
  await assert.rejects(operation === "status" ? f.service.status() : f[operation](), code("HOST_BUSY"));
  assert.deepEqual(f.calls, []);
});
for (const retire of ["replace", "generation", "offline"]) test(`Speech rejects ${retire} after original settings instead of continuing on another owner`, async t => {
  const f = await fixture(t), paused = pauseHost(f, "settings.get"), work = f.synthesize();
  await paused.entered.promise;
  if (retire === "generation") f.original.generation = "new-generation"; else f[retire]();
  paused.release.resolve(); await assert.rejects(work, code("HOST_UNAVAILABLE"));
  assert.deepEqual(f.calls, ["settings.get"]); assert.deepEqual(f.effects, []);
});
test("Speech closure after provider lookup prevents reading its secret", async t => {
  const f = await fixture(t), paused = pauseHost(f, "providers.get"), work = f.synthesize();
  await paused.entered.promise; f.close(); paused.release.resolve(); await assert.rejects(work, code("HOST_BUSY"));
  assert.deepEqual(f.calls, ["settings.get", "providers.get"]);
});
test("Speech secret completion cannot dispatch an adapter after Host replacement", async t => {
  const f = await fixture(t), paused = pauseHost(f, "providers.getSecret"), work = f.synthesize();
  await paused.entered.promise; f.replace(); paused.release.resolve(); await assert.rejects(work, code("HOST_UNAVAILABLE"));
  assert.deepEqual(f.effects, []);
});
test("Speech captures the adapter before provider setup and rejects its replacement", async t => {
  const f = await fixture(t), paused = pauseHost(f, "providers.get"), work = f.synthesize();
  await paused.entered.promise; f.retireAdapter(); paused.release.resolve(); await assert.rejects(work, code("PLUGIN_UNLOADED"));
  assert.deepEqual(f.effects, []);
});
test("late adapter HTTP plan cannot start a request after its Host is replaced", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.adapter(async () => { entered.resolve(); await release.promise; return { kind: "http", call: { url: "http://127.0.0.1:1/v1/speech", parse: "bytes" } }; });
  t.mock.method(globalThis, "fetch", async () => { f.effects.push("fetch"); return new Response("RIFF"); });
  const work = f.synthesize(); await entered.promise; f.replace(); release.resolve(); await assert.rejects(work, code("HOST_UNAVAILABLE"));
  assert.deepEqual(f.effects, ["adapter"]);
});
test("Speech scratch lookup cannot create a directory after admission closes", async t => {
  const f = await fixture(t), paused = pauseHost(f, "session.getScratchPath");
  await fs.rm(f.scratch, { recursive: true });
  const work = f.synthesize(); await paused.entered.promise; f.close(); paused.release.resolve();
  await assert.rejects(work, code("HOST_BUSY")); await assert.rejects(fs.stat(f.scratch), { code: "ENOENT" });
});
test("Speech rechecks admission after file metadata before reading audio bytes", async t => {
  const f = await fixture(t), paused = pauseFile(t, "stat");
  const originalRead = fs.readFile;
  t.mock.method(fs, "readFile", async (...args) => { f.effects.push("read"); return originalRead(...args); }); syncBuiltinESMExports();
  const work = f.transcribe(); await paused.entered.promise; f.close(); paused.release.resolve();
  await assert.rejects(work, code("HOST_BUSY")); assert.deepEqual(f.effects, []);
});
test("disposing Speech retains the original audio read and prevents later adapter work", async t => {
  const f = await fixture(t), paused = pauseFile(t, "readFile"), work = f.transcribe();
  await paused.entered.promise;
  try { f.service.dispose(); assert.ok(f.service.getHandoffActivity().operations > 0); }
  finally { paused.release.resolve(); }
  await assert.rejects(work, code("HOST_BUSY")); assert.deepEqual(f.effects, []);
  assert.equal(f.service.getHandoffActivity().operations, 0);
});
test("an admitted Speech output write stays owned through disposal without rollback or publication", async t => {
  const f = await fixture(t), paused = pauseFile(t, "writeFile"), work = f.synthesize();
  const [output] = await paused.entered.promise;
  try { f.service.dispose(); assert.ok(f.service.getHandoffActivity().operations > 0); }
  finally { paused.release.resolve(); }
  await assert.rejects(work, code("HOST_BUSY"));
  assert.equal(await fs.readFile(output, "utf8"), "RIFF fixture"); assert.deepEqual(f.logs, []);
  assert.equal(f.service.getHandoffActivity().operations, 0);
});
test("Speech retains an abort-ignoring HTTP body until it settles and refuses scratch mutation", async t => {
  const f = await fixture(t, "openai_audio"), entered = deferred(), release = deferred(); let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => { signal = init.signal; return {
    status: 200, ok: true, headers: new Headers({ "content-type": "audio/wav" }), body: null,
    async arrayBuffer() { entered.resolve(); await release.promise; return new TextEncoder().encode("RIFF").buffer; },
  }; });
  const work = f.synthesize(); await entered.promise;
  try { f.service.dispose(); assert.equal(signal.aborted, true); assert.ok(f.service.getHandoffActivity().operations > 0); }
  finally { release.resolve(); }
  await assert.rejects(work, code("HOST_BUSY"));
  assert.equal(f.calls.includes("session.getScratchPath"), false); assert.deepEqual(f.logs, []);
  assert.deepEqual(f.service.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});
test("Speech status never masks original Host replacement as unconfigured settings", async t => {
  const f = await fixture(t), paused = pauseHost(f, "settings.get"), work = f.service.status();
  await paused.entered.promise; f.replace(); paused.release.resolve(); await assert.rejects(work, code("HOST_UNAVAILABLE"));
});
test("a known settings failure preserves status fallback without inventing native work", async t => {
  const f = await fixture(t); f.onCall(async () => { throw Object.assign(new Error("Settings unavailable"), { code: -32000, errorCode: "NOT_FOUND" }); });
  const status = await f.service.status(); assert.equal(status.synthesize.configured, false);
  assert.deepEqual(f.service.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});
test("an unknown original Host completion remains refusal evidence after Speech settles", async t => {
  const f = await fixture(t); f.onCall(async () => { throw Object.assign(new Error("Host timed out"), { errorCode: "TIMEOUT" }); });
  await assert.rejects(f.synthesize(), code("TIMEOUT"));
  assert.deepEqual(f.service.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});
test("Speech HTTP waits for original unused unauthorized-body cleanup", async () => {
  const entered = deferred(), release = deferred(); let settled = false;
  const work = executeSpeechHttp({ url: "http://127.0.0.1:1", parse: "bytes" }, { fetchImpl: async () => ({
    status: 401, ok: false, headers: new Headers(), bodyUsed: false,
    body: { cancel: async () => { entered.resolve(); await release.promise; } },
  }) }).finally(() => { settled = true; });
  work.catch(() => {});
  await Promise.race([entered.promise, work.catch(() => {})]);
  try { assert.equal(settled, false); } finally { release.resolve(); }
  await assert.rejects(work, code("PROVIDER_UNAUTHORIZED"));
});
test("Speech HTTP guard prevents starting transport without converting owner refusal into network error", async () => {
  let requests = 0;
  await assert.rejects(executeSpeechHttp({ url: "http://127.0.0.1:1", parse: "bytes" }, {
    assertCurrent() { throw Object.assign(new Error("Owner retired"), { errorCode: "HOST_BUSY" }); },
    fetchImpl: async () => { requests++; return new Response("RIFF"); },
  }), code("HOST_BUSY")); assert.equal(requests, 0);
});

test("cancelled temporary admission permits new Speech work while permanent disposal does not", async t => {
  const f = await fixture(t); f.close(); await assert.rejects(f.synthesize(), code("HOST_BUSY"));
  f.open(); assert.equal((await f.synthesize()).mimeType, "audio/wav");
  f.service.dispose(); f.open(); await assert.rejects(f.service.status(), code("HOST_BUSY"));
  assert.equal(f.service.getHandoffActivity().operations, 0);
});
test("Speech cleanup failure is observable and preserves uncertainty without changing the provider refusal", async t => {
  const f = await fixture(t, "openai_audio");
  t.mock.method(globalThis, "fetch", async () => ({ status: 403, ok: false, headers: new Headers(), bodyUsed: false,
    body: { cancel: async () => { throw new Error("fixture cleanup failure"); } },
  }));
  await assert.rejects(f.synthesize(), code("PROVIDER_UNAUTHORIZED"));
  assert.deepEqual(f.service.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 2 });
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0][1], "warn"); assert.match(f.logs[0][2], /cleanup could not be confirmed/);
});
test("a late Speech response after disposal retains its original cleanup until completion", async t => {
  const f = await fixture(t, "openai_audio"), entered = deferred(), response = deferred(), cleaning = deferred(), release = deferred();
  t.mock.method(globalThis, "fetch", async () => { entered.resolve(); return response.promise; });
  const work = f.synthesize(), rejected = assert.rejects(work, code("HOST_BUSY"));
  await entered.promise; f.service.dispose();
  response.resolve({ status: 200, ok: true, headers: new Headers(), bodyUsed: false,
    body: { cancel: async () => { cleaning.resolve(); await release.promise; } },
    arrayBuffer: async () => { throw new Error("Retired body must not be consumed"); },
  });
  await cleaning.promise;
  try { assert.ok(f.service.getHandoffActivity().operations > 0); }
  finally { release.resolve(); }
  await rejected; assert.equal(f.service.getHandoffActivity().operations, 0); assert.deepEqual(f.logs, []);
});
