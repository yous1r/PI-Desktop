import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

const snapshot = { fixture: { name: "Fixture", models: { model: { id: "model", name: "Fixture Model",
  modalities: { input: ["text"], output: ["text"] }, limit: { context: 4096, output: 512 } } } } };
const response = () => new Response(JSON.stringify(snapshot), { headers: { "Content-Type": "application/json" } });
const deferred = () => Promise.withResolvers();
const options = { catalogPath: "unused-fixture-catalog.json", providers: [] };
function localRead(t, implementation) {
  t.mock.method(fs, "readFile", implementation); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("closed model-catalog admission performs no local or remote I/O", async (t) => {
  let local = 0, remote = 0;
  localRead(t, async () => { local++; return JSON.stringify(snapshot); });
  const catalog = new ModelsDevCatalog({ ...options, isAdmissionClosed: () => true,
    fetchImpl: async () => { remote++; return response(); } });
  assert.equal(await catalog.ensureLoaded(), false);
  assert.equal(await catalog.refresh(), false);
  assert.deepEqual({ local, remote }, { local: 0, remote: 0 });
  assert.equal(catalog.getHandoffActivity().operations, 0);
});

test("bundled load is counted once and admitted settlement survives gate closure", async (t) => {
  let closed = false, reads = 0;
  const entered = deferred(), release = deferred();
  localRead(t, () => { reads++; entered.resolve(); return release.promise; });
  const catalog = new ModelsDevCatalog({ ...options, isAdmissionClosed: () => closed });
  const first = catalog.ensureLoaded(), second = catalog.loadLocal();
  try {
    await entered.promise; closed = true;
    assert.equal(catalog.getHandoffActivity().operations, 1);
    assert.equal(reads, 1);
  } finally { release.resolve(JSON.stringify(snapshot)); }
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(catalog.getStatus().source, "bundled");
  assert.deepEqual(catalog.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("closure before deferred local I/O does not consume the later load attempt", async (t) => {
  let closed = false, reads = 0;
  localRead(t, async () => { reads++; return JSON.stringify(snapshot); });
  const catalog = new ModelsDevCatalog({ ...options, isAdmissionClosed: () => closed });
  const pending = catalog.ensureLoaded(); closed = true;
  assert.equal(await pending, false); assert.equal(reads, 0);
  closed = false;
  assert.equal(await catalog.ensureLoaded(), true); assert.equal(reads, 1);
});

test("refresh owns the response body and coalesces reentrant callers through real settlement", async () => {
  let requests = 0, joined;
  const body = deferred(), entered = deferred();
  const catalog = new ModelsDevCatalog({ ...options, fetchImpl: async () => {
    requests++; joined = catalog.refresh(); entered.resolve();
    return { ok: true, json: () => body.promise };
  } });
  const pending = catalog.refresh();
  try {
    await entered.promise;
    assert.equal(catalog.getHandoffActivity().operations, 1);
    assert.equal(requests, 1);
  } finally { body.resolve(snapshot); }
  assert.deepEqual(await Promise.all([pending, joined]), [true, true]);
  assert.equal(catalog.getStatus().source, "remote");
  assert.equal(catalog.getHandoffActivity().operations, 0);
  assert.ok(catalog.getHandoffActivity().uncontainedResources > 0,
    "settled fetch is not a native connection-pool closure proof");
});

test("refresh timeout retains ignored-abort work until settlement and rejects its late snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(), result = deferred(); let signal;
  const catalog = new ModelsDevCatalog({ ...options, timeoutMs: 10, fetchImpl: (_url, init) => {
    signal = init.signal; entered.resolve(); return result.promise;
  } });
  const pending = catalog.refresh(); await entered.promise;
  t.mock.timers.tick(10);
  assert.equal(signal.aborted, true);
  assert.equal(catalog.getHandoffActivity().operations, 1);
  result.resolve(response());
  assert.equal(await pending, false);
  assert.equal(catalog.getStatus().loaded, false);
  assert.equal(catalog.getHandoffActivity().operations, 0);
});

test("disposal aborts original refresh but keeps its obligation and suppresses late publication", async () => {
  const entered = deferred(), result = deferred(); let signal, calls = 0;
  const catalog = new ModelsDevCatalog({ ...options, fetchImpl: (_url, init) => {
    calls++; signal = init.signal; entered.resolve(); return result.promise;
  } });
  const pending = catalog.refresh(); await entered.promise;
  catalog.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(catalog.getHandoffActivity().operations, 1);
  const original = catalog.getStatus();
  result.resolve(response());
  assert.equal(await pending, false);
  assert.deepEqual(catalog.getStatus(), original);
  assert.equal(await catalog.refresh(), false);
  assert.equal(calls, 1); assert.equal(catalog.getHandoffActivity().operations, 0);
  assert.ok(catalog.getHandoffActivity().uncontainedResources > 0);
});

test("synchronous fetch failure releases the owned flight so a fresh refresh can retry", async () => {
  let attempts = 0;
  const catalog = new ModelsDevCatalog({ ...options, fetchImpl: () => {
    if (++attempts === 1) throw new Error("fixture offline");
    return Promise.resolve(response());
  } });
  assert.equal(await catalog.refresh(), false);
  assert.equal(catalog.getHandoffActivity().operations, 0);
  assert.equal(await catalog.refresh(), true);
  assert.equal(attempts, 2);
});

test("an unsuccessful response remains counted through actual body cancellation", async () => {
  const entered = deferred(), release = deferred();
  const catalog = new ModelsDevCatalog({ ...options, fetchImpl: async () => ({ ok: false, status: 503,
    body: { cancel: () => { entered.resolve(); return release.promise; } },
    json: () => assert.fail("unsuccessful body must not be parsed"),
  }) });
  const pending = catalog.refresh(); await entered.promise;
  assert.equal(catalog.getHandoffActivity().operations, 1);
  release.resolve(); assert.equal(await pending, false);
  assert.equal(catalog.getHandoffActivity().operations, 0);
  assert.match(catalog.getStatus().lastError, /503/);
});
