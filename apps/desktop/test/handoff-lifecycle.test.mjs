import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server, DesktopHandoffAdmission, createRuntimeLifecycle;
before(async () => {
  server = await createServer({ root: desktop, configFile: false, appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: currentSourceAliases(resolve(desktop, "../..")) } });
  ({ DesktopHandoffAdmission } = await server.ssrLoadModule("/electron/main/runtime/handoff-admission.ts"));
  ({ createRuntimeLifecycle } = await server.ssrLoadModule("/electron/main/runtime/lifecycle.ts"));
});
after(async () => { await server?.close(); });
const deferred = () => { let resolve;const promise = new Promise(yes => { resolve = yes; });return { promise, resolve }; };
const idle = () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0,
  terminals: 0, plugins: 0, admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0,
  schedules: 0, approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0 });
async function fixture(t) {
  const admission = new DesktopHandoffAdmission();const calls = [];
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "handoff-lifecycle-"));
  let starting = async () => {};
  const host = { async call(method) { calls.push(method);return {}; } };
  const state = { handoffAdmission: admission, host, sidecar: { setHost(value) { assert.equal(value, host);calls.push("rebind"); } }, agentHostBridge: null };
  const runtime = createRuntimeLifecycle({ runtimeState: state, dataDir,
    logger: { app() {} }, sendToRenderer: (channel, payload) => calls.push(payload.restarted ? "restarted" : channel),
    startHost: async () => { calls.push("startHost");await starting(); },
    startSidecar: async () => { calls.push("startSidecar");await starting(); },
    drainApprovedPlanExecutions: async () => { calls.push("drain"); },
    applyNetworkProxyFromAppSettings: async () => {}, plugins: { setServices() {} },
    setCurrentWorkspacePath() {}, rememberPluginScopes() {}, refreshUserMcp: async () => {},
    isQuitting: () => false, getDisplayLocale: () => "en" });
  t.after(async () => { admission.dispose();await rm(dataDir, { recursive: true, force: true }); });
  return { admission, calls, runtime, starting: fn => { starting = fn; },
    hold: () => admission.gate.acquireHandoff("transfer", async () => ({ ...idle(), admissions: admission.inFlightCount() })) };
}

test("closed handoff suppresses both runtime restarts without starting a timer or child", async t => {
  const f = await fixture(t);await f.hold();
  await f.runtime.superviseRestart("host");await f.runtime.superviseRestart("sidecar");
  assert.deepEqual(f.calls, []);assert.equal(f.admission.inFlightCount(), 0);
});

test("restart backoff remains busy and rechecks the gate before starting a child", async t => {
  const f = await fixture(t);t.mock.timers.enable({ apis: ["setTimeout"] });
  const restarting = f.runtime.superviseRestart("sidecar");
  const count = f.admission.inFlightCount();
  try {
    f.admission.dispose();t.mock.timers.tick(500);await restarting;
    assert.equal(count, 1);assert.deepEqual(f.calls, []);assert.equal(f.admission.inFlightCount(), 0);
  } finally { t.mock.timers.reset(); }
});

test("in-flight restart stays counted and cannot drain plans after admission closes", async t => {
  const f = await fixture(t);const entered = deferred();const pending = deferred();
  f.starting(async () => { entered.resolve();await pending.promise; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restarting = f.runtime.superviseRestart("sidecar");t.mock.timers.tick(500);
  try {
    await entered.promise;assert.equal(f.admission.inFlightCount(), 1);
    f.admission.dispose();pending.resolve();await restarting;
    assert.deepEqual(f.calls, ["startSidecar"]);assert.equal(f.admission.inFlightCount(), 0);
  } finally { pending.resolve();await restarting;t.mock.timers.reset(); }
});

test("boot retains its admission through setup and refuses sidecar creation after closure", async t => {
  const f = await fixture(t);const entered = deferred();const pending = deferred();
  f.starting(async () => { entered.resolve();await pending.promise; });
  const booting = f.runtime.bootBackends();
  try {
    await entered.promise;assert.equal(f.admission.inFlightCount(), 1);
    f.admission.dispose();pending.resolve();
    await assert.rejects(booting, { errorCode: "HOST_BUSY" });
    assert.deepEqual(f.calls, ["startHost"]);assert.equal(f.admission.inFlightCount(), 0);
  } finally { pending.resolve();await booting.catch(() => {}); }
});

test("normal host restart rebinds its sidecar and restores locale before draining plans", async t => {
  const f = await fixture(t);t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const restarting = f.runtime.superviseRestart("host");t.mock.timers.tick(500);await restarting;
    assert.deepEqual(f.calls.slice(0, 4), ["startHost", "rebind", "plugins.setLocale", "drain"]);
    assert.equal(f.calls.includes("restarted"), true);assert.equal(f.admission.inFlightCount(), 0);
  } finally { t.mock.timers.reset(); }
});

test("normal sidecar restart still drains approved plans", async t => {
  const f = await fixture(t);t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const restarting = f.runtime.superviseRestart("sidecar");t.mock.timers.tick(500);await restarting;
    assert.deepEqual(f.calls.slice(0, 2), ["startSidecar", "drain"]);
    assert.equal(f.calls.includes("restarted"), true);assert.equal(f.admission.inFlightCount(), 0);
  } finally { t.mock.timers.reset(); }
});
