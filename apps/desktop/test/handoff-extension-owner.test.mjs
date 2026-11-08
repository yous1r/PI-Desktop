import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { PluginExtensionOwnerBroker } = await import("../electron/main/plugin-extension-owner-broker.ts");
const { createPluginExtensionOwnerBridge } = await import("../electron/main/plugin-extension-owner-bridge.ts");
const { PluginExtensionLaunchBindings } = await import("../electron/main/plugin-extension-launch-bindings.ts");
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const operations = [{ name: "recall", readOnly: true }, { name: "retire", readOnly: false }];
const session = { sessionId: "session", turnId: "turn", mode: "agent", projectPath: "/project", workspaceRoot: "/project",
  extensions: [{ id: "extension", ownerPluginId: "demo.owner", operations }] };
const registration = { ...session, runtimeId: "runtime", extensionIds: ["extension"] };
const request = { requestId: "request", sessionId: "session", turnId: "turn", runtimeId: "runtime", extensionId: "extension", operation: "recall" };
const launch = { ...session, trustedExtensions: [{ id: "extension", ownerPluginId: "demo.owner", ownerOperations: operations }] };
function fixture(t, overrides = {}) {
  let closed = false; const calls = [];
  const broker = new PluginExtensionOwnerBroker({ isAdmissionClosed: () => closed, assertOwner() {},
    resolveSession: async () => structuredClone(session), acceptRuntime: async () => true,
    dispatch: async (...args) => { calls.push(args); return { ok: true }; }, ...overrides });
  t.after(() => broker.dispose());
  return { broker, calls, close: () => { closed = true; }, open: () => { closed = false; } };
}

test("closed owner admission refuses registration and ordinary calls before Host lookup", async t => {
  let reads = 0; const f = fixture(t, { resolveSession: async () => { reads++; return structuredClone(session); } });
  f.close(); await assert.rejects(f.broker.registerRuntime(registration), { code: "HOST_BUSY" }); assert.equal(reads, 0);
  f.open(); await f.broker.registerRuntime(registration); f.close();
  await assert.rejects(f.broker.callOwner(request), { code: "HOST_BUSY" }); assert.equal(reads, 1);
});

for (const change of ["gate", "close", "unload", "dispose"]) test(`registration ${change} during lookup cannot consume the launch`, async t => {
  const entered = deferred(), release = deferred(); let accepts = 0;
  const f = fixture(t, { resolveSession: async () => { entered.resolve(); await release.promise; return structuredClone(session); },
    acceptRuntime: async () => { accepts++; return true; } });
  const result = assert.rejects(f.broker.registerRuntime(registration)); await entered.promise;
  if (change === "gate") f.close();
  if (change === "close") f.broker.closeSession("session");
  if (change === "unload") f.broker.cancelPlugin("demo.owner");
  if (change === "dispose") f.broker.dispose();
  release.resolve(); await result; assert.equal(accepts, 0);
});

test("retired registration remains active until its original acceptance settles", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { acceptRuntime: async () => { entered.resolve(); return release.promise; } });
  const result = assert.rejects(f.broker.registerRuntime(registration)); await entered.promise;
  f.broker.dispose(); assert.ok(f.broker.getHandoffActivity().operations > 0);
  release.resolve(true); await result; assert.equal(f.broker.getHandoffActivity().operations, 0);
});

for (const phase of ["lookup", "dispatch", "publication"]) test(`cancelled ${phase} remains active after caller cancellation and disposal`, async t => {
  const entered = deferred(), release = deferred(); let reads = 0;
  const f = fixture(t, {
    resolveSession: async () => { reads++; if ((phase === "lookup" && reads === 2) || (phase === "publication" && reads === 3)) { entered.resolve(); await release.promise; } return structuredClone(session); },
    dispatch: async () => { if (phase === "dispatch") { entered.resolve(); await release.promise; } return { ok: true }; },
  });
  await f.broker.registerRuntime(registration);
  const result = assert.rejects(f.broker.callOwner(request), { name: "AbortError" }); await entered.promise;
  f.broker.cancelOwner(request); await result; f.broker.dispose();
  assert.ok(f.broker.getHandoffActivity().operations > 0);
  release.resolve(); await tick(); assert.deepEqual(f.broker.getHandoffActivity(), { operations: 0, runtimes: 0 });
});

test("owner timeout retains original dispatch and the existing request capacity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const entered = deferred(), release = deferred();
  const f = fixture(t, { dispatch: async () => { entered.resolve(); return release.promise; } });
  await f.broker.registerRuntime(registration);
  const result = assert.rejects(f.broker.callOwner(request), { name: "TimeoutError" }); await entered.promise;
  t.mock.timers.tick(10_000); await result;
  const duplicate = assert.rejects(f.broker.callOwner(request), /Duplicate/); t.mock.timers.tick(10_000); await duplicate;
  assert.ok(f.broker.getHandoffActivity().operations > 0);
  release.resolve({}); await tick(); assert.equal(f.broker.getHandoffActivity().operations, 0);
});

test("cancelled unresolved calls continue to occupy the 256-call bound", async t => {
  const release = deferred(); let reads = 0;
  const f = fixture(t, { resolveSession: async () => { reads++; if (reads > 1) await release.promise; return structuredClone(session); } });
  await f.broker.registerRuntime(registration);
  for (let n = 0; n < 256; n++) {
    const input = { ...request, requestId: `request-${n}` };
    const result = assert.rejects(f.broker.callOwner(input), { name: "AbortError" }); f.broker.cancelOwner(input); await result;
  }
  const overflow = { ...request, requestId: "overflow" };
  const rejected = assert.rejects(f.broker.callOwner(overflow), /Too many pending/); f.broker.cancelOwner(overflow); await rejected;
  release.resolve(); await tick(); assert.equal(f.broker.getHandoffActivity().operations, 0);
});

test("admission closing after lookup prevents dispatch and after dispatch prevents publication", async t => {
  for (const phase of ["lookup", "dispatch"]) {
    const entered = deferred(), release = deferred(); let reads = 0, calls = 0;
    const f = fixture(t, { resolveSession: async () => { reads++; if (phase === "lookup" && reads === 2) { entered.resolve(); await release.promise; } return structuredClone(session); },
      dispatch: async () => { calls++; entered.resolve(); await release.promise; return {}; } });
    await f.broker.registerRuntime(registration); const result = assert.rejects(f.broker.callOwner(request), { code: "HOST_BUSY" });
    await entered.promise; f.close(); release.resolve(); await result;
    assert.equal(calls, phase === "lookup" ? 0 : 1); assert.equal(reads, 2);
  }
});

test("closed admission permits only the existing single-use authorized retirement", async t => {
  let reads = 0; const f = fixture(t, { resolveSession: async () => { reads++; return structuredClone(session); } });
  await f.broker.registerRuntime(registration); f.close();
  await assert.rejects(f.broker.callOwner({ ...request, operation: "retire" }), { code: "HOST_BUSY" });
  f.broker.retireRuntime({ ...registration, reason: "app-quit" });
  const before = reads; await assert.rejects(f.broker.callOwner(request), { code: "HOST_BUSY" }); assert.equal(reads, before);
  assert.deepEqual(await f.broker.callOwner({ ...request, operation: "retire" }), { ok: true });
  await assert.rejects(f.broker.callOwner({ ...request, operation: "retire" }), /consumed/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][3].retirementReason, "app-quit");
});

function bridgeFixture(t, dispatch = async () => ({})) {
  const launches = new PluginExtensionLaunchBindings(); launches.observe("agent.prompt", launch);
  const reads = []; let gate, closed = false, available = true;
  const host = { generation: "host-1", isAvailable: () => available, call: async (method) => {
    reads.push(method); if (gate) { const saved = gate; gate = undefined; saved.entered.resolve(); await saved.release.promise; }
    return method === "session.get" ? { session: { id: "session", mode: "agent", projectPath: "/project", worktree: true } } : { path: "/project" };
  } };
  let currentHost = host;
  const plugins = { getAgentExtensions: () => [{ id: "extension", pluginId: "demo.owner", ownerOperations: operations }],
    onExtensionOwnerUnavailable: () => () => {}, callAgentExtension: dispatch };
  const bridge = createPluginExtensionOwnerBridge({ launches, getHost: () => currentHost, plugins,
    isAdmissionClosed: () => closed, pluginActiveInProject: () => true });
  t.after(() => bridge.dispose());
  return { bridge, launches, reads, host, plugins, hold: () => { gate = { entered: deferred(), release: deferred() }; return gate; },
    change: kind => { if (kind === "generation") host.generation = "host-2"; if (kind === "replacement") currentHost = { ...host }; if (kind === "offline") available = false; },
    close: () => { closed = true; } };
}

for (const change of ["generation", "replacement", "offline"]) test(`original Host ${change} during session lookup prevents the next RPC`, async t => {
  const f = bridgeFixture(t); const gate = f.hold(); const result = assert.rejects(f.bridge.registerRuntime(registration));
  await gate.entered.promise; f.change(change); gate.release.resolve(); await result;
  assert.deepEqual(f.reads, ["session.get"]);
});

test("a bridge cannot adopt a newer Host between otherwise idle requests", async t => {
  const f = bridgeFixture(t); await f.bridge.registerRuntime(registration); const count = f.reads.length;
  f.change("generation"); await assert.rejects(f.bridge.callOwner(request)); assert.equal(f.reads.length, count);
});

test("Host loss after plugin dispatch prevents result validation on a replacement owner", async t => {
  const entered = deferred(), release = deferred();
  const f = bridgeFixture(t, async () => { entered.resolve(); return release.promise; });
  await f.bridge.registerRuntime(registration); const result = assert.rejects(f.bridge.callOwner(request));
  await entered.promise; const count = f.reads.length; f.change("generation"); release.resolve({}); await result;
  assert.equal(f.reads.length, count);
});

async function sidecarFixture(t) {
  const child = `const rl=require('node:readline').createInterface({input:process.stdin}); let pending,status; const calls=[];
    const reply=(id,result={ok:true})=>console.log(JSON.stringify({id,result}));
    rl.on('line',line=>{const m=JSON.parse(line); calls.push(m.method); if(m.method==='agent.disposeSession') pending=m.id;
      else if(m.method==='agent.getStatus') status=m.id;
      else if(m.method==='fixture.releaseStatus'){reply(status,{status:{isRunning:false}});reply(m.id);}
      else if(m.method==='fixture.calls') reply(m.id,calls);
      else if(m.method==='fixture.release'){reply(pending);reply(m.id);} else reply(m.id);});`;
  const sidecar = new AgentSidecar(() => {}, { command: process.execPath, args: ["-e", child], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  t.after(async () => { await sidecar.dispose(); assert.equal(await sidecar.confirmExit(2_000), true);
    t.diagnostic(JSON.stringify({ kind: "extension-sidecar", test: t.name, originalChildExitObserved: true,
      activity: sidecar.getExtensionOwnerActivity(), nativeFamilyQualified: false })); });
  await sidecar.call("fixture.ready"); return sidecar;
}

test("sidecar retains original bridge work through replacement and disposal", async t => {
  const entered = deferred(), release = deferred(), sidecar = await sidecarFixture(t);
  const f = bridgeFixture(t, async () => { entered.resolve(); return release.promise; });
  sidecar.setExtensionOwnerLifecycle(f.bridge); await f.bridge.registerRuntime(registration);
  const result = assert.rejects(f.bridge.callOwner(request), { name: "AbortError" }); await entered.promise;
  sidecar.setExtensionOwnerLifecycle({ dispose() {}, closeSession() {}, getHandoffActivity: () => ({ operations: 0, runtimes: 0 }) });
  await result; assert.ok(sidecar.getExtensionOwnerActivity().operations > 0);
  await sidecar.dispose(); assert.ok(sidecar.getExtensionOwnerActivity().operations > 0);
  release.resolve({}); await tick(); assert.deepEqual(sidecar.getExtensionOwnerActivity(), { operations: 0, runtimes: 0, uncontainedResources: 0 });
});

for (const change of ["lifecycle", "launch"]) test(`old disposeSession cannot clear a replacement ${change}`, async t => {
  const sidecar = await sidecarFixture(t); let oldCloses = 0, newCloses = 0;
  sidecar.setExtensionOwnerLifecycle({ dispose() {}, closeSession() { oldCloses++; }, getHandoffActivity: () => ({ operations: 0, runtimes: 0 }) });
  await sidecar.call("agent.prompt", launch);
  const pending = sidecar.call("agent.disposeSession", { sessionId: "session" });
  await sidecar.call("fixture.ready");
  if (change === "lifecycle") sidecar.setExtensionOwnerLifecycle({ dispose() {}, closeSession() { newCloses++; }, getHandoffActivity: () => ({ operations: 0, runtimes: 0 }) });
  await sidecar.call("agent.prompt", { ...launch, turnId: "new-turn" });
  await sidecar.call("fixture.release"); await pending;
  assert.equal(sidecar.extensionOwnerLaunches.get("session")?.turnId, "new-turn");
  assert.equal(oldCloses, 0); assert.equal(newCloses, 0);
});

for (const phase of ["registration", "dispatch"]) test(`changed launch in the ${phase} continuation gap cannot authorize old work`, async t => {
  let calls = 0; const f = bridgeFixture(t, async () => { calls++; return {}; });
  if (phase === "dispatch") await f.bridge.registerRuntime(registration);
  const project = f.plugins.getAgentExtensions;
  f.plugins.getAgentExtensions = () => { queueMicrotask(() => f.launches.observe("agent.prompt", launch)); return project(); };
  await assert.rejects(phase === "registration" ? f.bridge.registerRuntime(registration) : f.bridge.callOwner(request), { name: "AbortError" });
  assert.equal(calls, 0);
  if (phase === "registration") assert.equal(f.launches.accept({ ...registration, runtimeId: "replacement" }), true);
});

test("retirement query from a replaced lifecycle cannot dispose or launch a session", async t => {
  const sidecar = await sidecarFixture(t);
  const lifecycle = () => ({ dispose() {}, closeSession() {}, getHandoffActivity: () => ({ operations: 0, runtimes: 0 }) });
  sidecar.setExtensionOwnerLifecycle(lifecycle()); await sidecar.call("agent.prompt", launch);
  sidecar.extensionOwnerLaunches.invalidatePlugin("demo.owner");
  const pending = assert.rejects(sidecar.call("agent.prompt", launch), /changed during retirement/);
  await sidecar.call("fixture.ready"); assert.ok(sidecar.getExtensionOwnerActivity().operations > 0);
  sidecar.setExtensionOwnerLifecycle(lifecycle()); await sidecar.call("fixture.releaseStatus"); await pending;
  const calls = await sidecar.call("fixture.calls");
  assert.equal(calls.filter(method => method === "agent.prompt").length, 1);
  assert.equal(calls.includes("agent.disposeSession"), false);
});

test("timed-out original session cleanup retains uncertainty after a late reply and root exit", async t => {
  const sidecar = await sidecarFixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = assert.rejects(sidecar.call("agent.disposeSession", { sessionId: "session" }, 10), /timeout/);
  await sidecar.call("fixture.ready"); assert.ok(sidecar.getExtensionOwnerActivity().operations > 0);
  t.mock.timers.tick(10); await pending; await sidecar.call("fixture.release");
  await sidecar.dispose(); assert.equal(await sidecar.confirmExit(2_000), true);
  assert.deepEqual(sidecar.getExtensionOwnerActivity(), { operations: 0, runtimes: 0, uncontainedResources: 1 });
  t.mock.timers.reset();
});

test("missing or invalid lifecycle activity remains a refusal after disposal", async t => {
  const sidecar = await sidecarFixture(t);
  sidecar.setExtensionOwnerLifecycle({ dispose() {}, closeSession() {} });
  sidecar.setExtensionOwnerLifecycle({ dispose() {}, closeSession() {}, getHandoffActivity: () => ({ operations: -1, runtimes: 0 }) });
  await sidecar.dispose(); assert.equal(sidecar.getExtensionOwnerActivity().uncontainedResources, 2);
});
