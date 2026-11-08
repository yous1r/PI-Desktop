import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { currentSourceAliases } from "./helpers/current-source-vite.mjs";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
let server, DesktopHandoffAdmission, createIpcInvocationRouter, createBackendRouter, IPC, registerScheduledIpc;
before(async () => {
  server = await createServer({
    root: desktop, configFile: false, appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: currentSourceAliases(root) },
  });
  ({ DesktopHandoffAdmission } = await server.ssrLoadModule("/electron/main/runtime/handoff-admission.ts"));
  ({ createIpcInvocationRouter } = await server.ssrLoadModule("/electron/main/ipc/invocation-router.ts"));
  ({ createBackendRouter } = await server.ssrLoadModule("/electron/main/remote/backend-router.ts"));
  ({ registerScheduledIpc } = await server.ssrLoadModule("/electron/main/ipc/scheduled-ipc.ts"));
  ({ IPC } = await server.ssrLoadModule(resolve(root, "packages/shared/src/index.ts")));
});
after(async () => { await server?.close(); });
const deferred = () => { let resolve;const promise = new Promise(yes => { resolve = yes; });return { promise, resolve }; };
const idle = () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0,
  terminals: 0, plugins: 0, admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0,
  schedules: 0, approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0 });
function fixture(t) {
  const admission = new DesktopHandoffAdmission();
  const renderer = new Map();const observed = [];
  const backend = createBackendRouter();
  const router = createIpcInvocationRouter({
    admission, ipcMain: { handle: (channel, fn) => renderer.set(channel, fn) },
    getBackendRouter: () => backend, observeInvoke: channel => observed.push(channel),
  });
  t.after(() => admission.dispose());
  return { admission, renderer, observed, backend, ...router,
    hold: () => admission.gate.acquireHandoff("transfer", async () => ({ ...idle(), admissions: admission.inFlightCount() })) };
}

test("admitted setup keeps a handoff busy until the original async result settles", async t => {
  const f = fixture(t);const pending = deferred();
  f.handle("setup", () => pending.promise);
  const result = f.invoke("setup");
  assert.equal(f.admission.inFlightCount(), 1);
  await assert.rejects(f.hold(), { code: "HOST_BUSY" });
  assert.equal(f.admission.isClosed(), false);
  pending.resolve("done");assert.equal(await result, "done");
  assert.equal(f.admission.inFlightCount(), 0);
  const hold = await f.hold();
  await assert.rejects(f.invoke("setup"), { errorCode: "HOST_BUSY" });
  hold.cancel();assert.equal(await f.invoke("setup"), "done");
  assert.deepEqual(f.observed, ["setup", "setup"]);
});

test("renderer, internal and event-bearing starts share one closed gate", async t => {
  const f = fixture(t);let effects = 0;
  f.handle(IPC.invoke.agentPrompt, async () => ++effects);
  f.handleWithEvent("event-start", async () => ++effects);
  await f.hold();
  const rendered = await f.renderer.get(IPC.invoke.agentPrompt)({}, { sessionId: "local", content: "work" });
  assert.equal(rendered.error.code, "HOST_BUSY");
  await assert.rejects(f.invoke(IPC.invoke.agentPrompt), { errorCode: "HOST_BUSY" });
  assert.equal((await f.renderer.get("event-start")({})).error.code, "HOST_BUSY");
  assert.equal(effects, 0);assert.equal(f.admission.inFlightCount(), 0);
});

test("remote session calls keep their existing route while local handoff is closed", async t => {
  const f = fixture(t);let local = 0;
  const sessionId = "remote:host:session";
  f.backend.registerBackend(sessionId, { handles: () => true, invoke: async () => "remote reply" });
  f.handle(IPC.invoke.agentPrompt, async () => ++local);
  await f.hold();
  const result = await f.renderer.get(IPC.invoke.agentPrompt)({}, { sessionId, content: "remote work" });
  assert.deepEqual(result, { ok: true, data: "remote reply" });
  assert.equal(local, 0);assert.deepEqual(f.observed, []);
  await assert.rejects(f.invoke(IPC.invoke.agentPrompt, [{ sessionId }]), { errorCode: "HOST_BUSY" });
});

test("local admission is rechecked after asynchronous backend routing", async t => {
  const f = fixture(t);let effects = 0;
  f.handle(IPC.invoke.agentPrompt, async () => ++effects);
  const pending = f.renderer.get(IPC.invoke.agentPrompt)({}, { sessionId: "local" });
  const hold = f.hold();
  assert.equal((await pending).error.code, "HOST_BUSY");await hold;
  assert.equal(effects, 0);
});

test("quit and authenticated dialog responses remain usable without exposing event handlers internally", async t => {
  const f = fixture(t);let quits = 0;
  f.handle(IPC.invoke.appQuit, async () => ++quits);
  f.handleWithEvent(IPC.invoke.lifecycleDialogRespond, async event => {
    if (event.sender.id !== 7) throw Object.assign(new Error("wrong sender"), { errorCode: "PERMISSION_DENIED" });
    return "confirmed";
  });
  await f.hold();
  assert.equal(await f.invoke(IPC.invoke.appQuit), 1);
  assert.equal((await f.renderer.get(IPC.invoke.lifecycleDialogRespond)({ sender: { id: 8 } })).error.code, "PERMISSION_DENIED");
  assert.deepEqual(await f.renderer.get(IPC.invoke.lifecycleDialogRespond)({ sender: { id: 7 } }), { ok: true, data: "confirmed" });
  await assert.rejects(f.invoke(IPC.invoke.lifecycleDialogRespond), { errorCode: "NOT_FOUND" });
  assert.equal(quits, 1);assert.equal(f.admission.inFlightCount(), 0);
});

test("disposal cannot erase admitted work and rejects late nested starts", async t => {
  const f = fixture(t);const pending = deferred();let nested = 0;
  f.handle("nested", async () => ++nested);
  f.handle("setup", async () => { await pending.promise;return f.invoke("nested"); });
  const result = f.invoke("setup");
  f.admission.dispose();assert.equal(f.admission.inFlightCount(), 1);
  pending.resolve();await assert.rejects(result, { errorCode: "HOST_BUSY" });
  assert.equal(nested, 0);assert.equal(f.admission.inFlightCount(), 0);assert.equal(f.admission.isClosed(), true);
});

test("synchronous exceptions and structured RPC errors keep their observable result and release setup counts", async t => {
  const f = fixture(t);
  f.handle("failure", () => { throw Object.assign(new Error("rejected"), { data: { errorCode: "PERMISSION_DENIED", retriable: true } }); });
  const result = await f.renderer.get("failure")({});
  assert.equal(result.error.code, "PERMISSION_DENIED");assert.equal(result.error.retriable, true);
  assert.equal(f.admission.inFlightCount(), 0);assert.deepEqual(f.observed, []);
  await assert.rejects(f.invoke("missing"), { errorCode: "NOT_FOUND" });
});

test("scheduled IPC user path creates a durable run and prompts through the same admission owner", async t => {
  const f = fixture(t);const calls = [];const runs = new Map();
  const host = { async call(method) { calls.push(method);return { sessionId: "session", runId: "run", prompt: "scheduled work" }; } };
  f.handle(IPC.invoke.agentPrompt, async request => { calls.push(request.content);return { turnId: "turn" }; });
  registerScheduledIpc({ registrar: f, getHost: () => host, scheduledRunsBySession: runs,
    invoke: f.invoke, admission: f.admission, isQuitting: () => false });
  assert.equal((await f.invoke(IPC.invoke.scheduledExecute, ["task", false])).runId, "run");
  assert.deepEqual(calls, ["scheduled.run", "scheduled work"]);assert.equal(runs.get("session"), "run");
  await f.hold();
  await assert.rejects(f.invoke(IPC.invoke.scheduledExecute, ["task", true]), { errorCode: "HOST_BUSY" });
  await assert.rejects(f.invoke(IPC.invoke.scheduledRun, ["task"]), { errorCode: "HOST_BUSY" });
  assert.deepEqual(calls, ["scheduled.run", "scheduled work"]);
});
