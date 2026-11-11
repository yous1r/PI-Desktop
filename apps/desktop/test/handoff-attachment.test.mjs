import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { OwnerHandoffAttachment } = await import("../../../packages/host-runtime/src/owner-handoff-attachment.ts");
const { createDesktopHandoffAttachmentTransport } = await import("../electron/main/runtime/handoff-attachment.ts");
const { createRacpRemoteHostClient } = await import("../electron/main/remote/racp-remote-host-client.ts");
const { harness, OWNER_TOKEN, VIEWER_TOKEN, MemoryLink } = await import("@pi-desktop/racp/test-harness");
const golden = JSON.parse(await readFile(new URL("../../../packages/shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const flush = () => new Promise(setImmediate);

async function fixture(t, { limits, buffer, token = OWNER_TOKEN } = {}) {
  const h = await harness({ limits });
  const nativeRecord = { ...structuredClone(golden.response.record), phase: "ready", revision: 6 };
  const ready = { version: 1, transferId: nativeRecord.id, profileId: nativeRecord.profile, ownerEpoch: nativeRecord.targetEpoch,
    recordRevision: 6, eventEpoch: h.host.hub.hostStream().epoch, protocolVersion: 11, snapshotRequired: true };
  const calls = [], frames = [], painted = [], errors = [], states = [];
  const state = { link: undefined, token, intercept: undefined, statusReads: [], nativeRecord, ready,
    recovered: Promise.withResolvers(), originalDetached: false, originalEvents: [] };
  const client = createRacpRemoteHostClient({ clientInfo: { name: "handoff-test", version: "1" }, requestTimeoutMs: 2000,
    reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 },
    onReconnected: async () => state.recovered.resolve(),
    transport: async () => {
      const auth = await h.authenticator.authenticate({ authorization: `Bearer ${state.token}`, urlHasToken: false, connectionId: `fixture-${calls.length}` });
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
  // Existing observation really owns a server subscription. H4 must retire it.
  const original = await client.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
  const offOriginal = client.client.subscribe(event => state.originalEvents.push(event));
  const attachment = new OwnerHandoffAttachment({
    target: { transferId: nativeRecord.id, sourceEpoch: nativeRecord.sourceEpoch, profileId: nativeRecord.profile },
    detachOriginal: async () => {
      offOriginal(); await client.client.request("events/unsubscribe", { subscriptionId: original.subscriptionId });
      state.originalDetached = true;
    },
    readStatus: async target => {
      assert.equal(state.originalDetached, true); state.statusReads.push(target);
      return { response: { version: 1, record: state.nativeRecord }, ready: state.ready };
    },
    resolveTransport: async () => {
      const link = state.link;
      return createDesktopHandoffAttachmentTransport({ client: client.client,
        // Test peer identity is independent of the Ready payload under test.
        identity: { profileId: nativeRecord.profile, ownerEpoch: nativeRecord.targetEpoch, protocolVersion: 11 },
        assertCurrent() { if (state.link !== link || !link.isOpen) throw new Error("AUTHENTICATED_CONNECTION_CHANGED"); },
        isClosed: () => !link.isOpen,
      });
    },
    onSnapshot: frame => frames.push(frame), onEvent: (view, event) => painted.push({ view, event }),
    onState: value => states.push(value), onError: error => errors.push(error), ...buffer,
  });
  t.after(async () => { await attachment.dispose(); await client.close(); });
  return { h, client, attachment, nativeRecord, state, calls, frames, painted, errors, states,
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

test("user attaches, reads history, resubscribes and detaches while a restored queue stays held", async t => {
  const f = await fixture(t);
  await f.h.host.queue.push({ id: "restored", sessionId: "s1", input: { text: "must stay queued" },
    context: { requestId: "restored" }, effectivePermissionMode: "ask", createdAt: "2026-10-01T00:00:00Z" });
  await f.h.host.queue.restore();
  const localView = { focus: "workspace-B", draft: "unsent", historyPosition: 42 };
  await f.attachment.reconcile("s1");
  assert.equal(f.h.host.queue.isHeld("s1"), true);
  assert.equal(f.h.host.queue.size("s1"), 1);
  assert.equal(f.frames[0].snapshot.session.permissionMode, "ask");
  let history;
  await f.attachment.readHistory({}, (view, result) => { history = { view, result }; });
  assert.equal(history.view.sessionId, "s1"); assert.deepEqual(history.result.items, []);
  await f.attachment.resync(); assert.equal(f.count(), 2);
  assert.equal(f.frames.length, 2); assert.notEqual(f.frames[0].view.generation, f.frames[1].view.generation);
  assert.deepEqual(localView, { focus: "workspace-B", draft: "unsent", historyPosition: 42 });
  assert.deepEqual(f.h.runtime.prompts, []); assert.deepEqual(f.h.runtime.inputs, []); assert.deepEqual(f.h.approvals.tool, []);
  assert.equal(f.h.host.queue.isHeld("s1"), true);
  assert.ok(f.calls.filter(call => call.method === "session/attach").every(call => call.params.role === "viewer"));
  assert.ok(f.calls.every(call => ["connection/initialize", "notifications/initialized", "events/subscribe", "events/unsubscribe", "events/ack", "session/attach", "session/history"].includes(call.method)));
  await f.attachment.detach(); assert.equal(f.count(), 0);
});

test("real RACP replays events after a held snapshot before the subscribe result", async t => {
  const f = await fixture(t), gate = holdReply(f, message => Boolean(message.result?.snapshot));
  const attaching = f.attachment.reconcile("s1"); const snapshotReply = await gate.entered;
  assert.notEqual(snapshotReply.result.snapshot.cursor.epoch, f.state.ready.eventEpoch);
  const first = f.publish("first"), second = f.publish("second");
  gate.release(); await attaching;
  assert.deepEqual(f.frames[0].events.map(event => event.eventId), [first.eventId, second.eventId]);
  assert.equal(f.frames[0].cursor.sequence, second.sequence);
  assert.equal(f.state.originalEvents.length, 0);
  const live = f.publish("live"); await flush();
  assert.deepEqual(f.painted.filter(row => row.event.scope === "session").map(row => row.event.eventId), [live.eventId]);
  assert.deepEqual(f.h.runtime.prompts, []);
});

test("dropped durable event freezes the view; RACP reconnect takes a new snapshot without dispatch", async t => {
  const f = await fixture(t); await f.attachment.reconcile("s1");
  let dropped = false;
  f.state.intercept = message => {
    if (message.method === "session/event" && !dropped) { dropped = true; return true; }
    return false;
  };
  f.publish("lost"); f.publish("gap"); await flush();
  assert.equal(dropped, true); assert.equal(f.attachment.state, "resync-required"); assert.equal(f.painted.length, 0);
  f.state.intercept = undefined; f.state.link.drop();
  await f.state.recovered.promise;
  assert.equal(f.attachment.state, "attached"); assert.equal(f.frames.length, 2);
  assert.equal(f.frames[1].cursor.sequence, f.h.host.hub.stream("s1").lastSequence);
  assert.equal(f.count(), 2); assert.deepEqual(f.h.runtime.prompts, []); assert.deepEqual(f.h.approvals.tool, []);
  assert.equal(f.state.statusReads.length, 2);
});

test("same-epoch replacement and dispose await the original asynchronous subscribe ID", async t => {
  const f = await fixture(t), gate = holdReply(f, message => message.result?.scope === "session" && Boolean(message.result?.subscriptionId));
  const opening = observed(f.attachment.reconcile("s1")); await gate.entered;
  const disposing = f.attachment.dispose(); let finished = false;
  void disposing.then(() => { finished = true; }); await Promise.resolve(); assert.equal(finished, false);
  gate.release(); await opening; await disposing;
  assert.equal(f.count(), 0); assert.equal(f.frames.length, 0);
});

test("permission changes are read from the authenticated peer; viewer Ready never authorizes writes", async t => {
  const f = await fixture(t); await f.attachment.reconcile("s1");
  f.h.sessions.set("s1", { ...f.h.sessions.get("s1"), permissionMode: "auto" });
  f.state.token = VIEWER_TOKEN; f.state.link.drop(); await f.state.recovered.promise;
  assert.equal(f.frames[1].snapshot.session.permissionMode, "auto");
  await assert.rejects(f.client.client.request("turn/start", { sessionId: "s1", input: { text: "forbidden" }, context: { requestId: "forbidden" } }), error => error.code === "FORBIDDEN");
  assert.deepEqual(f.h.runtime.prompts, []);
  const link = f.state.link;
  const port = createDesktopHandoffAttachmentTransport({ client: f.client.client,
    identity: { profileId: f.nativeRecord.profile, ownerEpoch: f.nativeRecord.targetEpoch, protocolVersion: 11 },
    assertCurrent() { assert.equal(f.state.link, link); }, isClosed: () => !link.isOpen });
  await assert.rejects(port.request("approval/respond", {}), /READ_ONLY/);
  await assert.rejects(port.request("session/attach", { sessionId: "s1", role: "owner" }), /READ_ONLY/);
  assert.deepEqual(f.h.approvals.tool, []);
});

test("evicted replay and a wrong Ready event epoch publish no snapshot", async t => {
  const f = await fixture(t, { limits: { replayWindowEvents: 1 } });
  const gate = holdReply(f, message => Boolean(message.result?.snapshot));
  const attaching = observed(f.attachment.reconcile("s1")); await gate.entered;
  f.publish("evicted"); f.publish("retained"); gate.release();
  assert.match((await attaching).error.message, /REPLAY_GAP/); assert.equal(f.frames.length, 0);
  await f.attachment.resync(); assert.equal(f.frames.length, 1);
  f.state.ready = { ...f.state.ready, eventEpoch: "wrong-host-epoch" };
  await assert.rejects(f.attachment.resync(), /EVENT_EPOCH/); assert.equal(f.frames.length, 1);
  await f.attachment.detach(); assert.equal(f.count(), 0);
});

test("stale snapshot, paged history and old-owner event frames cannot repaint another session", async t => {
  const f = await fixture(t); f.h.sessions.set("s2", { ...f.h.sessions.get("s1"), id: "s2" });
  const gate = holdReply(f, message => Boolean(message.result?.snapshot));
  const old = observed(f.attachment.reconcile("s1")); await gate.entered;
  await f.attachment.reconcile("s2"); gate.release(); assert.match((await old).error.message, /SUPERSEDED/);
  assert.deepEqual(f.frames.map(frame => frame.view.sessionId), ["s2"]);
  const history = holdReply(f, message => Boolean(message.result?.items)); let historyApplied = false;
  const paging = observed(f.attachment.readHistory({}, () => { historyApplied = true; })); await history.entered;
  await f.attachment.reconcile("s1"); history.release(); assert.match((await paging).error.message, /SUPERSEDED/);
  assert.equal(historyApplied, false); assert.equal(f.count(), 2);
});
