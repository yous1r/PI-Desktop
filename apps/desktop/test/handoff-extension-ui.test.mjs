import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentExtensionBridge } = await import("../electron/main/agent-extension-ui.ts");
const busy = error => error.errorCode === "HOST_BUSY";
const gone = error => error.errorCode === "HOST_UNAVAILABLE";
const flush = () => new Promise(resolve => setImmediate(resolve));
const envelope = (id, request = { kind: "input", title: id }) => ({ sessionId: "session", extensionId: "extension", extensionLabel: "Fixture", requestId: id, request });
function fixture(t, overrides = {}) {
  let closed = false, current = true;
  const prompts = [], errors = [], changes = [], statuses = [], toasts = [];
  const bridge = new AgentExtensionBridge({
    isAdmissionClosed: () => closed, hasRenderer: () => true, promptTimeoutMs: 1000,
    onChanged: () => changes.push(true), onPrompt: prompt => prompts.push(prompt),
    onStatus: event => statuses.push(event), onToast: message => toasts.push(message),
    onError: error => errors.push(error), ...overrides,
  });
  const source = bridge.bindSource?.(() => { if (!current) throw Object.assign(new Error("retired source"), { errorCode: "HOST_UNAVAILABLE" }); }) ?? bridge;
  t.after(() => { source.dispose?.(); bridge.cancelPrompts("session"); });
  return { bridge, source, prompts, errors, changes, statuses, toasts, close: () => { closed = true; }, retire: () => { current = false; } };
}
for (const kind of ["notify", "setStatus", "setWorkingMessage", "input"]) {
  test(`extension UI refuses ${kind} before publication while admission is closed`, async t => {
    const f = fixture(t); f.close();
    await assert.rejects(f.source.requestUi(envelope("request", { kind, title: "Prompt", message: "hello", level: "info", key: "key", text: "text" })), busy);
    assert.deepEqual([f.prompts.length, f.toasts.length, f.statuses.length], [0, 0, 0]);
  });
}
for (const kind of ["commands", "diagnostics"]) {
  test(`extension ${kind} publication refuses a closed gate without changing cached state`, t => {
    const f = fixture(t); f.close();
    assert.throws(() => kind === "commands" ? f.source.publishCommands("session", [{ name: "late" }]) : f.source.publishDiagnostics("session", [], []), busy);
    assert.deepEqual(f.bridge.allCommands(), []); assert.equal(f.changes.length, 0);
  });
}
test("queued extension prompts recheck admission after the previous prompt settles", async t => {
  const f = fixture(t), first = f.source.requestUi(envelope("first")), second = f.source.requestUi(envelope("second"));
  const rejected = assert.rejects(second, busy); await flush(); f.close(); f.bridge.cancelPrompts("other");
  await f.source.requestUi(envelope("cancel", { kind: "cancel", requestId: "first" }));
  assert.equal((await first).cancelled, true); await rejected;
  assert.equal(f.prompts.filter(prompt => !prompt.cancelled).length, 1);
});
test("renderer responses cannot continue a prompt after admission closes", async t => {
  const f = fixture(t), work = f.source.requestUi(envelope("first")); await flush(); f.close();
  assert.throws(() => f.bridge.respond(f.prompts[0].promptId, "late"), busy);
  await f.source.requestUi(envelope("cancel", { kind: "cancel", requestId: "first" })); assert.equal((await work).cancelled, true);
});
test("renderer responses and queued prompts reject a retired source", async t => {
  const f = fixture(t), first = f.source.requestUi(envelope("first")), second = f.source.requestUi(envelope("second"));
  const rejected = assert.rejects(second, gone); await flush(); f.retire();
  assert.throws(() => f.bridge.respond(f.prompts[0].promptId, "late"), gone);
  await f.source.requestUi(envelope("cancel", { kind: "cancel", requestId: "first" })); await first; await rejected;
  assert.equal(f.prompts.filter(prompt => !prompt.cancelled).length, 1);
});
test("failed prompt publication removes its timer and waiter and permits the next request", async t => {
  const failure = new Error("renderer send failed"); let fail = true;
  const f = fixture(t, { onPrompt: () => { if (fail) throw failure; } });
  await assert.rejects(f.source.requestUi(envelope("first")), failure);
  assert.equal(f.bridge.pendingPromptCount(), 0); assert.deepEqual(f.errors, [failure]); fail = false;
  const next = f.source.requestUi(envelope("second")); await flush(); f.bridge.cancelPrompts("session"); assert.equal((await next).cancelled, true);
});
test("failed dismissal notification remains observable without stranding the original waiter", async t => {
  const failure = new Error("renderer dismissal failed"); let shown;
  const f = fixture(t, { onPrompt: prompt => { if (prompt.cancelled) throw failure; shown = prompt; } });
  const work = f.source.requestUi(envelope("first")); await flush();
  assert.equal(f.bridge.respond(shown.promptId, "accepted"), true);
  assert.deepEqual(await work, { kind: "input", value: "accepted" }); assert.equal(f.bridge.pendingPromptCount(), 0); assert.deepEqual(f.errors, [failure]);
});
test("cancelled queued requests retain original activity and duplicate IDs until their queue tail settles", async t => {
  const f = fixture(t), first = f.source.requestUi(envelope("first")), queued = f.source.requestUi(envelope("queued")); await flush();
  await f.source.requestUi(envelope("cancel", { kind: "cancel", requestId: "queued" })); assert.equal((await queued).cancelled, true);
  assert.equal(f.source.getHandoffActivity().operations, 2); assert.equal(f.source.getHandoffActivity().inputs, 2);
  await assert.rejects(f.source.requestUi(envelope("queued")), /Duplicate/);
  f.bridge.respond(f.prompts[0].promptId, "done"); await first; await flush();
  assert.deepEqual(f.source.getHandoffActivity(), { operations: 0, inputs: 0 });
});
test("replaced UI sources cannot cancel or clear the replacement's identical session and request IDs", async t => {
  const f = fixture(t); f.source.publishCommands("session", [{ name: "old" }]);
  const cleanup = f.source.captureSession("session"), old = f.source.requestUi(envelope("same")); await flush(); f.retire();
  const replacement = f.bridge.bindSource(() => {}); t.after(() => replacement.dispose());
  replacement.publishCommands("session", [{ name: "new" }]); const next = replacement.requestUi(envelope("same")); await flush();
  assert.equal((await old).cancelled, true); cleanup(); f.source.dispose();
  await f.source.requestUi(envelope("cancel", { kind: "cancel", requestId: "same" }));
  assert.deepEqual(f.bridge.commandsForSession("session"), [{ name: "new" }]);
  assert.equal(f.bridge.respond(f.prompts.at(-1).promptId, "new"), true); assert.equal((await next).value, "new");
});
test("source disposal synchronously closes admission and keeps original prompt tails observable", async t => {
  const f = fixture(t), work = f.source.requestUi(envelope("first")); f.source.dispose();
  assert.ok(f.source.getHandoffActivity().operations > 0);
  await assert.rejects(f.source.requestUi(envelope("late")), gone); assert.equal((await work).cancelled, true); await flush();
  assert.deepEqual(f.source.getHandoffActivity(), { operations: 0, inputs: 0 }); assert.equal(f.bridge.pendingPromptCount(), 0);
});

for (const kind of ["notify", "setStatus"]) test(`${kind} observer execution remains visible to synchronous handoff inspection`, async t => {
  let f;
  const observe = () => assert.ok(f.source.getHandoffActivity().operations > 0);
  f = fixture(t, { onToast: observe, onStatus: observe });
  await f.source.requestUi(envelope("observe", { kind, message: "hello", level: "info", key: "key", text: "text" }));
  assert.deepEqual(f.source.getHandoffActivity(), { operations: 0, inputs: 0 });
});
