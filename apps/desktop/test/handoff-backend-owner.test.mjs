import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { DesktopBackendOwner } = await import("../electron/main/runtime/backend-owner.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");

const deferred = () => Promise.withResolvers();
function fixture(t, { fenced = true, prepare, configureHost, configureSidecar, createSidecar } = {}) {
  const calls = [], hosts = [], sidecars = [];
  const state = { host: null, sidecar: null, handoffAdmission: new DesktopHandoffAdmission() };
  let quitting = false;
  function makeHost() {
    const exits = new Set();
    const h = { generation: `host-${hosts.length}`, available: true, ended: false,
      isAvailable() { return this.available; },
      onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      exit() { this.available = false; this.ended = true; for (const fn of exits) fn({}); if (state.host === h) state.host = null; },
      async dispose() { calls.push(["disposeHost", h]); h.exit(); },
      async confirmExit() { return h.ended; },
    };
    hosts.push(h); calls.push(["createHost", h]); return h;
  }
  function makeSidecar(h) {
    const exits = new Set();
    const s = { host: h, ended: false, busy: 0, unknown: 0,
      onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      exit() { this.ended = true; for (const fn of exits) fn({}); if (state.sidecar === s) state.sidecar = null; },
      setHost(next) { calls.push(["rebind", s, next]); s.host = next; },
      captureHostBinding(original) { return () => !s.ended && s.host === original; },
      async fenceExecution() { calls.push(["fence", s, h]); return true; },
      async dispose() { calls.push(["disposeSidecar", s]); s.exit(); },
      async shutdown() { calls.push(["shutdownSidecar", s]); await s.dispose(); },
      async confirmExit() { return s.ended; },
      getExtensionOwnerActivity: () => ({ operations: s.busy, runtimes: 0, uncontainedResources: s.unknown }),
      getExtensionWorkspaceProcessActivity: () => ({ operations: 0, processes: 0, uncontainedResources: 0 }),
      getExtensionServiceActivity: () => ({ operations: 0, inputs: 0, uncontainedResources: 0 }),
    };
    sidecars.push(s); calls.push(["createSidecar", s, h]); return s;
  }
  const owner = new DesktopBackendOwner({ runtimeState: state, fenced, isQuitting: () => quitting,
    host: { prepare: async () => { calls.push(["prepareHost"]); return prepare?.(); }, create: makeHost,
      configure: async (h, _prepared, check) => { calls.push(["configureHost", h]); await configureHost?.(h, check); check(); } },
    sidecar: { create: h => createSidecar ? createSidecar(h, makeSidecar) : makeSidecar(h),
      configure: async (s, h, check) => { calls.push(["configureSidecar", s, h]); await configureSidecar?.(s, h, check); check(); } },
  });
  t.after(() => state.handoffAdmission.dispose());
  return { owner, state, calls, hosts, sidecars, quit: () => { quitting = true; }, names: () => calls.map(([name]) => name) };
}

test("cold boot and simultaneous restart requests share one Host and one configured Sidecar", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { configureHost: async () => { entered.resolve(); await release.promise; } });
  const host = f.owner.startHost(), sidecar = f.owner.startSidecar();
  assert.equal(f.owner.startHost(), host); assert.equal(f.owner.startSidecar(), sidecar);
  await entered.promise;
  assert.equal(f.owner.getHandoffActivity().operations, 2);
  assert.equal(f.state.sidecar, null);
  release.resolve(); await Promise.all([host, sidecar]);
  assert.equal(f.hosts.length, 1); assert.equal(f.sidecars.length, 1);
  assert.equal(f.state.sidecar, f.sidecars[0]);
  await Promise.all([f.owner.startHost(), f.owner.startSidecar()]);
  assert.equal(f.hosts.length, 1); assert.equal(f.sidecars.length, 1);
  assert.equal(f.owner.getHandoffActivity().operations, 0);
});

test("sidecar crash keeps original ownership until native Stop and child exit finish", async t => {
  const f = fixture(t); await f.owner.startSidecar();
  const old = f.sidecars[0], stop = deferred(), entered = deferred();
  old.fenceExecution = async () => { entered.resolve(); return stop.promise; };
  old.exit();
  const restarting = f.owner.startSidecar(); await entered.promise;
  assert.equal(f.sidecars.length, 1); assert.ok(f.names().includes("disposeSidecar"));
  assert.equal(f.owner.retainedSidecars().includes(old), true);
  stop.resolve(true); await restarting;
  assert.equal(f.hosts.length, 1); assert.equal(f.sidecars.length, 2);
});

test("simultaneous Host and Sidecar exits recover the original owner before starting one replacement", async t => {
  const f = fixture(t); await f.owner.startSidecar();
  const oldHost = f.hosts[0], oldSidecar = f.sidecars[0];
  oldHost.exit(); oldSidecar.exit();
  await Promise.all([f.owner.startSidecar(), f.owner.startHost(), f.owner.startSidecar()]);
  assert.equal(f.hosts.length, 2); assert.equal(f.sidecars.length, 2);
  assert.equal(f.calls.some(([name, , h]) => name === "fence" && h === oldHost), false);
  assert.ok(f.calls.findIndex(([name, s]) => name === "disposeSidecar" && s === oldSidecar) <
    f.calls.findIndex(([name, h]) => name === "createHost" && h === f.hosts[1]));
  assert.equal(f.state.sidecar.host, f.hosts[1]);
});

for (const boundary of ["prepare", "host", "sidecar"]) {
  test(`admission closing during ${boundary} prevents publication and cleans the original child`, async t => {
    const entered = deferred(), release = deferred();
    const wait = async () => { entered.resolve(); await release.promise; };
    const f = fixture(t, { prepare: boundary === "prepare" ? wait : undefined,
      configureHost: boundary === "host" ? wait : undefined, configureSidecar: boundary === "sidecar" ? wait : undefined });
    const starting = f.owner.startSidecar(); await entered.promise;
    f.state.handoffAdmission.dispose(); release.resolve();
    await assert.rejects(starting, /HOST_BUSY/);
    assert.equal(f.state.sidecar, null);
    assert.equal(f.hosts.length, boundary === "prepare" ? 0 : 1);
    if (boundary === "host") assert.equal(f.hosts[0].ended, true);
    if (boundary === "sidecar") assert.equal(f.sidecars[0].ended, true);
    assert.equal(f.owner.getHandoffActivity().operations, 0);
  });
}

test("Host identity change during Sidecar preparation never configures or publishes the stale instance", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { createSidecar: async (h, make) => { const s = make(h); entered.resolve(); await release.promise; return s; } });
  const starting = f.owner.startSidecar(); await entered.promise;
  f.hosts[0].generation = "replacement-generation"; release.resolve();
  await assert.rejects(starting, /BACKEND_OWNER_CHANGED/);
  assert.equal(f.state.sidecar, null); assert.equal(f.sidecars[0].ended, true);
  assert.equal(f.names().includes("configureSidecar"), false);
  assert.equal(f.owner.getHandoffActivity().uncontainedResources > 0, true);
});

test("Sidecar configure failure preserves its error and clears only the created instance", async t => {
  const failure = new Error("configure failed");
  const f = fixture(t, { configureSidecar: () => { throw failure; } });
  await assert.rejects(f.owner.startSidecar(), error => error === failure);
  assert.equal(f.state.sidecar, null); assert.equal(f.sidecars[0].ended, true);
  assert.equal(f.names().includes("fence"), true);
});

for (const failure of ["native", "child", "dispose"]) {
  test(`unconfirmed ${failure} retirement retains the original and refuses another Sidecar`, async t => {
    const f = fixture(t); await f.owner.startSidecar();
    const s = f.sidecars[0]; s.exit();
    if (failure === "native") s.fenceExecution = async () => false;
    if (failure === "child") s.confirmExit = async () => false;
    if (failure === "dispose") s.dispose = async () => { throw new Error("dispose failed"); };
    await assert.rejects(f.owner.startSidecar(), /BACKEND_CLEANUP_UNCONFIRMED/);
    await assert.rejects(f.owner.startSidecar(), /BACKEND_CLEANUP_UNCONFIRMED/);
    assert.equal(f.sidecars.length, 1); assert.equal(f.owner.retainedSidecars().includes(s), true);
    assert.equal(f.owner.getHandoffActivity().uncontainedResources > 0, true);
  });
}

test("retired extension work stays visible until original work settles; invalid reports never disappear", async t => {
  const f = fixture(t); await f.owner.startSidecar();
  const old = f.sidecars[0]; old.busy = 1; old.exit(); await f.owner.startSidecar();
  assert.equal(f.owner.retainedSidecars().includes(old), true);
  old.busy = 0; old.getExtensionServiceActivity = () => ({ operations: 0 });
  assert.equal(f.owner.retainedSidecars().includes(old), true);
  old.getExtensionServiceActivity = () => ({ operations: 0, inputs: 0, uncontainedResources: 0 });
  assert.equal(f.owner.retainedSidecars().includes(old), false);
});

test("ordinary Host restart rebinds the existing unfenced Sidecar", async t => {
  const f = fixture(t, { fenced: false }); await f.owner.startSidecar();
  const old = f.sidecars[0]; f.hosts[0].exit();
  await Promise.all([f.owner.startHost(), f.owner.startSidecar()]);
  assert.equal(f.sidecars.length, 1); assert.equal(f.state.sidecar, old); assert.equal(old.host, f.hosts[1]);
  assert.equal(f.names().includes("fence"), false);
});

test("shutdown seals creation, joins admitted preparation, then retires Sidecar before Host", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { configureSidecar: async () => { entered.resolve(); await release.promise; } });
  const starting = f.owner.startSidecar(); await entered.promise;
  const closing = f.owner.closeSidecar(); release.resolve();
  await assert.rejects(starting, /HOST_BUSY/); await closing;
  await assert.rejects(f.owner.startHost(), /HOST_BUSY/);
  assert.equal(f.hosts[0].ended, false);
  await f.owner.closeHost(); assert.equal(f.hosts[0].ended, true);
});

test("same-kind synchronous reentry joins the published operation before any factory callback", async t => {
  let reentered;
  const f = fixture(t, { prepare: async () => { reentered = f.owner.startHost(); } });
  const starting = f.owner.startHost(); await starting;
  assert.equal(reentered, starting); assert.equal(f.hosts.length, 1);
});

test("unconfirmed factory cleanup is sticky and cannot create another generation", async t => {
  let attempts = 0;
  const original = new AggregateError([new Error("lost cleanup")], "EXECUTION_FENCE_CLEANUP_UNCONFIRMED");
  const f = fixture(t, { createSidecar: () => { attempts++; throw original; } });
  await assert.rejects(f.owner.startSidecar(), error => error === original);
  await assert.rejects(f.owner.startSidecar(), /BACKEND_CLEANUP_UNCONFIRMED/);
  assert.equal(attempts, 1); assert.equal(f.owner.getHandoffActivity().uncontainedResources, 1);
});

test("a later successful Rust restart resolves generations retained across an intermediate failed Host startup", async t => {
  let attempts = 0;
  const f = fixture(t, { configureHost: () => { if (++attempts === 2) throw new Error("handshake failed"); } });
  await f.owner.startSidecar();
  const old = f.sidecars[0]; f.hosts[0].exit(); old.exit();
  await assert.rejects(f.owner.startSidecar(), /handshake failed/);
  assert.equal(f.owner.retainedSidecars().includes(old), true);
  await f.owner.startSidecar();
  assert.equal(f.hosts.length, 3); assert.equal(f.sidecars.length, 2);
  assert.equal(f.owner.retainedSidecars().includes(old), false);
});

test("unconfirmed Host exit blocks replacement even when transport is unavailable", async t => {
  const f = fixture(t); await f.owner.startSidecar();
  f.hosts[0].exit(); f.hosts[0].confirmExit = async () => false;
  await assert.rejects(f.owner.startHost(), /BACKEND_CLEANUP_UNCONFIRMED/);
  assert.equal(f.hosts.length, 1); assert.equal(f.sidecars.length, 1);
});

test("retired Sidecar capacity is bounded while delayed extension work remains owned", async t => {
  const f = fixture(t); await f.owner.startSidecar();
  for (let i = 0; i < 7; i++) { const s = f.state.sidecar; s.busy = 1; s.exit(); await f.owner.startSidecar(); }
  f.state.sidecar.busy = 1; f.state.sidecar.exit();
  await assert.rejects(f.owner.startSidecar(), /BACKEND_RETIRED_CAPACITY/);
  assert.equal(f.sidecars.length, 8); assert.equal(f.owner.retainedSidecars().length, 8);
  f.sidecars[0].busy = 0; await f.owner.startSidecar(); assert.equal(f.sidecars.length, 9);
});

test("retired async reports are rejected and their rejection is observed", async t => {
  const f = fixture(t); await f.owner.startSidecar();
  const old = f.sidecars[0]; old.busy = 1; old.exit(); await f.owner.startSidecar(); old.busy = 0;
  old.getExtensionOwnerActivity = () => Promise.reject(new Error("invalid async report"));
  assert.equal(f.owner.retainedSidecars().includes(old), true);
  await new Promise(resolve => setImmediate(resolve));
});

test("Host and Sidecar configure rejection never cleans a replacement published by another owner", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { configureSidecar: async () => { entered.resolve(); await release.promise; throw new Error("configure failed"); } });
  const starting = f.owner.startSidecar(); await entered.promise;
  const replacement = {}; f.state.sidecar = replacement; release.resolve();
  await assert.rejects(starting, /configure failed/);
  assert.equal(f.state.sidecar, replacement); assert.equal(f.sidecars[0].ended, true);
});

test("quit during Host preparation allocates no child", async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { prepare: async () => { entered.resolve(); await release.promise; } });
  const starting = f.owner.startHost(); await entered.promise; f.quit(); release.resolve();
  await assert.rejects(starting, /HOST_BUSY/); assert.equal(f.hosts.length, 0);
});

test("normal shutdown waits for graceful Sidecar completion and native proof before Host closure", async t => {
  const f = fixture(t); await f.owner.startSidecar(); const s = f.sidecars[0];
  const entered = deferred(), release = deferred();
  s.shutdown = async () => { entered.resolve(); await release.promise; await s.dispose(); };
  const closing = f.owner.closeSidecar(); assert.equal(f.owner.closeSidecar(), closing);
  await entered.promise; assert.equal(f.hosts[0].ended, false);
  assert.equal(f.owner.getHandoffActivity().operations, 1);
  release.resolve(); await closing;
  assert.equal(f.names().includes("fence"), true); assert.equal(f.hosts[0].ended, false);
  const hostClosing = f.owner.closeHost(); assert.equal(f.owner.closeHost(), hostClosing); await hostClosing;
  assert.equal(f.hosts[0].ended, true);
  assert.equal(f.owner.getHandoffActivity().operations, 0);
});
