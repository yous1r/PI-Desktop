import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DesktopHandoffAdmission } from "../electron/main/runtime/handoff-admission.ts";

const implementation = new URL("../electron/main/runtime/handoff-coordinator.ts", import.meta.url);
const record = JSON.parse(readFileSync(new URL("../../../packages/shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8")).response.record;
const deferred = () => Promise.withResolvers();
const code = expected => error => error.errorCode === expected;
const report = value => ({ getHandoffActivity: () => ({ ...value }) });
function fixture() {
  const admission = new DesktopHandoffAdmission();
  let valid = true;
  const native = { generation: randomUUID(), state: "running", activeProcesses: 1, rootExited: false, confirmed: false };
  const identity = { sourceEpoch: record.sourceEpoch, profileId: record.profile };
  const calls = [];
  let before = async () => {};
  const host = { generation: randomUUID(), isAvailable: () => true, async call(method, request) {
    calls.push(method); await before(method, request);
    if (method === "ownerHandoff.identity") return { ...request, ...identity };
    if (method === "ownerHandoff.readTransfer") return { ...request, record: structuredClone(record) };
    assert.equal(method, "ownerHandoff.inspect");
    return { ...request, native: { ...native }, nativeCoverage: "execution_generation_only",
      activity: { requests: 0, backgroundTasks: 0, writes: 0, uncertain: false },
      durable: { turns: false, queuedTurns: false, plans: false, approvals: false, scheduledRuns: false, modeClaims: false, modeWaits: false, worktrees: false },
      runtime: { tools: false, backgroundProcesses: false, remoteExecutions: false, pluginExecutions: false, permissions: false, configSync: false } };
  } };
  const sidecar = {
    captureHostBinding: original => () => valid && original === host,
    async executionStatus() { calls.push("native"); await before("native"); return { ...native }; },
    async call() { assert.fail("unqualified Desktop must not acquire a Sidecar hold"); },
    getExtensionOwnerActivity: () => ({ operations: 0, runtimes: 0, uncontainedResources: 0 }),
    getExtensionWorkspaceProcessActivity: () => ({ operations: 0, processes: 0, uncontainedResources: 0 }),
    getExtensionServiceActivity: () => ({ operations: 0, inputs: 0, uncontainedResources: 0 }),
  };
  const external = () => report({ operations: 0, resources: 0, uncontainedResources: 0 });
  const writes = () => report({ writes: 0, uncontainedResources: 0 });
  const original = { host, sidecar, admission,
    backends: { retainedSidecars: () => [sidecar], getHandoffActivity: () => ({ operations: 0, retiredSidecars: 0, uncontainedResources: 0 }) },
    agentHost: { handoffBusyCounts: () => ({ turns: 0, queuedTurns: 0, admissions: 0, approvals: 0, inputs: 0 }) },
    plans: { inFlightCount: () => 0 }, scheduler: { inFlightCount: () => 0 },
    modes: report({ operations: 0, turns: 0, queuedTurns: 0, uncontainedResources: 0 }),
    coordination: report({ admissions: 0, finalizations: 0, writes: 0, uncontainedResources: 0 }),
    events: report({ finalizations: 0, writes: 0, uncontainedResources: 0 }), outbox: writes(), checkpointer: writes(),
    scheduledRuns: new Map(), activeTurns: new Map(), activeTools: new Map(),
    plugins: report({ operations: 0, plugins: 0, schedules: 0, uncontainedResources: 0 }),
    remote: external(), browser: report({ operations: 0, pages: 0, uncontainedResources: 0 }),
    terminals: report({ terminals: 0, uncontainedResources: 0 }), userMcp: report({ mcp: 0, uncontainedResources: 0 }),
    mcpOAuth: external(), speech: external(),
  };
  let live = original;
  return { admission, host, sidecar, native, identity, original, calls,
    current: () => live, replace: value => { live = value; }, invalidate: () => { valid = false; },
    before: callback => { before = callback; },
    request: { version: 1, operation: "hold", exchangeId: randomUUID(), transferId: record.id, sourceEpoch: record.sourceEpoch, revision: 1 },
  };
}

test("Desktop binding obtains Rust identity and native generation before using original inventory and journal", async () => {
  const { bindDesktopHandoffOwner } = await import(implementation);
  const f = fixture(), owner = await bindDesktopHandoffOwner(f.current);
  const binding = owner.current().binding;
  assert.equal(binding.host, f.host); assert.equal(binding.sidecar, f.sidecar);
  assert.equal(binding.sourceEpoch, f.identity.sourceEpoch); assert.equal(binding.generation, f.native.generation);
  assert.ok((await owner.inspect()).uncontainedResources >= 10);
  assert.deepEqual(await owner.readTransfer(record.id), { version: 1, record });
  assert.deepEqual(f.calls, ["ownerHandoff.identity", "native", "ownerHandoff.inspect", "ownerHandoff.readTransfer"]);
});

for (const boundary of ["ownerHandoff.identity", "native", "ownerHandoff.inspect", "ownerHandoff.readTransfer"]) {
  for (const rejects of [false, true]) {
    test(`Desktop binding rejects replaced owners after ${boundary} ${rejects ? "failure" : "success"}`, async () => {
      const { bindDesktopHandoffOwner } = await import(implementation);
      const f = fixture(), entered = deferred(), resumed = deferred();
      const owner = boundary === "ownerHandoff.identity" || boundary === "native" ? null : await bindDesktopHandoffOwner(f.current);
      f.before(async method => { if (method === boundary) { entered.resolve(); await resumed.promise; if (rejects) throw new Error("private source payload"); } });
      const pending = owner ? boundary === "ownerHandoff.inspect" ? owner.inspect() : owner.readTransfer(record.id) : bindDesktopHandoffOwner(f.current);
      const rejected = assert.rejects(pending, code("HANDOFF_OWNER_CHANGED"));
      await entered.promise; f.replace({ ...f.original, host: { ...f.host, call: () => assert.fail("replacement called") } }); resumed.resolve();
      await rejected;
      assert.equal(f.admission.isClosed(), false, "readonly binding does not own admission");
    });
  }
}

for (const changed of ["generation", "sidecar", "token", "source"]) {
  test(`Desktop binding rejects ${changed} replacement during identity resolution`, async () => {
    const { bindDesktopHandoffOwner } = await import(implementation);
    const f = fixture(), entered = deferred(), resumed = deferred();
    f.before(async () => { entered.resolve(); await resumed.promise; });
    const pending = bindDesktopHandoffOwner(f.current);
    const rejected = assert.rejects(pending, code("HANDOFF_OWNER_CHANGED"));
    await entered.promise;
    if (changed === "generation") f.host.generation = randomUUID();
    if (changed === "sidecar") f.replace({ ...f.original, sidecar: { ...f.sidecar } });
    if (changed === "token") f.invalidate();
    if (changed === "source") f.original.backends = { ...f.original.backends };
    resumed.resolve(); await rejected;
    assert.deepEqual(f.calls, ["ownerHandoff.identity"]);
  });
}

test("Desktop binding rejects synchronous capture reentry before making RPCs", async () => {
  const { bindDesktopHandoffOwner } = await import(implementation);
  const f = fixture();
  f.sidecar.captureHostBinding = () => { f.replace({ ...f.original, events: { ...f.original.events } }); return () => true; };
  await assert.rejects(bindDesktopHandoffOwner(f.current), code("HANDOFF_OWNER_CHANGED"));
  assert.deepEqual(f.calls, []);
});

test("Desktop binding rejects a missing producer before querying authority", async () => {
  const { bindDesktopHandoffOwner } = await import(implementation);
  const f = fixture(); delete f.original.remote;
  await assert.rejects(bindDesktopHandoffOwner(f.current), code("HANDOFF_INVENTORY_UNAVAILABLE"));
  assert.deepEqual(f.calls, []);
});

for (const field of ["state", "rootExited", "confirmed", "activeProcesses"]) {
  test(`Desktop binding refuses invalid native ${field}`, async () => {
    const { bindDesktopHandoffOwner } = await import(implementation);
    const f = fixture(); f.native[field] = field === "state" ? "closed" : field === "activeProcesses" ? 0 : true;
    await assert.rejects(bindDesktopHandoffOwner(f.current), code("HANDOFF_OWNER_CHANGED"));
    assert.equal(f.admission.isClosed(), false);
  });
}

test("Desktop binding stays revoked after a detected source replacement returns", async () => {
  const { bindDesktopHandoffOwner } = await import(implementation);
  const f = fixture(), owner = await bindDesktopHandoffOwner(f.current);
  f.replace({ ...f.original, plugins: { ...f.original.plugins } });
  assert.throws(() => owner.current(), code("HANDOFF_OWNER_CHANGED"));
  f.replace(f.original);
  await assert.rejects(owner.readTransfer(record.id), code("HANDOFF_OWNER_CHANGED"));
  assert.deepEqual(f.calls, ["ownerHandoff.identity", "native"]);
});

test("Desktop coordinator uses the real inventory refusal and survives ordinary owner replacement", async () => {
  const { DesktopHandoffCoordinator } = await import(implementation);
  const f = fixture(), coordinator = new DesktopHandoffCoordinator(f.admission, f.current);
  assert.deepEqual(f.calls, [], "construction is not a startup query");
  await assert.rejects(coordinator.exchange(f.request), error => error.code === "HOST_BUSY");
  assert.equal(f.admission.isClosed(), false);
  const replacement = fixture(); replacement.original.admission = f.admission;
  f.replace(replacement.original);
  await assert.rejects(coordinator.exchange(replacement.request), error => error.code === "HOST_BUSY");
  assert.equal(f.admission.isClosed(), false);
  assert.deepEqual(replacement.calls, ["ownerHandoff.identity", "native", "ownerHandoff.inspect"]);
  coordinator.dispose();
});

test("Desktop coordinator reserves exchange before reentrant identity callbacks", async () => {
  const { DesktopHandoffCoordinator } = await import(implementation);
  const f = fixture(), coordinator = new DesktopHandoffCoordinator(f.admission, f.current);
  f.before(async method => { if (method === "ownerHandoff.identity") await assert.rejects(coordinator.exchange(f.request), code("HANDOFF_BUSY")); });
  await assert.rejects(coordinator.exchange(f.request), error => error.code === "HOST_BUSY");
  assert.equal(f.calls.filter(method => method === "ownerHandoff.identity").length, 1);
  coordinator.dispose();
});

for (const action of ["dispose", "maintenance"]) {
  test(`Desktop coordinator cannot proceed when ${action} closes admission during preparation`, async () => {
    const { DesktopHandoffCoordinator } = await import(implementation);
    const f = fixture(), entered = deferred(), resumed = deferred();
    const coordinator = new DesktopHandoffCoordinator(f.admission, f.current);
    f.before(async () => { entered.resolve(); await resumed.promise; });
    const pending = coordinator.exchange(f.request);
    const rejected = assert.rejects(pending, code(action === "dispose" ? "HANDOFF_UNAVAILABLE" : "HANDOFF_BUSY"));
    await entered.promise;
    if (action === "dispose") coordinator.dispose();
    else await f.admission.gate.acquire("maintenance", async () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0 }));
    resumed.resolve(); await rejected;
    assert.equal(f.admission.isClosed(), true);
    assert.deepEqual(f.calls, ["ownerHandoff.identity"]);
    coordinator.dispose();
  });
}

test("Desktop coordinator rejects a foreign admission source without authority queries", async () => {
  const { DesktopHandoffCoordinator } = await import(implementation);
  const f = fixture(), coordinator = new DesktopHandoffCoordinator(new DesktopHandoffAdmission(), f.current);
  await assert.rejects(coordinator.exchange(f.request), code("HANDOFF_OWNER_CHANGED"));
  assert.deepEqual(f.calls, []); coordinator.dispose();
});

for (const boundary of ["ownerHandoff.identity", "native"]) {
  test(`Desktop ${boundary} deadline observes late rejection without accepting a binding`, async t => {
    const { bindDesktopHandoffOwner } = await import(implementation);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), entered = deferred(), resumed = deferred();
    f.before(async method => { if (method === boundary) { entered.resolve(); await resumed.promise; throw new Error("late private failure"); } });
    const pending = bindDesktopHandoffOwner(f.current);
    const rejected = assert.rejects(pending, code("HANDOFF_QUERY_TIMEOUT"));
    await entered.promise; t.mock.timers.tick(2500); await rejected;
    resumed.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.admission.isClosed(), false);
  });
}

for (const rejects of [false, true]) {
  test(`Desktop coordinator permanently closes admission after changed inventory ${rejects ? "failure" : "success"}`, async () => {
    const { DesktopHandoffCoordinator } = await import(implementation);
    const f = fixture(), entered = deferred(), resumed = deferred();
    const coordinator = new DesktopHandoffCoordinator(f.admission, f.current);
    f.before(async method => { if (method === "ownerHandoff.inspect") {
      entered.resolve(); await resumed.promise; if (rejects) throw new Error("original read failed");
    } });
    const pending = coordinator.exchange(f.request);
    const rejected = assert.rejects(pending, code("HANDOFF_OWNER_CHANGED"));
    await entered.promise; assert.equal(f.admission.isClosed(), true);
    f.replace({ ...f.original, backends: { ...f.original.backends } }); resumed.resolve(); await rejected;
    f.replace(f.original);
    await assert.rejects(f.admission.run(() => assert.fail("changed source reopened admission")), /HOST_BUSY/);
    await assert.rejects(coordinator.exchange(f.request), code("HANDOFF_OWNER_CHANGED"));
    coordinator.dispose();
  });
}

test("Desktop coordinator refuses malformed requests without starting identity resolution", async () => {
  const { DesktopHandoffCoordinator } = await import(implementation);
  const f = fixture(), coordinator = new DesktopHandoffCoordinator(f.admission, f.current);
  await assert.rejects(coordinator.exchange({ ...f.request, inventory: {} }), code("HANDOFF_INVALID_REQUEST"));
  assert.deepEqual(f.calls, []); assert.equal(f.admission.isClosed(), false); coordinator.dispose();
});
