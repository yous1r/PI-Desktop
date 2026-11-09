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
      modeClaims: false, modeWaits: false, worktrees: false },
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
  assert.ok(Object.isFrozen(f.unqualified));
  assert.equal(result.children, 0);
  assert.equal(result.workers, 0);
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
  for (const key of Object.keys(f.response.durable)) f.response.durable[key] = true;
  for (const key of Object.keys(f.response.runtime)) f.response.runtime[key] = true;
  const result = await f.inspect();
  assert.equal(result.turns, 1); assert.equal(result.queuedTurns, 1); assert.equal(result.plans, 3);
  assert.equal(result.approvals, 2); assert.equal(result.schedules, 2); assert.equal(result.tools, 1);
  assert.equal(result.processes, 1); assert.equal(result.clients, 1); assert.equal(result.plugins, 1);
  assert.equal(result.admissions, 6); assert.equal(result.writes, 4);
  assert.equal(result.uncontainedResources, f.unqualified.length + 1);
});

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
