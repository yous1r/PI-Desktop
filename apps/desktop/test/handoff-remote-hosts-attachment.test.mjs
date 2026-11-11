import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRacpRemoteHostClient } = await import("../electron/main/remote/racp-remote-host-client.ts");
const { harness, OWNER_TOKEN, MemoryLink } = await import("@pi-desktop/racp/test-harness");
const golden = JSON.parse(await readFile(new URL("../../../packages/shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const root = fileURLToPath(new URL("../../..", import.meta.url));

async function until(predicate) {
  // RACP reconnect uses a timer, so yield to the timer queue rather than
  // spinning only on setImmediate.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
async function scratch(t) {
  const base = join(root, ".artifacts", "scratch");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "h4-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const encryption = {
  isAvailable: () => true,
  encryptString: plain => Buffer.from(`fixture:${plain}`),
  decryptString: bytes => {
    assert.ok(bytes.toString().startsWith("fixture:"));
    return bytes.toString().slice(8);
  },
};
function tunnels() {
  let disposal;
  return { close: async () => undefined, dispose: () => disposal ??= Promise.resolve(),
    getHandoffActivity: () => ({ operations: 0, resources: 0, uncontainedResources: 0 }) };
}
const record = hostKey => ({ hostKey, label: hostKey, url: "wss://fixture.invalid", deviceToken: "unused" });

/** Seven sessions so the normal host+7 budget and the attached host+5 budget differ. */
async function sevenSessionHarness() {
  const h = await harness({ operations: {
    workspaceTools: { execute: async () => ({}), abort: async () => undefined, shell: async () => ({ available: false }), disconnect: async () => undefined },
    workspaceFiles: { read: async () => ({}) },
  } });
  for (let index = 2; index <= 7; index += 1) h.sessions.set(`s${index}`, { ...h.sessions.get("s1"), id: `s${index}` });
  return h;
}

function adapterFactory(h, state) {
  return () => {
    const calls = [];
    state.calls.push(calls);
    return createRacpRemoteHostClient({
      clientInfo: { name: "h4-bootstrap", version: "1" }, requestTimeoutMs: 2_000,
      reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 },
      transport: async () => {
        const auth = await h.authenticator.authenticate({ authorization: `Bearer ${state.token}`, urlHasToken: false, connectionId: `boot-${calls.length}` });
        assert.ok(auth);
        const link = new MemoryLink(); state.links.push(link);
        const rawServer = link.serverSide(), rawClient = link.clientSide();
        assert.ok(h.server.accept(auth, rawServer));
        return { ...rawClient, send(frame) { calls.push(JSON.parse(frame)); rawClient.send(frame); } };
      },
    });
  };
}

function handoffRequest(h, nativeRecord, overrides = {}) {
  return {
    target: { transferId: nativeRecord.id, sourceEpoch: nativeRecord.sourceEpoch, profileId: nativeRecord.profile },
    identity: () => ({ profileId: nativeRecord.profile, ownerEpoch: nativeRecord.targetEpoch, protocolVersion: 11 }),
    // Outside the five sessions the RemoteHostConnection itself watches, so the
    // only attach for this session is the attachment's own viewer attach.
    sessionId: "s6",
    ...overrides,
  };
}
function readyStatus(h, nativeRecord) {
  const ready = { version: 1, transferId: nativeRecord.id, profileId: nativeRecord.profile,
    ownerEpoch: nativeRecord.targetEpoch, recordRevision: 6, eventEpoch: h.host.hub.hostStream().epoch,
    protocolVersion: 11, snapshotRequired: true };
  return async () => ({ response: { version: 1, record: nativeRecord }, ready });
}

async function bootFixture(t, h, extra = {}) {
  const state = { calls: [], links: [], token: OWNER_TOKEN };
  const boot = createRemoteHostsBoot({
    dataDir: await scratch(t), encryption, router: createBackendRouter(), emit: () => undefined,
    clientInfo: { name: "test", version: "0.22.4" }, tunnels: tunnels(),
    buildAdapter: adapterFactory(h, state), ...extra,
  });
  t.after(() => boot.closeAll().catch(() => undefined));
  return { boot, state };
}

test("opted-out hosts keep the host plus seven session subscriptions", async t => {
  const h = await sevenSessionHarness();
  const { boot } = await bootFixture(t, h);
  assert.equal((await boot.addHost(record("plain"))).connected, true);
  assert.equal(boot.handoffState("plain"), undefined);
  assert.equal(h.host.hub.subscriptionCount(), 8);
  await boot.closeAll();
  assert.equal(h.host.hub.subscriptionCount(), 0);
});

test("opted-in host without a Ready source fails closed and reserves the attachment budget", async t => {
  const h = await sevenSessionHarness();
  const nativeRecord = { ...structuredClone(golden.response.record), phase: "ready", revision: 6 };
  const { boot, state } = await bootFixture(t, h, {
    handoffAttachment: ({ hostKey }) => hostKey === "attached" ? handoffRequest(h, nativeRecord) : undefined,
  });
  assert.equal((await boot.addHost(record("attached"))).connected, true);
  await until(() => boot.handoffState("attached")?.state === "error");
  assert.deepEqual(boot.handoffState("attached"), { state: "error", code: "HANDOFF_ATTACHMENT_READY_UNAVAILABLE" });
  // Host + five sessions: the attachment's two streams were reserved but never opened.
  assert.equal(h.host.hub.subscriptionCount(), 6);
  assert.equal(state.calls.flat().filter(call => call.method === "session/attach" && call.params.sessionId === "s6").length, 0);
  assert.deepEqual(h.runtime.prompts, []);
});

test("opted-in host attaches as viewer within the reserved budget and disposes on close", async t => {
  const h = await sevenSessionHarness();
  const nativeRecord = { ...structuredClone(golden.response.record), phase: "ready", revision: 6 };
  const states = [];
  const { boot, state } = await bootFixture(t, h, {
    handoffAttachment: ({ hostKey }) => hostKey === "attached" ? handoffRequest(h, nativeRecord, {
      readStatus: readyStatus(h, nativeRecord), onState: (value, detail) => states.push({ state: value, code: detail?.code }),
    }) : undefined,
  });
  assert.equal((await boot.addHost(record("attached"))).connected, true);
  await until(() => boot.handoffState("attached")?.state === "attached");
  // Host + five session streams + attachment host/session streams = eight.
  assert.equal(h.host.hub.subscriptionCount(), 8);
  const calls = state.calls.flat();
  const attachmentAttaches = calls.filter(call => call.method === "session/attach" && call.params.sessionId === "s6");
  assert.equal(attachmentAttaches.length, 1);
  assert.ok(attachmentAttaches.every(call => call.params.role === "viewer"));
  assert.ok(calls.every(call => call.method !== "turn/start"));
  assert.deepEqual(h.runtime.prompts, []);
  await boot.closeAll();
  assert.equal(h.host.hub.subscriptionCount(), 0);
  assert.ok(state.calls.flat().some(call => call.method === "events/unsubscribe"));
  assert.ok(states.some(row => row.state === "disposed"));
  assert.equal(boot.handoffState("attached"), undefined);
});

test("an opted-in host reattaches across a RACP reconnect and keeps the reserved budget", async t => {
  const h = await sevenSessionHarness();
  const nativeRecord = { ...structuredClone(golden.response.record), phase: "ready", revision: 6 };
  const snapshots = [];
  const { boot, state } = await bootFixture(t, h, {
    handoffAttachment: ({ hostKey }) => hostKey === "attached" ? handoffRequest(h, nativeRecord, {
      readStatus: readyStatus(h, nativeRecord), onSnapshot: frame => snapshots.push(frame),
    }) : undefined,
  });
  assert.equal((await boot.addHost(record("attached"))).connected, true);
  await until(() => boot.handoffState("attached")?.state === "attached");
  assert.equal(snapshots.length, 1);
  state.links.at(-1).drop();
  await until(() => snapshots.length === 2);
  await until(() => boot.handoffState("attached")?.state === "attached");
  assert.equal(h.host.hub.subscriptionCount(), 8);
  const attaches = state.calls.flat().filter(call => call.method === "session/attach" && call.params.sessionId === "s6");
  assert.ok(attaches.length >= 2);
  assert.ok(attaches.every(call => call.params.role === "viewer"));
  assert.deepEqual(h.runtime.prompts, []);
});

test("replacing an opted-in host disposes the previous attachment", async t => {
  const h = await sevenSessionHarness();
  const nativeRecord = { ...structuredClone(golden.response.record), phase: "ready", revision: 6 };
  const builds = [];
  const { boot } = await bootFixture(t, h, {
    handoffAttachment: ({ hostKey }) => {
      if (hostKey !== "attached") return undefined;
      const states = [];
      builds.push(states);
      return handoffRequest(h, nativeRecord, {
        readStatus: readyStatus(h, nativeRecord), onState: (value, detail) => states.push({ state: value, code: detail?.code }),
      });
    },
  });
  assert.equal((await boot.addHost(record("attached"))).connected, true);
  await until(() => boot.handoffState("attached")?.state === "attached");
  assert.equal((await boot.addHost({ ...record("attached"), label: "replacement" })).connected, true);
  await until(() => boot.handoffState("attached")?.state === "attached");
  assert.equal(builds.length, 2);
  assert.ok(builds[0].some(row => row.state === "disposed"));
  assert.equal(h.host.hub.subscriptionCount(), 8);
  assert.deepEqual(h.runtime.prompts, []);
});
