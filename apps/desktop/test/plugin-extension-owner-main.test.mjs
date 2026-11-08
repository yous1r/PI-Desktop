import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");
const { createPluginExtensionOwnerBridge } = await import("../electron/main/plugin-extension-owner-bridge.ts");
const operations = [{ name: "recall", readOnly: true }, { name: "capture", readOnly: false }, { name: "retire", readOnly: false }];
const extension = { id: "extension", pluginId: "demo.owner", ownerOperations: operations };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

// The child is the external process edge. Main's launch observation, routing, broker,
// live Host resolution and cleanup all use their production implementations.
const childSource = `
  const rl = require('node:readline').createInterface({input:process.stdin});
  const pending = new Map(); const runtimes = new Map(); const disposals = []; let next = 0; let isRunning = false;
  const host = (method, params) => new Promise((resolve,reject) => {
    const id = 'reverse-' + ++next; pending.set(id,{resolve,reject});
    console.log(JSON.stringify({id,method:'host.proxy',params:{method,params}}));
  });
  async function retire(sessionId, reason) {
    const runtime = runtimes.get(sessionId); if (!runtime) return {ok:true};
    await host('extensions.owner.retireRuntime',{sessionId,runtimeId:runtime.runtimeId,reason});
    const result = await host('extensions.owner.call',{...runtime,requestId:'terminal-' + ++next,operation:'retire',payload:{}});
    runtimes.delete(sessionId); return result;
  }
  rl.on('line', async line => {
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); return;
    }
    try {
      let result = {ok:true};
      if (msg.method === 'agent.getStatus') result = {status:{isRunning}};
      if (msg.method === 'fixture.running') isRunning = msg.params.value;
      if (msg.method === 'fixture.disposals') result = disposals;
      if (msg.method === 'fixture.proxy') result = await host(msg.params.method,msg.params.params);
      if (msg.method === 'fixture.runtime') { runtimes.set(msg.params.sessionId,msg.params); }
      if (msg.method === 'agent.disposeSession') {
        disposals.push(msg.params);
        try { result = await retire(msg.params.sessionId,msg.params.reason ?? 'reconfigure'); }
        catch(error) { if (!String(error.message).includes('Stale owner runtime')) throw error; }
        finally { runtimes.delete(msg.params.sessionId); }
      }
      if (msg.method === 'agent.shutdown') { for (const sessionId of runtimes.keys()) await retire(sessionId,'app-quit'); }
      if (msg.method === 'fixture.crash') process.exit(3);
      console.log(JSON.stringify({id:msg.id,result}));
    } catch(error) { console.log(JSON.stringify({id:msg.id,error:{code:-32000,message:error.message ?? String(error)}})); }
  });`;

async function fixture(t, dispatch, mode = "agent") {
  const sidecar = new AgentSidecar(() => {}, { command: process.execPath, args: ["-e", childSource] });
  const records = new Map([["session", { id: "session", mode, projectPath: "/project", parentSessionId: "host-parent" }]]);
  const listeners = new Set(); const calls = []; let available = true; let hostGate;
  const host = { generation: "host-generation", isAvailable: () => true, call: async (method, params) => {
    if (hostGate) { hostGate.entered?.resolve(); await hostGate.promise; }
    if (method === "worktree.location") return { path: records.get(params.sessionId)?.worktree?.path };
    assert.equal(method, "session.get"); return { session: structuredClone(records.get(params.id) ?? null) };
  } };
  const plugins = {
    getAgentExtensions: () => available ? [extension] : [],
    onExtensionOwnerUnavailable: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    callAgentExtension: async (pluginId, operation, payload, context) => {
      calls.push({ pluginId, operation, payload, context });
      return dispatch ? dispatch(operation, payload, context) : { turnId: context.turnId, runtimeId: context.runtimeId };
    },
  };
  const bridge = createPluginExtensionOwnerBridge({ launches: sidecar.extensionOwnerLaunches, getHost: () => host, plugins,
    isAdmissionClosed: () => false,
    pluginActiveInProject: (_plugin, project) => project === "/project" || project === "remote:ssh/project" });
  sidecar.setExtensionOwnerLifecycle(bridge);
  sidecar.setTrustedExtensionBridge({ ...bridge, publishCommands() {}, publishDiagnostics() {}, requestUi: async () => ({}),
    configureModel: async () => ({}), queuePush: async () => ({}), queuePrioritize: async () => ({}) });
  const launch = { sessionId: "session", turnId: "turn-1", mode, projectPath: "/project", workspaceRoot: "/project",
    trustedExtensions: [{ id: "extension", ownerPluginId: "demo.owner", ownerOperations: operations }] };
  const request = { sessionId: "session", runtimeId: "runtime-1", turnId: "turn-1", extensionId: "extension", operation: "recall" };
  let sequence = 0;
  const proxy = (method, params) => sidecar.call("fixture.proxy", { method: `extensions.owner.${method}`, params });
  const call = (overrides = {}) => proxy("call", { ...request, requestId: `request-${++sequence}`, ...overrides });
  const registerRuntime = (runtimeId = "runtime-1", currentLaunch = launch) => proxy("registerRuntime", {
    ...currentLaunch, runtimeId, extensionIds: ["extension"],
  });
  t.after(() => sidecar.dispose());
  await sidecar.call("agent.prompt", launch);
  await registerRuntime();
  await sidecar.call("fixture.runtime", request);
  return { sidecar, bridge, records, calls, launch, request, proxy, call, registerRuntime, listeners,
    holdHost: (gate) => { hostGate = gate; },
    unload: () => { for (const listener of listeners) listener("demo.owner"); available = false; },
    reload: () => { available = true; } };
}

test("production Main bridge consults live Host mode, including legacy chat, and never falls back to Agent", async (t) => {
  const f = await fixture(t);
  await f.call({ operation: "capture" });
  for (const mode of ["plan", "goal", "chat"]) {
    f.records.get("session").mode = mode;
    await assert.rejects(f.call({ operation: "capture", mode: "agent" }), /Plan\/Goal/);
    await f.call(); assert.equal(f.calls.at(-1).context.mode, mode === "chat" ? "plan" : mode);
  }
  for (const mode of [undefined, "unknown", { mode: "agent" }]) {
    f.records.get("session").mode = mode;
    await assert.rejects(f.call({ operation: "capture" }), /stale/);
  }
  assert.equal(f.calls.filter((call) => call.operation === "capture").length, 1);
});

test("replacement launch cannot relabel the retiring generation's final local event", async (t) => {
  const f = await fixture(t); await f.call({ operation: "capture" });
  await f.sidecar.call("agent.prompt", { ...f.launch, turnId: "turn-2" });
  await assert.rejects(f.call(), /stale/);
  await f.proxy("retireRuntime", { sessionId: "session", runtimeId: "runtime-1", reason: "reconfigure" });
  await assert.rejects(f.call(), /Only.*retire/);
  await assert.rejects(f.call({ operation: "retire", turnId: "turn-2" }), /stale/);
  await f.call({ operation: "retire" });
  assert.deepEqual({ turn: f.calls.at(-1).context.turnId, runtime: f.calls.at(-1).context.runtimeId,
    reason: f.calls.at(-1).context.retirementReason }, { turn: "turn-1", runtime: "runtime-1", reason: "reconfigure" });
  await assert.rejects(f.call({ operation: "retire" }), /consumed/);
  await assert.rejects(f.registerRuntime(), /not authorized/);
  await f.registerRuntime("runtime-2", { ...f.launch, turnId: "turn-2" });
  await f.call({ runtimeId: "runtime-2", turnId: "turn-2", operation: "capture" });
  assert.equal(f.calls.at(-1).context.turnId, "turn-2");
  await assert.rejects(f.call({ operation: "retire" }), /Stale/);
});

test("reused generation retires under its last admitted turn and still honors a live Plan transition", async (t) => {
  const f = await fixture(t);
  await f.sidecar.call("agent.prompt", { ...f.launch, turnId: "turn-2" });
  await f.call({ turnId: "turn-2" });
  await f.sidecar.call("agent.executeApprovedPlan", { ...f.launch, turnId: "turn-3" });
  await f.proxy("retireRuntime", { sessionId: "session", runtimeId: "runtime-1", reason: "app-quit" });
  f.records.get("session").mode = "plan";
  await assert.rejects(f.call({ turnId: "turn-2", operation: "retire" }), /Plan\/Goal/);
  f.records.get("session").mode = "agent";
  await f.call({ turnId: "turn-2", operation: "retire" });
  assert.equal(f.calls.at(-1).context.turnId, "turn-2");
});

test("production scope resolution rejects cross-project and removed worktree calls and uses Host parent identity", async (t) => {
  const f = await fixture(t);
  await f.call({ payload: { parentSessionId: "forged", projectPath: "/other" } });
  assert.equal(f.calls.at(-1).context.parentSessionId, "host-parent");
  f.records.get("session").projectPath = "/other";
  await assert.rejects(f.call(), /stale/);
  f.records.get("session").projectPath = "/project";
  f.bridge.closeSession("session");
  const launch = { ...f.launch, workspaceRoot: "/worktree" };
  f.records.get("session").worktree = { path: "/worktree" };
  await f.sidecar.call("agent.compact", launch); await f.registerRuntime("worktree-runtime", launch);
  await f.call({ runtimeId: "worktree-runtime" });
  assert.equal(f.calls.at(-1).context.workspaceRoot, "/worktree");
  delete f.records.get("session").worktree;
  await assert.rejects(f.call({ runtimeId: "worktree-runtime" }), /stale/);
});

test("unload cancels pending plugin work and pending authorization; reload cannot revive the old generation", async (t) => {
  const entered = deferred(); const release = deferred(); let signal;
  const f = await fixture(t, async (_op, _payload, context) => { signal = context.signal; entered.resolve(); return release.promise; });
  const pending = assert.rejects(f.call(), /retired/); await entered.promise;
  f.unload(); await pending; assert.equal(signal.aborted, true); release.resolve({});
  assert.equal(f.sidecar.extensionOwnerLaunches.get("session"), undefined);
  f.reload(); await f.sidecar.call("agent.prompt", f.launch);
  await assert.rejects(f.registerRuntime(), /not authorized/);
  const gate = deferred(); f.holdHost(gate);
  const registering = assert.rejects(f.registerRuntime("runtime-2"));
  f.unload(); gate.resolve(); await registering;
});

for (const reason of ["session-close", "reconfigure"]) test(`Main sidecar waits for ${reason} terminal work before clearing session ownership`, async (t) => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, async (operation, _payload, context) => {
    if (operation === "retire") { entered.resolve(context); await release.promise; }
    return { ok: true };
  });
  const pending = f.sidecar.call("agent.disposeSession", { sessionId: "session", reason });
  const context = await entered.promise;
  assert.equal(context.retirementReason, reason); assert.ok(f.sidecar.extensionOwnerLaunches.get("session"));
  release.resolve(); await pending;
  assert.equal(f.sidecar.extensionOwnerLaunches.get("session"), undefined);
  await assert.rejects(f.call({ operation: "retire" }), /Stale/);
});

test("intentional Main sidecar disposal tears down broker/listener even though transport exit handlers are cleared", async (t) => {
  const entered = deferred(); const release = deferred(); let signal;
  const f = await fixture(t, async (_op, _payload, context) => { signal = context.signal; entered.resolve(); return release.promise; });
  const pending = assert.rejects(f.bridge.callOwner({ ...f.request, requestId: "direct" }), { name: "AbortError" });
  await entered.promise; await f.sidecar.dispose(); await pending;
  assert.equal(signal.aborted, true); assert.equal(f.listeners.size, 0); release.resolve({});
  await assert.rejects(f.bridge.registerRuntime({}), { name: "AbortError" });
  await assert.rejects(f.sidecar.call("agent.prompt", f.launch), /unavailable/);
  assert.equal(f.sidecar.extensionOwnerLaunches.get("session"), undefined);
});

test("normal app shutdown delivers app-quit before teardown and unregisters plugin lifecycle listener", async (t) => {
  const f = await fixture(t); await f.sidecar.shutdown();
  assert.equal(f.calls.at(-1).operation, "retire");
  assert.equal(f.calls.at(-1).context.retirementReason, "app-quit");
  assert.equal(f.listeners.size, 0);
  await assert.rejects(f.bridge.callOwner({ ...f.request, requestId: "late" }), { name: "AbortError" });
});

test("unexpected sidecar exit tears down broker without waiting for a later dispose", async (t) => {
  const f = await fixture(t); const exited = deferred(); f.sidecar.onExit(exited.resolve);
  await assert.rejects(f.sidecar.call("fixture.crash")); await exited.promise;
  assert.equal(f.listeners.size, 0);
  await assert.rejects(f.bridge.callOwner({ ...f.request, requestId: "late" }), { name: "AbortError" });
});

test("real Desktop runtime shutdown preserves its original turn through production Main launch replacement", async (t) => {
  const { DesktopAgentRuntime } = await import("../../../packages/agent-runtime/src/runtime.ts");
  const { routeExtensionRequest } = await import("../../../packages/host-runtime/src/extension-owner-routing.ts");
  const f = await fixture(t);
  f.bridge.closeSession("session"); await f.sidecar.call("agent.prompt", f.launch);
  const root = mkdtempSync(join(tmpdir(), "owner-main-runtime-")); const entry = join(root, "extension.ts");
  writeFileSync(entry, `export default function(pi) {
    pi.on("session_start", async (_event, ctx) => { await ctx.owner.call("recall", {}); });
    pi.on("session_shutdown", async (_event, ctx) => { await ctx.owner.call("retire", {}); });
  }`);
  const runtime = new DesktopAgentRuntime({
    host: { call: async (method, params) => method.startsWith("extensions.owner.")
      ? routeExtensionRequest(f.bridge, method, params) : {}, onNotification: () => () => {} },
    sessionId: "session", turnId: "turn-1", projectPath: "/project", mode: "agent", thinkingLevel: "off",
    trustedExtensions: [{ id: "extension", entry, root, source: "plugin", label: "Owner", ownerPluginId: "demo.owner", ownerOperations: operations }],
    provider: { id: "fixture", name: "Fixture", apiKey: "", authKind: "none", baseUrl: "http://127.0.0.1:1/v1",
      modelId: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, onEvent() {},
  });
  t.after(async () => { await runtime.dispose(); rmSync(root, { recursive: true, force: true }); });
  await runtime.loadTrustedExtensions();
  assert.equal(f.calls.at(-1).context.runtimeId, runtime.runtimeId);
  await f.sidecar.call("agent.prompt", { ...f.launch, turnId: "turn-2" });
  await runtime.dispose("reconfigure");
  assert.equal(f.calls.at(-1).operation, "retire");
  assert.equal(f.calls.at(-1).context.turnId, "turn-1");
  assert.equal(f.calls.at(-1).context.runtimeId, runtime.runtimeId);
  assert.equal(f.calls.at(-1).context.retirementReason, "reconfigure");
});

test("an outbound launch during terminal Host validation cannot change or discard the frozen turn", async (t) => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  await f.proxy("retireRuntime", { sessionId: "session", runtimeId: "runtime-1", reason: "reconfigure" });
  f.holdHost({ entered, promise: release.promise });
  const terminal = f.call({ operation: "retire" }); await entered.promise;
  await f.sidecar.call("agent.prompt", { ...f.launch, turnId: "turn-2" });
  release.resolve(); await terminal;
  assert.equal(f.calls.at(-1).context.turnId, "turn-1");
  assert.equal(f.calls.at(-1).context.runtimeId, "runtime-1");
});

test("terminal window expires without re-registration or late writes", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.bridge.retireRuntime({ sessionId: "session", runtimeId: "runtime-1", reason: "app-quit" });
  t.mock.timers.tick(2_001);
  await assert.rejects(f.bridge.callOwner({ ...f.request, requestId: "expired", operation: "retire" }), /Stale/);
  await assert.rejects(f.bridge.registerRuntime({ ...f.launch, runtimeId: "runtime-1", extensionIds: ["extension"] }), /not authorized/);
  assert.equal(f.calls.length, 0);
  t.mock.timers.reset();
});

test("plugin reload retires an idle runtime before the next launch, and never interrupts an active turn", async (t) => {
  const f = await fixture(t);
  await f.sidecar.call("fixture.running", { value: true });
  f.unload(); f.reload();
  await assert.rejects(f.sidecar.call("agent.prompt", f.launch), /active extension runtime/);
  assert.deepEqual(await f.sidecar.call("fixture.disposals"), []);
  await f.sidecar.call("fixture.running", { value: false });
  await f.sidecar.call("agent.prompt", { ...f.launch, turnId: "turn-2" });
  assert.deepEqual(await f.sidecar.call("fixture.disposals"), [{ sessionId: "session", reason: "reconfigure" }]);
  await f.registerRuntime("runtime-2", { ...f.launch, turnId: "turn-2" });
  await f.call({ runtimeId: "runtime-2", turnId: "turn-2", operation: "capture" });
  assert.equal(f.calls.at(-1).context.runtimeId, "runtime-2");
  await assert.rejects(f.registerRuntime(), /not authorized/);
});

test("custom mode owner calls preserve Host identity and cannot gain Agent write authority", async (t) => {
  const f = await fixture(t, undefined, "review");
  await f.call();
  assert.equal(f.calls.at(-1).context.mode, "review");
  await assert.rejects(f.call({ operation: "capture", mode: "agent" }), /Plan[/]Goal/);
  f.records.get("session").mode = "other-mode";
  await assert.rejects(f.call(), /authorized|stale/);
});
