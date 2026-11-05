import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginExtensionOwnerBroker } = await import("../electron/main/plugin-extension-owner-broker.ts");
const operations = [{ name: "recall", readOnly: true }, { name: "capture", readOnly: false }, { name: "retire", readOnly: false }];
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(t, overrides = {}) {
  const session = { sessionId: "s1", turnId: "t1", mode: "agent", projectPath: "remote:ssh/project",
    workspaceRoot: "/worktree", remoteWorkspace: { hostKey: "ssh", path: "/worktree" }, parentSessionId: "parent",
    extensions: [{ id: "e1", ownerPluginId: "demo.owner", operations }] };
  const calls = [];
  const broker = new PluginExtensionOwnerBroker({
    resolveSession: async (id) => id === session.sessionId ? structuredClone(session) : undefined,
    acceptRuntime: async () => true,
    dispatch: async (...args) => { calls.push(args); return { found: true }; }, ...overrides,
  });
  t.after(() => broker.dispose());
  const registration = { ...session, runtimeId: "r1", extensionIds: ["e1"] };
  const request = { requestId: "q1", sessionId: "s1", runtimeId: "r1", extensionId: "e1", turnId: "t1", operation: "recall" };
  return { session, calls, broker, registration, request };
}

test("owner broker uses host scope, detaches data and retires the handler signal on completion", async (t) => {
  const f = fixture(t);
  await f.broker.registerRuntime(f.registration);
  const result = await f.broker.callOwner({ ...f.request, pluginId: "other", mode: "agent",
    payload: { sessionId: "forged", projectPath: "forged", nested: { value: 1 } } });
  assert.deepEqual(result, { found: true });
  const [plugin, operation, payload, context] = f.calls[0];
  assert.equal(plugin, "demo.owner"); assert.equal(operation, "recall");
  assert.equal(payload.sessionId, "forged");
  const { extensions: _extensions, ...identity } = f.session;
  assert.deepEqual({ ...context, signal: undefined }, { ...identity, runtimeId: "r1", signal: undefined });
  assert.equal(context.signal.aborted, true);
});

for (const mode of ["plan", "goal"]) test(`owner broker rejects ${mode} writes including shutdown`, async (t) => {
  const f = fixture(t); f.session.mode = mode; f.registration.mode = mode;
  await f.broker.registerRuntime(f.registration);
  await f.broker.callOwner(f.request);
  await assert.rejects(f.broker.callOwner({ ...f.request, operation: "capture", mode: "agent" }), /Plan\/Goal/);
  f.broker.retireRuntime({ sessionId: "s1", runtimeId: "r1", reason: "app-quit" });
  await assert.rejects(f.broker.callOwner({ ...f.request, operation: "capture" }), /Plan\/Goal/);
  assert.equal(f.calls.length, 1);
});

test("registration and calls refuse forged session, plugin, turn, scope and unapproved generation", async (t) => {
  const f = fixture(t);
  for (const change of [{ sessionId: "s2" }, { mode: "plan" }, { projectPath: "wrong" }, { workspaceRoot: "wrong" },
    { remoteWorkspace: { hostKey: "wrong", path: "/worktree" } }, { extensionIds: ["other"] }]) {
    await assert.rejects(f.broker.registerRuntime({ ...f.registration, ...change }));
  }
  await f.broker.registerRuntime(f.registration);
  for (const change of [{ sessionId: "s2" }, { runtimeId: "r2" }, { extensionId: "other" }, { operation: "arbitrary" },
    { turnId: "wrong" }, { turnId: undefined }]) await assert.rejects(f.broker.callOwner({ ...f.request, ...change }));
  const denied = fixture(t, { acceptRuntime: async () => false });
  await assert.rejects(denied.broker.registerRuntime(denied.registration), /not authorized/);
  assert.equal(f.calls.length, 0);
});

test("cancellation rejects mismatched identity, aborts a waiting handler and discards its late result", async (t) => {
  const entered = deferred(); const result = deferred(); let signal;
  const f = fixture(t, { dispatch: async (_plugin, _operation, _payload, ctx) => { signal = ctx.signal; entered.resolve(); return result.promise; } });
  await f.broker.registerRuntime(f.registration);
  const pending = f.broker.callOwner(f.request); const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  assert.throws(() => f.broker.cancelOwner({ ...f.request, sessionId: "s2" }), /mismatch/);
  assert.throws(() => f.broker.cancelOwner({ ...f.request, extensionId: "e2" }), /mismatch/);
  assert.equal(signal.aborted, false);
  f.broker.cancelOwner(f.request); await rejected; assert.equal(signal.aborted, true); result.resolve("late");
});

for (const action of ["replace", "unload", "close"]) test(`${action} invalidates pending work and old generation`, async (t) => {
  const entered = deferred(); const result = deferred(); let signal;
  const f = fixture(t, { dispatch: async (_p, _o, _v, ctx) => { signal = ctx.signal; entered.resolve(); return result.promise; } });
  await f.broker.registerRuntime(f.registration);
  const pending = assert.rejects(f.broker.callOwner(f.request), { name: "AbortError" });
  await entered.promise;
  if (action === "replace") await f.broker.registerRuntime({ ...f.registration, runtimeId: "r2" });
  if (action === "unload") f.broker.cancelPlugin("demo.owner");
  if (action === "close") f.broker.closeSession("s1");
  await pending; assert.equal(signal.aborted, true); result.resolve("late");
  await assert.rejects(f.broker.callOwner(f.request), /Stale/);
});

test("grant, mode and turn changes during dispatch cannot publish stale results", async (t) => {
  for (const change of [(s) => { s.extensions = []; }, (s) => { s.turnId = "t2"; }, (s) => { s.mode = "plan"; }]) {
    const entered = deferred(); const result = deferred();
    const f = fixture(t, { dispatch: async () => { entered.resolve(); return result.promise; } });
    await f.broker.registerRuntime(f.registration);
    const pending = assert.rejects(f.broker.callOwner({ ...f.request, operation: "capture" }));
    await entered.promise; change(f.session); result.resolve("stale"); await pending;
  }
});

test("owner payload/result bounds and deadline are enforced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(); let signal;
  const f = fixture(t, { dispatch: async (_p, _o, payload, ctx) => {
    if (payload === "large-result") return "x".repeat(256 * 1024);
    signal = ctx.signal; entered.resolve(); return new Promise(() => {});
  } });
  await f.broker.registerRuntime(f.registration);
  await assert.rejects(f.broker.callOwner({ ...f.request, payload: "界".repeat(100_000) }), /256 KiB/);
  await assert.rejects(f.broker.callOwner({ ...f.request, payload: "large-result" }), /256 KiB/);
  const pending = assert.rejects(f.broker.callOwner(f.request), { name: "TimeoutError" });
  await entered.promise; t.mock.timers.tick(10_000); await pending; assert.equal(signal.aborted, true);
});

test("retirement exposes its reason only in a bounded window without closing a replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.broker.registerRuntime(f.registration);
  f.broker.retireRuntime({ ...f.registration, reason: "reconfigure" });
  await f.broker.callOwner({ ...f.request, operation: "retire" });
  assert.equal(f.calls[0][3].retirementReason, "reconfigure");
  await f.broker.registerRuntime({ ...f.registration, runtimeId: "r2" });
  t.mock.timers.tick(2_000);
  await f.broker.callOwner({ ...f.request, runtimeId: "r2" });
  assert.equal(f.calls[1][3].retirementReason, undefined);
  f.broker.retireRuntime({ ...f.registration, runtimeId: "r2", reason: "session-close" });
  t.mock.timers.tick(2_000);
  await assert.rejects(f.broker.callOwner({ ...f.request, runtimeId: "r2" }), /Stale/);
});

test("unload during async registration cannot resurrect an old plugin generation", async (t) => {
  const entered = deferred(); const accepted = deferred();
  const f = fixture(t, { acceptRuntime: async () => { entered.resolve(); return accepted.promise; } });
  const pending = assert.rejects(f.broker.registerRuntime(f.registration), { name: "AbortError" });
  await entered.promise; f.broker.cancelPlugin("demo.owner"); accepted.resolve(true); await pending;
  await assert.rejects(f.broker.callOwner(f.request), /Stale/);
});

test("cancellation while resolving host scope prevents any handler dispatch", async (t) => {
  const f = fixture(t); await f.broker.registerRuntime(f.registration);
  const pending = assert.rejects(f.broker.callOwner(f.request), { name: "AbortError" });
  f.broker.cancelOwner(f.request); await pending;
  assert.equal(f.calls.length, 0);
});
