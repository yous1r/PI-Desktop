import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { AgentExtensionBridge } = await import("../electron/main/agent-extension-ui.ts");
const { createTrustedExtensionServices: createServices } = await import("../electron/main/trusted-extension-services.ts");
const deferred = () => Promise.withResolvers();
const errorCode = expected => error => error.errorCode === expected || error.code === expected;
function fixture(t) {
  let closed = false, current = true, available = true;
  const calls = [], broadcasts = [], errors = [], prompts = [];
  let call = async () => ({ session: { providerId: "provider", modelId: "model", thinkingLevel: "off" } });
  let host = { generation: "one", isAvailable: () => available, call: (...args) => { calls.push(args); return call(...args); } };
  let push = async input => ({ id: "turn", ...input }), prioritize = async () => {};
  let queueBridge = { queue: { push: (...args) => { calls.push(["queue.push", ...args]); return push(...args); }, prioritize: (...args) => { calls.push(["queue.prioritize", ...args]); return prioritize(...args); } } };
  const ui = new AgentExtensionBridge({ isAdmissionClosed: () => closed, hasRenderer: () => true,
    onChanged() {}, onPrompt: prompt => prompts.push(prompt), onToast() {}, onStatus() {}, onError: error => errors.push(error) });
  const options = { getHost: () => host, getQueueBridge: () => queueBridge, current: () => current,
    isAdmissionClosed: () => closed, ui, broadcastEvent: (...args) => broadcasts.push(args) };
  const services = createServices(options); t.after(() => services.dispose?.());
  return { services, ui, calls, broadcasts, errors, prompts, options, close: () => { closed = true; }, open: () => { closed = false; },
    retire: () => { current = false; }, offline: () => { available = false; }, bump: () => { host.generation = "two"; },
    host: value => { if (value) host = value; return host; }, queue: value => { queueBridge = value; },
    call: value => { call = value; }, push: value => { push = value; }, prioritize: value => { prioritize = value; } };
}
for (const method of ["configureModel", "queuePush", "queuePrioritize"]) test(`${method} refuses closed admission before its original dispatch`, async t => {
  const f = fixture(t); f.close(); await assert.rejects(f.services[method]({ sessionId: "session", id: "turn" }), errorCode("HOST_BUSY")); assert.deepEqual(f.calls, []);
});
for (const change of ["replace", "generation", "offline", "sidecar"]) test(`model configuration refuses ${change} of its original owner before dispatch`, async t => {
  const f = fixture(t);
  if (change === "replace") f.host({ generation: "new", isAvailable: () => true, call: async () => { assert.fail("replacement dispatch"); } });
  if (change === "generation") f.bump(); if (change === "offline") f.offline(); if (change === "sidecar") f.retire();
  await assert.rejects(f.services.configureModel({ sessionId: "session" }), errorCode("HOST_UNAVAILABLE")); assert.deepEqual(f.calls, []);
});
for (const change of ["gate", "replace", "generation", "dispose"]) test(`model persistence retains original work and suppresses broadcast after ${change}`, async t => {
  const f = fixture(t), reply = deferred(), entered = deferred(); f.call(() => { entered.resolve(); return reply.promise; });
  const work = f.services.configureModel({ sessionId: "session", providerId: "provider", modelId: "model" });
  const rejected = assert.rejects(work, errorCode(change === "gate" ? "HOST_BUSY" : "HOST_UNAVAILABLE")); await entered.promise;
  if (change === "gate") f.close(); if (change === "replace") f.host({ generation: "new", isAvailable: () => true });
  if (change === "generation") f.bump(); if (change === "dispose") f.services.dispose();
  assert.equal(f.services.getHandoffActivity().operations, 1); reply.resolve({ session: { providerId: "provider", modelId: "model" } }); await rejected;
  assert.equal(f.calls.length, 1); assert.deepEqual(f.broadcasts, []); assert.equal(f.services.getHandoffActivity().operations, 0);
});
for (const method of ["queuePush", "queuePrioritize"]) test(`${method} retains its original bridge and rejects publication after replacement`, async t => {
  const f = fixture(t), reply = deferred(); f.push(() => reply.promise); f.prioritize(() => reply.promise);
  const work = f.services[method]({ sessionId: "session", id: "turn", content: "hello" });
  const rejected = assert.rejects(work, errorCode("HOST_UNAVAILABLE")); f.queue({ queue: { push: () => assert.fail("new queue"), prioritize: () => assert.fail("new queue") } });
  assert.equal(f.services.getHandoffActivity().operations, 1); reply.resolve({ id: "turn" }); await rejected;
  assert.equal(f.calls.length, 1); assert.equal(f.services.getHandoffActivity().operations, 0);
});
test("explicit Host rebind revokes original continuations and permits fresh calls without replay", async t => {
  const f = fixture(t), reply = deferred(); f.call(() => reply.promise);
  const old = f.services.configureModel({ sessionId: "session" }); const rejected = assert.rejects(old, errorCode("HOST_UNAVAILABLE"));
  const host = { generation: "new", isAvailable: () => true, call: async () => ({ session: { providerId: "new", modelId: "model" } }) };
  f.host(host); f.services.rebindHost(host); reply.resolve({ session: { providerId: "old", modelId: "model" } }); await rejected;
  assert.equal((await f.services.configureModel({ sessionId: "session" })).ok, true); assert.equal(f.broadcasts.length, 1); assert.equal(f.broadcasts[0][1][0].modelKey, "new/model");
});
test("matching Host rebind is a no-op and closed admission refuses a replacement binding", async t => {
  const f = fixture(t); f.services.rebindHost(f.host()); f.close(); f.services.rebindHost(f.host());
  const host = { generation: "new", isAvailable: () => true }; f.host(host); assert.throws(() => f.services.rebindHost(host), errorCode("HOST_BUSY"));
  f.open(); f.services.rebindHost(host); assert.deepEqual(f.services.getHandoffActivity(), { operations: 0, inputs: 0, uncontainedResources: 0 });
});
test("captured session cleanup retires only the old source after explicit rebind", async t => {
  const f = fixture(t); f.services.publishCommands({ sessionId: "session", commands: [{ name: "old", extensionId: "e", extensionLabel: "E" }] });
  const cleanup = f.services.captureSession("session"), host = { generation: "new", isAvailable: () => true }; f.host(host); f.services.rebindHost(host);
  f.services.publishCommands({ sessionId: "session", commands: [{ name: "fresh", extensionId: "e", extensionLabel: "E" }] }); cleanup();
  assert.equal(f.ui.commandsForSession("session")[0].name, "fresh");
});

for (const method of ["configureModel", "queuePush", "queuePrioritize"]) test(`${method} preserves unknown completion after timeout and disposal`, async t => {
  const f = fixture(t), failure = new Error("host RPC timeout: fixture");
  const reject = async () => { throw failure; }; f.call(reject); f.push(reject); f.prioritize(reject);
  await assert.rejects(f.services[method]({ sessionId: "session", id: "turn" }), failure);
  f.services.dispose(); assert.deepEqual(f.services.getHandoffActivity(), { operations: 0, inputs: 0, uncontainedResources: 1 });
});
test("known Host error replies do not invent unknown service completion", async t => {
  const f = fixture(t), failure = Object.assign(new Error("session missing"), { code: -32000, errorCode: "NOT_FOUND" });
  f.call(async () => { throw failure; }); await assert.rejects(f.services.configureModel({ sessionId: "session" }), failure);
  assert.deepEqual(f.services.getHandoffActivity(), { operations: 0, inputs: 0, uncontainedResources: 0 });
});
test("malformed reverse UI envelopes fail before renderer publication", async t => {
  const f = fixture(t), envelope = { sessionId: "session", extensionId: "e", extensionLabel: "E" };
  for (const params of [{}, { ...envelope, request: null }, { ...envelope, request: { kind: "unknown" } },
    { ...envelope, request: { kind: "select", title: "bad", options: [12] } }, { ...envelope, request: { kind: "notify", message: "bad", level: {} } }]) {
    assert.throws(() => f.services.requestUi(params), errorCode("INVALID_ARGUMENT"));
  }
  assert.deepEqual(f.prompts, []); assert.equal(f.services.getHandoffActivity().operations, 0);
});
