import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/mirror-shared-hook.mjs", import.meta.url));

const { IPC } = await import("@pi-desktop/shared");
const { MirrorRuntimeRegistry } = await import("../electron/main/mirror/mirror-runtime.ts");
const { registerMirrorIpc } = await import("../electron/main/ipc/mirror-ipc.ts");

const GROUP = {
  id: "group-a",
  name: "Mirror project",
  primaryPath: "C:/workspace/app",
  roots: [{ path: "C:/workspace/app", name: "app", position: 0 }],
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  lastOpenedAt: 1,
  legacy: false,
  detachedPaths: [],
  mirror: { hostKey: "dev", remotePath: "/srv/app", mode: "manual" },
};

function createHarness({ groups = [GROUP], initState = "ready" } = {}) {
  const handlers = new Map();
  const events = [];
  const calls = [];
  const engineCalls = [];
  let managerDisposals = 0;
  let initStarts = 0;
  const registry = new MirrorRuntimeRegistry({
    createSyncEngine(options) {
      const queue = { size: 2 };
      const activeConflicts = [
        {
          code: "MIRROR_CONFLICT",
          relPath: "src/main.rs",
          local: { size: 20, mtimeMs: 100 },
          remote: { size: 18, mtimeMs: 90, exists: true },
          baseline: { size: 15, mtimeMs: 80, sha256: "a".repeat(64) },
          timestamp: 100,
        },
      ];
      const engine = {
        queue,
        activeConflicts,
        startWatching() {
          engineCalls.push([options.projectId, "start"]);
        },
        stopWatching() {
          engineCalls.push([options.projectId, "stop"]);
        },
        async resolveConflict(relPath, resolution) {
          engineCalls.push([options.projectId, "resolve", relPath, resolution]);
          activeConflicts.length = 0;
        },
        async dispose() {
          engineCalls.push([options.projectId, "dispose"]);
        },
      };
      return engine;
    },
    now: () => 123,
    logger: { warn: () => undefined },
  });
  const init = {
    async status(projectGroupId) {
      return {
        projectGroupId,
        state: initState,
        completedSteps: initState === "ready" ? ["manifest"] : [],
        step: null,
        error: null,
      };
    },
    async start(projectGroupId) {
      initStarts += 1;
      return {
        projectGroupId,
        state: "ready",
        completedSteps: ["manifest"],
        step: null,
        error: null,
      };
    },
    close() {},
  };
  registerMirrorIpc({
    registrar: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      handleWithEvent(channel, handler) {
        handlers.set(channel, handler);
      },
      ipcMain: {},
      assertMainWindowSender() {},
    },
    getHost: () => ({
      async call(method, params = {}) {
        calls.push({ method, params });
        if (method === "project.groups.list") return { groups };
        if (method === "mirror.baseline.list") return { entries: [] };
        return {};
      },
    }),
    sendToRenderer(channel, payload) {
      events.push({ channel, payload });
    },
    async createRuntime(group) {
      assert.equal(group.id, GROUP.id);
      return {
        sync: {
          localRoot: group.primaryPath,
          helperFs: {
            stat: async () => [],
            hash: async () => ({ path: "", sha256: "" }),
            mkdirs: async () => [],
            putFile: async () => ({ path: "", size: 0, sha256: "", result: {} }),
            getFile: async () => ({ path: "", size: 0, sha256: "", result: {} }),
          },
          host: { call: async () => ({ entries: [] }) },
          mode: group.mirror.mode,
          startWatching: false,
        },
        runManager: {
          async start(request) {
            return {
              id: "run-1",
              projectId: request.projectId,
              hostKey: request.hostKey,
              remotePath: request.remotePath,
              kind: request.kind,
              command: request.command,
              chunks: (async function* () {
                yield { stream: "stdout", text: "first" };
                yield { stream: "stderr", text: "second" };
              })(),
              outcome: Promise.resolve({
                status: "succeeded",
                code: 0,
                kind: request.kind,
                bytes: 11,
                truncated: false,
              }),
              async cancel() {},
            };
          },
          async dispose() {
            managerDisposals += 1;
          },
        },
      };
    },
    getInitService: () => init,
    runtimeRegistry: registry,
  });
  return { handlers, events, calls, engineCalls, registry, get managerDisposals() { return managerDisposals; }, get initStarts() { return initStarts; } };
}

const handler = (harness, key) => harness.handlers.get(IPC.invoke[key]);

test("mirror IPC registers its complete invoke surface", () => {
  const h = createHarness();
  for (const key of [
    "mirrorStatusGet",
    "mirrorSyncStart",
    "mirrorSyncStop",
    "mirrorConflictList",
    "mirrorConflictResolve",
    "mirrorInitStatusGet",
    "mirrorInitStart",
    "mirrorRunStart",
    "mirrorRunCancel",
  ]) {
    assert.equal(typeof handler(h, key), "function", key);
  }
});

test("mirror status rejects invalid and unknown project ids and returns idle for a known unopened mirror", async () => {
  const h = createHarness();
  await assert.rejects(handler(h, "mirrorStatusGet")({ projectGroupId: 123 }), {
    errorCode: "INVALID_ARGUMENT",
  });
  await assert.rejects(handler(h, "mirrorStatusGet")({ projectGroupId: "missing" }), {
    errorCode: "REMOTE_PATH_NOT_FOUND",
  });
  const result = await handler(h, "mirrorStatusGet")({ projectGroupId: GROUP.id });
  assert.deepEqual(result.status, {
    projectGroupId: GROUP.id,
    state: "idle",
    mode: "manual",
    pendingPaths: 0,
    uploadedFiles: 0,
    conflictCount: 0,
    skippedFiles: 0,
    lastError: null,
  });
});

test("sync start is idempotent, publishes status, and refuses non-mirror projects", async () => {
  const h = createHarness();
  const first = await handler(h, "mirrorSyncStart")({ projectGroupId: GROUP.id });
  const second = await handler(h, "mirrorSyncStart")({ projectGroupId: GROUP.id });
  assert.equal(first.status.state, "watching");
  assert.equal(second.status.state, "watching");
  assert.equal(h.engineCalls.filter(([, action]) => action === "start").length, 1);
  assert.equal(h.events.filter((event) => event.channel === IPC.event.mirrorStatus).length, 2);
  const nonMirror = { ...GROUP, mirror: undefined };
  const h2 = createHarness({ groups: [nonMirror] });
  await assert.rejects(handler(h2, "mirrorSyncStart")({ projectGroupId: GROUP.id }), {
    errorCode: "INVALID_ARGUMENT",
  });
});

test("stopping an unopened project is harmless and stopping a live watcher pauses it", async () => {
  const h = createHarness();
  const before = await handler(h, "mirrorSyncStop")({ projectGroupId: GROUP.id });
  assert.equal(before.status.state, "idle");
  await handler(h, "mirrorSyncStart")({ projectGroupId: GROUP.id });
  const after = await handler(h, "mirrorSyncStop")({ projectGroupId: GROUP.id });
  assert.equal(after.status.state, "paused");
  assert.equal(h.engineCalls.filter(([, action]) => action === "stop").length, 1);
});

test("conflict resolution validates the enum, delegates, and broadcasts the new status", async () => {
  const h = createHarness();
  await handler(h, "mirrorSyncStart")({ projectGroupId: GROUP.id });
  const listed = await handler(h, "mirrorConflictList")({ projectGroupId: GROUP.id });
  assert.equal(listed.conflicts[0].relPath, "src/main.rs");
  await assert.rejects(
    handler(h, "mirrorConflictResolve")({
      projectGroupId: GROUP.id,
      relPath: "src/main.rs",
      resolution: "overwrite",
    }),
    { errorCode: "INVALID_ARGUMENT" },
  );
  const result = await handler(h, "mirrorConflictResolve")({
    projectGroupId: GROUP.id,
    relPath: "src/main.rs",
    resolution: "keep_local",
  });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(h.engineCalls.find(([, action]) => action === "resolve"), [
    GROUP.id,
    "resolve",
    "src/main.rs",
    "keep_local",
  ]);
  assert.equal(h.events.at(-1).channel, IPC.event.mirrorStatus);
});

test("initialization start emits state and status reads do not start a run", async () => {
  const h = createHarness({ initState: "needs-init" });
  const initial = await handler(h, "mirrorInitStatusGet")({ projectGroupId: GROUP.id });
  assert.equal(initial.init.state, "needs-init");
  assert.equal(h.initStarts, 0);
  const started = await handler(h, "mirrorInitStart")({ projectGroupId: GROUP.id });
  assert.equal(started.init.state, "ready");
  assert.equal(h.initStarts, 1);
  assert.equal(h.events.at(-1).channel, IPC.event.mirrorInitProgress);
});

test("remote run validates before constructing a runtime, streams ordered chunks and settles once", async () => {
  const h = createHarness();
  await assert.rejects(
    handler(h, "mirrorRunStart")({ projectGroupId: GROUP.id, kind: "debug", command: "echo x" }),
    { errorCode: "INVALID_ARGUMENT" },
  );
  assert.deepEqual(h.registry.activeGroupIds, []);
  await assert.rejects(
    handler(h, "mirrorRunStart")({ projectGroupId: GROUP.id, kind: "run", command: "x".repeat(4097) }),
    { errorCode: "INVALID_ARGUMENT" },
  );
  assert.deepEqual(h.registry.activeGroupIds, []);

  const started = await handler(h, "mirrorRunStart")({
    projectGroupId: GROUP.id,
    kind: "build",
    command: "cargo test",
  });
  assert.deepEqual(started, { runId: "run-1", projectGroupId: GROUP.id, kind: "build" });
  for (let index = 0; index < 20 && !h.events.some((event) => event.channel === IPC.event.mirrorRunSettled); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const runEvents = h.events.filter((event) => event.payload?.runId === "run-1");
  assert.deepEqual(runEvents.map((event) => event.channel), [
    IPC.event.mirrorRunChunk,
    IPC.event.mirrorRunChunk,
    IPC.event.mirrorRunSettled,
  ]);
  assert.deepEqual(runEvents.slice(0, 2).map((event) => event.payload.text), ["first", "second"]);
  assert.deepEqual(runEvents[2].payload, {
    runId: "run-1",
    projectGroupId: GROUP.id,
    kind: "build",
    status: "succeeded",
    code: 0,
    bytes: 11,
    truncated: false,
  });
});

test("disposed runtime closes the run manager and forgets the project", async () => {
  const h = createHarness();
  await handler(h, "mirrorSyncStart")({ projectGroupId: GROUP.id });
  const result = await h.registry.disposeRuntime(GROUP.id);
  assert.equal(result.disposed, true);
  assert.deepEqual(h.registry.activeGroupIds, []);
  assert.equal(h.managerDisposals, 1);
});
