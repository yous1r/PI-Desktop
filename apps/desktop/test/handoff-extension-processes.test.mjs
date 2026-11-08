import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { ExtensionWorkspaceProcesses } = await import("../electron/main/remote/extension-workspace-processes.ts");
const { createWorkspaceExecutionResolver } = await import("../electron/main/workspace-execution-context.ts");
const fail = code => Object.assign(new Error(code), { code, errorCode: code });
function deferred() { const { promise, resolve, reject } = Promise.withResolvers(); return { promise, resolve, reject }; }
function observe(promise) { void promise.catch(() => {}); return promise; }
const context = { workspaceId: "work", projectId: "work", authority: { kind: "remote", hostKey: "remote" }, roots: [{ path: "/work", name: "Work", primary: true }], platform: "linux", connectionState: "connected", generation: 1 };
const start = processId => ({ action: "start", processId, input: { command: "node", args: [] } });
function fixture(t) {
  const host = { generation: "one", isAvailable: () => true }; const calls = [], errors = [], gates = [];
  let currentHost = host, closed = false, current = true, generation = 1, allowed = true;
  let resolve = async () => context, request = async (_method, input) => input.action === "start" ? { processId: input.processId } : { ok: true };
  const client = { state: () => "connected", generation: () => generation, request: (method, input) => { calls.push(input); return request(method, input); } };
  let currentClient = client;
  const options = { isAdmissionClosed: () => closed, getHost: () => currentHost, current: () => current,
    client: () => currentClient, allowed: () => allowed, resolve: (...args) => resolve(...args), onCleanupError: () => errors.push("cleanup") };
  const router = new ExtensionWorkspaceProcesses(options);
  const call = (request, extra = {}) => router.handle({ sessionId: "session", extensionId: "extension", workspace: { hostKey: "remote", path: "/work" }, request, ...extra });
  t.after(() => { for (const gate of gates) gate.resolve(); router.dispose(); });
  return { router, calls, errors, call, options,
    gate: () => { const gate = deferred(); gates.push(gate); return gate; },
    closed: value => { closed = value; }, current: value => { current = value; }, allowed: value => { allowed = value; },
    host: value => { currentHost = value; }, bumpHost: () => { currentHost.generation += "-next"; }, offline: () => { currentHost.isAvailable = () => false; },
    client: value => { currentClient = value; }, bumpRemote: () => { generation++; },
    resolve: fn => { resolve = fn; }, request: fn => { request = fn; } };
}

test("closed admission refuses extension process start before workspace lookup", async t => {
  const f = fixture(t); let lookups = 0; f.resolve(async () => { lookups++; return context; }); f.closed(true);
  await assert.rejects(f.call(start("blocked")), { code: "HOST_BUSY" }); assert.equal(lookups, 0); assert.equal(f.calls.length, 0);
});
test("admission closing during workspace resolution prevents process launch", async t => {
  const f = fixture(t), gate = f.gate(); f.resolve(async () => { await gate.promise; return context; });
  const pending = f.call(start("late")); f.closed(true); gate.resolve();
  await assert.rejects(pending, { code: "HOST_BUSY" }); assert.equal(f.calls.length, 0);
});
for (const kind of ["replacement", "generation", "offline"]) test(`original local Host ${kind} is checked after process resolution`, async t => {
  const f = fixture(t), gate = f.gate(); f.resolve(async () => { await gate.promise; return context; });
  const pending = f.call(start("late"));
  if (kind === "replacement") f.host({ generation: "two", isAvailable: () => true });
  else if (kind === "generation") f.bumpHost(); else f.offline(); gate.resolve();
  await assert.rejects(pending, { code: "HOST_UNAVAILABLE" }); assert.equal(f.calls.length, 0);
});
test("temporary admission closure skips idle validation without closing a valid process", async t => {
  const f = fixture(t); await f.call(start("active")); let lookups = 0; f.resolve(async () => { lookups++; return context; });
  f.closed(true); await f.router.revalidate(); assert.equal(lookups, 0); assert.deepEqual(f.calls.map(x => x.action), ["start"]);
  f.closed(false); await f.call({ action: "read", processId: "active" });
});
test("idle validation already in flight preserves a valid process when admission closes", async t => {
  const f = fixture(t); await f.call(start("active")); const gate = f.gate(); f.resolve(async () => { await gate.promise; throw fail("HOST_BUSY"); });
  const checking = f.router.revalidate(); f.closed(true); gate.resolve(); await checking;
  assert.deepEqual(f.calls.map(x => x.action), ["start"]);
});
test("write validation closing admission refuses new input and preserves the original process", async t => {
  const f = fixture(t); await f.call(start("active")); const gate = f.gate(); f.resolve(async () => { await gate.promise; return context; });
  const writing = f.call({ action: "write", processId: "active", data: "never" }); f.closed(true); gate.resolve();
  await assert.rejects(writing, { code: "HOST_BUSY" }); assert.deepEqual(f.calls.map(x => x.action), ["start"]);
});
test("process output cannot publish after its local Host changes", async t => {
  const f = fixture(t); await f.call(start("active")); const entered = f.gate(), reply = f.gate();
  f.request(async (_method, input) => { if (input.action === "read") { entered.resolve(); await reply.promise; return { chunks: [], more: false }; } return { ok: true }; });
  const reading = f.call({ action: "read", processId: "active" }); await entered.promise; f.bumpHost(); reply.resolve();
  await assert.rejects(reading, { code: "HOST_UNAVAILABLE" }); assert.deepEqual(f.calls.map(x => x.action), ["start", "read", "close"]);
});
test("closed handles retain original reads and duplicate IDs until completion", async t => {
  const f = fixture(t); await f.call(start("active")); const entered = f.gate(), reply = f.gate();
  f.request(async (_method, input) => { if (input.action === "read") { entered.resolve(); await reply.promise; return { chunks: [], more: false }; } return { ok: true }; });
  const reading = f.call({ action: "read", processId: "active" }); const rejected = observe(assert.rejects(reading, { code: "PROCESS_GONE" })); await entered.promise;
  await f.call({ action: "close", processId: "active" });
  await assert.rejects(f.call(start("active")), { code: "CONFLICT" });
  assert.equal(f.router.getHandoffActivity().resources, 1); assert.ok(f.router.getHandoffActivity().operations > 0);
  reply.resolve(); await rejected; assert.equal(f.router.getHandoffActivity().resources, 0); assert.equal(f.router.getHandoffActivity().operations, 0);
});
test("all 64 retired process slots remain reserved while original reads settle", async t => {
  const f = fixture(t), reply = f.gate(), entered = f.gate(); let reads = 0;
  for (let i = 0; i < 64; i++) await f.call(start(`p${i}`));
  f.request(async (_method, input) => { if (input.action === "read") { if (++reads === 64) entered.resolve(); await reply.promise; return { chunks: [], more: false }; } return input.action === "start" ? { processId: input.processId } : { ok: true }; });
  const pending = Array.from({ length: 64 }, (_, i) => observe(assert.rejects(f.call({ action: "read", processId: `p${i}` }), { code: "PROCESS_GONE" })));
  await entered.promise; await Promise.all(Array.from({ length: 64 }, (_, i) => f.call({ action: "close", processId: `p${i}` })));
  await assert.rejects(f.call(start("overflow")), { code: "LIMIT_EXCEEDED" }); reply.resolve(); await Promise.all(pending);
  assert.equal(f.router.getHandoffActivity().resources, 0); await f.call(start("available"));
});
test("concurrent and reentrant process cleanup joins the exact original close", async t => {
  const f = fixture(t); await f.call(start("active")); const reply = f.gate(); let nested;
  f.request(async (_method, input) => { if (input.action === "close") { if (!nested) nested = Promise.resolve().then(() => f.call({ action: "close", processId: "active" })); await reply.promise; } return { ok: true }; });
  const first = f.call({ action: "close", processId: "active" }), second = f.call({ action: "close", processId: "active" });
  reply.resolve(); await Promise.all([first, second, nested]); assert.equal(f.calls.filter(x => x.action === "close").length, 1);
});
test("disposal waits for late process acceptance before original cleanup", async t => {
  const f = fixture(t), entered = f.gate(), reply = f.gate();
  f.request(async (_method, input) => { if (input.action === "start") { entered.resolve(); await reply.promise; return { processId: input.processId }; } return { ok: true }; });
  const pending = f.call(start("late")); const rejected = assert.rejects(pending, { code: "TOOL_ABORTED" }); await entered.promise; f.router.dispose();
  assert.deepEqual(f.calls.map(x => x.action), ["start"]); reply.resolve(); await rejected;
  assert.deepEqual(f.calls.map(x => x.action), ["start", "close"]);
  assert.deepEqual(f.router.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});
test("cleanup failures are observable once and retain native uncertainty", async t => {
  const f = fixture(t); await f.call(start("active")); f.request(async () => { throw fail("TRANSPORT_LOST"); });
  await assert.rejects(f.call({ action: "close", processId: "active" }), { code: "TRANSPORT_LOST" }); f.router.dispose();
  assert.deepEqual(f.errors, ["cleanup"]); assert.deepEqual(f.router.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});
test("mismatched process start replies trigger original cleanup", async t => {
  const f = fixture(t); f.request(async (_method, input) => input.action === "start" ? { processId: "other" } : { ok: true });
  await assert.rejects(f.call(start("requested")), { code: "INVALID_RESPONSE" }); assert.deepEqual(f.calls.map(x => x.action), ["start", "close"]);
});
test("invalid process cleanup acknowledgements do not report success", async t => {
  const f = fixture(t); await f.call(start("active")); f.request(async () => ({ ok: false }));
  await assert.rejects(f.call({ action: "close", processId: "active" }), { code: "INVALID_RESPONSE" }); assert.deepEqual(f.errors, ["cleanup"]);
});
test("closed admission permits cancellation and close on the saved connection", async t => {
  const f = fixture(t); await f.call(start("active")); f.closed(true); f.current(false);
  await f.call({ action: "cancel", processId: "active" }); await f.call({ action: "close", processId: "active" });
  assert.deepEqual(f.calls.map(x => x.action), ["start", "cancel", "close"]); assert.equal(f.router.getHandoffActivity().uncontainedResources, 1);
});
test("cleanup never borrows a replacement remote generation", async t => {
  const f = fixture(t); await f.call(start("active")); f.bumpRemote();
  await assert.rejects(f.call({ action: "close", processId: "active" }), { code: "HOST_UNAVAILABLE" });
  assert.deepEqual(f.calls.map(x => x.action), ["start"]); assert.deepEqual(f.errors, ["cleanup"]);
});
test("metadata-only refusal does not invent native process activity", async t => {
  const f = fixture(t); await assert.rejects(f.call({ ...start("invalid"), input: { command: "node", args: [], unknown: true } }), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(f.router.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});
test("workspace resolution guards each Host continuation before another RPC", async t => {
  const f = fixture(t), entered = f.gate(), reply = f.gate(), queries = [];
  const host = { generation: "real", isAvailable: () => true, call: async method => { queries.push(method); entered.resolve(); await reply.promise; return { groups: [] }; } };
  f.host(host); f.router.rebindHost?.(host);
  f.resolve(createWorkspaceExecutionResolver({ getHost: () => host, currentWorkspacePath: () => null, remoteState: async () => ({ connected: true, generation: 1, platform: "linux" }) }));
  const pending = f.call(start("guarded")); const rejected = assert.rejects(pending, { code: "HOST_BUSY" }); await entered.promise; f.closed(true); reply.resolve(); await rejected;
  assert.deepEqual(queries, ["project.groups.list"]);
});

const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");
function processSidecar(t) {
  const stderr = [];
  const child = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='fixture.exit')process.exit(0);console.log(JSON.stringify({id:m.id,result:{ok:true}}));});`;
  const sidecar = new AgentSidecar(text => stderr.push(text), { command: process.execPath, args: ["-e", child], cwd: process.env.TEMP,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP } });
  t.after(async () => {
    await sidecar.dispose(); assert.equal(await sidecar.confirmExit(2000), true); assert.deepEqual(stderr, []);
    t.diagnostic(JSON.stringify({ kind: "extension-process-sidecar", originalExitConfirmed: true, stderrEmpty: true, activity: sidecar.getExtensionWorkspaceProcessActivity(), nativeFamilyQualified: false }));
  });
  return sidecar;
}
test("explicit Desktop sidecar disposal retains pending original process cleanup", async t => {
  const f = fixture(t), sidecar = processSidecar(t); sidecar.setExtensionWorkspaceProcesses(f.router); await f.call(start("active"));
  const entered = f.gate(), release = f.gate(); f.request(async () => { entered.resolve(); await release.promise; return { ok: true }; });
  await sidecar.dispose(); await entered.promise;
  assert.ok(sidecar.getExtensionWorkspaceProcessActivity().operations > 0); assert.equal(sidecar.getExtensionWorkspaceProcessActivity().processes, 1);
  const closing = f.call({ action: "close", processId: "active" }); release.resolve(); await closing;
  assert.deepEqual(sidecar.getExtensionWorkspaceProcessActivity(), { operations: 0, processes: 0, uncontainedResources: 1 });
});
test("replacement process routers retain retired cleanup and uncertainty", async t => {
  const f = fixture(t), next = fixture(t), sidecar = processSidecar(t); sidecar.setExtensionWorkspaceProcesses(f.router); await f.call(start("old"));
  const release = f.gate(); f.request(async () => { await release.promise; return { ok: true }; });
  sidecar.setExtensionWorkspaceProcesses(next.router); await next.call(start("new"));
  assert.equal(sidecar.getExtensionWorkspaceProcessActivity().processes, 2);
  const closing = f.call({ action: "close", processId: "old" }); release.resolve(); await closing; await next.call({ action: "close", processId: "new" });
  assert.deepEqual(sidecar.getExtensionWorkspaceProcessActivity(), { operations: 0, processes: 0, uncontainedResources: 2 });
});
test("original sidecar exit closes its extension process router", async t => {
  const f = fixture(t), sidecar = processSidecar(t); sidecar.setExtensionWorkspaceProcesses(f.router); await f.call(start("active"));
  const closed = f.gate(); f.request(async () => { closed.resolve(); return { ok: true }; });
  await assert.rejects(sidecar.call("fixture.exit")); await closed.promise;
  assert.equal(await sidecar.confirmExit(2000), true); assert.equal(f.calls.filter(x => x.action === "close").length, 1);
  await assert.rejects(f.call(start("late")), { code: "HOST_BUSY" });
});
test("explicit sidecar Host rebind retires old processes and permits new starts", async t => {
  const f = fixture(t), sidecar = processSidecar(t); sidecar.setExtensionWorkspaceProcesses(f.router); await f.call(start("old"));
  const host = { generation: "replacement", isAvailable: () => true, onNotification: () => () => {}, onExit: () => () => {} }; f.host(host);
  await assert.rejects(f.call(start("implicit")), { code: "HOST_UNAVAILABLE" }); sidecar.setHost(host);
  await f.call(start("fresh")); sidecar.setHost(host);
  assert.deepEqual(f.calls.map(x => [x.action, x.processId]), [["start", "old"], ["close", "old"], ["start", "fresh"]]);
});
test("session process cleanup captures old handles without closing later starts", async t => {
  const f = fixture(t); await f.call(start("old")); const closeOriginal = f.router.captureSession("session"); await f.call(start("new"));
  closeOriginal(); await f.call({ action: "close", processId: "old" }); await f.call({ action: "read", processId: "new" });
  assert.deepEqual(f.calls.filter(x => x.action === "close").map(x => x.processId), ["old"]);
});
test("Desktop sidecar session disposal invokes the captured process cleanup", async t => {
  const f = fixture(t), sidecar = processSidecar(t); sidecar.setExtensionWorkspaceProcesses(f.router); await f.call(start("session-owned"));
  await sidecar.call("agent.disposeSession", { sessionId: "session" });
  assert.equal(f.calls.filter(x => x.action === "close").length, 1);
});
test("missing or invalid process owner statistics refuse handoff", async t => {
  const sidecar = processSidecar(t);
  for (const activity of [undefined, { operations: 0, resources: 0 }, { operations: -1, resources: 0, uncontainedResources: 0 }]) {
    sidecar.setExtensionWorkspaceProcesses({ dispose() {}, rebindHost() {}, captureSession: () => () => {}, getHandoffActivity: () => activity });
    assert.ok(sidecar.getExtensionWorkspaceProcessActivity().uncontainedResources > 0);
  }
});

for (const kind of ["replacement", "generation"]) test(`captured remote ${kind} during Host resolution is never adopted`, async t => {
  const f = fixture(t), entered = f.gate(), release = f.gate(); let queries = 0, replacementRequests = 0;
  const group = { id: "work", name: "Work", primaryPath: "remote-project:work", roots: [], remote: { hostKey: "remote", path: "/work" } };
  const host = { generation: "real", isAvailable: () => true, call: async method => {
    if (++queries === 3) { entered.resolve(); await release.promise; }
    return method === "project.groups.list" ? { groups: [group] } : { session: { projectPath: "remote-project:work" } };
  } };
  f.host(host); f.router.rebindHost(host);
  f.resolve(createWorkspaceExecutionResolver({ getHost: () => host, currentWorkspacePath: () => null,
    remoteState: async () => { throw Error("The original transport override must be used"); } }));
  const pending = f.call(start("pending")); const rejected = observe(assert.rejects(pending, { code: "HOST_UNAVAILABLE" })); await entered.promise;
  if (kind === "generation") f.bumpRemote();
  else f.client({ state: () => "connected", generation: () => 1, request: async () => { replacementRequests++; return {}; } });
  release.resolve(); await rejected; assert.equal(queries, 3); assert.equal(replacementRequests, 0); assert.equal(f.calls.length, 0);
});
test("Host rebind under closed admission cannot replace an active process owner", async t => {
  const f = fixture(t); await f.call(start("old")); const host = { generation: "new", isAvailable: () => true }; f.host(host); f.closed(true);
  assert.throws(() => f.router.rebindHost(host), { code: "HOST_BUSY" }); assert.deepEqual(f.calls.map(x => x.action), ["start"]);
  f.closed(false); f.router.rebindHost(host); await f.call(start("new")); assert.deepEqual(f.calls.map(x => x.action), ["start", "close", "start"]);
});
