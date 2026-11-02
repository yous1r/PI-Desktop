import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { McpSecurityService, mcpCredentialEndpoint } from "../electron/main/mcp-security.ts";
import { boundMemoryArguments, centralProjectForSession } from "../electron/main/mcp-memory-bindings.ts";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";
import { createServer } from "node:http";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";

// Only the native RPC boundary is a fixture. Security and MCP runtime are real modules.
function fixture() {
  const records = new Map(); const secrets = new Map(); const registryCalls = []; const invalidated = [];
  const host = { async call(method, params = {}) {
    if (method === "mcp.list") return { servers: [...records.values()] };
    if (method === "mcp.upsert") {
      assert.equal(params.server.bearerToken, undefined);
      registryCalls.push(params.server);
      const old = records.get(params.server.id);
      const server = { ...old, ...params.server, enabled: params.server.enabled ?? true, level: params.server.level ?? "global" };
      if (server.authType === "bearer") server.credentialRef = old?.credentialRef ?? `secret:mcp:bearer:${randomUUID()}`;
      else delete server.credentialRef;
      records.set(server.id, server); return { server };
    }
    if (method === "secrets.set") { secrets.set(params.secretRef, params.value); return { ok: true }; }
    if (method === "secrets.has") return { has: secrets.has(params.secretRef) };
    if (method === "secrets.getForRuntime") return { value: secrets.get(params.secretRef) ?? null };
    if (method === "secrets.delete") { secrets.delete(params.secretRef); return { ok: true }; }
    if (method === "mcp.remove") return { ok: records.delete(params.id) };
    if (method === "mcp.transfer") { const old = records.get(params.id); records.delete(params.id); const server = { ...old, id: "moved-memory", level: params.to.level }; records.set(server.id, server); return { server }; }
    throw new Error(`unsupported fixture RPC ${method}`);
  }};
  const security = new McpSecurityService({ getHost: () => host, invalidate: (id) => invalidated.push(id) });
  return { host, security, records, secrets, registryCalls, invalidated };
}
const input = (url = "https://center.example/mcp") => ({ id: "superclaude-memory", label: "Memory center", transport: "http", url,
  authType: "bearer", bearerToken: "synthetic-authorized-token", memoryProjectBindings: { "remote-project:demo": "pi-desktop" } });

test("native save/reopen/retain/rotate/clear keeps raw tokens out of registry records", async () => {
  const f = fixture();
  const saved = await f.security.upsert(input());
  assert.equal(saved.server.hasBearerToken, true);
  assert.equal(saved.server.bearerToken, undefined);
  assert.equal(await f.security.getBearerToken(saved.server), "synthetic-authorized-token");
  assert.doesNotMatch(JSON.stringify(f.registryCalls), /synthetic-authorized-token/);
  const { bearerToken, ...preserve } = input();
  assert.equal((await f.security.upsert(preserve)).server.credentialRef, saved.server.credentialRef);
  const rotated = await f.security.upsert({ ...preserve, bearerToken: "synthetic-rotated-token" });
  assert.equal(await f.security.getBearerToken(rotated.server), "synthetic-rotated-token");
  const restarted = new McpSecurityService({ getHost: () => f.host, invalidate() {} });
  assert.equal((await restarted.describe([rotated.server]))[0].hasBearerToken, true);
  assert.equal(await restarted.getBearerToken(rotated.server), "synthetic-rotated-token");
  const cleared = await f.security.upsert({ ...preserve, bearerToken: null });
  assert.equal(cleared.server.hasBearerToken, false);
  await assert.rejects(f.security.getBearerToken(cleared.server), { errorCode: "MCP_AUTH_REQUIRED" });
});

test("endpoint edits and untrusted stored references fail closed before spending a token", async () => {
  const f = fixture(); const saved = (await f.security.upsert(input())).server;
  const { bearerToken, ...preserve } = input("https://different.example/mcp");
  await assert.rejects(f.security.upsert(preserve), { errorCode: "MCP_AUTH_TARGET_CHANGED" });
  assert.equal(f.registryCalls.length, 1);
  await assert.rejects(f.security.getBearerToken({ ...saved, url: preserve.url }), { errorCode: "MCP_AUTH_TARGET_CHANGED" });
  await assert.rejects(f.security.getBearerToken({ ...saved, credentialRef: "secret:provider:other:api_key" }), { errorCode: "MCP_AUTH_REQUIRED" });
  for (const url of ["http://remote.example/mcp", "https://u:p@center.example/mcp", "https://center.example/mcp?secret=bad", "https://center.example/mcp#x"]) assert.throws(() => mcpCredentialEndpoint(url));
  await assert.rejects(f.security.upsert({ ...input(), caCertificate: "-----BEGIN PRIVATE KEY-----" }), { errorCode: "MCP_CA_INVALID" });
  await assert.rejects(f.security.upsert({ ...input(), headers: { authorization: "Bearer unsafe" } }), { errorCode: "MCP_AUTH_INVALID" });
});

test("explicit move preserves its credential and removal deletes it", async () => {
  const f = fixture(); const saved = (await f.security.upsert(input())).server;
  const moved = (await f.security.transfer({ id: saved.id, from: { level: "global" }, to: { level: "project", projectPath: "/repo" } })).server;
  assert.equal(moved.credentialRef, saved.credentialRef);
  assert.equal(await f.security.getBearerToken(moved), "synthetic-authorized-token");
  await f.security.remove({ id: moved.id, level: "project", projectPath: "/repo" });
  assert.equal(f.secrets.size, 0);
});

test("bindings use exact logical identity and refuse a conflicting requested repository", () => {
  const record = { memoryProjectBindings: { "remote-project:demo": "pi-desktop", "C:/repo": "local-project" } };
  assert.equal(centralProjectForSession(record, "remote-project:demo"), "pi-desktop");
  assert.equal(centralProjectForSession(record, "remote-project:other"), undefined);
  assert.equal(centralProjectForSession(record, "c:\\REPO"), "local-project");
  assert.deepEqual(boundMemoryArguments(record, "sc_memory_status", {}, "remote-project:demo"), { project: "pi-desktop" });
  assert.throws(() => boundMemoryArguments(record, "sc_memory_put", { project: "wrong" }, "remote-project:demo"), { errorCode: "MCP_PROJECT_BINDING_MISMATCH" });
  assert.deepEqual(boundMemoryArguments(record, "sc_memory_search", { query: "entry" }, "remote-project:demo"), { query: "entry", projects: ["pi-desktop"] });
});

test("remote project user path calls HTTP on Desktop, rotates and clears without a remote CLI", async (t) => {
  let acceptedToken = "synthetic-authorized-token"; const calls = []; const headers = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body); headers.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${acceptedToken}`) { response.writeHead(401).end(); return; }
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (rpc.method === "tools/list") result = { tools: [{ name: "sc_memory_status", description: "status", inputSchema: { type: "object", properties: {} } }] };
    else if (rpc.method === "tools/call") { calls.push(rpc.params.arguments); result = { content: [{ type: "text", text: JSON.stringify({ project: rpc.params.arguments.project, echoedCredential: acceptedToken }) }] }; }
    else result = {};
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const f = fixture(); let runtime;
  const security = new McpSecurityService({ getHost: () => f.host, invalidate: (id) => runtime?.invalidate(id, true) });
  runtime = new UserMcpRuntime({ security, createClient: (config) => new McpServerClient(config) });
  t.after(() => runtime.disposeAll());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const saved = await security.upsert(input(url)); runtime.setRecords([saved.server]);
  const tools = await runtime.toolsForProject("remote-project:demo");
  assert.equal(tools.length, 1); assert.match(tools[0].description, /pi-desktop/);
  const result = await runtime.callTool(tools[0].fullName, {}, "remote-project:demo", "session-fixture");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-authorized-token/);
  assert.match(JSON.stringify(result), /redacted/);
  assert.deepEqual(calls, [{ project: "pi-desktop" }]);
  const changed = await security.upsert({ ...input(url), bearerToken: "synthetic-rotated-token" });
  acceptedToken = "synthetic-rotated-token"; runtime.setRecords([changed.server]);
  await runtime.callTool(tools[0].fullName, {}, "remote-project:demo");
  assert.equal(headers.at(-1), `Bearer ${acceptedToken}`);
  const cleared = await security.upsert({ ...input(url), bearerToken: null }); runtime.setRecords([cleared.server]);
  const before = headers.length;
  assert.equal((await runtime.toolsForProject("remote-project:demo")).length, 0);
  assert.equal(runtime.statusFor(saved.server.id).errorCode, "MCP_AUTH_REQUIRED");
  assert.equal(headers.length, before, "missing credentials never send a request");
});
