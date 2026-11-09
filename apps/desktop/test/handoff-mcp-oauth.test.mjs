import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { McpOAuthManager, secretRefForMcpOAuth } from "../electron/main/mcp-oauth.ts";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";
import { registerMcpIpc } from "../electron/main/ipc/mcp-ipc.ts";
import { IPC } from "@pi-desktop/shared";

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
const refused = error => ["HOST_BUSY", "HOST_UNAVAILABLE", "OAUTH_RETIRED"].includes(error?.code ?? error?.errorCode);
const token = { clientId: "fixture-client", tokenEndpoint: "https://oauth.test/token", accessToken: "fixture-old", refreshToken: "fixture-refresh", expiresAt: 1 };
function fixture(t, overrides = {}) {
  const events = [], calls = [], requests = [], servers = [], opens = [], errors = [];
  const opened = deferred(), fetched = deferred();
  const state = { closed: false, owner: { generation: "one" } };
  const secrets = new Map();
  const hostCall = async (owner, method, params) => {
    calls.push({ owner, method, params });
    if (overrides.call) { const result = await overrides.call(method, params, owner); if (result !== undefined) return result; }
    if (method === "secrets.getForRuntime") return { value: secrets.get(params.secretRef) ?? null };
    if (method === "secrets.has") return { has: secrets.has(params.secretRef) };
    if (method === "secrets.set") { secrets.set(params.secretRef, params.value); return { ok: true }; }
    if (method === "secrets.delete") { secrets.delete(params.secretRef); return { ok: true }; }
    throw new Error(`Unexpected method ${method}`);
  };
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, init });
    fetched.resolve();
    if (overrides.fetch) { const result = await overrides.fetch(pathname, init); if (result !== undefined) return result; }
    const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    if (pathname === "/mcp") return new Response(null, { status: 401 });
    if (pathname.includes("oauth-protected-resource")) return json({ resource: "https://oauth.test/mcp", authorization_servers: ["https://oauth.test"] });
    if (pathname.includes("oauth-authorization-server")) return json({ authorization_endpoint: "https://oauth.test/authorize", token_endpoint: "https://oauth.test/token", registration_endpoint: "https://oauth.test/register" });
    if (pathname === "/register") return json({ client_id: "fixture-client" });
    if (pathname === "/token") return json({ access_token: "fixture-new", refresh_token: "fixture-rotated", expires_in: 3600 });
    throw new Error(`Unexpected path ${pathname}`);
  };
  const createServer = callback => {
    const server = new EventEmitter();
    Object.assign(server, {
      callback, listening: false, listenCount: 0, closeCount: 0,
      address: () => ({ port: 54321, family: "IPv4", address: "127.0.0.1" }),
      listen(_port, _host, done) {
        server.listenCount++;
        const complete = () => { server.listening = true; done(); };
        if (overrides.listen) overrides.listen(complete); else queueMicrotask(complete);
        return server;
      },
      close(done) { server.closeCount++; server.listening = false; if (overrides.close) overrides.close(done); else done?.(); return server; },
      closeAllConnections() {},
    });
    servers.push(server);
    return server;
  };
  const deps = {
    isAdmissionClosed: () => state.closed,
    captureOwner() {
      const owner = state.owner, generation = owner.generation;
      return { assertCurrent() { if (state.owner !== owner || owner.generation !== generation) throw Object.assign(new Error("Host changed"), { code: "HOST_UNAVAILABLE" }); },
        call: (method, params) => hostCall(owner, method, params) };
    },
    // The original implementation uses this mutable callback. New code must capture an owner instead.
    call: (method, params) => hostCall(state.owner, method, params), fetchImpl, createServer,
    openExternal: async url => { opens.push(url); opened.resolve(url); await overrides.open?.(); },
    emit: event => { events.push(event); overrides.emit?.(event); },
    log: (level, message) => { if (level === "error") errors.push(message); },
    onAuthorized: overrides.onAuthorized,
  };
  const manager = new McpOAuthManager(deps);
  t.after(() => manager.disposeAll());
  const callback = async () => {
    const url = new URL(await opened.promise);
    const req = new EventEmitter(); req.url = `/callback?code=fixture-code&state=${url.searchParams.get("state")}`;
    const res = new EventEmitter();
    Object.assign(res, { headersSent: false, destroyed: false, writableEnded: false,
      writeHead(status) { res.status = status; res.headersSent = true; },
      end(body) { res.body = body; res.writableEnded = true; res.emit("finish"); },
      destroy() { res.destroyed = true; res.emit("close"); },
    });
    await servers.at(-1).callback(req, res);
    await turn();
    return res;
  };
  return { manager, state, calls, requests, servers, opens, opened, fetched, events, errors, secrets, callback };
}

for (const [name, invoke] of [
  ["login", m => m.start("s", "https://oauth.test/mcp")],
  ["discovery", m => m.discoverMetadata("https://oauth.test/mcp")],
  ["registration", m => m.registerClient("https://oauth.test/register", "http://127.0.0.1/callback")],
  ["status", m => m.hasOAuth("s")], ["refresh", m => m.getValidAccessToken("s")],
  ["delete", m => m.deleteOAuth("s")], ["transfer", m => m.transferOAuth("s", "new")],
]) test(`OAuth refuses ${name} before side effects while admission is closed`, async t => {
  const f = fixture(t); f.state.closed = true;
  await assert.rejects(invoke(f.manager), refused);
  assert.equal(f.calls.length + f.requests.length + f.servers.length + f.opens.length, 0);
});

test("OAuth disposal permanently seals future work", async t => {
  const f = fixture(t); f.manager.disposeAll();
  await assert.rejects(f.manager.hasOAuth("s"), refused);
  assert.equal(f.calls.length, 0);
});

test("OAuth consumed callback still rejects token exchange failure and closes listener", async t => {
  const f = fixture(t, { fetch: async path => { if (path === "/token") throw new Error("fixture exchange failed"); } });
  const outcomes = []; void f.manager.startLogin("s", "https://oauth.test/mcp").then(value => outcomes.push(value), error => outcomes.push(error));
  await f.callback();
  assert.equal(outcomes.length, 1, "original token waiter must settle");
  assert.match(outcomes[0].message, /fixture exchange failed/);
  assert.equal(f.events.at(-1).kind, "error"); assert.equal(f.servers[0].closeCount, 1);
});

test("OAuth cancellation retains original token body and prevents late secret write", async t => {
  const body = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => { if (path === "/token") return { ok: true, json: () => { entered.resolve(); return body.promise; } }; } });
  await f.manager.start("s", "https://oauth.test/mcp"); const pending = f.callback(); await entered.promise;
  f.manager.cancel("s"); assert.ok(f.manager.getHandoffActivity().operations > 0);
  body.resolve({ access_token: "fixture-late" }); await pending;
  assert.equal(f.calls.filter(c => c.method === "secrets.set").length, 0);
  assert.equal(f.events.filter(e => e.kind === "done").length, 0);
  assert.equal(f.manager.getHandoffActivity().operations, 0);
});

test("OAuth Host replacement rejects late refresh without borrowing the replacement", async t => {
  const body = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => { if (path === "/token") { entered.resolve(); return body.promise; } } });
  f.secrets.set(secretRefForMcpOAuth("s"), JSON.stringify(token));
  const old = f.state.owner; const pending = f.manager.getValidAccessToken("s"); const rejected = assert.rejects(pending, refused);
  await entered.promise; f.state.owner = { generation: "two" };
  body.resolve(new Response(JSON.stringify({ access_token: "fixture-late" }))); await rejected;
  assert.ok(f.calls.every(c => c.owner === old)); assert.equal(f.calls.filter(c => c.method === "secrets.set").length, 0);
});

test("OAuth deletion waits for original refresh and cannot be resurrected by its late result", async t => {
  const body = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => { if (path === "/token") { entered.resolve(); return body.promise; } } });
  f.secrets.set(secretRefForMcpOAuth("s"), JSON.stringify(token));
  const refresh = f.manager.getValidAccessToken("s"); void refresh.catch(() => {}); await entered.promise;
  const deletion = f.manager.deleteOAuth("s"); body.resolve(new Response(JSON.stringify({ access_token: "fixture-late" })));
  await Promise.allSettled([refresh, deletion]);
  assert.equal(f.secrets.has(secretRefForMcpOAuth("s")), false);
});

test("OAuth transfer captures original Host before reading the secret", async t => {
  const read = deferred(), entered = deferred();
  const f = fixture(t, { call: async method => { if (method === "secrets.getForRuntime") { entered.resolve(); return read.promise; } } });
  const pending = f.manager.transferOAuth("s", "new"); const rejected = assert.rejects(pending, refused);
  await entered.promise; f.state.owner.generation = "two"; read.resolve({ value: JSON.stringify(token) }); await rejected;
  assert.equal(f.calls.filter(c => c.method !== "secrets.getForRuntime").length, 0);
});

test("OAuth cancelled stored-token lookup cannot bind listener or open browser later", async t => {
  const read = deferred(), entered = deferred();
  const f = fixture(t, { call: async method => { if (method === "secrets.getForRuntime") { entered.resolve(); return read.promise; } } });
  await f.manager.start("s", "https://oauth.test/mcp"); await entered.promise;
  f.manager.cancel("s"); read.resolve({ value: null }); await turn();
  assert.equal(f.servers.reduce((sum, server) => sum + server.listenCount, 0), 0); assert.equal(f.opens.length, 0);
});

test("OAuth cancelled browser launch retains original completion and suppresses late URL publication", async t => {
  const launch = deferred(); const f = fixture(t, { open: () => launch.promise });
  await f.manager.start("s", "https://oauth.test/mcp"); await f.opened.promise; f.manager.cancel("s");
  launch.resolve(); await turn(); assert.equal(f.events.filter(e => e.kind === "authUrl").length, 0);
});

test("OAuth listener cleanup remains visible until original close callback", async t => {
  let closed; const f = fixture(t, { close: done => { closed = done; } });
  await f.manager.start("s", "https://oauth.test/mcp"); await f.opened.promise; f.manager.cancel("s"); await turn();
  assert.ok(f.manager.getHandoffActivity().resources > 0); assert.ok(f.manager.getHandoffActivity().operations > 0);
  closed(); await turn(); const final = f.manager.getHandoffActivity();
  assert.equal(final.resources, 0); assert.equal(final.operations, 0); assert.ok(final.uncontainedResources > 0);
});

test("OAuth observer failure cannot skip cancellation or cleanup", async t => {
  const f = fixture(t, { emit: event => { if (event.kind === "cancelled") throw new Error("fixture observer failed"); } });
  await f.manager.start("s", "https://oauth.test/mcp"); await f.opened.promise;
  assert.doesNotThrow(() => f.manager.cancel("s")); await turn();
  assert.equal(f.servers[0].closeCount, 1); assert.ok(f.errors.length > 0);
});

test("OAuth original secret write remains owned after cancellation without rollback", async t => {
  const write = deferred(), entered = deferred();
  const f = fixture(t, { call: async (method, params) => { if (method === "secrets.set") { entered.resolve(params); await write.promise; } } });
  await f.manager.start("s", "https://oauth.test/mcp"); const callback = f.callback(); await entered.promise;
  f.manager.cancel("s"); assert.ok(f.manager.getHandoffActivity().operations > 0);
  write.resolve(); await callback;
  assert.ok(f.secrets.has(secretRefForMcpOAuth("s"))); assert.equal(f.events.filter(e => e.kind === "done").length, 0);
  assert.equal(f.calls.filter(c => c.method === "secrets.delete").length, 0);
});

test("OAuth cancelled pending bind closes the late original listener without opening a browser", async t => {
  const listening = deferred(); let bind;
  const f = fixture(t, { listen: done => { bind = done; listening.resolve(); } });
  await f.manager.start("s", "https://oauth.test/mcp"); await listening.promise;
  f.manager.cancel("s"); await turn(); assert.ok(f.manager.getHandoffActivity().operations > 0);
  bind(); await turn(); assert.equal(f.servers[0].closeCount, 1); assert.equal(f.opens.length, 0);
  assert.equal(f.manager.getHandoffActivity().resources, 0);
});

test("OAuth queued refresh retains its captured generation while the previous call settles", async t => {
  const read = deferred(), entered = deferred();
  const f = fixture(t, { call: async method => { if (method === "secrets.getForRuntime") { entered.resolve(); return read.promise; } } });
  const first = f.manager.getValidAccessToken("s"), second = f.manager.getValidAccessToken("s");
  const checks = [assert.rejects(first, refused), assert.rejects(second, refused)];
  await entered.promise; f.state.owner.generation = "two"; read.resolve({ value: null }); await Promise.all(checks);
  assert.equal(f.calls.length, 1); assert.equal(f.manager.getHandoffActivity().operations, 0);
});

test("OAuth discovery retains discarded probe-body cleanup after disposal without fallback", async t => {
  const cleanup = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => path === "/mcp" ? new Response(new ReadableStream({ cancel() { entered.resolve(); return cleanup.promise; } }), { status: 401 }) : undefined });
  const pending = f.manager.discoverMetadata("https://oauth.test/mcp"); const rejected = assert.rejects(pending, refused);
  await entered.promise; f.manager.disposeAll(); assert.ok(f.manager.getHandoffActivity().operations > 0);
  cleanup.resolve(); await rejected; assert.equal(f.requests.length, 1); assert.equal(f.manager.getHandoffActivity().operations, 0);
});

test("OAuth DCR refusal after admission closure cannot trigger exact-redirect fallback", async t => {
  const registration = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => { if (path === "/register") { entered.resolve(); return registration.promise; } } });
  await f.manager.start("s", "https://oauth.test/mcp"); await entered.promise; f.state.closed = true;
  registration.resolve(new Response(null, { status: 400 })); await turn();
  assert.equal(f.requests.filter(r => r.pathname === "/register").length, 1); assert.equal(f.opens.length, 0);
});

test("OAuth token storage failure settles the consumed callback and retains unknown completion", async t => {
  const f = fixture(t, { call: async method => { if (method === "secrets.set") throw Object.assign(new Error("fixture timeout"), { code: "HOST_TIMEOUT" }); } });
  const pending = f.manager.startLogin("s", "https://oauth.test/mcp"), rejected = assert.rejects(pending, /fixture timeout/);
  const response = await f.callback(); await rejected; assert.equal(response.status, 500);
  assert.equal(f.manager.getHandoffActivity().operations, 0); assert.ok(f.manager.getHandoffActivity().uncontainedResources > 0);
});

test("OAuth authorization hook remains owned after cancellation and cannot publish done", async t => {
  const hook = deferred(), entered = deferred();
  const f = fixture(t, { onAuthorized: async (_id, _record, assertCurrent) => { entered.resolve(); await hook.promise; assertCurrent(); } });
  await f.manager.start("s", "https://oauth.test/mcp"); const callback = f.callback(); await entered.promise;
  f.manager.cancel("s"); assert.ok(f.manager.getHandoffActivity().operations > 0);
  hook.resolve(); await callback; assert.equal(f.events.filter(e => e.kind === "done").length, 0);
});

test("OAuth timeout after consuming a callback settles the original waiter and retains its body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const body = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => { if (path === "/token") return { ok: true, json: () => { entered.resolve(); return body.promise; } }; } });
  const pending = f.manager.startLogin("s", "https://oauth.test/mcp"), rejected = assert.rejects(pending, /timed out/);
  const callback = f.callback(); await entered.promise; t.mock.timers.tick(300000); await rejected;
  assert.ok(f.manager.getHandoffActivity().operations > 0); body.resolve({ access_token: "fixture-late" }); await callback;
  assert.equal(f.secrets.size, 0);
});

for (const replacement of [false, true]) test(`OAuth temporary MCP test cleans only its original record (replacement=${replacement})`, async t => {
  const connected = deferred(), entered = deferred(); let retired = false;
  const runtime = new UserMcpRuntime({ isAdmissionClosed: () => false, createClient: () => ({
    connect: () => { entered.resolve(); return connected.promise; }, close() {}, isConnected: () => true,
    getTools: () => [], ping: async () => {}, callTool: async () => ({}),
  }) }); t.after(() => runtime.disposeAll());
  const record = { id: "s", transport: "http", url: "https://oauth.test/mcp", enabled: true };
  const pending = runtime.testAuthorized("s", record, () => { if (retired) throw Object.assign(new Error("retired"), { code: "OAUTH_RETIRED" }); });
  const rejected = assert.rejects(pending, refused); await entered.promise;
  if (replacement) runtime.setRecords([{ ...record, url: "https://replacement.test/mcp" }]); else retired = true;
  connected.resolve([]); await rejected;
  assert.deepEqual(runtime.listRecords(), replacement ? [{ ...record, url: "https://replacement.test/mcp" }] : []);
});

test("OAuth configuration changes retire an outstanding login before token storage", async t => {
  const body = deferred(), entered = deferred();
  const f = fixture(t, { fetch: async path => { if (path === "/token") return { ok: true, json: () => { entered.resolve(); return body.promise; } }; } });
  const runtime = new UserMcpRuntime({ isAdmissionClosed: () => false, oauth: f.manager, createClient: () => { throw new Error("no client expected"); } });
  t.after(() => runtime.disposeAll());
  runtime.setRecords([{ id: "s", transport: "http", url: "https://oauth.test/mcp" }]);
  await f.manager.start("s", "https://oauth.test/mcp"); const pending = f.callback(); await entered.promise;
  runtime.setRecords([{ id: "s", transport: "http", url: "https://replacement.test/mcp" }]);
  body.resolve({ access_token: "fixture-late" }); await pending; assert.equal(f.secrets.size, 0);
});

for (const [channel, payload, reply] of [
  [IPC.invoke.mcpOauthStart, { id: "s" }, { servers: [{ id: "s", transport: "http", url: "https://oauth.test/mcp" }] }],
  [IPC.invoke.mcpRemove, { id: "s" }, { ok: true }],
  [IPC.invoke.mcpTransfer, { id: "s" }, { server: { id: "new" } }],
  [IPC.invoke.mcpUpsert, { id: "s", enabled: false }, { server: { id: "s", enabled: false } }],
  [IPC.invoke.mcpSetEnabled, { id: "s", enabled: false }, { ok: true }],
]) test(`OAuth IPC rejects original Host replacement before continuation: ${channel}`, async () => {
  const handlers = new Map(), call = deferred(); let continued = 0;
  let host = { generation: "one", isAvailable: true, call: () => call.promise };
  registerMcpIpc({ registrar: { handle: (name, handler) => handlers.set(name, handler) }, getHost: () => host,
    userMcp: {}, oauth: { start: async () => { continued++; }, deleteOAuth: async () => { continued++; }, transferOAuth: async () => { continued++; }, invalidate() { continued++; } },
    currentWorkspacePath: () => null, refreshUserMcp: async () => { continued++; return []; }, describeError: String,
    sendToRenderer() {}, searchMcpMarket: async () => ({}),
  });
  const pending = handlers.get(channel)(payload), rejected = assert.rejects(pending, refused);
  host = { ...host, generation: "two" }; call.resolve(reply); await rejected; assert.equal(continued, 0);
});

test("OAuth retired token lookup cannot fall through to an unauthenticated MCP client", async t => {
  const read = deferred(), entered = deferred(); let created = 0;
  const runtime = new UserMcpRuntime({ isAdmissionClosed: () => false,
    oauth: { getValidAccessToken: () => { entered.resolve(); return read.promise; }, hasOAuth: async () => true },
    createClient: () => { created++; return { connect: async () => [], close() {}, isConnected: () => true, getTools: () => [] }; },
  }); t.after(() => runtime.disposeAll());
  runtime.setRecords([{ id: "s", transport: "http", url: "https://oauth.test/mcp" }]);
  const pending = runtime.test("s"), rejected = assert.rejects(pending, refused); await entered.promise;
  read.reject(Object.assign(new Error("Host changed"), { code: "HOST_UNAVAILABLE" })); await rejected;
  assert.equal(created, 0);
});

test("OAuth reentrant login supersedes the interrupted outer start", async t => {
  let replacement; let reenter = false;
  const f = fixture(t, { emit: event => { if (reenter && event.kind === "cancelled") { reenter = false; replacement = f.manager.start("s", "https://oauth.test/mcp"); } } });
  await f.manager.start("s", "https://oauth.test/mcp"); await f.opened.promise; reenter = true;
  await assert.rejects(f.manager.start("s", "https://oauth.test/mcp"), refused);
  const newest = await replacement; await turn();
  assert.equal(f.manager.cancel(newest.loginId), true);
});

test("OAuth cancelled authorization re-test cannot create a client after its token read", async t => {
  const read = deferred(), entered = deferred(); let retired = false, created = 0;
  const runtime = new UserMcpRuntime({ isAdmissionClosed: () => false,
    oauth: { getValidAccessToken: () => { entered.resolve(); return read.promise; }, hasOAuth: async () => true },
    createClient: () => { created++; return { connect: async () => [], close() {}, isConnected: () => true, getTools: () => [] }; },
  }); t.after(() => runtime.disposeAll());
  const pending = runtime.testAuthorized("s", { id: "s", transport: "http", url: "https://oauth.test/mcp" }, () => {
    if (retired) throw Object.assign(new Error("retired"), { code: "OAUTH_RETIRED" });
  }); const rejected = assert.rejects(pending, refused);
  await entered.promise; retired = true; read.resolve("fixture-token"); await rejected; assert.equal(created, 0);
});

test("OAuth five-minute deadline reports an error rather than user cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.manager.start("s", "https://oauth.test/mcp"); await f.opened.promise;
  t.mock.timers.tick(300000); await turn();
  assert.equal(f.events.at(-1).kind, "error"); assert.match(f.events.at(-1).message, /timed out/);
  assert.equal(f.events.filter(event => event.kind === "cancelled").length, 0);
});
