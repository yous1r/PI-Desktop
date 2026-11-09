import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");
const { AgentExtensionBridge } = await import("../electron/main/agent-extension-ui.ts");
const { createTrustedExtensionServices } = await import("../electron/main/trusted-extension-services.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const deferred = () => Promise.withResolvers();
const unavailable = error => error.errorCode === "HOST_UNAVAILABLE";
const zero = { operations: 0, inputs: 0, uncontainedResources: 0 };
const idle = () => Object.fromEntries("clients turns queuedTurns plans tools processes terminals plugins admissions finalizations writes children workers schedules approvals inputs nativeSessions mcp uncontainedResources".split(" ").map(key => [key, 0]));
const command = name => ({ sessionId: "session", commands: [{ extensionId: "extension", extensionLabel: "Fixture", name }] });
const envelope = (id, request = { kind: "confirm", title: id, message: "Continue?" }) => ({ sessionId: "session", extensionId: "extension", extensionLabel: "Fixture", requestId: id, request });
const child = `
const pending = new Map(); let sequence = 0;
const send = value => console.log(JSON.stringify(value));
require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
  const msg = JSON.parse(line);
  if (pending.has(msg.id)) { const done=pending.get(msg.id); pending.delete(msg.id); done(msg); return; }
  if (msg.method === 'fixture.exit') process.exit(0);
  if (msg.method === 'fixture.proxy') {
    const id='reverse-'+ ++sequence;
    const reply=await new Promise(resolve => { pending.set(id,resolve); send({id,method:'host.proxy',params:msg.params}); });
    send({...reply,id:msg.id}); return;
  }
  send({id:msg.id,result:{ok:true}});
});`;
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "extension-services-path-")), stderr = [], broadcasts = [], calls = [], prompts = [], errors = [];
  const admission = new DesktopHandoffAdmission(); let current = true, shown = deferred(), lastOperation;
  let call = async () => ({ session: { providerId: "provider", modelId: "model", thinkingLevel: "off" } });
  const queue = { push: async input => { calls.push(["queue.push", input]); return { id: "turn", ...input }; }, prioritize: async id => { calls.push(["queue.prioritize", id]); } };
  let host = { generation: "one", isAvailable: () => true, onNotification: () => () => {}, onExit: () => () => {}, call: (...args) => { calls.push(args); return call(...args); } };
  const sidecar = new AgentSidecar(text => stderr.push(text), { command: process.execPath, args: ["-e", child], cwd: root,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, PI_DESKTOP_AGENTS_DIR: join(root, "agents") } });
  const ui = new AgentExtensionBridge({ isAdmissionClosed: () => admission.isClosed(), hasRenderer: () => true,
    onChanged() {}, onToast() {}, onStatus() {}, onError: error => errors.push(error),
    onPrompt: prompt => { prompts.push(prompt); if (!prompt.cancelled) shown.resolve(prompt); } });
  const queueBridge = { queue };
  const options = { ui, isAdmissionClosed: () => admission.isClosed(), current: () => current,
    getHost: () => host, getQueueBridge: () => queueBridge, broadcastEvent: (...args) => broadcasts.push(args) };
  const services = createTrustedExtensionServices(options);
  sidecar.setExtensionServices(services);
  sidecar.setTrustedExtensionBridge({ ...services, configureModel: params => {
    lastOperation = services.configureModel(params); void lastOperation.catch(() => {}); return lastOperation;
  } });
  sidecar.setHost(host);
  t.after(async () => {
    await sidecar.dispose(); assert.equal(await sidecar.confirmExit(2000), true); assert.deepEqual(stderr, []); assert.deepEqual(errors, []);
    admission.dispose(); rmSync(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ kind: "extension-services-sidecar", originalExitConfirmed: true, stderrEmpty: true,
      activity: sidecar.getExtensionServiceActivity(), nativeFamilyQualified: false }));
  });
  await sidecar.call("fixture.ready");
  return { sidecar, services, ui, prompts, errors, broadcasts, calls, options, admission,
    proxy: (method, params, timeout) => sidecar.call("fixture.proxy", { method, params }, timeout),
    prompt: () => shown.promise, resetPrompt: () => { shown = deferred(); },
    call: value => { call = value; }, original: () => lastOperation, retire: () => { current = false; },
    replaceHost: () => { host = { ...host, generation: "next" }; sidecar.setHost(host); },
    hold: () => admission.gate.acquireHandoff("service-fixture", async () => {
      const activity = sidecar.getExtensionServiceActivity(); return { ...idle(), admissions: activity.operations, inputs: activity.inputs, uncontainedResources: activity.uncontainedResources };
    }) };
}
test("real sidecar reverse RPC covers closed admission, publication, model, queue and prompt round trip", async t => {
  const f = await fixture(t), hold = await f.hold();
  for (const [method, params] of [["extensions.commands.publish", command("closed")], ["extensions.ui.request", envelope("closed")],
    ["extensions.model.configure", { sessionId: "session" }], ["session.queuePush", { sessionId: "session", content: "closed" }], ["session.queuePrioritize", { id: "turn" }]]) {
    await assert.rejects(f.proxy(method, params), error => error.errorCode === "HOST_BUSY");
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.prompts, []); hold.cancel();
  await f.proxy("extensions.commands.publish", command("fresh")); assert.equal(f.ui.allCommands()[0].name, "fresh");
  await f.proxy("extensions.diagnostics.publish", { sessionId: "session", diagnostics: [], reports: [{ extensionId: "extension", state: "loaded", toolNames: [], commandNames: ["fresh"], agentNames: [], eventNames: [] }] });
  assert.equal(f.ui.statusForPlugin(["extension"]).state, "loaded");
  const model = await f.proxy("extensions.model.configure", { sessionId: "session", providerId: "provider", modelId: "model" });
  assert.equal(model.ok, true); assert.equal(f.broadcasts[0][1][0].modelKey, "provider/model");
  assert.equal((await f.proxy("session.queuePush", { sessionId: "session", content: "hello", idempotencyKey: "key" })).content, "hello");
  assert.deepEqual(await f.proxy("session.queuePrioritize", { id: "turn" }), { ok: true });
  const request = f.proxy("extensions.ui.request", envelope("confirm")); const prompt = await f.prompt();
  await assert.rejects(f.hold(), { code: "HOST_BUSY" }); f.ui.respond(prompt.promptId, true);
  assert.deepEqual(await request, { kind: "confirm", value: true });
  await f.sidecar.call("agent.disposeSession", { sessionId: "session" }); assert.deepEqual(f.ui.allCommands(), []);
  assert.deepEqual(f.sidecar.getExtensionServiceActivity(), zero);
});
test("outer sidecar timeout and deliberate disposal retain the original model operation", async t => {
  const f = await fixture(t), entered = deferred(), reply = deferred(); f.call(() => { entered.resolve(); return reply.promise; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outer = f.proxy("extensions.model.configure", { sessionId: "session" }, 100);
  const timedOut = assert.rejects(outer, /timeout/); await entered.promise; t.mock.timers.tick(100); await timedOut; t.mock.timers.reset();
  assert.equal(f.sidecar.getExtensionServiceActivity().operations, 1); await f.sidecar.dispose();
  assert.equal(f.sidecar.getExtensionServiceActivity().operations, 1);
  reply.resolve({ session: { providerId: "late", modelId: "model" } }); await assert.rejects(f.original(), unavailable);
  assert.deepEqual(f.broadcasts, []); assert.deepEqual(f.sidecar.getExtensionServiceActivity(), zero);
});
test("original sidecar exit retires UI and retains pending original service work", async t => {
  const f = await fixture(t), entered = deferred(), reply = deferred(); f.call(() => { entered.resolve(); return reply.promise; });
  const outer = f.proxy("extensions.model.configure", { sessionId: "session" }); const stopped = assert.rejects(outer); await entered.promise;
  await assert.rejects(f.sidecar.call("fixture.exit")); await stopped; assert.equal(await f.sidecar.confirmExit(2000), true);
  assert.equal(f.sidecar.getExtensionServiceActivity().operations, 1); reply.resolve({ session: { modelId: "late" } }); await assert.rejects(f.original(), unavailable);
  assert.deepEqual(f.broadcasts, []); assert.deepEqual(f.sidecar.getExtensionServiceActivity(), zero);
});
test("replacement services retain original work and cannot clear newer UI state", async t => {
  const f = await fixture(t), entered = deferred(), reply = deferred(); f.call(() => { entered.resolve(); return reply.promise; });
  const outer = f.proxy("extensions.model.configure", { sessionId: "session" }); const rejected = assert.rejects(outer, unavailable); await entered.promise;
  const replacement = createTrustedExtensionServices(f.options); f.sidecar.setExtensionServices(replacement); f.sidecar.setTrustedExtensionBridge(replacement);
  await f.proxy("extensions.commands.publish", command("new")); assert.equal(f.sidecar.getExtensionServiceActivity().operations, 1);
  reply.resolve({ session: { modelId: "late" } }); await rejected;
  assert.equal(f.ui.allCommands()[0].name, "new"); assert.deepEqual(f.broadcasts, []); assert.deepEqual(f.sidecar.getExtensionServiceActivity(), zero);
});
test("Desktop Host rebind retires original prompts and admits fresh reverse RPC", async t => {
  const f = await fixture(t), old = f.proxy("extensions.ui.request", envelope("old")); const oldPrompt = await f.prompt();
  f.replaceHost(); assert.equal((await old).cancelled, true); assert.equal(f.ui.respond(oldPrompt.promptId, true), false);
  f.resetPrompt(); const next = f.proxy("extensions.ui.request", envelope("new")); const prompt = await f.prompt();
  f.ui.respond(prompt.promptId, true); assert.equal((await next).value, true); assert.deepEqual(f.sidecar.getExtensionServiceActivity(), zero);
});
test("retired service uncertainty and invalid reports remain visible to Desktop handoff", async t => {
  const f = await fixture(t); f.call(async () => { throw new Error("host RPC timeout: session.configure"); });
  await assert.rejects(f.proxy("extensions.model.configure", { sessionId: "session" }), /timeout/);
  const replacement = createTrustedExtensionServices(f.options); f.sidecar.setExtensionServices(replacement);
  assert.equal(f.sidecar.getExtensionServiceActivity().uncontainedResources, 1);
  await f.sidecar.dispose(); assert.equal(f.sidecar.getExtensionServiceActivity().uncontainedResources, 1);
  for (const activity of [undefined, { operations: 0, inputs: 0 }, { ...zero, operations: -1 }]) {
    f.sidecar.setExtensionServices({ dispose() {}, getHandoffActivity: () => activity });
    assert.ok(f.sidecar.getExtensionServiceActivity().uncontainedResources > 1);
  }
});
