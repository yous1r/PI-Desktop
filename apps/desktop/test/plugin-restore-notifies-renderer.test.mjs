import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { register } from "node:module";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { DesktopBackendOwner } = await import("../electron/main/runtime/backend-owner.ts");

function loadLifecycle(imports) {
  const source = readFileSync(
    new URL("../electron/main/runtime/lifecycle.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "lifecycle.ts",
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (specifier) => {
      assert.ok(Object.hasOwn(imports, specifier), `unmocked dependency: ${specifier}`);
      return imports[specifier];
    },
    module.exports,
    module,
  );
  return module.exports.createRuntimeLifecycle;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("startup plugin restore notifies the renderer after every enabled plugin loads", async (t) => {
  const order = [];
  const events = [];
  const firstLoad = deferred();
  const secondLoad = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const createRuntimeLifecycle = loadLifecycle({
    "./backend-owner": { DesktopBackendOwner },
    "node:fs": { mkdirSync() {} },
    "node:path": { join: (...parts) => parts.join("/") },
    "@pi-desktop/shared": {
      APP_NAME: "PI Desktop",
      APP_VERSION: "0.0.0-test",
      ErrorCodes: { HOST_UNAVAILABLE: "HOST_UNAVAILABLE" },
      IPC: { event: { hostStatus: "hostStatus", pluginChanged: "pluginChanged" } },
      PROTOCOL_VERSION: "test",
    },
    "../linux-glibc": {
      isGlibcUnsupportedError: () => false,
      GLIBC_UNSUPPORTED_STATUS: "unsupported glibc",
    },
    "../host-boot-diagnostics": {
      DB_SCHEMA_TOO_NEW_STATUS: "schema too new",
      detectRuntimeArch: () => ({ mismatch: false }),
      schemaTooNewOf: () => null,
    },
    "../plugin-display-locale": { syncPluginDisplayLocale: async () => {} },
    "@pi-desktop/host-runtime": {
      RuntimeSupervisor: class {
        superviseRestart() {
          return Promise.resolve();
        }
      },
    },
  });
  const listedPlugins = [
    { id: "demo.first", path: "/plugins/first", enabled: true, permissions: [] },
    { id: "demo.second", path: "/plugins/second", enabled: true, permissions: [], source: "dev" },
  ];
  const runtimeState = {
    handoffAdmission: new DesktopHandoffAdmission(),
    host: {
      generation: "fixture", isAvailable: () => true, onExit: () => () => {},
      call: async (method) => {
        if (method === "settings.get") return {};
        if (method === "workspace.get") return { workspace: { path: "/workspace" } };
        if (method === "plugins.list") return { plugins: listedPlugins };
        throw new Error(`unexpected host call: ${method}`);
      },
    },
    sidecar: null,
  };
  const host = runtimeState.host;
  runtimeState.host = null;
  t.after(() => runtimeState.handoffAdmission.dispose());
  const plugins = {
    setServices() {},
    loadFromPath: async (path) => {
      if (path === "/plugins/first") {
        firstStarted.resolve();
        await firstLoad.promise;
        order.push("loaded:first");
      } else {
        secondStarted.resolve();
        await secondLoad.promise;
        order.push("loaded:second");
      }
    },
    watchDevPlugin: () => order.push("watched:second"),
  };
  const lifecycle = createRuntimeLifecycle({
    runtimeState,
    dataDir: "/tmp/pi-desktop-test",
    logger: { app: (_area, _level, message, details) => {
      if (message === "plugin restored") order.push(`restored:${details.pluginId}`);
    } },
    sendToRenderer: (channel, payload) => {
      events.push({ channel, payload });
      order.push(`sent:${payload.reason}`);
    },
    fenced: false,
    hostStartup: { prepare: async () => "", create: () => host, configure: async () => {} },
    sidecarStartup: { create: () => ({ onExit: () => () => {}, setHost() {}, captureHostBinding: () => () => true }), configure: async () => {} },
    drainApprovedPlanExecutions: async () => {},
    applyNetworkProxyFromAppSettings: async () => {},
    plugins,
    setCurrentWorkspacePath: () => {},
    rememberPluginScopes: () => {},
    refreshUserMcp: async () => {},
    isQuitting: () => false,
    getDisplayLocale: () => "en",
  });

  const boot = lifecycle.bootBackends();
  await firstStarted.promise;
  assert.equal(runtimeState.handoffAdmission.inFlightCount(), 1);
  assert.deepEqual(events, [], "the renderer stays untouched while restore is in flight");
  firstLoad.resolve();
  await secondStarted.promise;
  assert.deepEqual(events, [], "the event waits for the entire restore pass");
  secondLoad.resolve();
  await boot;
  assert.equal(runtimeState.handoffAdmission.inFlightCount(), 0);

  assert.deepEqual(events, [{
    channel: "pluginChanged",
    payload: { reason: "restore" },
  }]);
  assert.ok(order.indexOf("loaded:second") < order.indexOf("sent:restore"));
  assert.ok(order.indexOf("watched:second") < order.indexOf("sent:restore"));
});
