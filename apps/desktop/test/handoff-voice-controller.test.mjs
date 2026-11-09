import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { behavior, models, resetModels } from "./helpers/voice-native-model-stub.mjs";
register(new URL("./helpers/audio-backend-hook.mjs", import.meta.url));
const { VoiceController, ModelManager, TranscriptionEngine, getCatalog } = await import("@pi-desktop/voice-runtime");

async function fixture(t) {
  resetModels();
  const root = await mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR || tmpdir()), "voice-controller-"));
  const info = getCatalog()[0], file = join(root, info.id, info.hfFilename);
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, "fixture model");
  const manager = new ModelManager(root), engine = new TranscriptionEngine(manager);
  const captures = [], phases = [], options = {}, errors = [];
  const factory = {
    async getDevices() { return []; }, async checkPermission() { return "granted"; }, async requestPermission() { return true; },
    create() {
      const capture = {
        isActive: false, cancelCalls: 0, startEntered: Promise.withResolvers(), stopEntered: Promise.withResolvers(),
        onFrame(callback) { this.frame = callback; },
        async start() { this.startEntered.resolve(); await options.start?.(this); this.isActive = true; },
        async stop() { this.stopEntered.resolve(); await options.stop?.(this); this.isActive = false; return new Float32Array(0); },
        cancel() { this.cancelCalls++; this.isActive = false; options.cancel?.(this); },
      };
      captures.push(capture); options.created?.(capture); return capture;
    },
  };
  const settings = { enabled: true, deviceId: null, languages: ["en"], chineseVariant: "simplified", modelId: info.id };
  const controller = new VoiceController(engine, factory, () => settings, error => errors.push(error));
  controller.on("stateChange", state => phases.push(state.phase));
  t.after(async () => { controller.dispose(); await controller.whenIdle?.(); await engine.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { controller, manager, engine, captures, phases, options, settings, errors };
}

for (const method of ["prepare", "start"]) {
  test(`cancel during ${method} model loading prevents late ready and capture`, async t => {
    const { controller, captures } = await fixture(t);
    const entered = Promise.withResolvers(), loaded = Promise.withResolvers();
    behavior.load = async model => { entered.resolve(); await loaded.promise; return model; };
    const work = controller[method]();
    const rejection = assert.rejects(work, { name: "AbortError" });
    await entered.promise; controller.cancel(); loaded.resolve(); await rejection;
    assert.equal(controller.state.phase, "idle"); assert.equal(captures.length, 0);
    assert.equal(controller.getHandoffActivity().operations, 0);
  });
}

test("cancel reaches a capture whose asynchronous start is not active yet", async t => {
  const { controller, options, captures } = await fixture(t);
  const entered = Promise.withResolvers(), start = Promise.withResolvers();
  options.start = async () => { entered.resolve(); await start.promise; };
  const work = controller.start(), rejection = assert.rejects(work, { name: "AbortError" });
  await entered.promise; controller.cancel();
  assert.equal(captures[0].cancelCalls, 1);
  assert.ok(controller.getHandoffActivity().operations > 0);
  start.resolve(); await rejection;
  assert.equal(controller.state.phase, "idle"); assert.equal(captures[0].isActive, false);
  assert.equal(controller.getHandoffActivity().operations, 0);
});

test("old startup failure cannot clear or overwrite a replacement recording", async t => {
  const { controller, options, captures } = await fixture(t);
  const entered = Promise.withResolvers(), start = Promise.withResolvers();
  options.start = async () => { entered.resolve(); await start.promise; };
  const old = controller.start(), rejected = assert.rejects(old, /fixture old start failure/);
  await entered.promise; controller.cancel(); delete options.start;
  await controller.start(); start.reject(new Error("fixture old start failure")); await rejected;
  assert.equal(controller.state.phase, "listening"); assert.equal(captures[1].isActive, true);
  captures[1].frame(new Int16Array([16384]));
  assert.equal((await controller.stop()).text, "fixture transcript");
  assert.deepEqual(models[0].transcriptions[0].pcm, [0.5]);
});

test("late frames from a cancelled capture cannot enter a replacement transcript", async t => {
  const { controller, captures } = await fixture(t);
  await controller.start(); controller.cancel(); await controller.start();
  captures[0].frame(new Int16Array([-32768])); captures[1].frame(new Int16Array([16384]));
  await controller.stop();
  assert.deepEqual(models[0].transcriptions[0].pcm, [0.5]);
});

test("cancel during original capture stop prevents transcription and preserves next capture", async t => {
  const { controller, options, captures } = await fixture(t);
  const stop = Promise.withResolvers(); options.stop = () => stop.promise;
  await controller.start(); captures[0].frame(new Int16Array([100]));
  const old = controller.stop(), rejected = assert.rejects(old, { name: "AbortError" });
  await captures[0].stopEntered.promise; controller.cancel(); delete options.stop;
  await controller.start(); captures[1].frame(new Int16Array([16384]));
  stop.resolve(); await rejected;
  assert.equal(controller.state.phase, "listening"); assert.equal(models[0].transcriptions.length, 0);
  await controller.stop(); assert.deepEqual(models[0].transcriptions[0].pcm, [0.5]);
});

test("cancelled batch completion remains counted and cannot replace newer visible state", async t => {
  const { controller, captures } = await fixture(t);
  const entered = Promise.withResolvers(), text = Promise.withResolvers();
  behavior.transcribe = async () => { entered.resolve(); return text.promise; };
  await controller.start(); captures[0].frame(new Int16Array([100]));
  const old = controller.stop(), rejected = assert.rejects(old, { name: "AbortError" });
  await entered.promise; controller.cancel();
  assert.ok(controller.getHandoffActivity().operations > 0);
  await controller.start(); text.resolve({ text: "old transcript" }); await rejected;
  assert.equal(controller.state.phase, "listening"); assert.equal(captures[1].isActive, true);
  assert.equal(controller.getHandoffActivity().operations, 0);
});

test("dispose while preparing retains work and prevents late state publication", async t => {
  const { controller, captures, phases } = await fixture(t);
  const entered = Promise.withResolvers(), load = Promise.withResolvers();
  behavior.load = async model => { entered.resolve(); await load.promise; return model; };
  const old = controller.start(), rejected = assert.rejects(old, { name: "AbortError" });
  await entered.promise; controller.dispose(); const before = [...phases];
  assert.ok(controller.getHandoffActivity().operations > 0);
  load.resolve(); await rejected; await controller.whenIdle();
  assert.deepEqual(phases, before); assert.equal(controller.state.phase, "idle"); assert.equal(captures.length, 0);
});

test("reentrant cancellation from ready prevents subsequent native capture", async t => {
  const { controller, captures } = await fixture(t);
  controller.on("stateChange", state => { if (state.phase === "ready") controller.cancel(); });
  await assert.rejects(controller.start(), { name: "AbortError" });
  assert.equal(captures.length, 0); assert.equal(controller.state.phase, "idle");
});

test("reentrant cancellation before model preparation prevents native load", async t => {
  const { controller } = await fixture(t);
  controller.on("stateChange", state => { if (state.phase === "preparing") controller.cancel(); });
  await assert.rejects(controller.start(), { name: "AbortError" });
  assert.equal(models.length, 0); assert.equal(controller.state.phase, "idle");
});

test("reentrant done observer can start a next recording without old cleanup clearing it", async t => {
  const { controller, captures } = await fixture(t);
  let next;
  controller.on("stateChange", state => {
    if (state.phase === "done" && !next) { controller.cancel(); next = controller.start(); }
  });
  await controller.start(); captures[0].frame(new Int16Array([10])); await controller.stop(); await next;
  assert.equal(controller.state.phase, "listening");
  captures[1].frame(new Int16Array([16384])); await controller.stop();
  assert.deepEqual(models[0].transcriptions[1].pcm, [0.5]);
});

test("capture cleanup exceptions still revoke callbacks and settle cancellation", async t => {
  const { controller, captures, options, errors } = await fixture(t);
  await controller.start(); options.cancel = () => { throw new Error("fixture capture cancel failure"); };
  assert.doesNotThrow(() => controller.cancel());
  assert.equal(controller.state.phase, "idle"); assert.equal(errors.length, 1);
  captures[0].frame(new Int16Array([100]));
  assert.equal(controller.getHandoffActivity().resources, 0);
  assert.equal(controller.getHandoffActivity().uncontainedResources, 1);
});

test("standalone prepare cannot replace an active recording", async t => {
  const { controller, captures } = await fixture(t);
  await controller.start();
  await assert.rejects(controller.prepare(), /Cannot prepare/);
  assert.equal(controller.state.phase, "listening"); assert.equal(captures[0].isActive, true);
});

test("cancelled stream finalization cannot trigger batch fallback", async t => {
  const { controller, engine, captures } = await fixture(t);
  const entered = Promise.withResolvers(), finished = Promise.withResolvers();
  let cancels = 0;
  t.mock.method(engine, "createStream", () => ({ feed() {}, finalize() { entered.resolve(); return finished.promise; }, cancel() { cancels++; } }));
  await controller.start(); captures[0].frame(new Int16Array([16384]));
  const work = controller.stop(), rejected = assert.rejects(work, { name: "AbortError" });
  await entered.promise; controller.cancel(); assert.ok(controller.getHandoffActivity().operations > 0);
  finished.reject(new Error("fixture stream failure")); await rejected;
  assert.equal(models[0].transcriptions.length, 0); assert.equal(cancels, 1); assert.equal(controller.state.phase, "idle");
});

test("ordinary stream failure still falls back to the original batch audio and settings", async t => {
  const { controller, engine, captures, settings } = await fixture(t);
  let cancels = 0;
  t.mock.method(engine, "createStream", () => ({ feed() {}, async finalize() { throw new Error("fixture stream failure"); }, cancel() { cancels++; } }));
  await controller.start(); captures[0].frame(new Int16Array([16384])); settings.languages[0] = "fr";
  const result = await controller.stop();
  assert.equal(result.text, "fixture transcript"); assert.equal(result.language, "en"); assert.equal(cancels, 1);
  assert.deepEqual(models[0].transcriptions, [{ pcm: [0.5], options: { language: "en" } }]);
});

test("concurrent stop calls join the same original transcription", async t => {
  const { controller, captures } = await fixture(t);
  await controller.start(); captures[0].frame(new Int16Array([16384]));
  const results = await Promise.all([controller.stop(), controller.stop()]);
  assert.deepEqual(results[0], results[1]); assert.equal(models[0].transcriptions.length, 1);
});

test("cancellation notification can reenter cancel once without recursive publication", async t => {
  const { controller, phases } = await fixture(t);
  await controller.start(); let notifications = 0;
  controller.on("stateChange", state => {
    if (state.phase === "cancelling" && ++notifications < 3) controller.cancel();
  });
  controller.cancel();
  assert.equal(notifications, 1); assert.equal(phases.filter(phase => phase === "cancelling").length, 1);
  assert.equal(controller.state.phase, "idle");
});

test("cleanup reentry cannot publish old done over a newly started recording", async t => {
  const { controller, engine, captures } = await fixture(t);
  let next;
  t.mock.method(engine, "createStream", () => ({ feed() {}, async finalize() { return "stream transcript"; }, cancel() {
    if (!next) { controller.cancel(); next = controller.start(); }
  } }));
  await controller.start(); captures[0].frame(new Int16Array([16384]));
  await assert.rejects(controller.stop(), { name: "AbortError" }); await next;
  assert.equal(controller.state.phase, "listening"); assert.equal(captures[1].isActive, true);
});

test("state observer failures do not strand cancellation or original operation accounting", async t => {
  const { controller, captures, errors } = await fixture(t);
  await controller.start();
  controller.on("stateChange", () => { throw new Error("fixture observer failure"); });
  controller.cancel(); await controller.whenIdle();
  assert.equal(captures[0].isActive, false); assert.equal(controller.state.phase, "idle");
  assert.equal(errors.length, 2); assert.equal(controller.getHandoffActivity().operations, 0);
});
