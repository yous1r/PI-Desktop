import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

// Electron and unused import/search services are external to these session actions.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`); return imports[id];
  }, module.exports, module);
  return module.exports;
}
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} }, "node:fs": fs, "node:path": path, "@pi-desktop/shared": shared,
  "../importers": {}, "../services/session-collaboration": {}, "../bootstrap/remote-hosts.js": {}, "../services/session-search": {},
});
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(retire = async () => {}) {
  const handlers = new Map(); const events = []; const warnings = []; let exists = true;
  const host = { call: async (method) => { events.push(method); if (method === "session.delete") exists = false; return { ok: true }; } };
  const sidecar = {
    call: async (method, params) => { events.push({ method, params }); await retire(); events.push("retired"); return { ok: true }; },
    clearProjectInstructionRoot() {}, clearVendorAuthBindings() {},
  };
  registerSessionIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => sidecar, dataDir: "/unused", activeTurns: new Map(), sessionProjects: new Map(),
    persistenceOutbox: { dropSession: async () => events.push("drop"), prepareSessionReplacement: async () => events.push("drain") },
    logger: { app: (...args) => { if (args[1] === "warn") warnings.push(args); } }, plugins: { broadcastEvent() {} },
    sessionCapabilityContext: async () => ({}), enrichSession: (session) => session,
    acquireSessionOperation: async () => { events.push("lock"); return () => events.push("unlock"); },
    beginTranscriptRewrite: () => ({ commit() {}, rollback() {} }), forgetTranscriptRewriteHistory() {}, stripWinLongPrefix: (value) => value,
  });
  return { handlers, events, warnings, exists: () => exists };
}

test("session delete waits for session-close retirement while Host identity still exists", async () => {
  const entered = deferred(); const release = deferred();
  const f = fixture(async () => { entered.resolve(); await release.promise; });
  const deleted = f.handlers.get(shared.IPC.invoke.sessionDelete)("session");
  await entered.promise;
  assert.equal(f.exists(), true);
  assert.deepEqual(f.events, ["lock", { method: "agent.disposeSession", params: { sessionId: "session", reason: "session-close" } }]);
  release.resolve(); await deleted;
  assert.deepEqual(f.events.slice(-4), ["retired", "session.delete", "drop", "unlock"]);
});

test("failed retirement remains observable and releases the delete gate", async () => {
  const f = fixture(async () => { throw new Error("sidecar unavailable"); });
  await f.handlers.get(shared.IPC.invoke.sessionDelete)("session");
  assert.equal(f.warnings.length, 1); assert.equal(f.exists(), false); assert.equal(f.events.at(-1), "unlock");
});

test("transcript replacement explicitly retires as reconfigure without reporting conversation closure", async () => {
  const f = fixture();
  await f.handlers.get(shared.IPC.invoke.sessionReplaceMessages)({ sessionId: "session", messages: [] });
  const request = f.events.find((item) => typeof item === "object");
  assert.deepEqual(request, { method: "agent.disposeSession", params: { sessionId: "session", reason: "reconfigure" } });
  assert.ok(f.events.indexOf("retired") < f.events.indexOf("session.replaceMessages"));
});

const { registerPluginIpc } = load("../electron/main/ipc/plugin-ipc.ts", {
  electron: { dialog: {} }, "@pi-desktop/shared": shared, "@pi-desktop/plugin-devkit": {},
  "../browser-host": { BROWSER_PLUGIN_ID: "local.browser" }, "../plugin-runtime": {}, "../plugin-view-host": {},
  "../plugin-renderer-extension": {},
});
test("native uninstall clears connection authority before deleting registration, while disable retains it", async () => {
  const handlers = new Map(), events = []; let failCleanup = false;
  registerPluginIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler), handleWithEvent() {} },
    getHost: () => ({ call: async method => { events.push(method); return { ok: true }; } }),
    plugins: { unload: async () => events.push("unload"), connections: { uninstall: async () => {
      events.push("credentials.delete"); if (failCleanup) throw new Error("storage offline");
    }, list: async id => { assert.equal(id, "local.fixture"); return []; } } },
    pluginViews: { closePlugin() {} }, browserHost: {}, pluginScopes: new Map(), agentExtensions: {},
    rememberPluginScopes() {}, refreshUserMcp: async () => {}, sendToRenderer() {}, logger: { app() {} },
  });
  assert.deepEqual(await handlers.get(shared.IPC.invoke.pluginConnectionsList)({ pluginId: "local.fixture" }), { connections: [] });
  await handlers.get(shared.IPC.invoke.pluginDisable)("local.fixture");
  assert.deepEqual(events.splice(0), ["unload", "plugins.disable"]);
  await handlers.get(shared.IPC.invoke.pluginUninstall)("local.fixture");
  assert.deepEqual(events.splice(0), ["unload", "credentials.delete", "plugins.uninstall"]);
  failCleanup = true;
  await assert.rejects(handlers.get(shared.IPC.invoke.pluginUninstall)("local.fixture"), /storage offline/);
  assert.deepEqual(events, ["unload", "credentials.delete"]);
});
