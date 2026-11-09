import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createRacpRemoteHostClient } = await import("../electron/main/remote/racp-remote-host-client.ts");
const { harness, OWNER_TOKEN, MemoryLink } = await import("@pi-desktop/racp/test-harness");
const turn = () => new Promise(setImmediate);
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

async function fixture(t, options = {}) {
  const host = await harness(options.host);
  const state = { held: false, calls: 0, links: [], transport: null, closing: null, message: null, warnings: [] };
  let adapter;
  const create = async () => {
    const auth = await host.authenticator.authenticate({ authorization: `Bearer ${OWNER_TOKEN}`, urlHasToken: false, connectionId: `fixture-${state.calls}` });
    assert.ok(auth);
    const link = new MemoryLink(); state.links.push(link);
    assert.ok(host.server.accept(auth, link.serverSide()));
    const raw = link.clientSide();
    return {
      ...raw,
      close(code, reason) { if (state.closing) state.closing(raw, code, reason); else raw.close(code, reason); },
      onMessage(handler) { raw.onMessage(frame => { handler(frame); state.message?.(JSON.parse(frame)); }); },
    };
  };
  adapter = createRacpRemoteHostClient({
    clientInfo: { name: "fixture", version: "1" }, requestTimeoutMs: 2000,
    isAdmissionClosed: () => state.held,
    transport: async () => { state.calls++; return state.transport ? state.transport(create) : create(); },
    log: (_level, message) => state.warnings.push(message),
    ...options.client,
  });
  t.after(async () => { await adapter.close().catch(() => {}); for (const link of state.links) link.drop(); });
  return { adapter, state, host };
}

test("closed admission prevents a new transport factory from running", async t => {
  const { adapter, state } = await fixture(t); state.held = true;
  await assert.rejects(adapter.connect(), { code: "HOST_BUSY" });
  assert.equal(state.calls, 0);
});

test("a transport arriving after admission closes is closed before initialization", async t => {
  const { adapter, state } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  state.transport = async create => { entered.resolve(); await release.promise; return create(); };
  const opening = observe(adapter.connect()); await entered.promise;
  state.held = true; release.resolve(); const result = await opening;
  assert.equal(result.error?.code, "HOST_BUSY");
  assert.equal(state.links[0].isOpen, false); assert.deepEqual(state.links[0].toServer, []);
});

test("original transport creation remains counted after outer close", async t => {
  const { adapter, state } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  state.transport = async create => { entered.resolve(); await release.promise; return create(); };
  const opening = observe(adapter.connect()); await entered.promise; await adapter.close();
  try { assert.ok(adapter.getHandoffActivity().operations > 0); }
  finally { release.resolve(); await opening; }
  await turn();
  assert.deepEqual(adapter.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
  assert.equal(state.links[0].isOpen, false);
});

test("unregister and close retain the original inbound handler until actual completion", async t => {
  const { adapter, state } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await adapter.connect();
  const unregister = adapter.client.handleServerRequest("fixture/owned", async () => { entered.resolve(); return release.promise; });
  state.links[0].serverSide().send(JSON.stringify({ jsonrpc: "2.0", id: "original", method: "fixture/owned", params: {} }));
  await entered.promise; unregister(); await adapter.close();
  try { assert.ok(adapter.getHandoffActivity().operations > 0); }
  finally { release.resolve({ stale: true }); await turn(); }
  assert.equal(adapter.getHandoffActivity().operations, 0);
  assert.equal(state.links[0].toServer.some(frame => JSON.parse(frame).id === "original"), false);
});

test("closed admission refuses new inbound work but preserves protocol error replies", async t => {
  const { adapter, state } = await fixture(t); await adapter.connect(); let invoked = 0;
  adapter.client.handleServerRequest("fixture/owned", async () => { invoked++; return { ok: true }; });
  state.held = true;
  state.links[0].serverSide().send(JSON.stringify({ jsonrpc: "2.0", id: "held", method: "fixture/owned", params: {} }));
  await turn();
  const response = state.links[0].toServer.map(frame => JSON.parse(frame)).find(frame => frame.id === "held");
  assert.equal(invoked, 0); assert.equal(response.error.data.code, "HOST_BUSY");
  assert.equal(state.links[0].isOpen, true);
});

test("temporary local admission holds preserve remote requests and original teardown", async t => {
  const { adapter, state } = await fixture(t); await adapter.connect(); state.held = true;
  assert.ok(Array.isArray((await adapter.client.request("session/list")).sessions));
  assert.equal(state.calls, 1); assert.equal(state.links[0].isOpen, true);
  await adapter.close(); assert.equal(state.links[0].isOpen, false);
});

test("a response resolved just before close cannot publish under a retired connection", async t => {
  const { adapter, state } = await fixture(t); await adapter.connect();
  state.message = message => { if (message.result?.sessions) void adapter.close(); };
  await assert.rejects(adapter.client.request("session/list"), { code: "HOST_DISCONNECTED" });
});

test("concurrent and reentrant closes join the same original completion", async t => {
  const { adapter, state } = await fixture(t); await adapter.connect(); let nested, calls = 0;
  state.closing = (raw, code, reason) => { calls++; nested = adapter.close(); raw.close(code, reason); };
  const closing = adapter.close(); assert.equal(nested, closing);
  assert.equal(adapter.close(), closing); await closing; assert.equal(calls, 1);
});

test("a close request without an original close event retains the transport resource", async t => {
  const { adapter, state } = await fixture(t); await adapter.connect();
  let original, code, reason;
  state.closing = (raw, closeCode, closeReason) => { original = raw; code = closeCode; reason = closeReason; };
  await adapter.close();
  try { assert.equal(adapter.getHandoffActivity().resources, 1); }
  finally { original.close(code, reason); await turn(); }
  assert.deepEqual(adapter.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});

test("explicit reopen uses a new binding while an original inbound callback is still pending", async t => {
  const { adapter, state } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await adapter.connect();
  adapter.client.handleServerRequest("fixture/owned", async () => { entered.resolve(); return release.promise; });
  state.links[0].serverSide().send(JSON.stringify({ jsonrpc: "2.0", id: "old", method: "fixture/owned", params: {} }));
  await entered.promise; await adapter.close(); await adapter.connect();
  try { assert.ok(adapter.getHandoffActivity().operations > 0); }
  finally { release.resolve({ obsolete: true }); await turn(); }
  assert.equal(state.links[1].toServer.some(frame => JSON.parse(frame).id === "old"), false);
  assert.ok(Array.isArray((await adapter.client.request("session/list")).sessions));
  assert.equal(adapter.getHandoffActivity().uncontainedResources, 2);
});

test("automatic reconnect backoff remains counted until its original timer settles after close", async t => {
  const { adapter, state } = await fixture(t, { client: { reconnect: { enabled: true, baseDelayMs: 5, maxAttempts: 2 } } });
  await adapter.connect(); t.mock.timers.enable({ apis: ["setTimeout"] });
  state.links[0].drop(); await turn(); await adapter.close();
  try { assert.ok(adapter.getHandoffActivity().operations > 0); }
  finally { t.mock.timers.tick(5); await turn(); }
  assert.equal(state.calls, 1); assert.equal(adapter.getHandoffActivity().operations, 0);
});

test("an old inbound callback cannot send a mutation through an explicitly reopened client", async t => {
  const { adapter, state, host } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers();
  await adapter.connect();
  adapter.client.handleServerRequest("fixture/owned", async () => {
    entered.resolve(); await release.promise;
    const result = await observe(adapter.client.request("session/create", { title: "obsolete mutation" }));
    finished.resolve(result); return result;
  });
  state.links[0].serverSide().send(JSON.stringify({ jsonrpc: "2.0", id: "old-effect", method: "fixture/owned", params: {} }));
  await entered.promise; await adapter.close(); await adapter.connect(); release.resolve();
  assert.equal((await finished.promise).error?.code, "HOST_DISCONNECTED");
  assert.equal(host.sessions.size, 1);
  assert.equal(state.links[1].toServer.some(frame => JSON.parse(frame).method === "session/create"), false);
});

test("old inbound cleanup cannot close the replacement connection", async t => {
  const { adapter, state } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers();
  await adapter.connect();
  adapter.client.handleServerRequest("fixture/owned", async () => {
    entered.resolve(); await release.promise;
    const result = await observe(adapter.close()); finished.resolve(result); return result;
  });
  state.links[0].serverSide().send(JSON.stringify({ jsonrpc: "2.0", id: "old-close", method: "fixture/owned", params: {} }));
  await entered.promise; await adapter.close(); await adapter.connect(); release.resolve();
  assert.equal((await finished.promise).error?.code, "HOST_DISCONNECTED");
  assert.equal(adapter.state(), "connected"); assert.equal(state.links[1].isOpen, true);
});

test("a newly registered handler survives explicit reopen from the disconnected observer", async t => {
  const { adapter, state } = await fixture(t); await adapter.connect(); let reopening;
  const detach = adapter.client.subscribeState(value => {
    if (value !== "disconnected") return;
    detach(); reopening = adapter.connect();
    adapter.client.handleServerRequest("fixture/new", async () => ({ fresh: true }));
  });
  await adapter.close(); await reopening;
  state.links[1].serverSide().send(JSON.stringify({ jsonrpc: "2.0", id: "fresh", method: "fixture/new", params: {} }));
  await turn();
  const response = state.links[1].toServer.map(frame => JSON.parse(frame)).find(frame => frame.id === "fresh");
  assert.deepEqual(response.result, { fresh: true });
});

test("reconnect callbacks remain owned through close and sibling rejection", async t => {
  const { adapter, state } = await fixture(t, { client: { reconnect: { enabled: true, baseDelayMs: 5, maxAttempts: 2 } } });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await adapter.connect();
  adapter.client.subscribeReconnect(async () => { entered.resolve(); await release.promise; });
  adapter.client.subscribeReconnect(async () => { throw new Error("fixture sibling failure"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.links[0].drop(); await turn(); t.mock.timers.tick(5); await entered.promise;
  await adapter.close();
  try { assert.ok(adapter.getHandoffActivity().operations > 0); }
  finally { release.resolve(); await turn(); }
  assert.equal(state.calls, 2); assert.equal(adapter.getHandoffActivity().operations, 0);
});
