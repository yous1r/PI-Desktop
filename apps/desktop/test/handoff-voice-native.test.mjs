import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { behavior, models, resetModels } from "./helpers/voice-native-model-stub.mjs";
register(new URL("./helpers/audio-backend-hook.mjs", import.meta.url));
const { ModelManager, TranscriptionEngine, getCatalog, VoiceController } = await import("@pi-desktop/voice-runtime");

async function fixture(t) {
  resetModels();
  const root = await mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR || tmpdir()), "voice-native-"));
  const infos = getCatalog().slice(0, 2), errors = [];
  for (const info of infos) {
    const file = join(root, info.id, info.hfFilename);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, "fixture model");
  }
  const manager = new ModelManager(root, error => errors.push(error)), engine = new TranscriptionEngine(manager);
  t.after(async () => { await engine.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { manager, engine, id: infos[0].id, other: infos[1].id, errors };
}
const aborted = { name: "AbortError" };

test("concurrent preparation shares one original native load", async t => {
  const { manager, id } = await fixture(t);
  const entered = Promise.withResolvers(), load = Promise.withResolvers();
  behavior.load = async model => { entered.resolve(); await load.promise; return model; };
  const first = manager.ensureLoaded(id), second = manager.ensureLoaded(id);
  await entered.promise; load.resolve(); await Promise.all([first, second]);
  assert.equal(models.length, 1); assert.equal(manager.getLoadedModel(), models[0]);
});

test("unload revokes pending load and disposes its late original result", async t => {
  const { manager, id } = await fixture(t);
  const entered = Promise.withResolvers(), load = Promise.withResolvers();
  behavior.load = async model => { entered.resolve(); await load.promise; return model; };
  const work = manager.ensureLoaded(id), result = work.then(() => null, error => error);
  await entered.promise; manager.unload(); load.resolve();
  assert.equal((await result)?.name, "AbortError");
  assert.equal(manager.getLoadedModelId(), null); assert.equal(models[0].disposeCalls, 1);
});

test("replacement load cannot be overwritten by an older completion", async t => {
  const { manager, id, other } = await fixture(t);
  const entered = Promise.withResolvers(), load = Promise.withResolvers();
  behavior.load = async model => { if (models.length === 1) { entered.resolve(); await load.promise; } return model; };
  const old = manager.ensureLoaded(id), result = old.then(() => null, error => error);
  await entered.promise; const next = manager.ensureLoaded(other); load.resolve();
  await next; assert.equal((await result)?.name, "AbortError");
  assert.equal(manager.getLoadedModelId(), other); assert.equal(models[0].disposeCalls, 1);
});

test("unload from a loading observer prevents native acquisition", async t => {
  const { manager, id } = await fixture(t);
  manager.on("modelStateChanged", (_id, state) => { if (state.status === "loading") manager.unload(); });
  await assert.rejects(manager.ensureLoaded(id), aborted); assert.equal(models.length, 0);
});

test("batch passes original cancellation signal and retains model until compute settles", async t => {
  const { manager, engine, id } = await fixture(t);
  await manager.ensureLoaded(id);
  const entered = Promise.withResolvers(), compute = Promise.withResolvers(), abort = new AbortController();
  behavior.transcribe = async () => { entered.resolve(); return compute.promise; };
  const work = engine.transcribe(new Float32Array([0.5]), { language: "en" }, abort.signal);
  const result = work.then(() => null, error => error);
  await entered.promise; abort.abort(); manager.unload();
  const before = models[0].disposeCalls, signal = models[0].transcriptions[0].options.signal;
  compute.resolve({ text: "stale" }); await result;
  assert.equal(before, 0); assert.equal(signal.aborted, true); assert.equal(signal.reason, abort.signal.reason);
  assert.equal((await result)?.name, "AbortError"); assert.equal(models[0].disposeCalls, 1);
});

test("model replacement rejects old batch publication without cancellation", async t => {
  const { manager, engine, id, other } = await fixture(t); await manager.ensureLoaded(id);
  const entered = Promise.withResolvers(), compute = Promise.withResolvers();
  behavior.transcribe = async () => { entered.resolve(); return compute.promise; };
  const work = engine.transcribe(new Float32Array([1]), { language: "en" });
  const result = work.then(() => null, error => error); await entered.promise;
  const next = manager.ensureLoaded(other); compute.resolve({ text: "stale" }); await next;
  assert.equal((await result)?.name, "AbortError"); assert.equal(manager.getLoadedModelId(), other);
});

test("async native stream queues owned PCM and reads final structured text", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const entered = Promise.withResolvers(), ready = Promise.withResolvers();
  behavior.stream = async () => { entered.resolve(); await ready.promise; };
  const stream = engine.createStream({ language: "en" }); assert.ok(stream);
  await entered.promise; const pcm = new Float32Array([0.5]);
  try { stream.feed(pcm); pcm[0] = -1; stream.feed(new Float32Array([1])); }
  finally { ready.resolve(); }
  assert.equal(await stream.finalize(), "fixture stream transcript");
  const session = models[0].sessions[0];
  assert.deepEqual(session.value.frames, [[0.5], [1]]);
  assert.deepEqual(session.value.events, ["feed-start", "feed-end", "feed-start", "feed-end", "finalize", "reset"]);
  assert.equal(session.disposeCalls, 1); stream.cancel(); assert.equal(session.disposeCalls, 1);
});

test("cancel before stream initialization retains and cleans the original session", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const entered = Promise.withResolvers(), ready = Promise.withResolvers();
  behavior.stream = async () => { entered.resolve(); await ready.promise; };
  const stream = engine.createStream({ language: "en" }); await entered.promise;
  stream.cancel(); manager.unload();
  const before = models[0].disposeCalls; ready.resolve();
  await engine.whenIdle(); await manager.whenIdle();
  assert.equal(before, 0); assert.equal(models[0].sessions[0].value.resetCalls, 1);
  assert.equal(models[0].sessions[0].disposeCalls, 1); assert.equal(models[0].disposeCalls, 1);
  assert.equal(engine.getHandoffActivity().operations, 0);
  assert.ok(manager.getHandoffActivity().uncontainedResources > 0);
});

test("pending feed survives cancel and prevents premature session or model disposal", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const entered = Promise.withResolvers(), feed = Promise.withResolvers();
  behavior.feed = async () => { entered.resolve(); await feed.promise; };
  const stream = engine.createStream({ language: "en" }); stream.feed(new Float32Array([0.5]));
  await entered.promise; stream.cancel(); manager.unload();
  const session = models[0].sessions[0], before = [session.disposeCalls, models[0].disposeCalls];
  assert.ok(engine.getHandoffActivity().operations > 0); feed.resolve();
  await engine.whenIdle(); await manager.whenIdle();
  assert.deepEqual(before, [0, 0]); assert.equal(session.value.resetCalls, 1); assert.equal(session.disposeCalls, 1);
  await assert.rejects(stream.finalize(), aborted);
});

test("concurrent finalization joins one native finalize and blocks subsequent feed", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const stream = engine.createStream({ language: "en" });
  const first = stream.finalize(), second = stream.finalize();
  assert.throws(() => stream.feed(new Float32Array([1])), /finaliz|closed|cancel/i);
  assert.deepEqual(await Promise.all([first, second]), ["fixture stream transcript", "fixture stream transcript"]);
  assert.equal(models[0].sessions[0].value.events.filter(event => event === "finalize").length, 1);
});

test("native feed failure is observed by finalize and cleans the original session", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  behavior.feed = async () => { throw new Error("fixture feed failed"); };
  const stream = engine.createStream({ language: "en" }); stream.feed(new Float32Array([1]));
  await assert.rejects(stream.finalize(), /fixture feed failed/); await engine.whenIdle();
  assert.equal(models[0].sessions[0].disposeCalls, 1);
});

test("stream initialization failure disposes its session and permits original batch fallback", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  behavior.stream = async () => { throw new Error("fixture stream unavailable"); };
  const stream = engine.createStream({ language: "en" });
  await assert.rejects(stream.finalize(), /fixture stream unavailable/);
  assert.equal(await engine.transcribe(new Float32Array([0.5]), { language: "en" }), "fixture transcript");
  assert.equal(models[0].sessions[0].disposeCalls, 1);
});

test("shutdown cancels retained stream work and permanently refuses new compute", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const initialized = Promise.withResolvers(); behavior.stream = () => initialized.resolve();
  const stream = engine.createStream({ language: "en" });
  await initialized.promise; await engine.shutdown();
  await assert.rejects(engine.transcribe(new Float32Array([0]), { language: "en" }), /shut down|disposed/i);
  assert.throws(() => engine.createStream({ language: "en" }), /shut down|disposed/i);
  assert.equal(models[0].sessions[0].disposeCalls, 1); await assert.rejects(stream.finalize(), aborted);
});

test("real controller completes async native stream without unintended batch fallback", async t => {
  const { manager, engine, id } = await fixture(t); behavior.streaming = true;
  let onFrame;
  const capture = { async start() {}, async stop() { return new Float32Array(0); }, cancel() {}, onFrame(callback) { onFrame = callback; }, isActive: true };
  const controller = new VoiceController(engine, { create: () => capture }, () => ({ enabled: true, modelId: id, deviceId: null, languages: ["en"], chineseVariant: "simplified" }));
  t.after(() => controller.dispose());
  await controller.start(); onFrame(new Int16Array([-32768, 0, 16384]));
  assert.equal((await controller.stop()).text, "fixture stream transcript");
  assert.equal(models[0].transcriptions.length, 0);
  assert.deepEqual(models[0].sessions[0].value.frames, [[-1, 0, 0.5]]);
  assert.equal(manager.getLoadedModelId(), id);
});

test("unsupported synchronous session creation preserves null-stream batch behavior", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id);
  assert.equal(engine.createStream({ language: "en" }), null);
  await engine.whenIdle();
  assert.equal(await engine.transcribe(new Float32Array([0.5]), { language: "en" }), "fixture transcript");
  assert.equal(engine.getHandoffActivity().resources, 0);
});

test("cancel during native finalization retains compute and suppresses late text", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const entered = Promise.withResolvers(), final = Promise.withResolvers();
  behavior.finalize = async () => { entered.resolve(); await final.promise; };
  const stream = engine.createStream({ language: "en" });
  const work = stream.finalize(), rejected = assert.rejects(work, aborted);
  await entered.promise; stream.cancel();
  assert.ok(engine.getHandoffActivity().operations > 0);
  assert.equal(models[0].sessions[0].disposeCalls, 0);
  final.resolve(); await rejected; await engine.whenIdle();
  assert.equal(models[0].sessions[0].disposeCalls, 1);
});

test("session cleanup errors are observable and do not strand model leases", async t => {
  const { manager, engine, id, errors } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  behavior.reset = () => { throw new Error("fixture reset failed"); };
  behavior.sessionDispose = () => { throw new Error("fixture session dispose failed"); };
  const stream = engine.createStream({ language: "en" });
  assert.equal(await stream.finalize(), "fixture stream transcript");
  await engine.whenIdle(); manager.unload(); await manager.whenIdle();
  assert.equal(errors.length, 2); assert.equal(models[0].disposeCalls, 1);
  assert.ok(engine.getHandoffActivity().uncontainedResources >= 3);
});

test("failed model disposal refuses replacement and reports retained uncertainty", async t => {
  const { manager, id, other, errors } = await fixture(t); await manager.ensureLoaded(id);
  behavior.dispose = () => { throw new Error("fixture model dispose failed"); };
  manager.unload(); await manager.whenIdle();
  await assert.rejects(manager.ensureLoaded(other), /cleanup is unconfirmed/);
  assert.equal(errors.length, 1); assert.equal(models.length, 1);
  assert.equal(manager.getHandoffActivity().resources, 1);
});

test("model state observer reentry cannot publish a retired loaded model", async t => {
  const { manager, id } = await fixture(t);
  manager.on("modelStateChanged", (_id, state) => { if (state.status === "loaded") manager.unload(); });
  await assert.rejects(manager.ensureLoaded(id), aborted);
  assert.equal(manager.getLoadedModel(), null); assert.equal(models[0].disposeCalls, 1);
});

test("bounded stream backlog falls back without submitting queued native frames", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const entered = Promise.withResolvers(), ready = Promise.withResolvers();
  behavior.stream = async () => { entered.resolve(); await ready.promise; };
  const stream = engine.createStream({ language: "en" }); await entered.promise;
  for (let index = 0; index < 257; index++) stream.feed(new Float32Array([1]));
  const rejected = assert.rejects(stream.finalize(), /backlog exceeded/); ready.resolve(); await rejected;
  await engine.whenIdle(); assert.equal(models[0].sessions[0].value.frames.length, 0);
  assert.equal(await engine.transcribe(new Float32Array([1]), { language: "en" }), "fixture transcript");
});

test("model cleanup reentry preserves a newer same-model loading state", async t => {
  const { manager, id } = await fixture(t); await manager.ensureLoaded(id);
  const entered = Promise.withResolvers(), load = Promise.withResolvers();
  behavior.load = async model => { entered.resolve(); await load.promise; return model; };
  let next;
  behavior.dispose = () => { if (!next) next = manager.ensureLoaded(id); };
  manager.unload(); await entered.promise;
  const state = manager.getState(id).status; load.resolve(); await next;
  assert.equal(state, "loading"); assert.equal(manager.getLoadedModel(), models[1]);
});

test("cancel from native reset prevents final text publication", async t => {
  const { manager, engine, id } = await fixture(t); await manager.ensureLoaded(id); behavior.streaming = true;
  const stream = engine.createStream({ language: "en" });
  behavior.reset = () => stream.cancel();
  await assert.rejects(stream.finalize(), aborted); await engine.whenIdle();
  assert.equal(models[0].sessions[0].disposeCalls, 1);
});

test("shutdown retains an original load and cleans its late result", async t => {
  const { manager, engine, id } = await fixture(t);
  const entered = Promise.withResolvers(), load = Promise.withResolvers();
  behavior.load = async model => { entered.resolve(); await load.promise; return model; };
  const work = manager.ensureLoaded(id), rejected = assert.rejects(work, aborted);
  await entered.promise; const shutdown = engine.shutdown();
  assert.ok(manager.getHandoffActivity().operations > 0);
  load.resolve(); await rejected; await shutdown;
  assert.equal(models[0].disposeCalls, 1); assert.equal(manager.getLoadedModel(), null);
  await assert.rejects(manager.ensureLoaded(id), /disposed/);
});

test("real controller falls back after asynchronous native stream failure", async t => {
  const { engine, id } = await fixture(t); behavior.streaming = true;
  behavior.stream = async () => { throw new Error("fixture stream failure"); };
  let onFrame;
  const capture = { async start() {}, async stop() { return new Float32Array(0); }, cancel() {}, onFrame(callback) { onFrame = callback; }, isActive: true };
  const controller = new VoiceController(engine, { create: () => capture }, () => ({ enabled: true, modelId: id, deviceId: null, languages: ["en"], chineseVariant: "simplified" }));
  t.after(() => controller.dispose());
  await controller.start(); onFrame(new Int16Array([-32768, 0, 16384]));
  assert.equal((await controller.stop()).text, "fixture transcript");
  assert.deepEqual(models[0].transcriptions[0].pcm, [-1, 0, 0.5]);
  assert.equal(models[0].sessions[0].disposeCalls, 1);
});
