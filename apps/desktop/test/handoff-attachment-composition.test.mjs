import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createDesktopHandoffReattachment } = await import("../electron/main/runtime/handoff-reattachment.ts");
const { createRacpRemoteHostClient } = await import("../electron/main/remote/racp-remote-host-client.ts");
const { harness, OWNER_TOKEN, VIEWER_TOKEN, MemoryLink } = await import("@pi-desktop/racp/test-harness");
const golden = JSON.parse(await readFile(new URL("../../../packages/shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const flush = () => new Promise(setImmediate);
async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) { if (predicate()) return; await flush(); }
  assert.fail("condition was not reached");
}

/**
 * Composition fixture: a real in-memory RACP client whose reconnect loop opens
 * a fresh MemoryLink on every attempt. The authority resolver re-captures the
 * authenticated identity from the link that currently carries it, exactly as
 * the H5 owner binding will. `readStatus` stands in for the H3 Ready join.
 */
async function fixture(t, { token = OWNER_TOKEN } = {}) {
  const h = await harness();
  const nativeRecord = { ...structuredClone(golden.response.record), phase: "ready", revision: 6 };
  const ready = { version: 1, transferId: nativeRecord.id, profileId: nativeRecord.profile, ownerEpoch: nativeRecord.targetEpoch,
    recordRevision: 6, eventEpoch: h.host.hub.hostStream().epoch, protocolVersion: 11, snapshotRequired: true };
  const calls = [], frames = [], painted = [], errors = [], states = [];
  const state = { link: undefined, token, intercept: undefined, statusReads: [], nativeRecord, ready,
    ownerEpoch: nativeRecord.targetEpoch, recovered: Promise.withResolvers() };
  const client = createRacpRemoteHostClient({ clientInfo: { name: "h4-composition", version: "1" }, requestTimeoutMs: 2000,
    reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 },
    onReconnected: async () => state.recovered.resolve(),
    transport: async () => {
      const auth = await h.authenticator.authenticate({ authorization: `Bearer ${state.token}`, urlHasToken: false, connectionId: `h4-${calls.length}` });
      assert.ok(auth);
      const link = new MemoryLink(); state.link = link;
      const rawServer = link.serverSide(), rawClient = link.clientSide();
      assert.ok(h.server.accept(auth, { ...rawServer, send(frame) {
        const message = JSON.parse(frame);
        if (state.intercept?.(message, () => rawServer.send(frame))) return;
        rawServer.send(frame);
      } }));
      return { ...rawClient, send(frame) { calls.push(JSON.parse(frame)); rawClient.send(frame); } };
    },
  });
  await client.connect();
  // An existing observation already owns a server subscription; enable() retires it.
  const original = await client.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
  const offOriginal = client.client.subscribe(() => undefined);
  let originalDetached = false;
  const port = createDesktopHandoffReattachment({
    authority() {
      const link = state.link;
      return {
        target: { transferId: nativeRecord.id, sourceEpoch: nativeRecord.sourceEpoch, profileId: nativeRecord.profile },
        // The authenticated identity is independent of the Ready payload under test.
        identity: { profileId: nativeRecord.profile, ownerEpoch: state.ownerEpoch, protocolVersion: 11 },
        client: client.client,
        assertCurrent() { if (state.link !== link || !link.isOpen) throw new Error("AUTHENTICATED_CONNECTION_CHANGED"); },
        isClosed: () => !link.isOpen,
      };
    },
    detachOriginal: async () => {
      offOriginal();
      await client.client.request("events/unsubscribe", { subscriptionId: original.subscriptionId });
      originalDetached = true;
    },
    readStatus: async target => { state.statusReads.push(target); return { response: { version: 1, record: state.nativeRecord }, ready: state.ready }; },
    sessionId: "s1",
    onSnapshot: frame => frames.push(frame),
    onEvent: (view, event) => painted.push({ view, event }),
    onState: (value, detail) => states.push({ state: value, code: detail?.code }),
    onError: error => errors.push(error),
  });
  t.after(async () => { await port.dispose().catch(() => undefined); await client.close().catch(() => undefined); });
  return { h, client, port, nativeRecord, ready, state, calls, frames, painted, errors, states,
    isOriginalDetached: () => originalDetached,
    publish: label => h.host.hub.publish({ scope: "session", sessionId: "s1", kind: "session.changed", revision: 1, payload: { label } }),
    count: () => h.host.hub.subscriptionCount() };
}

function holdReply(f, predicate) {
  const entered = Promise.withResolvers(); let deliver;
  f.state.intercept = (message, send) => {
    if (!predicate(message)) return false;
    f.state.intercept = undefined; deliver = send; entered.resolve(message); return true;
  };
  return { entered: entered.promise, release: () => { assert.ok(deliver); deliver(); } };
}

test("enable reconciles the snapshot then applies replay in order and starts no turn", async t => {
  const f = await fixture(t), gate = holdReply(f, message => Boolean(message.result?.snapshot));
  const enabling = observed(f.port.enable()); await gate.entered;
  const first = f.publish("first"), second = f.publish("second");
  gate.release(); assert.equal((await enabling).error, undefined);
  assert.equal(f.port.state, "attached");
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.frames[0].events.map(event => event.eventId), [first.eventId, second.eventId]);
  assert.equal(f.frames[0].cursor.sequence, second.sequence);
  assert.equal(f.isOriginalDetached(), true);
  assert.equal(f.count(), 2);
  assert.ok(f.calls.filter(call => call.method === "session/attach").every(call => call.params.role === "viewer"));
  assert.ok(f.calls.every(call => !["turn/start", "approval/respond", "session/delete"].includes(call.method)));
  assert.deepEqual(f.h.runtime.prompts, []); assert.deepEqual(f.h.runtime.inputs, []); assert.deepEqual(f.h.approvals.tool, []);
});

test("a RACP reconnect recreates the attachment from the captured identity and replays after the new snapshot", async t => {
  const f = await fixture(t); await f.port.enable();
  assert.equal(f.frames.length, 1);
  f.state.recovered = Promise.withResolvers();
  const gate = holdReply(f, message => Boolean(message.result?.snapshot));
  f.state.link.drop();
  await gate.entered;
  const first = f.publish("after-1"), second = f.publish("after-2");
  gate.release(); await f.state.recovered.promise;
  assert.equal(f.port.state, "attached");
  assert.ok(f.states.some(row => row.state === "unavailable" && row.code === "HANDOFF_ATTACHMENT_DISCONNECTED"));
  assert.equal(f.frames.length, 2);
  // A fresh attachment instance reconciles a fresh Ready object rather than
  // reusing the previous capture.
  assert.notEqual(f.frames[0].view.ready, f.frames[1].view.ready);
  assert.deepEqual(f.frames[1].events.map(event => event.eventId), [first.eventId, second.eventId]);
  assert.equal(f.frames[1].cursor.sequence, second.sequence);
  assert.equal(f.state.statusReads.length, 2);
  assert.equal(f.count(), 2);
  assert.deepEqual(f.h.runtime.prompts, []); assert.deepEqual(f.h.approvals.tool, []);
});

test("a changed authenticated owner epoch is refused without repainting", async t => {
  const f = await fixture(t); await f.port.enable();
  assert.equal(f.frames.length, 1);
  // The replacement connection authenticates as a different target owner; the
  // durable ready record still names the previous epoch.
  f.state.ownerEpoch = "9a1c5f5e-0f77-4a13-9ffc-3a12b6a8d1d1";
  f.state.recovered = Promise.withResolvers();
  f.state.link.drop(); await f.state.recovered.promise;
  assert.equal(f.port.state, "error");
  assert.equal(f.port.detail?.code, "HANDOFF_ATTACHMENT_AUTH_MISMATCH");
  assert.match(String(f.errors.at(-1)?.message ?? f.errors.at(-1)), /HANDOFF_ATTACHMENT_AUTH_MISMATCH/);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.painted, []);
  assert.equal(f.count(), 0);
});

test("ownerChanged reattaches to the new epoch on the same connection and releases the old streams", async t => {
  const f = await fixture(t); await f.port.enable();
  const unsubscribeBefore = f.calls.filter(call => call.method === "events/unsubscribe").length;
  const nextEpoch = "2f4b8f0c-6a51-4f2e-8e0d-7c9a1b3d5e6f";
  f.state.nativeRecord = { ...f.state.nativeRecord, targetEpoch: nextEpoch, revision: 7 };
  f.state.ready = { ...f.state.ready, ownerEpoch: nextEpoch, recordRevision: 7 };
  f.state.ownerEpoch = nextEpoch;
  await f.port.ownerChanged();
  assert.equal(f.port.state, "attached");
  assert.equal(f.frames.length, 2);
  assert.notEqual(f.frames[0].view.ready, f.frames[1].view.ready);
  assert.equal(f.frames[1].view.ready.ownerEpoch, nextEpoch);
  assert.ok(f.calls.filter(call => call.method === "events/unsubscribe").length > unsubscribeBefore);
  assert.equal(f.count(), 2);
  assert.deepEqual(f.h.runtime.prompts, []);
});

test("a permission change on reconnect is read from the authenticated peer and starts no turn", async t => {
  const f = await fixture(t); await f.port.enable();
  f.h.sessions.set("s1", { ...f.h.sessions.get("s1"), permissionMode: "auto" });
  f.state.token = VIEWER_TOKEN; f.state.recovered = Promise.withResolvers();
  f.state.link.drop(); await f.state.recovered.promise;
  assert.equal(f.port.state, "attached");
  assert.equal(f.frames.length, 2);
  assert.equal(f.frames[1].snapshot.session.permissionMode, "auto");
  await assert.rejects(f.client.client.request("turn/start", { sessionId: "s1", input: { text: "forbidden" }, context: { requestId: "forbidden" } }),
    error => error.code === "FORBIDDEN");
  assert.deepEqual(f.h.runtime.prompts, []); assert.deepEqual(f.h.approvals.tool, []);
});

test("closing the authenticated connection publishes unavailable and releases every subscription", async t => {
  const f = await fixture(t); await f.port.enable();
  assert.equal(f.count(), 2);
  await f.client.close();
  await until(() => f.port.state === "unavailable");
  assert.equal(f.count(), 0);
  assert.ok(f.states.some(row => row.state === "unavailable" && row.code === "HANDOFF_ATTACHMENT_DISCONNECTED"));
});

test("disable releases every subscription and dispose ends the port permanently", async t => {
  const f = await fixture(t); await f.port.enable();
  assert.equal(f.count(), 2);
  await f.port.disable();
  assert.equal(f.port.state, "detached");
  assert.equal(f.count(), 0);
  await f.port.enable();
  assert.equal(f.port.state, "attached");
  assert.equal(f.count(), 2);
  await f.port.dispose();
  assert.equal(f.port.state, "disposed");
  assert.equal(f.count(), 0);
  await assert.rejects(f.port.enable(), error => error.code === "HANDOFF_ATTACHMENT_DISPOSED");
  await assert.rejects(f.port.ownerChanged(), error => error.code === "HANDOFF_ATTACHMENT_DISPOSED");
});
