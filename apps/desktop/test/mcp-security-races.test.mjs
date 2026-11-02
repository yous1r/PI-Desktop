import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { McpSecurityService } from "../electron/main/mcp-security.ts";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";

const PROJECT = "remote-project:race";
const INPUT = { id: "memory-race", label: "Memory", transport: "http", url: "https://center.example/mcp", authType: "bearer", enabled: true,
  scope: { mode: "global", projects: [] }, memoryProjectBindings: { [PROJECT]: "alpha" } };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Native persistence and the MCP peer are the external seams; manager/runtime wiring is real.
async function setup(t) {
  let saved;
  let stored;
  let nextRead;
  const configs = [];
  const dispatched = [];
  let catalog = [{ name: "sc_memory_put" }];
  let peerError;
  const host = { async call(method, params = {}) {
    if (method === "mcp.list") return { servers: saved ? [saved] : [] };
    if (method === "mcp.upsert") {
      assert.equal(params.server.bearerToken, undefined);
      saved = { ...saved, ...params.server, credentialRef: saved?.credentialRef || `secret:mcp:bearer:${randomUUID()}` };
      return { server: saved };
    }
    if (method === "secrets.set") { stored = params.value; return { ok: true }; }
    if (method === "secrets.has") return { has: !!stored };
    if (method === "secrets.getForRuntime") {
      const captured = stored;
      const gate = nextRead; nextRead = undefined;
      if (gate) { gate.started.resolve(); await gate.release.promise; }
      return { value: captured };
    }
    throw new Error(`unexpected native RPC: ${method}`);
  }};
  let runtime;
  const security = new McpSecurityService({ getHost: () => host, invalidate: (id) => runtime?.invalidate(id, true) });
  runtime = new UserMcpRuntime({ security, createClient: (config) => {
    configs.push(config);
    let connected = false;
    const tools = catalog;
    return {
      connect: async () => { connected = true; return tools; },
      getTools: () => connected ? tools : [], isConnected: () => connected,
      close: () => { connected = false; }, ping: async () => {},
      callTool: async (name, args) => { dispatched.push({ name, args }); if (peerError) throw peerError; return { content: [] }; },
    };
  }});
  t.after(() => runtime.disposeAll());
  const first = (await security.upsert({ ...INPUT, bearerToken: "synthetic-old-token" })).server;
  runtime.setRecords([first]);
  return {
    runtime, security, configs, dispatched,
    blockRead() { const gate = { started: deferred(), release: deferred() }; nextRead = gate; return gate; },
    async rotate() { const record = (await security.upsert({ ...INPUT, bearerToken: "synthetic-new-token" })).server; runtime.setRecords([record]); return record; },
    setCatalog(tools) { catalog = tools; }, setPeerError(error) { peerError = error; },
  };
}

test("a delayed old credential read cannot start a client after token rotation", async (t) => {
  const f = await setup(t);
  const gate = f.blockRead();
  const stale = f.runtime.toolsForProject(PROJECT);
  await gate.started.promise;
  await f.rotate();
  assert.equal((await f.runtime.toolsForProject(PROJECT)).length, 1);
  gate.release.resolve();
  assert.deepEqual(await stale, []);
  assert.deepEqual(f.configs.map((config) => config.values.Authorization), ["Bearer synthetic-new-token"]);
  assert.equal(f.runtime.statusFor(INPUT.id).state, "ready");
});

test("an old failed secret read cannot invalidate a newer ready connection", async (t) => {
  const f = await setup(t);
  const gate = f.blockRead();
  const stale = f.runtime.toolsForProject(PROJECT);
  await gate.started.promise;
  await f.rotate();
  await f.runtime.toolsForProject(PROJECT);
  gate.release.reject(new Error("old host secret read failed"));
  assert.deepEqual(await stale, []);
  assert.equal(f.runtime.statusFor(INPUT.id).state, "ready");
  await f.runtime.callTool("mcp_memory_race_sc_memory_put", { content: "explicit new call" }, PROJECT);
  assert.equal(f.dispatched.length, 1);
});

test("disposal during a secret await cannot resurrect a connection or catalog", async (t) => {
  const f = await setup(t);
  const gate = f.blockRead();
  const pending = f.runtime.toolsForProject(PROJECT);
  await gate.started.promise;
  f.runtime.disposeAll();
  gate.release.resolve();
  assert.deepEqual(await pending, []);
  assert.equal(f.configs.length, 0);
  assert.equal(f.runtime.hasTool("mcp_memory_race_sc_memory_put"), false);
});

test("a project scoped away during a credential await cannot dispatch a write", async (t) => {
  const f = await setup(t);
  const [tool] = await f.runtime.toolsForProject(PROJECT);
  const gate = f.blockRead();
  const pending = f.runtime.callTool(tool.fullName, { content: "must not be sent" }, PROJECT);
  const denied = assert.rejects(pending, { errorCode: "TOOL_NOT_FOUND" });
  await gate.started.promise;
  f.runtime.setRecords(f.runtime.listRecords().map((record) => ({ ...record, scope: { mode: "projects", projects: ["remote-project:other"] } })));
  gate.release.resolve();
  await denied;
  assert.equal(f.dispatched.length, 0);
});

test("changing the repository binding during an await cancels old dispatch", async (t) => {
  const f = await setup(t);
  const [tool] = await f.runtime.toolsForProject(PROJECT);
  const gate = f.blockRead();
  const pending = f.runtime.callTool(tool.fullName, { content: "old context" }, PROJECT);
  const denied = assert.rejects(pending, { errorCode: "UNAVAILABLE" });
  await gate.started.promise;
  f.runtime.setRecords(f.runtime.listRecords().map((record) => ({ ...record, memoryProjectBindings: { [PROJECT]: "beta" } })));
  gate.release.resolve();
  await denied;
  assert.equal(f.dispatched.length, 0);
});

test("recovery never replays a mutation and retained names must pass fresh discovery", async (t) => {
  const f = await setup(t);
  const [tool] = await f.runtime.toolsForProject(PROJECT);
  f.setPeerError(new Error("response lost after mutation"));
  await assert.rejects(f.runtime.callTool(tool.fullName, { content: "one intended write" }, PROJECT), /response lost/);
  assert.equal(f.dispatched.length, 1);
  f.setCatalog([{ name: "sc_memory_status" }]);
  await f.rotate();
  assert.equal(f.dispatched.length, 1, "saving credentials does not execute or replay tools/call");
  await assert.rejects(f.runtime.callTool(tool.fullName, { content: "removed tool" }, PROJECT), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(f.dispatched.length, 1, "a routing hint is not permission to call a removed tool");
});


test("an obsolete authorization probe failure cannot discard a replacement connection", async (t) => {
  const started = deferred();
  const reply = deferred();
  let connections = 0;
  const runtime = new UserMcpRuntime({ createClient: () => {
    const oldProbe = connections++ === 0;
    let connected = false;
    const tools = [{ name: "sc_memory_projects" }, { name: "sc_memory_status" }];
    return {
      connect: async () => { connected = true; return tools; },
      isConnected: () => connected, getTools: () => connected ? tools : [],
      close: () => { connected = false; }, ping: async () => {},
      callTool: async () => {
        if (oldProbe) { started.resolve(); return reply.promise; }
        return { structuredContent: { projects: [{ id: "alpha" }], patterns: ["alpha"] } };
      },
    };
  }});
  t.after(() => runtime.disposeAll());
  const record = { ...INPUT, id: "superclaude-memory", authType: undefined };
  runtime.setRecords([record]);
  const stale = runtime.test(record.id);
  await started.promise;
  runtime.invalidate(record.id, true);
  runtime.setRecords([{ ...record, url: "https://replacement.example/mcp" }]);
  assert.equal((await runtime.test(record.id)).state, "ready");
  reply.reject(new Error("obsolete grant probe failed"));
  assert.equal((await stale).state, "ready");
  assert.equal(runtime.statusFor(record.id).state, "ready");
  assert.deepEqual(runtime.statusFor(record.id).authorizedProjects, ["alpha"]);
});
