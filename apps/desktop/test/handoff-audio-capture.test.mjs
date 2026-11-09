import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { behavior, importEntered, loading, recorders, reset, settleReads } from "./helpers/pv-recorder-control.mjs";

register(new URL("./helpers/audio-backend-hook.mjs", import.meta.url).href);
const { PvRecorderBackend } = await import("../electron/main/audio-backend.ts");

function fixture(t) {
  reset();
  let closed = false;
  const errors = [];
  const backend = new PvRecorderBackend(() => closed, (error) => errors.push(error));
  const capture = backend.create(null);
  t.after(async () => {
    capture.cancel();
    backend.dispose?.();
    settleReads();
    await backend.whenIdle?.().catch(() => undefined);
  });
  return { backend, capture, errors, close: () => { closed = true; } };
}

// The native module's first evaluation is deliberately held until both starts
// have entered, matching the production dynamic-import boundary.
test("cancelling during native import prevents recorder construction", async (t) => {
  const { capture } = fixture(t);
  const starting = capture.start();
  const result = assert.rejects(starting, { name: "AbortError" });
  await importEntered.promise;
  capture.cancel();
  loading.resolve();
  await result;
  assert.equal(recorders.length, 0);
});

test("concurrent starts reserve the capture before the import continuation", async (t) => {
  const { capture } = fixture(t);
  const results = await Promise.allSettled([capture.start(), capture.start()]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(recorders.length, 1);
});

test("cancel waits for the original read before releasing and suppresses late frames", async (t) => {
  const { backend, capture } = fixture(t);
  const frames = [];
  capture.onFrame((frame) => frames.push(frame));
  await capture.start();
  const recorder = recorders[0];
  capture.cancel();
  assert.equal(recorder.stopCalls, 1);
  assert.equal(recorder.releaseCalls, 0, "a queued native read still owns the handle");
  assert.equal(capture.isActive, false);
  assert.ok(backend.getHandoffActivity().operations > 0);
  assert.equal(backend.getHandoffActivity().resources, 1);
  recorder.reads[0].resolve(new Int16Array([123]));
  await backend.whenIdle();
  assert.equal(recorder.releaseCalls, 1);
  assert.deepEqual(frames, []);
  assert.deepEqual(backend.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});

test("cancelled capture cannot be reused until original cleanup settles", async (t) => {
  const { backend, capture } = fixture(t);
  await capture.start();
  const original = recorders[0];
  capture.cancel();
  await assert.rejects(capture.start(), /already active/);
  original.reads[0].resolve(new Int16Array([300]));
  await backend.whenIdle();
  await capture.start();
  const next = recorders[1];
  assert.equal(next.isRecording, true);
  assert.equal(next.releaseCalls, 0);
  capture.cancel();
  next.reads[0].resolve(new Int16Array(0));
  await backend.whenIdle();
  assert.equal(original.releaseCalls, 1);
  assert.equal(next.releaseCalls, 1);
});

test("concurrent stop and cancel join one original cleanup", async (t) => {
  const { capture } = fixture(t);
  await capture.start();
  const recorder = recorders[0];
  const stops = [capture.stop(), capture.stop()];
  capture.cancel();
  recorder.reads[0].resolve(new Int16Array(0));
  await Promise.all(stops);
  assert.equal(recorder.stopCalls, 1);
  assert.equal(recorder.releaseCalls, 1);
});

test("normal recording returns exact PCM and ignores observer failures", async (t) => {
  const { backend, capture } = fixture(t);
  capture.onFrame(() => { throw new Error("fixture observer"); });
  await capture.start();
  const recorder = recorders[0];
  const nextRead = recorder.nextRead.promise;
  recorder.reads[0].resolve(new Int16Array([-32768, 0, 16384]));
  await nextRead;
  const stopping = capture.stop();
  recorder.reads[1].resolve(new Int16Array([999]));
  assert.deepEqual([...await stopping], [-1, 0, 0.5]);
  assert.equal(recorder.releaseCalls, 1);
  await backend.whenIdle();
});

test("unexpected read failure remains observable after original cleanup", async (t) => {
  const { capture } = fixture(t);
  await capture.start();
  const recorder = recorders[0];
  recorder.reads[0].reject(new Error("fixture read failure"));
  // The read rejection is the explicit synchronization point, not a timer.
  await recorder.reads[0].promise.catch(() => undefined);
  await assert.rejects(capture.stop(), /fixture read failure/);
  assert.equal(recorder.releaseCalls, 1);
});

test("startup failure releases the acquired recorder once", async (t) => {
  const { backend, capture } = fixture(t);
  behavior.start = () => { throw new Error("fixture start failure"); };
  await assert.rejects(capture.start(), /fixture start failure/);
  assert.equal(recorders[0].releaseCalls, 1);
  assert.equal(backend.getHandoffActivity().resources, 0);
});

test("sample-rate mismatch releases the original recorder without reading", async (t) => {
  const { capture } = fixture(t);
  behavior.sampleRate = 48000;
  await assert.rejects(capture.start(), /reported 48000 Hz; expected 16000 Hz/);
  assert.equal(recorders[0].releaseCalls, 1);
  assert.equal(recorders[0].reads.length, 0);
});

test("cancel cleanup failure is reported and retains the unresolved resource", async (t) => {
  const { backend, capture, errors } = fixture(t);
  await capture.start();
  const recorder = recorders[0];
  behavior.release = () => { throw new Error("fixture release failure"); };
  capture.cancel();
  recorder.reads[0].resolve(new Int16Array(0));
  await assert.rejects(backend.whenIdle(), /cleanup could not be confirmed/);
  assert.equal(errors.length, 1);
  assert.equal(backend.getHandoffActivity().resources, 1);
  assert.ok(backend.getHandoffActivity().uncontainedResources > 0);
  await assert.rejects(capture.start(), /already active/);
  assert.equal(recorder.releaseCalls, 1);
});

test("closed admission blocks capture and enumeration before native work", async (t) => {
  const { backend, capture, close } = fixture(t);
  close();
  await assert.rejects(capture.start(), { code: "HOST_BUSY" });
  await assert.rejects(backend.getDevices(), { code: "HOST_BUSY" });
  assert.equal(recorders.length, 0);
  assert.deepEqual(backend.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("gate closure during native import continuation prevents capture", async (t) => {
  const { backend, capture, close } = fixture(t);
  const starting = capture.start();
  close();
  await assert.rejects(starting, { code: "HOST_BUSY" });
  assert.equal(recorders.length, 0);
  await backend.whenIdle();
});

test("disposal retains the read and permanently prevents later acquisition", async (t) => {
  const { backend, capture } = fixture(t);
  await capture.start();
  const recorder = recorders[0];
  backend.dispose();
  assert.equal(recorder.releaseCalls, 0);
  recorder.reads[0].resolve(new Int16Array(0));
  await backend.whenIdle();
  assert.equal(recorder.releaseCalls, 1);
  await assert.rejects(capture.start(), { code: "HOST_BUSY" });
  await assert.rejects(backend.getDevices(), { code: "HOST_BUSY" });
});

test("reentrant cancellation during native startup cannot publish an active capture", async (t) => {
  const { backend, capture } = fixture(t);
  behavior.start = () => capture.cancel();
  await assert.rejects(capture.start(), { name: "AbortError" });
  await backend.whenIdle();
  assert.equal(capture.isActive, false);
  assert.equal(recorders[0].releaseCalls, 1);
  assert.equal(recorders[0].reads.length, 0);
});

test("reentrant native stop joins the cleanup before invoking external code", async (t) => {
  const { capture } = fixture(t);
  await capture.start();
  const recorder = recorders[0];
  behavior.stop = () => capture.cancel();
  const stopped = capture.stop();
  recorder.reads[0].resolve(new Int16Array(0));
  await stopped;
  assert.equal(recorder.releaseCalls, 1);
});

test("temporary admission closure preserves admitted recording and original stop", async (t) => {
  const { capture, close } = fixture(t);
  const frames = [];
  capture.onFrame((frame) => frames.push([...frame]));
  await capture.start();
  const recorder = recorders[0];
  const nextRead = recorder.nextRead.promise;
  close();
  recorder.reads[0].resolve(new Int16Array([16384]));
  await nextRead;
  const stopped = capture.stop();
  recorder.reads[1].resolve(new Int16Array(0));
  assert.deepEqual([...await stopped], [0.5]);
  assert.deepEqual(frames, [[16384]]);
});

test("failed cleanup notification cannot strand original cleanup completion", async (t) => {
  reset();
  const messages = [];
  t.mock.method(console, "error", (...args) => messages.push(args));
  const backend = new PvRecorderBackend(() => false, () => { throw new Error("fixture reporter failure"); });
  const capture = backend.create(null);
  await capture.start();
  behavior.release = () => { throw new Error("fixture release failure"); };
  capture.cancel();
  settleReads();
  await assert.rejects(backend.whenIdle(), /cleanup could not be confirmed/);
  assert.equal(backend.getHandoffActivity().operations, 0);
  assert.equal(backend.getHandoffActivity().resources, 1);
  assert.equal(messages.length, 1);
});

test("native stop failure waits for the read and still releases the original handle", async (t) => {
  const { capture, errors } = fixture(t);
  await capture.start();
  const recorder = recorders[0];
  behavior.stop = () => { throw new Error("fixture stop failure"); };
  const stopped = assert.rejects(capture.stop(), /cleanup could not be confirmed/);
  assert.equal(recorder.releaseCalls, 0);
  recorder.reads[0].resolve(new Int16Array(0));
  await stopped;
  assert.equal(recorder.releaseCalls, 1);
  assert.equal(errors.length, 1);
});

test("enumeration cannot publish after a reentrant gate closure", async (t) => {
  const { backend, close } = fixture(t);
  behavior.devices = () => { close(); return ["fixture device"]; };
  await assert.rejects(backend.getDevices(), { code: "HOST_BUSY" });
  assert.deepEqual(backend.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});

test("a replacement capture cannot bypass an original read or failed release", async (t) => {
  const { backend, capture } = fixture(t);
  await capture.start();
  const original = recorders[0];
  const replacement = backend.create(null);
  capture.cancel();
  await assert.rejects(replacement.start(), /already active|cleanup is pending/);
  behavior.release = () => { throw new Error("fixture release failure"); };
  original.reads[0].resolve(new Int16Array(0));
  await assert.rejects(backend.whenIdle(), /cleanup could not be confirmed/);
  await assert.rejects(replacement.start(), /already active|cleanup is pending/);
  assert.equal(recorders.length, 1);
});
