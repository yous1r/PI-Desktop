import assert from "node:assert/strict";
import test from "node:test";

import {
  MirrorRuntimeRegistry,
  mirrorRuntimeRegistry,
} from "../electron/main/mirror/mirror-runtime.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fakeSyncEngineCalls() {
  return {
    startWatching: 0,
    stopWatching: 0,
    dispose: 0,
  };
}

function createFakeEngine({
  failStart = false,
  failDispose = false,
  disposeDelayMs = 0,
} = {}) {
  const calls = fakeSyncEngineCalls();
  return {
    calls,
    startWatching() {
      calls.startWatching += 1;
      if (failStart) throw new Error("watch failed");
    },
    stopWatching() {
      calls.stopWatching += 1;
    },
    async dispose() {
      calls.dispose += 1;
      if (disposeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, disposeDelayMs));
      }
      if (failDispose) throw new Error("dispose failed");
    },
  };
}

function createFakeDapSession({
  failDisconnect = false,
  failClose = false,
} = {}) {
  const calls = { disconnect: 0, close: 0 };
  return {
    calls,
    async disconnect() {
      calls.disconnect += 1;
      if (failDisconnect) throw new Error("disconnect failed");
    },
    async close() {
      calls.close += 1;
      if (failClose) throw new Error("close failed");
    },
  };
}

/** Builds a registry plus the bookkeeping a test needs to inspect it. */
function createHarness(engineOptionsByGroup = {}) {
  const created = [];
  const warnings = [];

  const registry = new MirrorRuntimeRegistry({
    createSyncEngine(options) {
      const engine = createFakeEngine(engineOptionsByGroup[options.projectId]);
      created.push({ options, engine });
      return engine;
    },
    logger: {
      warn(message, data) {
        warnings.push({ message, data });
      },
    },
    now: () => 1_700_000_000_000,
  });

  return { registry, created, warnings };
}

function engineOptions(groupId, overrides = {}) {
  return {
    localRoot: `/local/${groupId}`,
    helperFs: {
      stat: async () => [],
      putFile: async () => ({ size: 0, sha256: "" }),
      getFile: async () => ({ size: 0, sha256: "" }),
    },
    host: { call: async () => ({}) },
    ...overrides,
  };
}

// ── 1. Nothing starts by itself ──────────────────────────────────────────────

test("runtime: importing the module constructs no runtime and no watcher", () => {
  // The process-wide registry is created at import time with the real engine
  // factory. If import alone started anything, this would already hold entries.
  assert.deepEqual(mirrorRuntimeRegistry.activeGroupIds, []);
  assert.equal(mirrorRuntimeRegistry.hasRuntime("any-project"), false);
});

test("runtime: engine factory is not called before ensureRuntime", async () => {
  const { registry, created } = createHarness();

  assert.equal(created.length, 0);
  assert.deepEqual(registry.activeGroupIds, []);
  assert.deepEqual(await registry.disposeAll(), []);
  assert.equal(created.length, 0);
});

// ── 2. One runtime per open project ──────────────────────────────────────────

test("runtime: ensureRuntime returns the live runtime and never duplicates it", () => {
  const { registry, created } = createHarness();

  const first = registry.ensureRuntime("group-a", engineOptions("group-a"));
  const second = registry.ensureRuntime("group-a", {
    ...engineOptions("group-a"),
    localRoot: "/somewhere/else",
    startWatching: false,
  });

  assert.equal(second, first);
  assert.equal(created.length, 1);
  // The open that established the project owns its roots and watcher state.
  assert.equal(first.syncEngine, created[0].engine);
  assert.equal(first.createdAt, 1_700_000_000_000);
  assert.equal(created[0].options.projectId, "group-a");
  assert.equal(created[0].options.localRoot, "/local/group-a");
  assert.equal(created[0].engine.calls.startWatching, 1);

  const other = registry.ensureRuntime("group-b", engineOptions("group-b"));
  assert.notEqual(other, first);
  assert.equal(created.length, 2);
  assert.deepEqual(registry.activeGroupIds, ["group-a", "group-b"]);
});

test("runtime: registry-only options are not forwarded to the engine", () => {
  const { registry, created } = createHarness();
  const session = createFakeDapSession();

  registry.ensureRuntime("group-a", {
    ...engineOptions("group-a"),
    startWatching: false,
    dapSession: session,
  });

  assert.equal("startWatching" in created[0].options, false);
  assert.equal("dapSession" in created[0].options, false);
  assert.equal(created[0].engine.calls.startWatching, 0);
});

test("runtime: group ids are normalized and an empty id is rejected", () => {
  const { registry } = createHarness();
  registry.ensureRuntime("  group-a  ", engineOptions("group-a"));
  assert.equal(registry.hasRuntime("group-a"), true);
  assert.throws(() => registry.ensureRuntime("   ", engineOptions("blank")), /MIRROR_RUNTIME_MISSING_GROUP_ID/);
});

test("runtime: a watcher that fails to start leaves the runtime owned, not leaked", () => {
  const { registry, warnings } = createHarness({ "group-a": { failStart: true } });

  const entry = registry.ensureRuntime("group-a", engineOptions("group-a"));

  assert.equal(registry.getRuntime("group-a"), entry);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /watcher failed/);
});

// ── 3. Full cleanup ──────────────────────────────────────────────────────────

test("runtime: disposeRuntime stops the engine, disconnects DAP, and forgets the entry", async () => {
  const { registry } = createHarness();
  const session = createFakeDapSession();

  const entry = registry.ensureRuntime("group-a", {
    ...engineOptions("group-a"),
    dapSession: session,
  });

  const result = await registry.disposeRuntime("group-a");

  assert.deepEqual(result, { projectGroupId: "group-a", disposed: true, errors: [] });
  assert.equal(entry.syncEngine.calls.dispose, 1);
  assert.equal(session.calls.disconnect, 1);
  assert.equal(session.calls.close, 0);
  assert.equal(entry.dapSession, null);
  assert.equal(registry.hasRuntime("group-a"), false);
  assert.deepEqual(registry.activeGroupIds, []);
});

test("runtime: disposal is idempotent and does not re-run collaborators", async () => {
  const { registry } = createHarness();
  const session = createFakeDapSession();
  const entry = registry.ensureRuntime("group-a", {
    ...engineOptions("group-a"),
    dapSession: session,
  });

  const first = registry.disposeRuntime("group-a");
  const second = registry.disposeRuntime("group-a");
  assert.equal(second, first);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.disposed, true);

  const third = await registry.disposeRuntime("group-a");
  assert.deepEqual(third, { projectGroupId: "group-a", disposed: false, errors: [] });
  assert.equal(entry.syncEngine.calls.dispose, 1);
  assert.equal(session.calls.disconnect, 1);
});

test("runtime: a reopened group after disposal gets a fresh runtime", async () => {
  const { registry, created } = createHarness();
  registry.ensureRuntime("group-a", engineOptions("group-a"));
  await registry.disposeRuntime("group-a");

  const reopened = registry.ensureRuntime("group-a", engineOptions("group-a"));
  assert.equal(created.length, 2);
  assert.equal(reopened.syncEngine, created[1].engine);
  assert.equal(registry.hasRuntime("group-a"), true);
});

// ── 4. Failing collaborators stay observable and do not block the rest ───────

test("runtime: a throwing engine and a failing DAP session are reported, not skipped", async () => {
  const { registry, warnings } = createHarness({ "group-a": { failDispose: true } });
  const session = createFakeDapSession({ failDisconnect: true });

  registry.ensureRuntime("group-a", {
    ...engineOptions("group-a"),
    dapSession: session,
  });

  const result = await registry.disposeRuntime("group-a");

  assert.equal(result.disposed, true);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /^sync-engine-dispose: dispose failed/);
  assert.match(result.errors[1], /^dap-disconnect: disconnect failed/);
  // A rejected disconnect can leave the socket and SSH forward open, so the
  // unconditional close must still run.
  assert.equal(session.calls.close, 1);
  assert.equal(registry.hasRuntime("group-a"), false);
  assert.ok(warnings.some((entry) => /disposal completed with errors/.test(entry.message)));
  assert.ok(warnings.some((entry) => /DAP session did not disconnect cleanly/.test(entry.message)));
});

test("runtime: disposeAll disposes every project even when one fails", async () => {
  const { registry } = createHarness({ "group-broken": { failDispose: true } });
  const brokenSession = createFakeDapSession({ failDisconnect: true, failClose: true });

  registry.ensureRuntime("group-broken", {
    ...engineOptions("group-broken"),
    dapSession: brokenSession,
  });
  const healthy = registry.ensureRuntime("group-healthy", engineOptions("group-healthy"));
  const healthySession = createFakeDapSession();
  assert.equal(registry.attachDapSession("group-healthy", healthySession), true);

  const results = await registry.disposeAll();
  const byGroup = new Map(results.map((result) => [result.projectGroupId, result]));

  assert.equal(results.length, 2);
  assert.equal(byGroup.get("group-broken").disposed, true);
  assert.match(byGroup.get("group-broken").errors.join(" | "), /dap-close: close failed/);
  assert.deepEqual(byGroup.get("group-healthy"), {
    projectGroupId: "group-healthy",
    disposed: true,
    errors: [],
  });
  assert.equal(healthy.syncEngine.calls.dispose, 1);
  assert.equal(healthySession.calls.disconnect, 1);
  assert.deepEqual(registry.activeGroupIds, []);
});

test("runtime: a throwing logger cannot break disposal", async () => {
  const registry = new MirrorRuntimeRegistry({
    createSyncEngine: () => {
      return {
        startWatching() {},
        stopWatching() {},
        dispose() {
          throw new Error("boom");
        },
      };
    },
    logger: {
      warn() {
        throw new Error("logger unavailable");
      },
    },
  });
  registry.ensureRuntime("group-a", engineOptions("group-a"));

  const result = await registry.disposeRuntime("group-a");
  assert.equal(result.disposed, true);
  assert.match(result.errors[0], /^sync-engine-dispose: boom/);
});

// ── 5. DAP session attachment stays an explicit caller action ────────────────

test("runtime: attaching a DAP session without a live runtime reports false", () => {
  const { registry } = createHarness();
  const session = createFakeDapSession();

  assert.equal(registry.attachDapSession("group-a", session), false);
  assert.equal(session.calls.disconnect, 0);
});

test("runtime: replacing a DAP session disconnects the previous one", async () => {
  const { registry } = createHarness();
  const first = createFakeDapSession();
  const second = createFakeDapSession();
  const entry = registry.ensureRuntime("group-a", engineOptions("group-a"));

  assert.equal(registry.attachDapSession("group-a", first), true);
  assert.equal(registry.attachDapSession("group-a", second), true);
  // Wait for the fire-and-forget teardown of the replaced session.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.calls.disconnect, 1);
  assert.equal(second.calls.disconnect, 0);
  assert.equal(entry.dapSession, second);

  await registry.disposeRuntime("group-a");
  assert.equal(second.calls.disconnect, 1);
});
