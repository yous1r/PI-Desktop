import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Only Electron is replaced; event persistence, the disk outbox and the quit
// handler use their production wiring. No user profile is opened by this test.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:electron", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:electron") return {
      format: "module", shortCircuit: true,
      source: `import { EventEmitter } from "node:events";
        export const app = new EventEmitter();
        app.quit = () => {};
        export const globalShortcut = { unregister() {} };`,
    };
    return next(url, context);
  },
});
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const transcriptRewrite = {
  beginTranscriptRewrite: () => ({ commit() {}, rollback: () => [] }),
  deferTranscriptEvent: () => false,
  isStaleTranscriptEvent: () => false,
};

for (const outcome of ["complete", "error", "unresponsive"]) {
test(`quit settles a regenerated branch when the host is ${outcome}`, async (t) => {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-quit-regenerate-"));
  const archiveStarted = Promise.withResolvers();
  const releaseArchive = Promise.withResolvers();
  const sidecarStopped = Promise.withResolvers();
  const modeShutdownStarted = Promise.withResolvers();
  const releaseModeShutdown = Promise.withResolvers();
  const messages = new Map();
  const archived = [];
  const warnings = [];
  const activeTurns = new Map([["session", "turn"]]);
  let hostDisposed = false;
  let pluginsDisposed = false;
  let plansDisposed = false;
  let speechDisposed = false;
  const host = {
    isAvailable: () => !hostDisposed,
    async call(method, params) {
      assert.equal(hostDisposed, false, "persistence requires a live host");
      if (method === "session.appendMessage") messages.set(params.message.id, params.message);
      if (method === "session.saveActiveRevision") {
        archiveStarted.resolve();
        await releaseArchive.promise;
        if (outcome === "error") throw new Error("archive storage unavailable");
        assert.equal(hostDisposed, false, "the archive must finish before host disposal");
        archived.push([...messages.values()]);
      }
      return {};
    },
    async dispose() { hostDisposed = true; },
  };
  const logger = { app: (_area, level, event) => {
    if (level === "warn") warnings.push(event);
  } };
  const outbox = new PersistenceOutbox(dataDir, () => undefined);
  const checkpoint = {
    observe() {}, flush: async () => {}, flushAll: async () => {},
    settleIf() {}, dispose() {},
  };
  const persistence = createEventPersistence({
    runtimeState: { host }, steeringReplies: new Set(), completionNoticeTurns: new Set(), activeTurns,
    activeToolCalls: new Map(), activeToolCallKey: (s, c) => `${s}:${c}`,
    approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: (s, turn) => `${s}:${turn}`,
    inflightCheckpointer: checkpoint, persistenceOutbox: outbox,
    transcriptRewrite,
    addActiveTurnUsage() {}, logger,
    finishTurn: async () => { activeTurns.clear(); },
    isStaleTerminalEvent: () => false,
    finishApprovedExecution: async () => {}, emitAgentEvent() {},
  });
  const state = {
    handoffAdmission: new DesktopHandoffAdmission(),
    planRuntime: { dispose() { plansDisposed = true; } },
    shutdownComplete: false, shutdownPromise: null, quitting: false,
    quitConfirmed: true, closeBehavior: "quit", tray: null,
    pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
  };
  const dispose = () => undefined;
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state,
    getHost: () => host,
    getSidecar: () => null,
    backends: { closeHost: () => host.dispose(), closeSidecar: async () => {
      assert.equal(pluginsDisposed, false, "extension shutdown requires live owner plugin services");
      assert.equal(hostDisposed, false, "extension shutdown requires live host context");
      sidecarStopped.resolve();
    } },
    getMcpControl: () => null, activeTurns, persistenceOutbox: outbox,
    inflightCheckpointer: checkpoint,
    flushEventPersistence: () => persistence.flush(),
    pluginPanels: { closeAll: async () => {} },
    plugins: { disposeAll: async () => { pluginsDisposed = true; } }, userMcp: { disposeAll: dispose },
    speech: { dispose() { speechDisposed = true; } },
    browserHost: { dispose }, pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false }, logger,
    confirmQuitDialog: async () => true, disposePowerSaveBlockers: dispose,
    modeRuns: { async dispose() { modeShutdownStarted.resolve(); await releaseModeShutdown.promise; } },
  });
  t.after(async () => {
    releaseArchive.resolve();
    releaseModeShutdown.resolve();
    await state.shutdownPromise;
    await persistence.flush();
    app.removeAllListeners();
    await rm(dataDir, { recursive: true, force: true });
  });
  const reply = {
    id: "answer", role: "assistant", content: "Completed regenerated answer",
    createdAt: new Date(0).toISOString(), status: "complete",
  };
  persistence.persistAgentEvent({ sessionId: "session", turnId: "turn", ts: 1,
    event: { type: "message_end", message: reply } });
  persistence.persistAgentEvent({ sessionId: "session", turnId: "turn", ts: 2,
    event: { type: "agent_end", messageIds: [reply.id] } });
  await archiveStarted.promise;
  if (outcome === "unresponsive") t.mock.timers.enable({ apis: ["setTimeout"] });
  app.emit("before-quit", { preventDefault() {} });
  await modeShutdownStarted.promise;
  assert.equal(hostDisposed, false, "mode settlement keeps its original Host alive");
  assert.equal(pluginsDisposed, false, "mode shutdown precedes resource disposal");
  releaseModeShutdown.resolve();
  await sidecarStopped.promise;
  assert.equal(state.handoffAdmission.isClosed(), true, "confirmed quit closes new admission before disposal");
  assert.equal(plansDisposed, true, "confirmed quit disposes plan retries before resource teardown");
  assert.equal(speechDisposed, true, "confirmed quit seals Speech before awaited cleanup");
  assert.equal(hostDisposed, false, "quit must wait for the branch already being saved");
  if (outcome === "unresponsive") {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2_000);
    await state.shutdownPromise;
    assert.equal(hostDisposed, true, "an unresponsive archive cannot prevent quitting");
    assert.deepEqual(warnings, ["quit before event persistence settled"]);
    return;
  }
  releaseArchive.resolve();
  await state.shutdownPromise;
  assert.deepEqual(archived, outcome === "complete" ? [[reply]] : []);
  assert.deepEqual(warnings, outcome === "complete" ? [] : ["save active regenerate branch failed"]);
  assert.equal(hostDisposed, true);
});
}

test("a repeated before-quit cannot bypass the pending renderer confirmation", async (t) => {
  app.removeAllListeners();
  const originalQuit = app.quit;
  const probeKeys = [
    "PI_DESKTOP_BOOT_PROBE",
    "PI_DESKTOP_SUPERVISION_PROBE",
    "PI_DESKTOP_CAPTURE",
  ];
  const originalProbeValues = probeKeys.map((key) => process.env[key]);
  for (const key of probeKeys) delete process.env[key];
  const confirmations = [];
  let confirmationCount = 0;
  let plansDisposed = false;
  let speechDisposed = false;
  const state = {
    handoffAdmission: new DesktopHandoffAdmission(),
    planRuntime: { dispose() { plansDisposed = true; } },
    shutdownComplete: false,
    shutdownPromise: null,
    quitting: false,
    quitConfirmed: false,
    closeBehavior: "quit",
    tray: null,
    pluginLauncherAccelerator: null,
    toggleWindowAccelerator: null,
  };
  const dispose = () => undefined;
  app.quit = () => {
    app.emit("before-quit", { preventDefault() {} });
  };
  registerShutdownHandlers({
    hasSingleInstanceLock: true,
    state,
    getHost: () => null,
    getSidecar: () => null,
    getMcpControl: () => null,
    activeTurns: new Map(),
    persistenceOutbox: { flush: async () => {}, size: () => 0 },
    inflightCheckpointer: { flushAll: async () => {}, dispose },
    flushEventPersistence: async () => {},
    backends: { closeSidecar: async () => {}, closeHost: async () => {} },
    pluginPanels: { closeAll: async () => {} },
    plugins: { disposeAll: async () => {} },
    userMcp: { disposeAll: dispose },
    speech: { dispose() { speechDisposed = true; } },
    browserHost: { dispose },
    pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false },
    logger: { app() {} },
    confirmQuitDialog: () => {
      confirmationCount += 1;
      return new Promise((resolve) => confirmations.push(resolve));
    },
    disposePowerSaveBlockers: dispose,
  });
  const requestQuit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    return prevented;
  };
  t.after(() => {
    app.removeAllListeners();
    app.quit = originalQuit;
    for (let index = 0; index < probeKeys.length; index += 1) {
      const value = originalProbeValues[index];
      if (value === undefined) delete process.env[probeKeys[index]];
      else process.env[probeKeys[index]] = value;
    }
  });

  assert.equal(requestQuit(), true);
  assert.equal(confirmationCount, 1);
  assert.equal(requestQuit(), true);
  assert.equal(confirmationCount, 1);
  assert.equal(state.shutdownPromise, null);
  assert.equal(state.quitting, false);
  assert.equal(state.handoffAdmission.isClosed(), false);

  confirmations[0](false);
  await Promise.resolve();
  assert.equal(state.quitConfirmed, false);
  assert.equal(state.handoffAdmission.isClosed(), false, "cancelled confirmation keeps normal admission");
  assert.equal(plansDisposed, false, "cancelled confirmation preserves plan runtime");
  assert.equal(speechDisposed, false, "cancelled confirmation preserves Speech");
  assert.equal(requestQuit(), true);
  assert.equal(confirmationCount, 2);

  confirmations[1](true);
  await Promise.resolve();
  assert.ok(state.shutdownPromise);
  await state.shutdownPromise;
  assert.equal(state.shutdownComplete, true);
  assert.equal(state.handoffAdmission.isClosed(), true);
  assert.equal(plansDisposed, true);
  assert.equal(speechDisposed, true);
});

test("personal todo preparation blocks disposal and permits a cancelled quit to retry", async (t) => {
  app.removeAllListeners();
  const originalQuit = app.quit;
  let plansDisposed = false;
  let speechDisposed = false;
  const state = {
    handoffAdmission: new DesktopHandoffAdmission(),
    planRuntime: { dispose() { plansDisposed = true; } },
    shutdownComplete: false, shutdownPromise: null, quitting: false,
    quitConfirmed: true, closeBehavior: "quit", tray: null,
    pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
  };
  const preparations = [];
  let hostDisposed = false;
  let releaseResources = false;
  const dispose = () => undefined;
  app.quit = () => app.emit("before-quit", { preventDefault() {} });
  t.after(async () => {
    for (const pending of preparations) pending.resolve(false);
    await state.shutdownPromise;
    app.removeAllListeners();
    app.quit = originalQuit;
  });
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state,
    getHost: () => ({ dispose: async () => { hostDisposed = true; } }),
    getSidecar: () => null, getMcpControl: () => null,
    activeTurns: new Map(),
    persistenceOutbox: { flush: async () => {}, size: () => 0 },
    inflightCheckpointer: { flushAll: async () => {}, dispose },
    flushEventPersistence: async () => {},
    backends: { closeSidecar: async () => {}, closeHost: async () => { hostDisposed = true; } },
    pluginPanels: { closeAll: async () => {} },
    plugins: { disposeAll: async () => {} }, userMcp: { disposeAll: dispose },
    speech: { dispose() { speechDisposed = true; } },
    browserHost: { dispose }, pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false }, logger: { app() {} },
    confirmQuitDialog: async () => true,
    disposePowerSaveBlockers: () => { releaseResources = true; },
    preparePersonalTodosQuit: () => {
      const pending = Promise.withResolvers(); preparations.push(pending); return pending.promise;
    },
  });
  app.quit(); app.quit();
  assert.equal(preparations.length, 1);
  assert.equal(state.shutdownPromise, null);
  assert.equal(releaseResources, false);
  assert.equal(hostDisposed, false);
  preparations[0].resolve(false);
  await Promise.resolve();
  assert.equal(state.quitting, false);
  assert.equal(state.quitConfirmed, false);
  assert.equal(hostDisposed, false);
  assert.equal(state.handoffAdmission.isClosed(), false, "unsaved todos keep the application usable");
  assert.equal(plansDisposed, false, "unsaved todos preserve plan runtime");
  assert.equal(speechDisposed, false, "unsaved todos preserve Speech");
  state.quitConfirmed = true;
  app.quit();
  assert.equal(preparations.length, 2);
  preparations[1].resolve(true);
  await Promise.resolve();
  assert.ok(state.shutdownPromise);
  await state.shutdownPromise;
  assert.equal(releaseResources, true);
  assert.equal(hostDisposed, true);
  assert.equal(state.shutdownComplete, true);
  assert.equal(state.handoffAdmission.isClosed(), true);
  assert.equal(plansDisposed, true);
  assert.equal(speechDisposed, true);
});
