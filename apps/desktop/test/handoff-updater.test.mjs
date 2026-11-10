/**
 * H1-R02 updater ownership: admission gating, per-operation original-owner
 * attribution, counted operations and disposal evidence.
 *
 * electron-updater, Electron, the platform installer and the system browser are
 * replaced by the isolated fixtures in `test/helpers`; nothing here starts a
 * check, download, shell, browser or installer outside this process.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");
/** The same module instance `updater.ts` sees for `import { shell } from "electron"`. */
const electronStub = await import("./helpers/updater-electron-stub.mjs");

/** Mirrors AUTO_CHECK_INITIAL_DELAY_MS / AUTO_CHECK_INTERVAL_MS in updater.ts. */
const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function deferred() {
  const state = {};
  state.promise = new Promise((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
  });
  return state;
}

/** Resolves queued microtasks without sleeping. */
async function flush(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/** Waits for a condition on macrotask boundaries so no arbitrary delay is used. */
async function until(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition never settled: ${label}`);
}

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  cancellations = [];
  /** Every transport handed out, so a test can settle them individually. */
  pendingChecks = [];
  /** When true, `checkForUpdates()` returns a promise the test settles. */
  manualChecks = false;
  /** When set, the check result carries this pending download and a token. */
  pendingDownload = null;

  info() {
    return {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
  }

  result() {
    const info = this.info();
    if (!this.pendingDownload) {
      return {
        updateInfo: info,
        cancellationToken: undefined,
        downloadPromise: undefined,
      };
    }
    return {
      updateInfo: info,
      cancellationToken: {
        cancel: () => {
          this.cancellations.push(info.version);
          this.emit("update-cancelled", info);
        },
      },
      downloadPromise: this.pendingDownload.promise,
    };
  }

  checkForUpdates() {
    this.checkCalls += 1;
    if (!this.manualChecks) return Promise.resolve(this.result());
    const transport = deferred();
    this.pendingChecks.push(transport);
    return transport.promise;
  }

  downloadUpdate() {
    this.downloadCalls += 1;
    return Promise.resolve([]);
  }

  quitAndInstall() {
    this.installCalls += 1;
  }
}

function createController(options = {}) {
  const sent = [];
  const reads = { count: 0 };
  const logs = [];
  // A replacement is modelled as a new Host generation: every captured guard
  // reports false once the generation it was captured under is gone.
  const generation = options.generation ?? (() => 1);
  const cache = options.cacheMaintenance ?? {
    discardDownloadedInstaller: async () => undefined,
    reclaimLegacyCache: async () => undefined,
  };
  const controller = new AppUpdaterController({
    logger: {
      app: (category, level, message, fields) =>
        logs.push({ category, level, message, fields }),
    },
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform: "darwin",
    isPackaged: true,
    autoUpdater: options.updater,
    readUpdateSettings: async () => {
      reads.count += 1;
      if (options.readUpdateSettings) return options.readUpdateSettings();
      return options.settings ?? { updatePreference: "automatic" };
    },
    persistLastNotifiedVersion: options.persistLastNotifiedVersion,
    persistDismissedVersion: options.persistDismissedVersion,
    cacheMaintenance: cache,
    isAdmissionClosed: options.isAdmissionClosed,
    captureOwner: () => {
      const captured = generation();
      return () => generation() === captured;
    },
  });
  return { controller, sent, reads, logs };
}

test("a closed gate refuses a fresh check before it reads settings or queries the feed", async () => {
  const updater = new FakeUpdater();
  const { controller, reads } = createController({
    updater,
    isAdmissionClosed: () => true,
  });

  await assert.rejects(
    controller.check(),
    (error) => error.errorCode === "HOST_BUSY" && error.code === "HOST_BUSY",
  );
  assert.equal(reads.count, 0, "a closed gate must not start the settings read");
  assert.equal(updater.checkCalls, 0, "no feed query may start after closure");
  await assert.rejects(
    controller.openReleases(),
    (error) => error.errorCode === "HOST_BUSY",
    "the releases browser launch is a fresh external effect",
  );

  const activity = controller.getHandoffActivity();
  assert.deepEqual(Object.keys(activity).sort(), [
    "operations",
    "resources",
    "uncontainedResources",
  ]);
  assert.deepEqual(activity, {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
  controller.dispose();
});

test("closed install refuses before the installer is spawned", async () => {
  const updater = new FakeUpdater();
  let closed = false;
  const { controller } = createController({
    updater,
    isAdmissionClosed: () => closed,
  });

  const pending = controller.check();
  await until(() => updater.checkCalls === 1, "check start");
  updater.emit("update-available", updater.info());
  updater.emit("update-downloaded", updater.info());
  await pending;
  assert.equal(controller.getState().status, "downloaded");

  closed = true;
  assert.throws(
    () => controller.install(),
    (error) => error.errorCode === "HOST_BUSY" && error.code === "HOST_BUSY",
  );
  assert.equal(updater.installCalls, 0, "quitAndInstall must not run after closure");
  assert.equal(controller.isInstallingUpdate(), false, "the latch stays clear");
  assert.equal(controller.getHandoffActivity().resources, 0);

  // The ordinary path is unchanged while the gate is open.
  closed = false;
  controller.install();
  assert.equal(updater.installCalls, 1);
  assert.equal(controller.isInstallingUpdate(), true);
  const activity = controller.getHandoffActivity();
  assert.equal(activity.resources, 1);
  assert.ok(
    activity.uncontainedResources >= 1,
    "the spawned installer never reports exit",
  );
  controller.dispose();
});

test("a pending check is counted before the feed callback settles", async () => {
  const updater = new FakeUpdater();
  updater.manualChecks = true;
  const { controller } = createController({ updater });

  const pending = controller.check();
  await until(() => updater.pendingChecks.length === 1, "check start");
  assert.equal(controller.getHandoffActivity().operations, 1);

  updater.pendingChecks[0].resolve(updater.result());
  await pending;
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("a settings read is counted until it settles and gates the feed query", async () => {
  const updater = new FakeUpdater();
  const read = deferred();
  const { controller } = createController({
    updater,
    readUpdateSettings: () => read.promise,
  });

  const pending = controller.check();
  await until(
    () => controller.getHandoffActivity().operations === 1,
    "settings read start",
  );
  assert.equal(updater.checkCalls, 0, "the feed query waits for the read");

  read.resolve({ updatePreference: "automatic" });
  await pending;
  await flush();
  assert.equal(updater.checkCalls, 1);
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("a caller timeout leaves the underlying check counted until it really settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = new FakeUpdater();
  updater.manualChecks = true;
  const { controller } = createController({ updater });

  const pending = controller.check();
  await until(() => updater.pendingChecks.length === 1, "check start");
  t.mock.timers.tick(8_000);
  await pending;
  assert.equal(controller.getState().status, "idle");
  assert.equal(
    controller.getHandoffActivity().operations,
    1,
    "the bounded wait must not release the real check",
  );

  updater.pendingChecks[0].resolve(updater.result());
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("a reentrant check hands the feed one query, not two", async () => {
  const updater = new FakeUpdater();
  updater.manualChecks = true;
  const { controller } = createController({ updater });

  const first = controller.check();
  const second = controller.check();
  await until(() => updater.checkCalls === 1, "check start");
  await flush();
  assert.equal(updater.checkCalls, 1);
  assert.equal(controller.getHandoffActivity().operations, 1);

  updater.pendingChecks[0].resolve(updater.result());
  await Promise.all([first, second]);
  await flush();
  assert.equal(updater.checkCalls, 1);
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("a detached dismissal write stays counted until it is persisted", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const write = deferred();
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.0" },
    persistDismissedVersion: async (version) => {
      persisted.push(version);
      await write.promise;
    },
  });

  const pending = controller.check();
  await until(() => updater.checkCalls === 1, "check start");
  updater.emit("update-available", updater.info());
  await pending;
  await until(() => persisted.length === 1, "detached dismissal write");
  assert.deepEqual(persisted, [null], "a newer release clears the old dismissal");
  assert.equal(
    controller.getHandoffActivity().operations,
    1,
    "a detached settings write stays visible until it settles",
  );

  write.resolve();
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("a queued dismissal write is counted from enqueue and revalidates its original owner", async () => {
  const updater = new FakeUpdater();
  const writes = [];
  let generation = 1;
  const { controller } = createController({
    updater,
    generation: () => generation,
    settings: { updatePreference: "manual" },
    persistDismissedVersion: async (version) => {
      const entry = { version, done: deferred() };
      writes.push(entry);
      return entry.done.promise;
    },
  });

  const pending = controller.check();
  await until(() => updater.checkCalls === 1, "check start");
  updater.emit("update-available", updater.info());
  await pending;

  const dismissing = controller.dismiss();
  await until(() => writes.length === 1, "first write");
  assert.deepEqual(
    writes.map((entry) => entry.version),
    ["0.16.1"],
  );

  // A newer release clears the earlier dismissal while the first write is still
  // running, so the second write is queued behind it.
  updater.nextVersion = "0.16.2";
  updater.emit("update-available", updater.info());
  await flush();
  assert.equal(
    controller.getHandoffActivity().operations,
    2,
    "a queued write is counted from enqueue, not from when the queue reaches it",
  );

  // The original Host generation is replaced before the queued write executes.
  generation = 2;
  writes[0].done.resolve();
  await dismissing;
  await flush();
  assert.deepEqual(
    writes.map((entry) => entry.version),
    ["0.16.1"],
    "a queued write must not run through the replacement owner",
  );
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("a detached cache pass is counted while open and skipped after closure", async () => {
  const updater = new FakeUpdater();
  const discard = deferred();
  const cache = {
    discardCalls: 0,
    reclaimCalls: 0,
    discardDownloadedInstaller() {
      cache.discardCalls += 1;
      return discard.promise;
    },
    reclaimLegacyCache() {
      cache.reclaimCalls += 1;
      return Promise.resolve();
    },
  };
  let closed = false;
  const { controller } = createController({
    updater,
    cacheMaintenance: cache,
    isAdmissionClosed: () => closed,
  });

  await controller.reclaimRelocatedUpdateCache();
  assert.equal(cache.reclaimCalls, 1);

  const pending = controller.check();
  await until(() => updater.checkCalls === 1, "check start");
  updater.emit("update-not-available", updater.info());
  await pending;
  await until(() => cache.discardCalls === 1, "cache discard");
  assert.equal(
    controller.getHandoffActivity().operations,
    1,
    "a detached cache pass stays visible until it settles",
  );

  discard.resolve();
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 0);

  closed = true;
  updater.emit("update-not-available", updater.info());
  await controller.reclaimRelocatedUpdateCache();
  await flush();
  assert.equal(cache.discardCalls, 1, "no fresh cache pass after closure");
  assert.equal(cache.reclaimCalls, 1, "no fresh cache adoption after closure");
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("disposal cancels the owned download, removes only its listeners and retains work", async () => {
  const updater = new FakeUpdater();
  updater.pendingDownload = deferred();
  const thirdParty = [];
  const { controller, sent } = createController({ updater });
  updater.on("update-available", (info) => thirdParty.push(info.version));

  const pending = controller.check();
  await until(() => updater.checkCalls === 1, "check start");
  updater.emit("update-available", updater.info());
  await pending;
  await until(
    () => controller.getHandoffActivity().operations === 1,
    "counted download",
  );
  assert.equal(updater.listenerCount("update-available"), 2);

  const sentBeforeDispose = sent.length;
  controller.dispose();

  assert.equal(
    updater.listenerCount("update-available"),
    1,
    "only this controller's listener is removed",
  );
  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(
    controller.getHandoffActivity().operations,
    1,
    "disposal retains unsettled work instead of clearing it",
  );
  assert.ok(
    controller.getHandoffActivity().uncontainedResources >= 1,
    "disposal does not claim the updater transport or installer exited",
  );
  assert.equal(sent.length, sentBeforeDispose, "a sealed owner pushes no state");

  updater.emit("update-available", updater.info());
  assert.deepEqual(thirdParty, ["0.16.1", "0.16.1"]);
  assert.equal(sent.length, sentBeforeDispose);

  updater.pendingDownload.resolve([]);
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 0);
});

test("a retained auto-check timer cannot start work after the gate closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const updater = new FakeUpdater();
  let closed = false;
  const { controller, reads } = createController({
    updater,
    isAdmissionClosed: () => closed,
  });

  controller.startAutoCheck();
  await until(() => reads.count === 1, "settings load");
  // The timers are created from the settled settings promise, not from the call.
  await flush(20);

  t.mock.timers.tick(AUTO_CHECK_INITIAL_DELAY_MS);
  await until(() => updater.checkCalls === 1, "initial auto check");
  await flush();

  closed = true;
  t.mock.timers.tick(AUTO_CHECK_INTERVAL_MS);
  await flush();
  assert.equal(updater.checkCalls, 1, "no scheduled check may start after closure");
  assert.equal(controller.getHandoffActivity().operations, 0);

  controller.dispose();
  t.mock.timers.tick(AUTO_CHECK_INTERVAL_MS);
  await flush();
  assert.equal(updater.checkCalls, 1, "disposal clears the owned interval");
});

test("a preference-triggered check cannot start after the gate closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const updater = new FakeUpdater();
  let closed = false;
  const { controller } = createController({
    updater,
    settings: { updatePreference: "manual" },
    isAdmissionClosed: () => closed,
  });

  controller.startAutoCheck();
  await until(() => controller.getState().mode === "manual", "settings applied");

  controller.setPreference("automatic");
  await until(() => updater.checkCalls === 1, "preference triggered check");
  await flush();
  const uncontained = controller.getHandoffActivity().uncontainedResources;
  assert.ok(uncontained >= 1);

  controller.setPreference("manual");
  await flush();
  closed = true;
  controller.setPreference("automatic");
  await flush();
  assert.equal(updater.checkCalls, 1, "the preference callback starts no new check");
  assert.equal(
    controller.getHandoffActivity().uncontainedResources,
    uncontained,
    "a refused trigger records no new transport handoff",
  );
  controller.dispose();
});

test("a pending check cannot query, persist or push through the owner that replaced it", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const read = deferred();
  let generation = 1;
  const { controller, sent, reads } = createController({
    updater,
    generation: () => generation,
    settings: { updatePreference: "manual" },
    readUpdateSettings: () => read.promise,
    persistLastNotifiedVersion: async (version) => persisted.push(version),
  });

  const entryA = controller.check();
  await until(() => reads.count === 1, "entry A settings read");
  assert.equal(controller.getHandoffActivity().operations, 1);

  // The original Host generation is replaced while entry A is still waiting.
  generation = 2;
  // Entry B captures the replacement and returns without a version to dismiss.
  await controller.dismiss();
  assert.equal(controller.getHandoffActivity().operations, 1);

  read.resolve({ updatePreference: "manual" });
  await assert.rejects(
    entryA,
    (error) => error.errorCode === "HOST_BUSY" && error.code === "HOST_BUSY",
    "entry A must refuse its transport handoff after the replacement",
  );
  await flush();

  assert.equal(updater.checkCalls, 0, "no feed query through the replacement");
  assert.equal(sent.length, 0, "no renderer push through the replacement");
  assert.deepEqual(persisted, [], "no settings write through the replacement");
  assert.equal(reads.count, 1, "the replaced entry does not re-read settings");
  assert.equal(
    controller.getHandoffActivity().operations,
    0,
    "the refused entry releases its counted read",
  );
  controller.dispose();
});

test("two live transports make events unattributable instead of adopting a new owner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = new FakeUpdater();
  updater.manualChecks = true;
  const persisted = [];
  const { controller, sent, logs } = createController({
    updater,
    settings: { updatePreference: "manual" },
    persistLastNotifiedVersion: async (version) => persisted.push(version),
  });

  const first = controller.check();
  await until(() => updater.pendingChecks.length === 1, "first transport");
  t.mock.timers.tick(8_000);
  await first;
  await flush();

  // The first transport survives its caller's timeout; a second check starts.
  const second = controller.check();
  await until(() => updater.pendingChecks.length === 2, "second transport");
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 2);
  const sentBeforeAmbiguity = sent.length;

  updater.emit("update-available", updater.info());
  await flush();
  assert.equal(
    sent.length,
    sentBeforeAmbiguity,
    "an unattributable event pushes nothing",
  );
  assert.equal(updater.autoInstallOnAppQuit, false, "no deferred installer enabled");
  assert.deepEqual(persisted, [], "no settings write from an ambiguous event");
  assert.equal(
    controller.getState().availableVersion,
    "0.16.1",
    "the local state is still recorded for the inventory",
  );
  assert.ok(
    logs.some((entry) => /ambiguous/i.test(entry.message)),
    "the ambiguity stays diagnosable",
  );

  // The straggler settles, leaving one attributable transport.
  updater.pendingChecks[0].resolve(updater.result());
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 1);
  updater.emit("update-available", updater.info());
  await flush();
  assert.ok(sent.length > sentBeforeAmbiguity, "the remaining transport pushes");
  assert.deepEqual(persisted, ["0.16.1"], "attribution returns to that transport");

  updater.pendingChecks[1].resolve(updater.result());
  await second;
  await flush();
  assert.equal(controller.getHandoffActivity().operations, 0);
  controller.dispose();
});

test("opening the releases page is counted, uncontained and never kills the browser", async () => {
  const updater = new FakeUpdater();
  const { controller } = createController({ updater });
  const opened = [];
  const gate = deferred();
  const originalOpenExternal = electronStub.shell.openExternal;
  electronStub.shell.openExternal = async (url) => {
    opened.push(url);
    await gate.promise;
    return undefined;
  };
  try {
    const pending = controller.openReleases();
    await until(() => opened.length === 1, "browser launch");
    const activity = controller.getHandoffActivity();
    assert.equal(activity.operations, 1, "the awaited launch is counted");
    assert.ok(
      activity.uncontainedResources >= 1,
      "an external browser process never reports its exit",
    );

    gate.resolve();
    await pending;
    await flush();
    assert.equal(controller.getHandoffActivity().operations, 0);
    assert.ok(
      controller.getHandoffActivity().uncontainedResources >= 1,
      "closure of that process is still not claimed",
    );

    // Disposal seals new launches but does not terminate the running browser.
    controller.dispose();
    await assert.rejects(controller.openReleases(), (error) => error.errorCode === "HOST_BUSY");
    assert.equal(opened.length, 1);
  } finally {
    electronStub.shell.openExternal = originalOpenExternal;
    controller.dispose();
  }
});
