import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { loading, recorders, reset, settleReads } from "./helpers/pv-recorder-control.mjs";
import { models, resetModels } from "./helpers/voice-native-model-stub.mjs";
register(new URL("./helpers/audio-backend-hook.mjs", import.meta.url));
const { PvRecorderBackend } = await import("../electron/main/audio-backend.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { VoiceController, ModelManager, TranscriptionEngine, getCatalog } = await import("@pi-desktop/voice-runtime");

test("Dictation records exact PCM, transcribes, and retains cancelled original native work", async t => {
  reset(); resetModels(); loading.resolve();
  const root = await mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR || tmpdir()), "audio-path-"));
  const info = getCatalog()[0], file = join(root, info.id, info.hfFilename);
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, "fixture model");
  const admission = new DesktopHandoffAdmission(), errors = [], phases = [];
  const backend = new PvRecorderBackend(() => admission.isClosed(), error => errors.push(error));
  const manager = new ModelManager(root), engine = new TranscriptionEngine(manager);
  const controller = new VoiceController(engine, backend, () => ({ enabled: true, deviceId: null, languages: ["en"], chineseVariant: "simplified", modelId: info.id }));
  controller.on("stateChange", state => phases.push(state.phase));
  t.after(async () => {
    controller.dispose(); backend.dispose(); settleReads(); await backend.whenIdle();
    await engine.shutdown(); admission.dispose(); await rm(root, { recursive: true, force: true });
  });
  const inspect = async () => { const activity = backend.getHandoffActivity(); return {
    clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: activity.operations, processes: 0, terminals: 0, plugins: 0,
    admissions: admission.inFlightCount(), finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
    approvals: 0, inputs: 0, nativeSessions: activity.resources, mcp: 0, uncontainedResources: activity.uncontainedResources,
  }; };
  const hold = await admission.gate.acquireHandoff(randomUUID(), inspect);
  await assert.rejects(backend.getDevices(), { code: "HOST_BUSY" });
  assert.equal(recorders.length, 0); hold.cancel();
  await controller.start();
  const original = recorders[0], nextRead = original.nextRead.promise;
  original.reads[0].resolve(new Int16Array([-32768, 0, 16384])); await nextRead;
  const stopped = controller.stop(); original.reads[1].resolve(new Int16Array(0));
  const result = await stopped;
  assert.equal(result.text, "fixture transcript"); assert.equal(result.language, "en");
  assert.deepEqual(models[0].transcriptions, [{ pcm: [-1, 0, 0.5], options: { language: "en" } }]);
  assert.equal(original.releaseCalls, 1); assert.equal(controller.state.phase, "done");
  controller.cancel(); await controller.start();
  const cancelled = recorders[1]; controller.cancel();
  assert.equal(controller.state.phase, "idle"); assert.equal(cancelled.releaseCalls, 0);
  assert.ok(backend.getHandoffActivity().operations > 0); assert.equal(backend.getHandoffActivity().resources, 1);
  cancelled.reads[0].resolve(new Int16Array([123])); await backend.whenIdle();
  assert.equal(cancelled.releaseCalls, 1); assert.equal(models[0].transcriptions.length, 1);
  assert.ok(phases.includes("listening") && phases.includes("transcribing")); assert.deepEqual(errors, []);
  const activity = backend.getHandoffActivity();
  assert.deepEqual(activity, { operations: 0, resources: 0, uncontainedResources: 2 });
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
  t.diagnostic(JSON.stringify({ kind: "audio-user-path", exactPcmTranscription: true, originalReleases: 2, lateFramePublished: false,
    activity, nativeFamilyQualified: false, physicalMicrophoneUsed: false }));
});
