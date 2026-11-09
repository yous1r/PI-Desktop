import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { McpOAuthManager, secretRefForMcpOAuth } = await import("../electron/main/mcp-oauth.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { registerMcpIpc } = await import("../electron/main/ipc/mcp-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();

test("real OAuth IPC login, MCP re-test and cancelled token stream retain original ownership", { timeout: 10000 }, async t => {
  const admission = new DesktopHandoffAdmission(), secrets = new Map(), handlers = new Map(), listeners = [], listenerClosures = [];
  const events = [], requests = [], completed = deferred(), tokenEntered = deferred(), tokenClosed = deferred();
  let opened = deferred(), slow = false, tokenResponse, origin, runtime, manager;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin); requests.push(url.pathname);
      let body = ""; for await (const chunk of request) body += chunk;
      const json = (data, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer fixture-access") {
          response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/metadata"`);
          json({ error: "unauthorized" }, 401); return;
        }
        const message = JSON.parse(body);
        if (message.id === undefined) { response.writeHead(202); response.end(); return; }
        const result = message.method === "tools/list" ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } :
          message.method === "tools/call" ? { content: [{ type: "text", text: "authorized-result" }] } :
          { protocolVersion: "2025-03-26", capabilities: { tools: {} } };
        json({ jsonrpc: "2.0", id: message.id, result });
      } else if (url.pathname === "/metadata") json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
      else if (url.pathname === "/.well-known/oauth-authorization-server") json({ authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
      else if (url.pathname === "/register") json({ client_id: "fixture-client" }, 201);
      else if (url.pathname === "/token") {
        if (!slow) json({ access_token: "fixture-access", token_type: "Bearer" });
        else {
          tokenResponse = response; response.once("close", tokenClosed.resolve);
          response.writeHead(200, { "content-type": "application/json" }); response.write('{"access_token":'); tokenEntered.resolve();
        }
      } else { response.writeHead(404); response.end(); }
    } catch (error) { completed.reject(error); response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const record = { id: "fixture", label: "Fixture", transport: "http", url: `${origin}/mcp`, enabled: true };
  const host = { generation: "fixture-generation", isAvailable: true, async call(method, params) {
    if (method === "mcp.list") return { servers: [record] };
    if (method === "secrets.getForRuntime") return { value: secrets.get(params.secretRef) ?? null };
    if (method === "secrets.set") { secrets.set(params.secretRef, params.value); return { ok: true }; }
    if (method === "secrets.has") return { has: secrets.has(params.secretRef) };
    throw new Error(`Unexpected host method ${method}`);
  } };
  manager = new McpOAuthManager({ isAdmissionClosed: () => admission.isClosed(),
    captureOwner: () => ({ call: host.call.bind(host), assertCurrent() { assert.equal(host.isAvailable, true); } }),
    createServer: callback => {
      const listener = createServer(callback), closed = deferred(); listeners.push(listener); listenerClosures.push(closed.promise);
      listener.once("close", closed.resolve); return listener;
    },
    openExternal: async url => { opened.resolve(url); },
    emit: event => { events.push(event); if (event.kind === "done") completed.resolve(event); if (event.kind === "error") completed.reject(new Error(event.message)); },
    onAuthorized: (id, original, assertCurrent) => runtime.testAuthorized(id, original, assertCurrent),
  });
  runtime = new UserMcpRuntime({ isAdmissionClosed: () => admission.isClosed(), oauth: manager, createClient: config => new McpServerClient(config) });
  runtime.setRecords([record]);
  t.after(async () => {
    manager.disposeAll(); runtime.disposeAll(); admission.dispose(); tokenResponse?.end(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await Promise.all(listenerClosures);
  });
  registerMcpIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, payload => admission.invoke(channel, () => handler(payload))) },
    getHost: () => host, userMcp: runtime, oauth: manager, currentWorkspacePath: () => null,
    refreshUserMcp: async () => [record], describeError: String, sendToRenderer() {}, searchMcpMarket: async () => ({}),
  });
  const inspect = async () => {
    const oauth = manager.getHandoffActivity(), mcp = runtime.getHandoffActivity();
    return { clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0,
      admissions: admission.inFlightCount(), finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
      approvals: 0, inputs: 0, nativeSessions: 0, mcp: mcp.mcp + oauth.operations + oauth.resources,
      uncontainedResources: mcp.uncontainedResources + oauth.uncontainedResources };
  };
  const hold = await admission.gate.acquireHandoff(randomUUID(), inspect);
  await assert.rejects(handlers.get(IPC.invoke.mcpOauthStart)({ id: record.id }), { errorCode: "HOST_BUSY" });
  assert.equal(requests.length, 0); hold.cancel();
  await handlers.get(IPC.invoke.mcpOauthStart)({ id: record.id });
  const authorization = new URL(await opened.promise);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256"); assert.equal(authorization.searchParams.get("scope"), "read");
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", authorization.searchParams.get("state"));
  const response = await fetch(callback); assert.equal(response.status, 200); assert.match(await response.text(), /Authorization successful/);
  assert.equal((await completed.promise).status.state, "ready");
  assert.deepEqual(await runtime.callTool("mcp_fixture_lookup", {}, null, "fixture-session"), { content: [{ type: "text", text: "authorized-result" }] });
  await Promise.all(listenerClosures); await flush(); assert.equal(manager.getHandoffActivity().operations, 0);
  const stored = secrets.get(secretRefForMcpOAuth(record.id));
  slow = true; opened = deferred();
  const login = await handlers.get(IPC.invoke.mcpOauthStart)({ id: record.id });
  const nextAuth = new URL(await opened.promise), nextCallback = new URL(nextAuth.searchParams.get("redirect_uri"));
  nextCallback.searchParams.set("code", "cancelled-code"); nextCallback.searchParams.set("state", nextAuth.searchParams.get("state"));
  const cancelledResponse = fetch(nextCallback).then(async result => { await result.text(); }, () => {});
  await tokenEntered.promise; assert.ok(manager.getHandoffActivity().operations > 0);
  assert.deepEqual(await handlers.get(IPC.invoke.mcpOauthCancel)({ loginId: login.loginId }), { ok: true });
  await Promise.all([cancelledResponse, tokenClosed.promise, ...listenerClosures]); await flush();
  assert.equal(secrets.get(secretRefForMcpOAuth(record.id)), stored); assert.equal(events.filter(e => e.kind === "done").length, 1);
  runtime.disposeAll(); await flush();
  const final = manager.getHandoffActivity(); assert.equal(final.operations, 0); assert.equal(final.resources, 0); assert.ok(final.uncontainedResources > 0);
  assert.equal(runtime.getHandoffActivity().mcp, 0);
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
  t.diagnostic(JSON.stringify({ kind: "oauth-user-path", listenerCount: listeners.length, originalListenersClosed: true,
    cancelledTokenResponseClosed: true, successfulTools: 1, activity: final, nativeFamilyQualified: false }));
});
