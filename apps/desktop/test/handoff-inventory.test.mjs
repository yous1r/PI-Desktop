import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopHandoffAdmission } from "../electron/main/runtime/handoff-admission.ts";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";
import { InflightCheckpointer } from "../../../packages/host-runtime/src/inflight-checkpoint.ts";
import { RemoteBootActivity } from "../electron/main/remote/remote-boot-activity.ts";
import { SidecarWorkspaceProcesses } from "../electron/main/agent-sidecar-processes.ts";
import { OwnerHandoffInventorySchema } from "../../../packages/shared/src/owner-handoff.ts";
import * as Value from "typebox/value";

const implementation = new URL("../electron/main/runtime/handoff-inventory.ts", import.meta.url);
const external = () => ({ operations: 0, resources: 0, uncontainedResources: 0 });
const reporter = (value) => ({ getHandoffActivity: () => ({ ...value }) });
const write = () => reporter({ writes: 0, uncontainedResources: 0 });
const code = (expected) => (error) => error.errorCode === expected;

async function fixture() {
  const { inspectDesktopHandoff, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES } = await import(implementation);
  let liveBinding = true;
  const generation = randomUUID();
  const response = {
    activity: { requests: 0, backgroundTasks: 0, writes: 0, uncertain: false },
    durable: { turns: false, queuedTurns: false, plans: false, approvals: false, scheduledRuns: false,
      modeClaims: false, modeWaits: false, worktrees: false, workers: 0 },
    runtime: { tools: false, backgroundProcesses: false, remoteExecutions: false,
      pluginExecutions: false, permissions: false, configSync: false },
    nativeCoverage: "execution_generation_only",
    native: { generation, state: "running", confirmed: false, rootExited: false, activeProcesses: 1 },
  };
  let onInspect = async () => undefined;
  const host = { generation: 1, isAvailable: () => true, call: async (method, request) => {
    assert.equal(method, "ownerHandoff.inspect");
    await onInspect();
    return { ...request, ...structuredClone(response) };
  } };
  const sidecar = {
    captureHostBinding: () => () => liveBinding,
    getExtensionOwnerActivity: () => ({ operations: 0, runtimes: 0, uncontainedResources: 0 }),
    getExtensionWorkspaceProcessActivity: () => ({ operations: 0, processes: 0, uncontainedResources: 0 }),
    getExtensionServiceActivity: () => ({ operations: 0, inputs: 0, uncontainedResources: 0 }),
  };
  const original = {
    binding: { host, sidecar, generation, sourceEpoch: randomUUID(), profileId: "a".repeat(64) },
    admission: new DesktopHandoffAdmission(),
    backends: { retainedSidecars: () => [sidecar], getHandoffActivity: () => ({ operations: 0, retiredSidecars: 0, uncontainedResources: 0 }) },
    agentHost: { handoffBusyCounts: () => ({ turns: 0, queuedTurns: 0, admissions: 0, approvals: 0, inputs: 0 }) },
    plans: { inFlightCount: () => 0 },
    modes: reporter({ operations: 0, turns: 0, queuedTurns: 0, uncontainedResources: 0 }),
    coordination: reporter({ admissions: 0, finalizations: 0, writes: 0, uncontainedResources: 0 }),
    events: reporter({ finalizations: 0, writes: 0, uncontainedResources: 0 }),
    outbox: write(), checkpointer: write(),
    scheduler: { inFlightCount: () => 0 }, scheduledRuns: new Map(), activeTurns: new Map(), activeTools: new Map(),
    plugins: reporter({ operations: 0, plugins: 0, schedules: 0, uncontainedResources: 0 }),
    remote: reporter(external()), browser: reporter({ operations: 0, pages: 0, uncontainedResources: 0 }),
    terminals: reporter({ terminals: 0, uncontainedResources: 0 }),
    userMcp: reporter({ mcp: 0, uncontainedResources: 0 }), mcpOAuth: reporter(external()), speech: reporter(external()),
    modelCatalog: reporter(external()), updater: reporter(external()), mcpControl: reporter(external()),
    vendorOAuth: reporter(external()), personalTodos: reporter(external()), collaboration: reporter(external()),
    surfaces: reporter(external()),
  };
  let current = original;
  return { original, response, host, sidecar, unqualified: DESKTOP_HANDOFF_UNQUALIFIED_SOURCES,
    inspect: () => inspectDesktopHandoff(() => current),
    change: (value) => { current = value; }, invalidate: () => { liveBinding = false; },
    onInspect: (fn) => { onInspect = fn; },
  };
}

test("Desktop inventory reports all nineteen families and retains explicit qualification gaps", async () => {
  const f = await fixture(), result = await f.inspect();
  assert.ok(Value.Check(OwnerHandoffInventorySchema, result));
  assert.equal(Object.keys(result).length, 19);
  assert.ok(f.unqualified.includes("rust-background-admission"));
  assert.ok(f.unqualified.includes("voice-and-live-voice"));
  assert.equal(result.uncontainedResources, f.unqualified.length);
  assert.ok(f.unqualified.includes("worker-execution-classification"));
  assert.equal(f.unqualified.length, 10, "all ten qualification gaps are still retained");
  assert.ok(Object.isFrozen(f.unqualified));
  assert.equal(result.children, 0);
  assert.equal(result.workers, 0, "no durable Worker obligation in this fixture");
  assert.equal(result.nativeSessions, 0, "the running Sidecar root is not a user execution");
  await assert.rejects(f.original.admission.gate.acquireHandoff(randomUUID(), f.inspect), /HOST_BUSY/);
  assert.equal(f.original.admission.isClosed(), false);
});

test("Desktop inventory samples each top-level owner without adding nested plugin or tunnel reports", async () => {
  const f = await fixture();
  f.original.plugins = reporter({ operations: 3, plugins: 2, schedules: 1, uncontainedResources: 4 });
  f.original.remote = reporter({ operations: 5, resources: 6, uncontainedResources: 7 });
  f.sidecar.getExtensionOwnerActivity = () => ({ operations: 8, runtimes: 9, uncontainedResources: 10 });
  f.sidecar.getExtensionWorkspaceProcessActivity = () => ({ operations: 11, processes: 12, uncontainedResources: 13 });
  f.sidecar.getExtensionServiceActivity = () => ({ operations: 14, inputs: 15, uncontainedResources: 16 });
  const result = await f.inspect();
  assert.equal(result.clients, 6);
  assert.equal(result.plugins, 11);
  assert.equal(result.processes, 12);
  assert.equal(result.inputs, 15);
  assert.equal(result.schedules, 1);
  assert.equal(result.admissions, 3 + 5 + 8 + 11 + 14);
  assert.equal(result.uncontainedResources, f.unqualified.length + 4 + 7 + 10 + 13 + 16);
});

test("Desktop inventory preserves local turns, plans, modes, tools and scheduled completions", async () => {
  const f = await fixture();
  f.original.agentHost.handoffBusyCounts = () => ({ turns: 2, queuedTurns: 3, admissions: 4, approvals: 5, inputs: 6 });
  f.original.plans.inFlightCount = () => 7;
  f.original.modes = reporter({ operations: 8, turns: 9, queuedTurns: 10, uncontainedResources: 1 });
  f.original.scheduler.inFlightCount = () => 11;
  f.original.scheduledRuns.set("session", "run"); f.original.activeTurns.set("session", "turn");
  f.original.activeTools.set("tool", {});
  const result = await f.inspect();
  assert.equal(result.turns, 12);
  assert.equal(result.queuedTurns, 13);
  assert.equal(result.plans, 7);
  assert.equal(result.admissions, 12);
  assert.equal(result.approvals, 5);
  assert.equal(result.inputs, 6);
  assert.equal(result.schedules, 12);
  assert.equal(result.tools, 1);
});

test("Desktop inventory maps original Rust durable and runtime obligations without claiming native coverage", async () => {
  const f = await fixture();
  f.response.activity = { requests: 2, backgroundTasks: 3, writes: 4, uncertain: true };
  for (const key of Object.keys(f.response.durable)) {
    if (typeof f.response.durable[key] === "boolean") f.response.durable[key] = true;
  }
  f.response.durable.workers = 4;
  for (const key of Object.keys(f.response.runtime)) f.response.runtime[key] = true;
  const result = await f.inspect();
  assert.equal(result.turns, 1); assert.equal(result.queuedTurns, 1); assert.equal(result.plans, 3);
  assert.equal(result.approvals, 2); assert.equal(result.schedules, 2); assert.equal(result.tools, 1);
  assert.equal(result.processes, 1); assert.equal(result.clients, 1); assert.equal(result.plugins, 1);
  assert.equal(result.admissions, 6); assert.equal(result.writes, 4);
  assert.equal(result.workers, 4, "the durable Worker count is propagated unchanged");
  assert.equal(result.uncontainedResources, f.unqualified.length + 1);
});

test("Desktop inventory counts durable Workers without merging Sidecar families or dropping the gap", async () => {
  const f = await fixture();
  f.response.durable.workers = 2;
  const result = await f.inspect();
  assert.equal(result.workers, 2);
  assert.equal(result.children, 0, "subagent delegations are not Worker sessions");
  assert.equal(result.nativeSessions, 0, "native Pi sessions are not Worker sessions");
  assert.equal(result.turns, 0, "a queued-only Worker adds no Agent Host turn");
  assert.ok(f.unqualified.includes("worker-execution-classification"),
    "the count alone does not qualify the Worker execution classification");
  assert.equal(result.uncontainedResources, f.unqualified.length);
  assert.ok(Value.Check(OwnerHandoffInventorySchema, result));
  await assert.rejects(f.original.admission.gate.acquireHandoff(randomUUID(), f.inspect), /HOST_BUSY/);
});

for (const [label, workers] of [["missing", undefined], ["negative", -1], ["fractional", 0.5],
  ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["non-numeric", true]]) {
  test(`Desktop inventory refuses a ${label} durable Worker count instead of reporting idle`, async () => {
    const f = await fixture();
    f.response.durable.workers = workers;
    await assert.rejects(f.inspect(), (error) => error.message === "HANDOFF_INVALID_INSPECTION");
  });
}

for (const name of ["backends", "admission", "agentHost", "plans", "modes", "coordination", "events", "outbox", "checkpointer",
  "scheduler", "scheduledRuns", "activeTurns", "activeTools", "plugins", "remote", "browser", "terminals", "userMcp", "mcpOAuth", "speech"]) {
  test(`Desktop inventory refuses the missing ${name} owner`, async () => {
    const f = await fixture(); delete f.original[name];
    await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  });
}
for (const [label, value] of [["missing field", { writes: 0 }], ["extra field", { writes: 0, uncontainedResources: 0, retired: 1 }],
  ["negative", { writes: -1, uncontainedResources: 0 }], ["fractional", { writes: 0.5, uncontainedResources: 0 }],
  ["unsafe", { writes: Number.MAX_SAFE_INTEGER + 1, uncontainedResources: 0 }],
  ["NaN", { writes: NaN, uncontainedResources: 0 }], ["promise", Promise.resolve({ writes: 0, uncontainedResources: 0 })]]) {
  test(`Desktop inventory refuses a ${label} source report`, async () => {
    const f = await fixture(); f.original.outbox.getHandoffActivity = () => value;
    await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  });
}

test("Desktop inventory refuses a throwing producer with its source name and no payload leakage", async () => {
  const f = await fixture(); f.original.browser.getHandoffActivity = () => { throw new Error("private source payload"); };
  await assert.rejects(f.inspect(), (error) => error.errorCode === "HANDOFF_INVENTORY_UNAVAILABLE" &&
    error.source === "browser" && !error.message.includes("private"));
});

test("Desktop inventory refuses safe individual counters whose sum overflows", async () => {
  const f = await fixture(); f.original.outbox = reporter({ writes: Number.MAX_SAFE_INTEGER, uncontainedResources: 0 });
  f.original.checkpointer = reporter({ writes: 1, uncontainedResources: 0 });
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
});

for (const [label, replace] of [
  ["Host", (f) => { f.original.binding.host = { ...f.host }; }],
  ["Host generation", (f) => { f.host.generation++; }],
  ["Sidecar", (f) => { f.original.binding.sidecar = { ...f.sidecar }; }],
  ["Sidecar binding", (f) => f.invalidate()],
  ["source epoch", (f) => { f.original.binding.sourceEpoch = randomUUID(); }],
  ["native generation", (f) => { f.original.binding.generation = randomUUID(); }],
  ["profile", (f) => { f.original.binding.profileId = "b".repeat(64); }],
  ["resource owner", (f) => { f.original.remote = reporter(external()); }],
  ["backend owner", (f) => { f.original.backends = { ...f.original.backends }; }],
  ["model catalog", (f) => { f.original.modelCatalog = reporter(external()); }],
  ["updater", (f) => { f.original.updater = reporter(external()); }],
  ["MCP control", (f) => { f.original.mcpControl = reporter(external()); }],
  ["vendor OAuth", (f) => { f.original.vendorOAuth = reporter(external()); }],
  ["personal todos", (f) => { f.original.personalTodos = reporter(external()); }],
  ["collaboration", (f) => { f.original.collaboration = reporter(external()); }],
  ["Electron surfaces", (f) => { f.original.surfaces = reporter(external()); }],
]) {
  test(`Desktop inventory refuses a changed ${label} during original Rust inspection`, async () => {
    const f = await fixture(); f.onInspect(() => { replace(f); });
    await assert.rejects(f.inspect(), code("HANDOFF_OWNER_CHANGED"));
  });
}

test("Desktop inventory checks owner changes on rejected inspection and synchronous report reentry", async () => {
  const f = await fixture(); f.onInspect(() => { f.invalidate(); throw new Error("old transport failed"); });
  await assert.rejects(f.inspect(), code("HANDOFF_OWNER_CHANGED"));
  const g = await fixture(); g.original.browser.getHandoffActivity = () => {
    g.invalidate(); return { operations: 0, pages: 0, uncontainedResources: 0 };
  };
  await assert.rejects(g.inspect(), code("HANDOFF_OWNER_CHANGED"));
});

test("Desktop inventory refuses a missing, unavailable or non-running original owner", async () => {
  const f = await fixture(); f.change(null);
  await assert.rejects(f.inspect(), code("HANDOFF_OWNER_UNAVAILABLE"));
  const g = await fixture(); g.host.isAvailable = () => false;
  await assert.rejects(g.inspect(), code("HANDOFF_OWNER_CHANGED"));
  const h = await fixture(); h.response.native = { ...h.response.native, state: "closed", confirmed: true, rootExited: true, activeProcesses: 0 };
  await assert.rejects(h.inspect(), code("HANDOFF_OWNER_CHANGED"));
});

test("Desktop inventory samples local work admitted while the original Rust read is pending", async () => {
  const f = await fixture(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  f.onInspect(async () => { entered.resolve(); await resume.promise; });
  const reading = f.inspect();
  await entered.promise; f.original.activeTurns.set("session", "turn"); resume.resolve();
  assert.equal((await reading).turns, 1);
});

test("Desktop inventory keeps original writes after queue removal and checkpoint disposal", async (t) => {
  const f = await fixture(), dir = await mkdtemp(join(tmpdir(), "handoff-inventory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appending = Promise.withResolvers(), appended = Promise.withResolvers(), saving = Promise.withResolvers();
  const outbox = new PersistenceOutbox(dir, () => undefined);
  const checkpointer = new InflightCheckpointer(() => saving.promise);
  f.original.outbox = outbox; f.original.checkpointer = checkpointer;
  try {
    await outbox.enqueue({ key: "reply", sessionId: "session", message: { id: "reply" } }, () => ({ isAvailable: () => true,
      call: async () => { appending.resolve(); await appended.promise; } }));
    await appending.promise; await outbox.dropSession("session");
    checkpointer.observe({ sessionId: "session", turnId: "turn", message: { id: "reply", role: "assistant", content: "partial", timestamp: new Date(0).toISOString() } });
    checkpointer.dispose();
    const busy = await f.inspect(); assert.ok(busy.writes >= 2);
    await assert.rejects(f.original.admission.gate.acquireHandoff(randomUUID(), f.inspect), /HOST_BUSY/);
    appended.resolve(); saving.resolve(); await outbox.flush(() => null);
    await checkpointer.flushAll();
    assert.equal((await f.inspect()).writes, 0);
  } finally { appended.resolve(); saving.resolve(); checkpointer.dispose(); }
});

test("Desktop inventory retains retired remote clients and process cleanup uncertainty", async () => {
  const f = await fixture(), remote = new RemoteBootActivity(() => undefined), processes = new SidecarWorkspaceProcesses();
  const clientReport = { operations: 0, resources: 1, uncontainedResources: 1 };
  const client = reporter(clientReport);
  remote.own(client); remote.retire(client);
  f.original.remote = { getHandoffActivity: () => remote.snapshot(reporter(external())) };
  const owner = { ...reporter({ operations: 0, resources: 0, uncontainedResources: 1 }), dispose() {}, rebindHost() {}, captureSession: () => () => {} };
  processes.set(owner); processes.dispose();
  f.sidecar.getExtensionWorkspaceProcessActivity = () => processes.snapshot();
  const result = await f.inspect();
  assert.equal(result.clients, 1);
  assert.ok(result.uncontainedResources >= f.unqualified.length + 2);
});

test("Desktop inventory observes rejected asynchronous reports while refusing their shape", async () => {
  const f = await fixture();
  f.original.outbox.getHandoffActivity = () => Promise.reject(new Error("invalid async producer"));
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  await new Promise(resolve => setImmediate(resolve));
});

test("Desktop inventory refuses accessors without reading them", async () => {
  const f = await fixture(); let reads = 0;
  f.original.outbox.getHandoffActivity = () => ({ get writes() { reads++; return 0; }, uncontainedResources: 0 });
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  assert.equal(reads, 0);
});

test("Desktop inventory retains finalizations and visible browser, terminal, MCP and Speech work", async () => {
  const f = await fixture();
  f.original.coordination = reporter({ admissions: 2, finalizations: 3, writes: 4, uncontainedResources: 1 });
  f.original.events = reporter({ finalizations: 5, writes: 6, uncontainedResources: 1 });
  f.original.browser = reporter({ operations: 7, pages: 8, uncontainedResources: 1 });
  f.original.terminals = reporter({ terminals: 9, uncontainedResources: 1 });
  f.original.userMcp = reporter({ mcp: 10, uncontainedResources: 1 });
  f.original.mcpOAuth = reporter({ operations: 11, resources: 12, uncontainedResources: 1 });
  f.original.speech = reporter({ operations: 13, resources: 14, uncontainedResources: 1 });
  const result = await f.inspect();
  assert.equal(result.admissions, 33); assert.equal(result.finalizations, 8);
  assert.equal(result.writes, 10); assert.equal(result.terminals, 9); assert.equal(result.mcp, 22);
  assert.equal(result.uncontainedResources, f.unqualified.length + 7 + 8 + 14);
});

test("Desktop inventory includes backend setup and retained Sidecar obligations exactly once", async () => {
  const f = await fixture(), old = { ...f.sidecar };
  old.getExtensionOwnerActivity = () => ({ operations: 2, runtimes: 3, uncontainedResources: 4 });
  old.getExtensionWorkspaceProcessActivity = () => ({ operations: 5, processes: 6, uncontainedResources: 7 });
  old.getExtensionServiceActivity = () => ({ operations: 8, inputs: 9, uncontainedResources: 10 });
  f.sidecar.getExtensionOwnerActivity = () => ({ operations: 11, runtimes: 12, uncontainedResources: 0 });
  f.original.backends.retainedSidecars = () => [old, f.sidecar];
  f.original.backends.getHandoffActivity = () => ({ operations: 13, retiredSidecars: 1, uncontainedResources: 1 });
  const result = await f.inspect();
  assert.equal(result.admissions, 2 + 5 + 8 + 11 + 13);
  assert.equal(result.plugins, 15); assert.equal(result.processes, 6); assert.equal(result.inputs, 9);
  assert.equal(result.uncontainedResources, f.unqualified.length + 4 + 7 + 10 + 1 + 1);
});

for (const [label, make] of [
  ["missing current", () => []], ["duplicate current", f => [f.sidecar, f.sidecar]],
  ["sparse", () => Array(1)], ["asynchronous", f => Promise.resolve([f.sidecar])],
  ["rejected", () => Promise.reject(new Error("invalid backend list"))],
  ["accessor", f => Object.defineProperty([f.sidecar], 0, { get() { throw new Error("must not read"); } })],
]) {
  test(`Desktop inventory refuses a ${label} retained Sidecar list`, async () => {
    const f = await fixture(); f.original.backends.retainedSidecars = () => make(f);
    await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  });
}

test("Desktop inventory refuses inconsistent retirement counts and rejected retired reports", async () => {
  const f = await fixture();
  f.original.backends.getHandoffActivity = () => ({ operations: 0, retiredSidecars: 1, uncontainedResources: 0 });
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  const old = { ...f.sidecar, getExtensionOwnerActivity: () => Promise.reject(new Error("retired owner failed")) };
  f.original.backends.retainedSidecars = () => [old, f.sidecar];
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
});

test("Desktop inventory refuses retained owner replacement during synchronous report reentry", async () => {
  const f = await fixture(), old = { ...f.sidecar }; let retained = [old, f.sidecar];
  f.original.backends.retainedSidecars = () => retained;
  f.original.backends.getHandoffActivity = () => ({ operations: 0, retiredSidecars: 1, uncontainedResources: 0 });
  old.getExtensionServiceActivity = () => {
    retained = [{ ...old }, f.sidecar]; return { operations: 0, inputs: 0, uncontainedResources: 0 };
  };
  await assert.rejects(f.inspect(), code("HANDOFF_OWNER_CHANGED"));
});

test("Desktop inventory follows real backend restart retention until original extension work settles", async () => {
  const { DesktopBackendOwner } = await import("../electron/main/runtime/backend-owner.ts");
  const f = await fixture(), state = { host: null, sidecar: null, handoffAdmission: f.original.admission };
  const created = [];
  f.host.onExit = () => () => undefined;
  const owner = new DesktopBackendOwner({ runtimeState: state, fenced: true, isQuitting: () => false,
    host: { prepare: async () => undefined, create: () => f.host, configure: async () => undefined },
    sidecar: { create: () => {
      const exits = new Set();
      const s = { ...f.sidecar, pending: 0, onExit: fn => { exits.add(fn); return () => exits.delete(fn); },
        exit: () => { for (const fn of exits) fn({}); state.sidecar = null; },
        setHost: () => undefined, fenceExecution: async () => true,
        dispose: async () => undefined, confirmExit: async () => true };
      s.getExtensionServiceActivity = () => ({ operations: s.pending, inputs: 0, uncontainedResources: 0 });
      created.push(s); return s;
    }, configure: async () => undefined } });
  f.original.backends = owner;
  await owner.startSidecar(); f.original.binding.sidecar = state.sidecar;
  assert.equal((await f.inspect()).admissions, 0);
  const old = created[0]; old.pending = 1; old.exit();
  await owner.startSidecar(); f.original.binding.sidecar = state.sidecar;
  const busy = await f.inspect();
  assert.equal(busy.admissions, 1); assert.equal(busy.uncontainedResources, f.unqualified.length + 1);
  old.pending = 0;
  const settled = await f.inspect();
  assert.equal(settled.admissions, 0); assert.equal(settled.uncontainedResources, f.unqualified.length);
});

test("Desktop inventory requires a complete model-catalog owner report", async () => {
  const f = await fixture(); delete f.original.modelCatalog;
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  f.original.modelCatalog = reporter({ operations: 0, resources: 0 });
  await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
});

test("Desktop inventory follows a real model refresh until body settlement and retains native uncertainty", async () => {
  const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const catalog = new ModelsDevCatalog({ catalogPath: "unused.json", providers: [],
    isAdmissionClosed: () => f.original.admission.isClosed(), fetchImpl: async () => {
      entered.resolve(); return { ok: true, json: () => release.promise };
    } });
  f.original.modelCatalog = catalog;
  const loading = catalog.refresh();
  try {
    await entered.promise;
    const busy = await f.inspect();
    assert.equal(busy.admissions, 1);
    assert.ok(busy.uncontainedResources > f.unqualified.length);
    await assert.rejects(f.original.admission.gate.acquireHandoff(randomUUID(), f.inspect), /HOST_BUSY/);
  } finally { release.resolve({ fixture: { name: "Fixture", models: { model: { id: "model", name: "Fixture model" } } } }); }
  assert.equal(await loading, true);
  const settled = await f.inspect();
  assert.equal(settled.admissions, 0);
  assert.ok(settled.uncontainedResources > f.unqualified.length);
  catalog.dispose();
});

for (const source of ["updater", "mcpControl", "vendorOAuth", "personalTodos", "collaboration", "surfaces"]) {
  test(`Desktop inventory requires a complete ${source} producer`, async () => {
    const f = await fixture(); delete f.original[source];
    await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
    f.original[source] = reporter({ operations: 0, resources: 0 });
    await assert.rejects(f.inspect(), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  });
  test(`Desktop inventory includes actual ${source} work and resources`, async () => {
    const f = await fixture();
    f.original[source] = reporter({ operations: 2, resources: 3, uncontainedResources: 4 });
    const observed = await f.inspect();
    assert.equal(observed.admissions, 2);
    assert.equal(observed.uncontainedResources, f.unqualified.length + 7);
  });
}

test("Desktop inventory retains replaced MCP listeners and unfinished handlers", async () => {
  const { createMcpControlHandoffOwner } = await import("../electron/main/mcp-control-lifecycle.ts");
  const f = await fixture(), registry = createMcpControlHandoffOwner();
  const original = { operations: 1, resources: 1, uncontainedResources: 1 };
  registry.retain(reporter(original));
  registry.retain(reporter({ operations: 0, resources: 1, uncontainedResources: 0 }));
  f.original.mcpControl = registry;
  assert.equal((await f.inspect()).admissions, 1);
  original.operations = 0; original.resources = 0;
  const settled = await f.inspect();
  assert.equal(settled.admissions, 0);
  assert.equal(settled.uncontainedResources, f.unqualified.length + 2);
});

test("production updater wiring keeps the original Host while inventory observes its settings read", async () => {
  const { register } = await import("node:module");
  register(new URL("./helpers/updater-module-stubs.mjs", import.meta.url));
  const { createDesktopUpdater } = await import("../electron/main/bootstrap/updater.ts");
  const f = await fixture(), pending = Promise.withResolvers();
  let current = { generation: 1, isAvailable: () => true, call: () => pending.promise };
  const controller = createDesktopUpdater({ logger: { app() {} }, send() {}, currentVersion: "0.16.0",
    isPackaged: true, getLocale: () => "en", getHost: () => current, isAdmissionClosed: () => false });
  f.original.updater = controller;
  const checking = controller.check({ manual: true });
  const rejected = assert.rejects(checking, code("HOST_BUSY"));
  assert.equal((await f.inspect()).admissions, 1);
  current = { generation: 2, isAvailable: () => true, call: () => assert.fail("replacement Host must not be called") };
  pending.resolve({ updatePreference: "manual" });
  try { await rejected; assert.equal((await f.inspect()).admissions, 0); }
  finally { controller.dispose(); }
});

test("production updater transport stays in inventory until actual check settlement", async t => {
  const { register } = await import("node:module");
  register(new URL("./helpers/updater-module-stubs.mjs", import.meta.url));
  const { autoUpdater } = await import("./helpers/updater-electron-updater-stub.mjs");
  const { createDesktopUpdater } = await import("../electron/main/bootstrap/updater.ts");
  const f = await fixture(), started = Promise.withResolvers(), pending = Promise.withResolvers();
  const previous = Object.getOwnPropertyDescriptor(autoUpdater, "checkForUpdates");
  autoUpdater.checkForUpdates = () => { started.resolve(); return pending.promise; };
  t.after(() => { if (previous) Object.defineProperty(autoUpdater, "checkForUpdates", previous); else delete autoUpdater.checkForUpdates; });
  const host = { generation: 1, isAvailable: () => true, call: async () => ({ updatePreference: "manual" }) };
  const controller = createDesktopUpdater({ logger: { app() {} }, send() {}, currentVersion: "0.16.0",
    isPackaged: true, getLocale: () => "en", getHost: () => host, isAdmissionClosed: () => false });
  f.original.updater = controller;
  const checking = controller.check({ manual: true });
  try {
    await started.promise;
    assert.equal((await f.inspect()).admissions, 1);
    controller.dispose();
    assert.equal((await f.inspect()).admissions, 1);
  } finally { pending.resolve(); await checking; controller.dispose(); }
  const settled = await f.inspect();
  assert.equal(settled.admissions, 0);
  assert.ok(settled.uncontainedResources > f.unqualified.length);
});

test("a real loopback MCP listener obstructs inventory until its original stop completes", async () => {
  const { McpControlServer } = await import("../electron/main/mcp-control.ts");
  const { createMcpControlHandoffOwner } = await import("../electron/main/mcp-control-lifecycle.ts");
  const f = await fixture(), dir = await mkdtemp(join(tmpdir(), "h1-inventory-mcp-"));
  const registry = createMcpControlHandoffOwner();
  const server = new McpControlServer({ dataDir: dir, port: 0, channels: {}, invoke: async () => undefined,
    isAdmissionClosed: () => f.original.admission.isClosed() });
  registry.retain(server); f.original.mcpControl = registry;
  try {
    await server.start();
    assert.equal((await f.inspect()).uncontainedResources, f.unqualified.length + 1);
    await assert.rejects(f.original.admission.gate.acquireHandoff("mcp-listener", f.inspect), { code: "HOST_BUSY" });
    await server.stop();
    assert.equal((await f.inspect()).uncontainedResources, f.unqualified.length);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

for (const change of ["replacement", "generation", "gate", "dispose"]) {
  test(`production OAuth wiring retains the pending original call after ${change}`, async t => {
    const { createDesktopVendorOAuth } = await import("../electron/main/bootstrap/oauth.ts");
    const f = await fixture(), pending = Promise.withResolvers(), entered = Promise.withResolvers();
    let closed = false;
    let current = { generation: 1, isAvailable: () => true, call: method => {
      assert.equal(method, "providers.list"); entered.resolve(); return pending.promise;
    } };
    const oauth = createDesktopVendorOAuth({ getHost: () => current, isAdmissionClosed: () => closed,
      emit: () => assert.fail("retired operation must not publish"),
      openExternal: () => assert.fail("fixture must not open a browser") });
    t.after(() => oauth.dispose());
    f.original.vendorOAuth = oauth;
    const resolving = oauth.resolveAuth("fixture-account");
    const rejected = assert.rejects(resolving, error => ["HOST_BUSY", "HOST_UNAVAILABLE"].includes(error.errorCode ?? error.code));
    await entered.promise;
    if (change === "replacement") current = { generation: 1, isAvailable: () => true,
      call: () => assert.fail("replacement Host must not be called") };
    if (change === "generation") current.generation += 1;
    if (change === "gate") closed = true;
    if (change === "dispose") oauth.dispose();
    try { assert.ok((await f.inspect()).admissions > 0); }
    finally { pending.resolve({ providers: [] }); }
    await rejected;
    assert.equal((await f.inspect()).admissions, 0);
  });
}

test("Desktop inventory retains an actual todo draft until its writer commits", async () => {
  const { createTodoActivity } = await import("../electron/main/personal-todos/activity.ts");
  const { createTodoCoordinator } = await import("../electron/main/personal-todos/coordinator.ts");
  const f = await fixture(), pending = Promise.withResolvers(), entered = Promise.withResolvers();
  const activity = createTodoActivity(), timers = new Set();
  const coordinator = createTodoCoordinator({ activity, publish() {},
    clock: { now: () => 0, set: callback => { timers.add(callback); return callback; }, clear: timer => timers.delete(timer) },
    persistence: { get: async () => ({ schemaVersion: 1, revision: 0, updatedAt: null, items: [] }),
      replace: request => { entered.resolve(request); return activity.track(() => pending.promise); } } });
  f.original.personalTodos = { getHandoffActivity: () => activity.snapshot() };
  await coordinator.get();
  coordinator.edit({ items: [], expectedEditVersion: 0 });
  assert.equal((await f.inspect()).admissions, 1, "draft alone obstructs idle");
  const saving = coordinator.flush();
  const request = await entered.promise;
  try { assert.equal((await f.inspect()).admissions, 2, "draft and original write both remain visible"); }
  finally { pending.resolve({ schemaVersion: 1, revision: 1, updatedAt: 1, items: request.items }); }
  await saving;
  assert.equal((await f.inspect()).admissions, 0);
  coordinator.dispose();
  assert.equal(timers.size, 0);
});

test("Desktop inventory follows actual collaboration receipt replay through settlement", async () => {
  const { createSessionCollaborationService } = await import("../electron/main/services/session-collaboration.ts");
  const f = await fixture(), pending = Promise.withResolvers(), entered = Promise.withResolvers();
  let mayFlush = false;
  const host = { generation: 1, isAvailable: () => true, call: async method => {
    assert.equal(method, "session.collaboration.settle"); entered.resolve(); await pending.promise; return {};
  } };
  const service = createSessionCollaborationService({ getHost: () => host, getSidecar: () => null,
    getBridge: () => null, getActiveTurn: () => undefined, flushTranscript: async () => mayFlush,
    isPluginLoaded: () => true, isQuitting: () => false, isAdmissionClosed: () => true, onChanged() {}, log() {} });
  f.original.collaboration = service;
  await service.settle("fixture-session", "fixture-turn");
  assert.equal((await f.inspect()).uncontainedResources, f.unqualified.length + 1);
  mayFlush = true;
  const draining = service.drain();
  await entered.promise;
  try { assert.ok((await f.inspect()).admissions > 0); }
  finally { pending.resolve(); }
  await draining;
  const settled = await f.inspect();
  assert.equal(settled.admissions, 0);
  assert.equal(settled.uncontainedResources, f.unqualified.length);
});

test("Desktop inventory follows original surface work through seal and observed cleanup", async () => {
  const { createSurfaceActivity } = await import("../electron/main/surface-activity.ts");
  const f = await fixture(), pending = Promise.withResolvers();
  const surfaces = createSurfaceActivity({ isAdmissionClosed: () => false,
    getHost: () => ({ host: f.host, generation: f.host.generation }) });
  f.original.surfaces = surfaces;
  let alive = true;
  const work = surfaces.begin("fixture-window-load").track(() => pending.promise);
  surfaces.attach("main-window", "fixture-window", () => alive);
  surfaces.seal();
  try {
    const busy = await f.inspect();
    assert.equal(busy.admissions, 1);
    assert.equal(busy.uncontainedResources, f.unqualified.length + 1);
  } finally { pending.resolve(); }
  await work;
  assert.equal((await f.inspect()).uncontainedResources, f.unqualified.length + 1);
  alive = false;
  assert.equal((await f.inspect()).uncontainedResources, f.unqualified.length);
});
