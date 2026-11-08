import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
function childFixture(onCall = () => false) {
  let receive = () => {}, exit = () => {}, next = 0, kills = 0;
  const sent = [], replies = new Map();
  return {
    sent, get kills() { return kills; },
    postMessage(value) {
      sent.push(value);
      if (value.t === "res") { replies.get(value.id)?.resolve(value); replies.delete(value.id); return; }
      if (value.t !== "init" && value.t !== "call") return;
      if (!onCall(value, this)) queueMicrotask(() => this.reply(value));
    },
    reply(value, result = null) { receive({ t: "res", id: value.id, ok: true, value: result }); },
    fail(value, code) { receive({ t: "res", id: value.id, ok: false, error: { code, message: "Fixture refusal" } }); },
    request(api, args = [], context = {}) {
      const id = `p${++next}`, result = deferred(); replies.set(id, result);
      receive({ t: "call", id, api, args, ...context }); return result.promise;
    },
    onMessage(handler) { receive = handler; }, onExit(handler) { exit = handler; },
    kill() { kills++; exit(0); },
  };
}
function fixture(t, options = {}) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-callback-"));
  const id = "test.handoff-callback";
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: id,
    version: "1.0.0", main: "main.js", permissions: ["clipboard.write", "agent.tool.register", "desktop.control"], ...options.manifest }));
  writeFileSync(join(root, "main.js"), "module.exports = {};\n");
  const children = [];
  let closed = false;
  const context = { workspaceId: "w", projectId: "w", authority: { kind: "local" },
    roots: [{ path: root, name: "w", primary: true }], platform: "win32", connectionState: "connected", generation: 1 };
  const runtime = new PluginRuntime({ isAdmissionClosed: () => closed,
    spawnProcess: () => { const child = childFixture(options.onCall); children.push(child); return child; }, ...options.host });
  t.after(async () => { await runtime.disposeAll(); rmSync(root, { recursive: true, force: true }); });
  return { root, id, context, runtime, children, close: () => { closed = true; } };
}

test("closed admission rejects panel host calls before side effects", async t => {
  let writes = 0;
  const f = fixture(t, { host: { writeClipboard: async () => { writes++; } } });
  await f.runtime.loadFromPath(f.root); f.close();
  await assert.rejects(f.runtime.invokePanelBridge(f.id, "clipboard.writeText", { text: "closed" }), { code: "HOST_BUSY" });
  assert.equal(writes, 0);
});

test("closed admission rejects child callbacks while preserving teardown callbacks", async t => {
  const writes = [];
  const f = fixture(t, { host: { writeClipboard: async text => { writes.push(text); } }, onCall: (message, child) => {
    if (message.method !== "lifecycle.unload") return false;
    void child.request("clipboard.writeText", ["cleanup"], { parentCallId: message.id }).then(result => {
      assert.equal(result.ok, true); child.reply(message);
    }); return true;
  } });
  await f.runtime.loadFromPath(f.root); f.close();
  const blocked = await f.children[0].request("clipboard.writeText", ["ordinary"]);
  assert.equal(blocked.error?.code, "HOST_BUSY");
  await f.runtime.unload(f.id);
  assert.deepEqual(writes, ["cleanup"]);
});

test("cancelled tool callbacks retain original host work after plugin unload", async t => {
  const entered = deferred(), release = deferred(), answered = deferred();
  const f = fixture(t, { host: { desktopControl: { operations: [{ id: "session/get", risk: "read" }],
    invoke: async () => { entered.resolve(); await release.promise; return {}; } } }, onCall: (message, child) => {
      if (message.method !== "tool.execute") return false;
      void child.request("desktop.invoke", [{ operation: "session/get", args: ["s"] }],
        { invocationId: message.invocationId, parentCallId: message.id }).then(answered.resolve);
      return true;
    } });
  t.after(() => release.resolve());
  await f.runtime.loadFromPath(f.root);
  assert.equal((await f.children[0].request("agent.registerTool", [{ name: "work", schema: { type: "object" } }])).ok, true);
  const work = outcome(f.runtime.getTools()[0].execute({}, { sessionId: "s" }));
  await entered.promise; f.runtime.cancelSessionTools("s");
  assert.equal((await work).error?.code, "PLUGIN_TOOL_ABORTED"); await answered.promise;
  await f.runtime.unload(f.id);
  assert.ok(f.runtime.getHandoffActivity().operations > 0, "original host callback must remain counted");
  release.resolve(); await setImmediate();
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
});

test("callback rechecks original admission after workspace validation", async t => {
  const entered = deferred(), release = deferred(); let validate = false, writes = 0;
  const f = fixture(t, { host: { writeClipboard: async () => { writes++; },
    resolveWorkspaceExecution: async () => { if (validate) { entered.resolve(); await release.promise; } return f.context; } } });
  t.after(() => release.resolve());
  await f.runtime.loadFromPath(f.root);
  const panel = f.runtime.invokePanelBridge(f.id, "pending", {}, { sessionId: "s" }); await panel;
  // A host callback carrying an active parent's workspace must recheck after resolving it.
  const pending = deferred();
  f.runtime.setServices({ spawnProcess: () => childFixture((message, target) => {
    if (message.method !== "panel.invoke") return false;
    pending.resolve({ message, target }); return true;
  }) });
  await f.runtime.loadFromPath(f.root);
  const call = outcome(f.runtime.invokePanelBridge(f.id, "pending", {}, { sessionId: "s" }));
  const { message, target } = await pending.promise; validate = true;
  const callback = target.request("clipboard.writeText", ["late"], { parentCallId: message.id });
  await entered.promise; f.close(); release.resolve();
  assert.equal((await callback).error?.code, "HOST_BUSY"); assert.equal(writes, 0);
  target.reply(message); await call;
});

test("closed admission prevents registered command and tool dispatch", async t => {
  const f = fixture(t); await f.runtime.loadFromPath(f.root); const child = f.children[0];
  await child.request("commands.register", [{ id: "work", title: "Work" }]);
  await child.request("agent.registerTool", [{ name: "work", schema: { type: "object" } }]);
  f.close();
  await assert.rejects(f.runtime.getCommands()[0].run(), { code: "HOST_BUSY" });
  await assert.rejects(f.runtime.getTools()[0].execute({}, { sessionId: "s" }), { code: "HOST_BUSY" });
  assert.equal(child.sent.some(message => ["command.run", "tool.execute"].includes(message.method)), false);
});

test("a retired command cannot dispatch through the replacement installation", async t => {
  const f = fixture(t); await f.runtime.loadFromPath(f.root);
  await f.children[0].request("commands.register", [{ id: "work", title: "Work" }]);
  const command = f.runtime.getCommands()[0]; await f.runtime.loadFromPath(f.root);
  await assert.rejects(command.run(), { code: "PLUGIN_UNLOADED" });
  assert.equal(f.children[1].sent.some(message => message.method === "command.run"), false);
});

test("workspace resolution closing admission never spawns a backend", async t => {
  const entered = deferred(), release = deferred(); let spawns = 0;
  const f = fixture(t, { manifest: { execution: { main: "workspace" } }, host: {
    resolveWorkspaceExecution: async () => { entered.resolve(); await release.promise; return f.context; },
    spawnProcess: () => { spawns++; return childFixture(); },
  } });
  t.after(() => release.resolve()); await f.runtime.loadFromPath(f.root);
  const call = outcome(f.runtime.invokePanelBridge(f.id, "work"));
  await entered.promise; f.close(); release.resolve();
  assert.equal((await call).error?.code, "HOST_BUSY"); assert.equal(spawns, 0);
});

test("retired pending workspace creation remains counted and never initializes its late child", async t => {
  const entered = deferred(), release = deferred(), child = childFixture();
  const f = fixture(t, { manifest: { execution: { main: "workspace" } }, host: {
    resolveWorkspaceExecution: async () => f.context,
    spawnProcess: () => { entered.resolve(); return release.promise; },
  } });
  t.after(() => release.resolve(child)); await f.runtime.loadFromPath(f.root);
  const call = outcome(f.runtime.invokePanelBridge(f.id, "work")); await entered.promise;
  await f.runtime.unload(f.id);
  assert.ok(f.runtime.getHandoffActivity().operations > 0, "retired startup must remain counted");
  release.resolve(child);
  assert.equal((await call).error?.code, "PLUGIN_UNLOADED");
  assert.equal(child.sent.some(message => message.t === "init"), false);
  assert.equal(child.kills, 1);
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
});

function mcpFixture(t, onRequest = () => undefined, servers = ["one"]) {
  const requests = [];
  const f = fixture(t, { manifest: { permissions: ["mcp.server.remote"], net: { domains: ["mcp.example.test"] },
    contributes: { mcpServers: servers.map(id => ({ id, transport: "http", url: `https://mcp.example.test/${id}` })) } },
    host: { mcp: { fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body); requests.push({ url, ...request });
      await onRequest(request, f, init);
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        : request.method === "tools/list" ? { tools: [{ name: "work", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "done" }] };
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    } } } });
  return { ...f, requests };
}

test("closed admission prevents plugin MCP tool dispatch", async t => {
  const f = mcpFixture(t); await f.runtime.loadFromPath(f.root); f.close();
  await assert.rejects(f.runtime.getTools()[0].execute({}, { sessionId: "s" }), { code: "HOST_BUSY" });
  assert.equal(f.requests.some(request => request.method === "tools/call"), false);
});

test("cancelled MCP calls retain original HTTP work after unload", async t => {
  const entered = deferred(), release = deferred();
  const f = mcpFixture(t, async request => { if (request.method === "tools/call") { entered.resolve(); await release.promise; } });
  t.after(() => release.resolve()); await f.runtime.loadFromPath(f.root);
  const controller = new AbortController();
  const call = outcome(f.runtime.getTools()[0].execute({}, { sessionId: "s", signal: controller.signal }));
  await entered.promise; controller.abort(); assert.ok((await call).error);
  await f.runtime.unload(f.id);
  assert.ok(f.runtime.getHandoffActivity().operations > 0, "HTTP request outlives cancelled RPC");
  release.resolve(); await setImmediate();
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
});

test("unloaded MCP discovery cannot disappear while its HTTP request remains pending", async t => {
  const entered = deferred(), release = deferred();
  const f = mcpFixture(t, async request => { if (request.method === "tools/list") { entered.resolve(); await release.promise; } });
  t.after(() => release.resolve());
  const loading = outcome(f.runtime.loadFromPath(f.root)); await entered.promise;
  await f.runtime.unload(f.id); assert.ok((await loading).error);
  assert.ok(f.runtime.getHandoffActivity().operations > 0, "retired discovery still owns its HTTP request");
  release.resolve(); await setImmediate();
  assert.deepEqual(f.runtime.getTools(), []); assert.equal(f.runtime.getHandoffActivity().operations, 0);
});

test("closing admission during MCP discovery prevents the next server attempt", async t => {
  const f = mcpFixture(t, (request, owner) => { if (request.method === "tools/list") owner.close(); }, ["one", "two"]);
  await assert.rejects(f.runtime.loadFromPath(f.root), { code: "HOST_BUSY" });
  assert.equal(f.requests.some(request => request.url.endsWith("/two")), false);
  assert.deepEqual(f.runtime.getTools(), []);
});

test("an old workspace exit cannot remove a replacement's pending registration", async () => {
  const { WorkspacePluginInstances } = await import("../electron/main/workspace-plugin-instances.ts");
  const first = {}, second = {}, old = {}, fresh = {}, release = deferred(), closed = [];
  const instances = new WorkspacePluginInstances(async owner => owner === first ? old : release.promise,
    async instance => { closed.push(instance); });
  const context = { authority: { kind: "local" }, workspaceId: "w", generation: 1 };
  await instances.get(first, "p", context);
  const pending = outcome(instances.get(second, "p", context));
  instances.remove(old); release.resolve(fresh);
  assert.equal((await pending).value, fresh);
  assert.deepEqual(closed, []);
  await instances.disposeOwner(second); assert.deepEqual(closed, [fresh]);
});

for (const action of ["list", "save", "remove"]) test(`connection ${action} cannot borrow a reloaded plugin's grant`, async t => {
  const entered = deferred(), release = deferred(), records = new Map(); let block = false, writes = 0;
  const f = fixture(t, { manifest: { permissions: ["net.connection"] }, host: { connectionSecrets: {
    read: async key => { const value = records.get(key) ?? null; if (block) { entered.resolve(); await release.promise; } return value; },
    write: async (key, value) => { writes++; records.set(key, value); }, delete: async key => { records.delete(key); },
  } } });
  t.after(() => release.resolve()); await f.runtime.loadFromPath(f.root);
  const input = { pluginId: f.id, label: "Test", baseUrl: "https://connection.example.test", allowHttp: false,
    routes: [{ path: "/work", methods: ["POST"] }] };
  const record = await f.runtime.connections.save(input); const before = writes; block = true;
  const operation = outcome(action === "save" ? f.runtime.connections.save({ ...input, id: record.id })
    : action === "list" ? f.runtime.connections.list(f.id) : f.runtime.connections.remove(f.id, record.id));
  await entered.promise; await f.runtime.unload(f.id); await f.runtime.loadFromPath(f.root);
  release.resolve(); assert.equal((await operation).error?.code, "PLUGIN_UNLOADED"); assert.equal(writes, before);
});

test("managed connection work stays counted through cancellation and original response completion", async t => {
  const entered = deferred(), release = deferred(), records = new Map();
  const f = fixture(t, { manifest: { permissions: ["net.connection"] }, host: { connectionSecrets: {
    read: async key => records.get(key) ?? null, write: async (key, value) => { records.set(key, value); }, delete: async () => {},
  }, connectionTransport: async () => { entered.resolve(); await release.promise; return new Response("done"); } } });
  t.after(() => release.resolve()); await f.runtime.loadFromPath(f.root);
  const connection = await f.runtime.connections.save({ pluginId: f.id, label: "Test", baseUrl: "https://connection.example.test",
    allowHttp: false, routes: [{ path: "/work", methods: ["POST"] }] });
  const call = outcome(f.runtime.connections.request(f.id, { connectionId: connection.id, expectedRevision: connection.revision,
    requestId: "work", method: "POST", path: "/work" }));
  await entered.promise; await f.runtime.unload(f.id);
  assert.ok(f.runtime.getHandoffActivity().operations > 0, "original network work remains owned");
  release.resolve(); assert.equal((await call).error?.code, "ABORTED");
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
});

test("answered plugin errors do not add uncertainty, but a caller deadline does", async t => {
  const entered = deferred(); let pending;
  const f = fixture(t, { onCall: (message, child) => {
    if (message.method !== "panel.invoke") return false;
    if (message.payload.channel === "refuse") child.fail(message, "PERMISSION_DENIED");
    else { pending = message; entered.resolve(); }
    return true;
  } });
  await f.runtime.loadFromPath(f.root); const before = f.runtime.getHandoffActivity().uncontainedResources;
  await assert.rejects(f.runtime.invokePanelBridge(f.id, "refuse"), { code: "PERMISSION_DENIED" });
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, before);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timed = outcome(f.runtime.invokePanelBridge(f.id, "pending")); await entered.promise;
  t.mock.timers.tick(110000); assert.equal((await timed).error?.code, "TIMEOUT"); t.mock.timers.reset();
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, before + 1);
  f.children[0].reply(pending); await f.runtime.unload(f.id);
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, before + 1);
});

test("retired unfinished workspace startups retain the existing instance limit", async () => {
  const { WorkspacePluginInstances } = await import("../electron/main/workspace-plugin-instances.ts");
  const release = deferred(), owner = {};
  const instances = new WorkspacePluginInstances(async () => { await release.promise; return {}; }, async () => {});
  const context = { authority: { kind: "local" }, workspaceId: "w", generation: 1 };
  const pending = Array.from({ length: 64 }, (_, index) => outcome(instances.get(owner, `p${index}`, context)));
  await instances.disposeOwner(owner);
  const refused = outcome(instances.get(owner, "overflow", context));
  try { assert.equal((await refused).error?.code, "LIMIT_EXCEEDED"); }
  finally { release.resolve(); await Promise.all(pending); }
  const current = await instances.get(owner, "current", context); assert.equal(instances.has(current), true);
  await instances.disposeOwner(owner);
});

for (const retire of ["gate", "unload"]) test(`workspace context lookup retains its original owner after ${retire}`, async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { manifest: { execution: { main: "workspace" } }, host: {
    resolveWorkspaceExecution: async () => { entered.resolve(); await release.promise; return f.context; },
  } });
  t.after(() => release.resolve()); await f.runtime.loadFromPath(f.root);
  const lookup = outcome(f.runtime.captureWorkspaceContext(f.id, "s")); await entered.promise;
  if (retire === "gate") f.close(); else await f.runtime.unload(f.id);
  const counted = f.runtime.getHandoffActivity().operations > 0;
  release.resolve(); const result = await lookup;
  assert.equal(result.error?.code, retire === "gate" ? "HOST_BUSY" : "PLUGIN_UNLOADED");
  assert.equal(counted, true); assert.equal(f.runtime.getHandoffActivity().operations, 0);
});

test("closed admission prevents ordinary one-way plugin events", async t => {
  const f = fixture(t); await f.runtime.loadFromPath(f.root);
  f.runtime.broadcastEvent("session:activated", ["open"]);
  f.close(); f.runtime.broadcastEvent("session:activated", ["closed"]);
  assert.deepEqual(f.children[0].sent.filter(item => item.t === "event").map(item => item.args), [["open"]]);
});
