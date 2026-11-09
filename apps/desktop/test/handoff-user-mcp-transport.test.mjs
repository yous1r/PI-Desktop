import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createServer } from "node:http";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const record = () => ({ id: "fixture", label: "Fixture", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true, scope: { mode: "global", projects: [] } });
const tools = [{ name: "lookup", inputSchema: { type: "object" } }];
function fixture(t) {
  const admission = new DesktopHandoffAdmission(), messages = [], configs = [], clients = [], streams = [];
  let handler = async message => {
    if (message.method === "initialize") return Response.json({ id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } });
    if (message.method === "tools/list") return Response.json({ id: message.id, result: { tools } });
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ id: message.id, result: {} });
  };
  const runtime = new UserMcpRuntime({ isAdmissionClosed: () => admission.isClosed(), connectTimeoutMs: 1000,
    createClient: config => {
      configs.push(config);
      const client = new McpServerClient({ ...config, fetchImpl: async (url, options) => {
        const message = JSON.parse(options.body); messages.push({ url, message, signal: options.signal }); return handler(message, url, options);
      } }); clients.push(client); return client;
    } });
  runtime.setRecords([record()]);
  t.after(async () => { runtime.disposeAll(); admission.dispose(); for (const stream of streams) stream.close(); await flush(); });
  return { runtime, admission, messages, configs, clients, handler: value => { handler = value; },
    body: (message, sse = false) => {
      let controller, closed = false;
      const stream = new ReadableStream({ start: value => { controller = value; } });
      const close = () => { if (!closed) { closed = true; controller.close(); } }; streams.push({ close });
      const text = JSON.stringify({ id: message.id, result: { content: [{ type: "text", text: "result" }] } });
      controller.enqueue(new TextEncoder().encode(sse ? `data: ${text}\n\n` : text));
      return { close, response: new Response(stream, { headers: { "content-type": sse ? "text/event-stream" : "application/json" } }) };
    } };
}
for (const sse of [false, true]) test(`user MCP retains original ${sse ? "SSE" : "JSON body"} after cancellation and cache removal`, async t => {
  const f = fixture(t); await f.runtime.toolsForProject(null); const entered = deferred(); let body;
  f.handler(async message => {
    if (message.method === "tools/call") { body = f.body(message, sse); entered.resolve(); return body.response; }
    return new Response(null, { status: 202 });
  });
  const work = f.runtime.callTool("mcp_fixture_lookup", {}, null, "session");
  const result = sse ? work : assert.rejects(work, { code: "TOOL_ABORTED" }); await entered.promise;
  if (sse) assert.deepEqual(await result, { content: [{ type: "text", text: "result" }] });
  else { f.runtime.cancelSessionCalls("session"); await result; }
  f.runtime.invalidate("fixture"); f.runtime.disposeAll(); await flush();
  assert.ok(f.runtime.getHandoffActivity().mcp > 0, "original reader remains pending after RPC/registry retirement");
  body.close(); await flush(); assert.deepEqual(f.runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
});
test("user MCP cancellation notification remains allowed and counted after admission closes", async t => {
  const f = fixture(t); await f.runtime.toolsForProject(null); const entered = deferred(), cancelled = deferred(); let body, notification;
  f.handler(async message => {
    if (message.method === "tools/call") { body = f.body(message); entered.resolve(); return body.response; }
    if (message.method === "notifications/cancelled") { notification = f.body(message); cancelled.resolve(); return notification.response; }
    return new Response(null, { status: 202 });
  });
  const work = f.runtime.callTool("mcp_fixture_lookup", {}, null, "session"); const rejected = assert.rejects(work, { code: "TOOL_ABORTED" });
  await entered.promise; f.admission.dispose(); f.runtime.cancelSessionCalls("session"); await rejected; await cancelled.promise;
  f.runtime.disposeAll(); await flush(); assert.equal(f.runtime.getHandoffActivity().mcp, 2);
  body.close(); notification.close(); await flush(); assert.equal(f.runtime.getHandoffActivity().mcp, 0);
});
for (const change of ["gate", "retire"]) test(`user MCP redirects recheck the original entry after ${change}`, async t => {
  const f = fixture(t); await f.runtime.toolsForProject(null); const entered = deferred(), response = deferred();
  f.handler(async (_message, url) => { if (String(url).endsWith("/other")) return Response.json({ id: 3, result: {} }); entered.resolve(); return response.promise; });
  const count = f.messages.length, work = f.runtime.callTool("mcp_fixture_lookup", {}, null, "session");
  const rejected = assert.rejects(work); await entered.promise;
  if (change === "gate") f.admission.dispose(); else f.runtime.invalidate("fixture");
  response.resolve(new Response(null, { status: 307, headers: { location: "/other" } })); await rejected; await flush();
  assert.equal(f.messages.length, count + 1, "no request reaches the redirected destination");
});
test("a retired original MCP client cannot reconnect or send through its replacement", async t => {
  const f = fixture(t); await f.runtime.toolsForProject(null); const old = f.clients[0]; f.runtime.invalidate("fixture");
  await f.runtime.toolsForProject(null); const count = f.messages.length;
  await assert.rejects(old.connect(), { errorCode: "UNAVAILABLE" }); assert.equal(f.messages.length, count);
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, 2);
});
test("factory retirement cannot publish a newly returned stale MCP client", async t => {
  let runtime, closed = 0, connected = 0;
  runtime = new UserMcpRuntime({ isAdmissionClosed: () => false, createClient: () => {
    runtime.setRecords([]);
    return { close() { closed++; }, connect: async () => { connected++; return tools; }, isConnected: () => true, getTools: () => tools };
  } }); t.after(() => runtime.disposeAll()); runtime.setRecords([record()]);
  await assert.rejects(runtime.toolsForProject(null), { errorCode: "UNAVAILABLE" });
  assert.equal(connected, 0); assert.equal(closed, 1); assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
});

test("real loopback MCP returns a tool result while retaining its original SSE reader", async t => {
  const admission = new DesktopHandoffAdmission(), ended = deferred(); let stream;
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (message.method === "tools/call") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: message.id, result: { content: [{ type: "text", text: "loopback-result" }] } })}\n\n`);
      stream = response; response.once("close", ended.resolve); return;
    }
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: message.id, result: message.method === "tools/list" ? { tools } : { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const runtime = new UserMcpRuntime({ isAdmissionClosed: () => admission.isClosed(), createClient: config => new McpServerClient(config) });
  t.after(async () => {
    runtime.disposeAll(); admission.dispose(); stream?.end(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await flush();
  });
  runtime.setRecords([{ ...record(), url: `http://127.0.0.1:${server.address().port}/mcp` }]);
  assert.equal((await runtime.toolsForProject(null))[0].fullName, "mcp_fixture_lookup");
  assert.deepEqual(await runtime.callTool("mcp_fixture_lookup", {}, null, "session"), { content: [{ type: "text", text: "loopback-result" }] });
  assert.equal(runtime.getHandoffActivity().mcp, 2, "cached client plus unfinished original SSE send");
  runtime.invalidate("fixture"); assert.ok(runtime.getHandoffActivity().mcp > 0);
  await ended.promise; await flush(); assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
  t.diagnostic(JSON.stringify({ kind: "user-mcp-transport-path", resultBeforeStreamEnd: true, originalResponseClosed: true,
    activity: runtime.getHandoffActivity(), nativeFamilyQualified: false }));
});
