/**
 * H1-R07 Electron surfaces and listener registrations.
 *
 * The first group exercises the shared owner contract; the second group wires
 * the real `bootstrap/window.ts`, `bootstrap/launcher.ts` and
 * `bootstrap/app-lifecycle.ts` modules against the controlled Electron fixture
 * in `test/helpers/surface-electron.mjs`. Nothing here creates a live
 * BrowserWindow, Tray, global accelerator, display or network connection.
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const helpers = join(here, "helpers");
const scratch = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "handoff-electron-surfaces-"));

// The surface modules read these Electron process extensions at call time.
Object.defineProperty(process, "platform", { value: "linux" });
process.getSystemVersion = () => "10.0.19045";

const appFixturePath = join(scratch, "app-root");
// The renderer URL would replace the packaged file load below with a dev load.
delete process.env.ELECTRON_RENDERER_URL;
mkdirSync(join(appFixturePath, "build"), { recursive: true });
writeFileSync(join(appFixturePath, "build", "icon.png"), "fixture");
process.env.PI_SURFACE_FIXTURE_APP_PATH = appFixturePath;

register(pathToFileURL(join(helpers, "ts-import-hooks.mjs")));
register(pathToFileURL(join(helpers, "surface-electron-hook.mjs")));

const { createWindow } = await import(
  pathToFileURL(join(repositoryRoot, "apps/desktop/electron/main/bootstrap/window.ts")).href
);
const { createLauncher } = await import(
  pathToFileURL(join(repositoryRoot, "apps/desktop/electron/main/bootstrap/launcher.ts")).href
);
const { createApplicationLifecycle } = await import(
  pathToFileURL(join(repositoryRoot, "apps/desktop/electron/main/bootstrap/app-lifecycle.ts")).href
);
const { createSurfaceActivity } = await import(
  pathToFileURL(join(repositoryRoot, "apps/desktop/electron/main/surface-activity.ts")).href
);
const electron = await import(pathToFileURL(join(helpers, "surface-electron.mjs")).href);
const { FakeBrowserWindow, electronState, resetElectronState } = electron;

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) await new Promise(setImmediate);
};

const until = async (predicate, label) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error(`condition never settled: ${label}`);
};

function deferred() {
  const state = {};
  state.promise = new Promise((resolvePromise, rejectPromise) => {
    state.resolve = resolvePromise;
    state.reject = rejectPromise;
  });
  return state;
}

function ownerFixture() {
  const gate = { closed: false, host: null };
  const surfaces = createSurfaceActivity({
    isAdmissionClosed: () => gate.closed,
    getHost: () => gate.host,
  });
  return { gate, surfaces };
}

function dataDirectory() {
  return mkdtempSync(join(scratch, "data-"));
}

function windowFixture(surfaces, dataDir = dataDirectory()) {
  const state = {
    mainWindow: null,
    notificationViewingSessionId: null,
    requestedWorkPanelReservation: 0,
    workPanelReservation: { width: 0, xOffset: 0 },
    workPanelDisplayKey: null,
    workPanelBaseBounds: null,
    workPanelLastAppliedBounds: null,
    expectedWorkPanelBounds: null,
    workPanelUserMovePending: false,
    workPanelNativeResizeActive: false,
    workPanelChatResizeTimer: null,
    workPanelChatResizeActive: false,
    setWorkPanelChatWidthForWindow: null,
    pluginLauncherBinding: null,
    closePromptOpen: false,
    quitConfirmed: false,
    menuRendererReadyGate: null,
    quitting: false,
    tray: null,
    closeBehavior: "ask",
    developerMode: false,
    macosWindowTranslucency: true,
    pluginLauncherWindow: null,
    host: null,
  };
  const deps = {
    state,
    dataDir,
    windowMinWidth: 900,
    windowMinHeight: 600,
    windowBoundsSettleMs: 1,
    workPanelNativeResizeSettleMs: 1,
    windowsAllowedToClose: new WeakSet(),
    applyWorkPanelReservation: () => ({ width: 0, xOffset: 0 }),
    markWorkPanelChatResizeActive: () => {},
    workPanelMinimumWindowWidth: () => 900,
    observedWorkPanelBaseBounds: (bounds) => bounds,
    classifyDisplayTransition: () => "none",
    resetMenuRendererReady: () => {},
    safeOpenExternal: async () => {},
    showPluginLauncher: async () => {},
    askCloseBehavior: async () => null,
    applyCloseBehavior: () => {},
    createTray: () => {},
    browserHost: { setWindow: () => {} },
    pluginViews: { setWindow: () => {}, hideVisibleView: () => {} },
    logger: { app: () => {} },
    surfaces,
  };
  return { state, deps };
}

function launcherFixture(surfaces) {
  const { state, deps: windowDeps } = windowFixture(surfaces);
  const launcherState = {
    creationPromise: null,
    pluginLauncherAccelerator: null,
    toggleWindowAccelerator: null,
  };
  const runtime = createLauncher({
    state,
    launcherState,
    surfaces,
    appState: { applicationBooted: true },
    getHost: () => null,
    logger: { app: () => {} },
    safeOpenExternal: async () => {},
    toggleMainWindow: () => {},
  });
  return { state, windowDeps, launcherState, runtime };
}

function lifecycleFixture(surfaces) {
  const { state, deps: windowDeps } = windowFixture(surfaces);
  const appState = {
    windowCreationPromise: null,
    applicationBooted: true,
    pendingApplicationMenuCommands: [],
    appliedMenuSettings: null,
  };
  const appearanceState = {
    updaterLocale: "en",
    pluginPanelTheme: "light",
    appThemePreference: "system",
    broadcastAppearanceSignature: "",
  };
  const lifecycle = createApplicationLifecycle({
    state,
    appState,
    appearanceState,
    surfaces,
    dataDir: windowDeps.dataDir,
    isDevelopmentBuild: false,
    windowsAllowedToClose: new WeakSet(),
    windowMinWidth: 900,
    windowMinHeight: 600,
    windowBoundsSettleMs: 1,
    workPanelNativeResizeSettleMs: 1,
    applyWorkPanelReservation: () => ({ width: 0, xOffset: 0 }),
    markWorkPanelChatResizeActive: () => {},
    workPanelMinimumWindowWidth: () => 900,
    observedWorkPanelBaseBounds: (bounds) => bounds,
    classifyDisplayTransition: () => "none",
    sendToRenderer: () => {},
    safeOpenExternal: async () => {},
    showPluginLauncher: async () => {},
    askCloseBehavior: async () => null,
    applyCloseBehavior: () => {},
    browserHost: { setWindow: () => {} },
    pluginViews: {
      setWindow: () => {},
      hideVisibleView: () => {},
      setFontScale: () => {},
      resyncZoom: () => {},
    },
    plugins: { getThemes: () => [], broadcastEvent: () => {} },
    logger: { app: () => {} },
    refreshReleaseNotes: () => {},
    applyPluginLauncherShortcut: () => {},
    applyToggleWindowShortcut: () => {},
    broadcastPluginPanelEvent: () => {},
    getHost: () => null,
    getRunningSessionIds: () => [],
  });
  return { state, appState, lifecycle };
}

beforeEach(() => {
  resetElectronState();
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Shared owner contract                                               */
/* ------------------------------------------------------------------ */

test("a closed admission refuses a fresh surface before any effect", () => {
  const { gate, surfaces } = ownerFixture();
  const scope = surfaces.begin("main-window.create", { create: "main-window" });
  scope.assertFresh();
  gate.closed = true;
  assert.throws(() => scope.assertFresh(), { errorCode: "HOST_BUSY" });
  assert.throws(
    () => surfaces.attach("main-window", "main-window", () => true),
    { errorCode: "HOST_BUSY" },
  );
  assert.deepEqual(surfaces.getHandoffActivity(), {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
});

test("a creation that resumed after an await is refused and leaves no surface", async () => {
  const { gate, surfaces } = ownerFixture();
  const scope = surfaces.begin("main-window.create", { create: "main-window" });
  const reading = deferred();
  const pending = scope.track(() => reading.promise);
  assert.equal(surfaces.getHandoffActivity().operations, 1);
  gate.closed = true;
  reading.resolve("window-state");
  await pending;
  assert.throws(() => scope.assertFresh(), { errorCode: "HOST_BUSY" });
  assert.deepEqual(surfaces.getHandoffActivity(), {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
});

test("a replaced Host invalidates its original operation; an absent Host does not", () => {
  const { gate, surfaces } = ownerFixture();
  const hostA = { generation: 1 };
  const hostB = { generation: 2 };
  gate.host = { host: hostA, generation: 1 };
  const bound = surfaces.begin("main-window.create", { create: "main-window" });
  gate.host = { host: hostB, generation: 2 };
  assert.throws(() => bound.assertFresh(), { errorCode: "HOST_BUSY" });
  // The same instance with the same generation is still the original owner.
  const current = surfaces.begin("main-window.create", { create: "main-window" });
  current.assertFresh();
  // No Host at entry is not bound to a generation; startup ordering stays valid.
  gate.host = null;
  const unbound = surfaces.begin("main-window.create", { create: "main-window" });
  gate.host = { host: hostA, generation: 1 };
  unbound.assertFresh();
});

test("a live slot occupant cannot be rebound, and its own probe releases it", () => {
  const { surfaces } = ownerFixture();
  const alive = { value: true };
  const stale = surfaces.begin("tray.create", { create: "tray" });
  surfaces.attach("tray", "tray", () => alive.value);
  assert.equal(surfaces.getHandoffActivity().resources, 1);
  assert.throws(() => stale.assertFresh(), { errorCode: "HOST_BUSY" });
  assert.throws(() => surfaces.attach("tray", "tray", () => true), {
    errorCode: "HOST_BUSY",
  });
  // The probe is the cleanup evidence: no timer or dispose call releases it.
  alive.value = false;
  assert.equal(surfaces.getHandoffActivity().resources, 0);
  surfaces.attach("tray", "tray", () => false);
  assert.equal(surfaces.getHandoffActivity().resources, 0);
});

test("an unreadable liveness probe stays counted and becomes an explicit blocker", () => {
  const { surfaces } = ownerFixture();
  const broken = () => {
    throw new Error("native state unavailable");
  };
  surfaces.retain("global-shortcut.plugin-launcher", broken);
  const first = surfaces.getHandoffActivity();
  assert.deepEqual(first, { operations: 0, resources: 1, uncontainedResources: 1 });
  const second = surfaces.getHandoffActivity();
  assert.equal(second.resources, 1, "an unproven surface must stay counted");
  assert.equal(second.uncontainedResources, 1, "the unobservable closure is recorded once");
});

test("counted work lasts until the underlying promise settles, not a seal or a wait", async () => {
  const { surfaces } = ownerFixture();
  const scope = surfaces.begin("main-window.load");
  const loading = deferred();
  const tracked = scope.track(() => loading.promise);
  surfaces.seal();
  assert.equal(surfaces.getHandoffActivity().operations, 1);
  assert.throws(() => surfaces.begin("late").assertFresh(), { errorCode: "HOST_BUSY" });
  loading.resolve();
  await tracked;
  assert.equal(surfaces.getHandoffActivity().operations, 0);
});

test("a pending persistence hold is counted until it is released, and release is idempotent", () => {
  const { surfaces } = ownerFixture();
  const hold = surfaces.hold();
  assert.equal(surfaces.getHandoffActivity().operations, 1);
  hold.release();
  hold.release();
  assert.equal(surfaces.getHandoffActivity().operations, 0);
});

test("the owner snapshot is exactly the handoff inventory contract", () => {
  const { surfaces } = ownerFixture();
  assert.deepEqual(Object.keys(surfaces.getHandoffActivity()).sort(), [
    "operations",
    "resources",
    "uncontainedResources",
  ]);
  assert.ok(Number.isSafeInteger(surfaces.getHandoffActivity().resources));
});

/* ------------------------------------------------------------------ */
/* Main window wiring                                                  */
/* ------------------------------------------------------------------ */

test("createWindow refuses a creation that resumed after the admission closed", async () => {
  const { gate, surfaces } = ownerFixture();
  const { state, deps } = windowFixture(surfaces);
  const creating = createWindow(deps);
  // The settings read is still pending, so this is the post-await boundary.
  gate.closed = true;
  await assert.rejects(creating, { errorCode: "HOST_BUSY" });
  assert.equal(electronState.windows.length, 0);
  assert.equal(state.mainWindow, null);
  assert.deepEqual(surfaces.getHandoffActivity(), {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
});

test("two concurrent createWindow continuations cannot create a replacement window", async () => {
  const { surfaces } = ownerFixture();
  const { state, deps } = windowFixture(surfaces);
  const results = await Promise.allSettled([createWindow(deps), createWindow(deps)]);
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.errorCode, "HOST_BUSY");
  assert.equal(electronState.windows.length, 1);
  assert.equal(state.mainWindow, electronState.windows[0]);
  assert.equal(surfaces.getHandoffActivity().resources, 4);
});

test("the admitted creation counts the renderer load and retains the surface until close", async () => {
  const { surfaces } = ownerFixture();
  const { state, deps } = windowFixture(surfaces);
  const loadGate = deferred();
  FakeBrowserWindow.loadGate = loadGate.promise;
  const creating = createWindow(deps);
  await until(
    () =>
      electronState.windows.length === 1 &&
      surfaces.getHandoffActivity().operations === 1,
    "initial renderer load counted",
  );
  assert.equal(electronState.windows.length, 1);
  assert.deepEqual(surfaces.getHandoffActivity(), {
    operations: 1,
    resources: 4,
    uncontainedResources: 0,
  });
  loadGate.resolve();
  FakeBrowserWindow.loadGate = null;
  await creating;
  assert.equal(surfaces.getHandoffActivity().operations, 0);
  assert.match(state.mainWindow.loadedFile.file, /renderer[\\/]index\.html$/);
  state.mainWindow.destroy();
  assert.deepEqual(surfaces.getHandoffActivity(), {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
});

test("a pending bounds write stays an operation until close persists or cancels it", async () => {
  const { surfaces } = ownerFixture();
  const { state, deps } = windowFixture(surfaces);
  await createWindow(deps);
  const window = state.mainWindow;
  window.emit("resize");
  assert.equal(surfaces.getHandoffActivity().operations, 1);
  window.emit("close", { preventDefault() {} });
  await flush();
  assert.equal(surfaces.getHandoffActivity().operations, 0);
  assert.equal(surfaces.getHandoffActivity().resources, 4);
});

/* ------------------------------------------------------------------ */
/* Plugin launcher wiring                                              */
/* ------------------------------------------------------------------ */

test("the launcher never prewarms, creates or shows a surface while admission is closed", async () => {
  const { gate, surfaces } = ownerFixture();
  const { runtime } = launcherFixture(surfaces);
  gate.closed = true;
  runtime.prewarmPluginLauncher();
  await flush();
  assert.equal(electronState.windows.length, 0);
  await assert.rejects(runtime.showPluginLauncher(), { errorCode: "HOST_BUSY" });
  assert.equal(electronState.windows.length, 0);
  assert.equal(surfaces.getHandoffActivity().resources, 0);
});

test("a shown launcher owns its surface and event until it actually closes", async () => {
  const { surfaces } = ownerFixture();
  const { state, runtime } = launcherFixture(surfaces);
  await runtime.showPluginLauncher();
  const window = state.pluginLauncherWindow;
  assert.equal(window.visible, true);
  assert.equal(window.webContents.sent.at(-1).channel, IPC.event.pluginLauncherShown);
  assert.equal(surfaces.getHandoffActivity().resources, 1);
  window.destroy();
  assert.equal(state.pluginLauncherWindow, null);
  assert.equal(surfaces.getHandoffActivity().resources, 0);
});

test("a prewarmed launcher is reused by a later show instead of being refused", async () => {
  const { surfaces } = ownerFixture();
  const { state, runtime } = launcherFixture(surfaces);
  // Startup prewarms the launcher before the user can open it.
  runtime.prewarmPluginLauncher();
  await until(() => state.pluginLauncherWindow !== null, "prewarmed launcher");
  const window = state.pluginLauncherWindow;
  assert.equal(surfaces.getHandoffActivity().resources, 1);
  await runtime.showPluginLauncher();
  assert.equal(state.pluginLauncherWindow, window, "the prewarmed launcher is the shown one");
  assert.equal(window.visible, true);
  assert.equal(electronState.windows.length, 1, "a show never creates a second launcher");
  // Showing the same live surface again stays a reuse: the occupant of the
  // slot must not be read as a competing creation.
  await runtime.showPluginLauncher();
  assert.equal(electronState.windows.length, 1);
  assert.equal(surfaces.getHandoffActivity().resources, 1);
  window.destroy();
  assert.equal(surfaces.getHandoffActivity().resources, 0);
});

test("a launcher show continuation cannot display a surface after closure", async () => {
  const { gate, surfaces } = ownerFixture();
  const { runtime } = launcherFixture(surfaces);
  const loadGate = deferred();
  FakeBrowserWindow.loadGate = loadGate.promise;
  const showing = runtime.showPluginLauncher();
  await until(() => electronState.windows.length === 1, "launcher window created");
  gate.closed = true;
  loadGate.resolve();
  FakeBrowserWindow.loadGate = null;
  await assert.rejects(showing, { errorCode: "HOST_BUSY" });
  assert.equal(electronState.windows[0].visible, false);
  assert.equal(
    surfaces.getHandoffActivity().resources,
    1,
    "the launcher created before the refusal stays an owned surface",
  );
  electronState.windows[0].destroy();
  assert.equal(surfaces.getHandoffActivity().resources, 0);
});

test("global shortcuts register only while open and are retained until native unregister", () => {
  const { gate, surfaces } = ownerFixture();
  const { launcherState, runtime } = launcherFixture(surfaces);
  runtime.applyPluginLauncherShortcut();
  runtime.applyToggleWindowShortcut();
  assert.equal(electronState.shortcuts.size, 2);
  assert.equal(surfaces.getHandoffActivity().resources, 2);
  // Native unregister is the cleanup evidence; no dispose call clears these.
  electronState.shortcuts.clear();
  assert.equal(surfaces.getHandoffActivity().resources, 0);
  gate.closed = true;
  launcherState.pluginLauncherAccelerator = null;
  runtime.applyPluginLauncherShortcut();
  assert.equal(electronState.shortcuts.size, 0);
});

/* ------------------------------------------------------------------ */
/* Application lifecycle wiring                                        */
/* ------------------------------------------------------------------ */

test("the lifecycle tray is created only while open and released with the native tray", () => {
  const { gate, surfaces } = ownerFixture();
  const { lifecycle, appState } = lifecycleFixture(surfaces);
  lifecycle.createTray();
  assert.equal(electronState.trays.length, 1);
  assert.equal(appState.windowCreationPromise, null);
  assert.equal(surfaces.getHandoffActivity().resources, 1);
  electronState.trays[0].destroy();
  assert.equal(surfaces.getHandoffActivity().resources, 0);
  gate.closed = true;
  lifecycle.createTray();
  assert.equal(electronState.trays.length, 1);
  assert.equal(surfaces.getHandoffActivity().resources, 0);
});

test("ensureWindow creates through the shared owner and refuses after closure", async () => {
  const { gate, surfaces } = ownerFixture();
  const { lifecycle, state } = lifecycleFixture(surfaces);
  const created = await lifecycle.ensureWindow();
  assert.equal(created, true);
  assert.equal(electronState.windows.length, 1);
  assert.equal(surfaces.getHandoffActivity().resources, 4);
  state.mainWindow.destroy();
  assert.equal(surfaces.getHandoffActivity().resources, 0);
  gate.closed = true;
  assert.equal(await lifecycle.ensureWindow(), false);
  assert.equal(electronState.windows.length, 1, "a refused creation adds no window");
});

test("the Windows launcher chord observes a closed-gate refusal without an unhandled rejection", async () => {
  const { gate, surfaces } = ownerFixture();
  const { runtime } = launcherFixture(surfaces);
  const { state, deps } = windowFixture(surfaces);
  const logged = Promise.withResolvers();
  deps.showPluginLauncher = () => runtime.showPluginLauncher();
  deps.logger.app = (_area, level, message) => {
    if (message === "plugin launcher refused") logged.resolve(level);
  };
  await createWindow(deps);
  state.pluginLauncherBinding = "Alt+Space";
  gate.closed = true;
  let prevented = false;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    state.mainWindow.webContents.emit("before-input-event", { preventDefault: () => { prevented = true; } },
      { type: "keyDown", code: "Space", alt: true, control: false, meta: false, shift: false });
    assert.equal(prevented, true);
    assert.equal(await logged.promise, "warn");
    assert.equal(electronState.windows.length, 1, "a refused chord creates no launcher");
  } finally {
    Object.defineProperty(process, "platform", platform);
    state.mainWindow.destroy();
  }
});
