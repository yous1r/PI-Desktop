import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
const record = (hostKey = "host") => ({ hostKey, label: hostKey, url: "wss://fixture.invalid", deviceToken: "fixture-token" });
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
  return {
    close: async () => {},
    dispose: () => disposal ??= Promise.resolve(),
    getHandoffActivity: () => ({ operations: 0, resources: 0, uncontainedResources: 0 }),
  };
}
function adapter(options = {}) {
  let state = "disconnected";
  const started = Promise.withResolvers();
  const connecting = Promise.withResolvers();
  const closeStarted = Promise.withResolvers();
  const listeners = new Set();
  let closing;
  return {
    started, connecting, closeStarted,
    state: () => state,
    getHandoffActivity: () => options.activity ?? { operations: 0, resources: state === "connected" ? 1 : 0, uncontainedResources: 0 },
    async connect() {
      state = "connecting";
      started.resolve();
      if (options.holdConnect) await connecting.promise;
      state = "connected";
    },
    close() {
      if (closing) return closing;
      state = "disconnected";
      if (options.holdConnect) connecting.reject(new Error("fixture connect canceled"));
      closeStarted.resolve();
      closing = options.close ? options.close() : Promise.resolve();
      return closing;
    },
    push: event => { for (const listener of listeners) listener(event); },
    client: {
      async request(method, params) {
        if (options.request) {
          const response = options.request(method, params);
          if (response !== undefined) return response;
        }
        if (method === "session/list") return { sessions: [] };
        if (method === "events/subscribe") return { subscriptionId: "fixture-host", starting: { epoch: "fixture", sequence: 1 }, replayComplete: true };
        return { ok: true };
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "handoff-remote-hosts-"));
  const boot = createRemoteHostsBoot({ dataDir, encryption, router: createBackendRouter(), emit: () => {},
    clientInfo: { name: "test", version: "0.22.3" }, tunnels: tunnels(), buildAdapter: () => adapter(), ...options });
  t.after(async () => { await boot.closeAll().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  return boot;
}

test("remote boot waits for original adapter cleanup after canceling a pending connect", async t => {
  const release = Promise.withResolvers();
  const client = adapter({ holdConnect: true, close: () => release.promise });
  const boot = await fixture(t, { buildAdapter: () => client });
  await boot.registry.upsert(record());
  const opening = boot.open().catch(error => error);
  await client.started.promise;
  const closing = boot.closeAll();
  let settled = false;
  void closing.then(() => { settled = true; });
  await client.closeStarted.promise;
  await turn();
  const early = settled;
  release.resolve();
  await closing;
  assert.ok(await opening instanceof Error);
  assert.equal(early, false, "closeAll must join original cleanup");
});

test("remote boot reports cleanup failure after every sibling settles even if its logger throws", async t => {
  const release = Promise.withResolvers();
  const original = new Error("fixture adapter cleanup failed");
  const client = adapter({ close: async () => { throw original; } });
  const tunnelOwner = tunnels();
  tunnelOwner.dispose = () => release.promise;
  const boot = await fixture(t, { buildAdapter: () => client, tunnels: tunnelOwner, log: () => { throw new Error("fixture observer failed"); } });
  await boot.addHost(record());
  const closing = boot.closeAll().then(() => null, error => error);
  let settled = false;
  void closing.then(() => { settled = true; });
  await turn();
  const early = settled;
  release.resolve();
  const failure = await closing;
  assert.equal(early, false);
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /cleanup could not be confirmed/);
  assert.ok(boot.getHandoffActivity().uncontainedResources > 0);
});

test("remote boot admission refuses new hosts and preserves the connected workspace", async t => {
  let held = false;
  const clients = [];
  const boot = await fixture(t, { isAdmissionClosed: () => held, buildAdapter: () => { const client = adapter(); clients.push(client); return client; } });
  assert.equal((await boot.addHost(record("live"))).connected, true);
  const original = boot.workspaceClient("live");
  held = true;
  await assert.rejects(boot.addHost(record("new")), { errorCode: "HOST_BUSY" });
  assert.equal(clients.length, 1);
  assert.equal(boot.workspaceClient("live"), original);
  assert.deepEqual(await original.request("fixture/read"), { ok: true });
  assert.deepEqual((await boot.list()).map(row => row.hostKey), ["live"]);
});

test("remote boot counts pending open and original cleanup after removal from the live map", async t => {
  const release = Promise.withResolvers();
  const client = adapter({ holdConnect: true, close: () => release.promise });
  const boot = await fixture(t, { buildAdapter: () => client });
  const opening = boot.addHost(record()).catch(error => error);
  await client.started.promise;
  const duringOpen = boot.getHandoffActivity?.();
  const closing = boot.closeAll();
  await client.closeStarted.promise;
  const duringClose = boot.getHandoffActivity?.();
  release.resolve();
  await Promise.all([opening, closing]);
  assert.ok(duringOpen?.operations > 0);
  assert.ok(duringClose?.operations > 0);
  assert.equal(boot.getHandoffActivity().operations, 0);
});

test("remote boot replacement waits for the original host cleanup", async t => {
  const release = Promise.withResolvers();
  const first = adapter({ close: () => release.promise });
  const second = adapter();
  let builds = 0;
  const boot = await fixture(t, { buildAdapter: () => ++builds === 1 ? first : second });
  await boot.addHost(record());
  const replacement = boot.addHost({ ...record(), label: "replacement" });
  await first.closeStarted.promise;
  const beforeRelease = builds;
  release.resolve();
  assert.equal((await replacement).connected, true);
  assert.equal(beforeRelease, 1);
  assert.equal(boot.workspaceClient("host"), second.client);
});

test("remote boot concurrent and reentrant close share the same completion", async t => {
  let boot;
  let nested;
  let closes = 0;
  const client = adapter();
  client.close = () => {
    closes++;
    if (closes === 1) nested = boot.closeAll();
    return Promise.resolve();
  };
  boot = await fixture(t, { buildAdapter: () => client });
  await boot.addHost(record());
  const closing = boot.closeAll();
  const again = boot.closeAll();
  await Promise.all([closing, again, nested]);
  assert.equal(again, closing);
  assert.equal(nested, closing);
  assert.equal(closes, 1);
});

test("remote boot retains retired client work and its uncertainty after replacement", async t => {
  const activity = { operations: 1, resources: 0, uncontainedResources: 1 };
  const first = adapter({ activity });
  const second = adapter();
  let builds = 0;
  const boot = await fixture(t, { buildAdapter: () => ++builds === 1 ? first : second });
  await boot.addHost(record());
  await boot.addHost(record());
  assert.ok(boot.getHandoffActivity().operations > 0);
  activity.operations = 0;
  const snapshot = boot.getHandoffActivity();
  assert.equal(snapshot.operations, 0);
  assert.ok(snapshot.uncontainedResources > 0);
  await boot.closeAll();
  assert.ok(boot.getHandoffActivity().uncontainedResources > 0);
});

test("remote boot closes late SSH setup when admission changes before adapter creation", async t => {
  let held = false;
  let builds = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const tunnelOwner = tunnels();
  let closes = 0;
  tunnelOwner.open = () => { started.resolve(); return release.promise; };
  tunnelOwner.close = async () => { closes++; };
  const boot = await fixture(t, { tunnels: tunnelOwner, isAdmissionClosed: () => held, buildAdapter: () => { builds++; return adapter(); } });
  const adding = boot.addHost({ ...record(), metadata: { transport: "ssh", ssh: { host: "fixture.invalid", remotePort: 1234, version: "0.22.3" } } }).catch(error => error);
  await started.promise;
  held = true;
  release.resolve({ url: "ws://127.0.0.1:1/v1/racp/ws" });
  assert.equal((await adding).errorCode, "HOST_BUSY");
  assert.equal(builds, 0);
  assert.ok(closes > 0);
});

test("remote boot retains canceled preparation until its original registry read settles", async t => {
  const boot = await fixture(t);
  await boot.registry.upsert(record());
  const originalList = boot.registry.list;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  boot.registry.list = async () => { started.resolve(); await release.promise; return originalList(); };
  const preparing = boot.prepareHost({ hostKey: "host", requestId: "fixture-prepare" }).catch(error => error);
  await started.promise;
  boot.cancelPreparation("host", "fixture-prepare");
  assert.equal((await preparing).errorCode, "HOST_PREPARATION_CANCELLED");
  const pending = boot.getHandoffActivity().operations;
  const closing = boot.closeAll();
  release.resolve();
  await closing;
  assert.ok(pending > 0);
  assert.equal(boot.getHandoffActivity().operations, 0);
});

test("remote boot joins event-driven refresh after closing the original host", async t => {
  let hold = false;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const client = adapter({ request: method => {
    if (hold && method === "session/list") { started.resolve(); return release.promise; }
  } });
  const events = [];
  const boot = await fixture(t, { buildAdapter: () => client, emit: (...args) => events.push(args) });
  await boot.addHost(record());
  hold = true;
  client.push({ scope: "host", kind: "session.changed", epoch: "fixture", sequence: 1,
    payload: { session: { id: "fixture-session" } } });
  await started.promise;
  const closing = boot.closeAll();
  let settled = false;
  void closing.then(() => { settled = true; });
  await turn();
  const early = settled;
  const count = events.length;
  release.resolve({ sessions: [] });
  await closing;
  assert.equal(early, false);
  assert.equal(events.length, count, "late refresh must not publish after shutdown");
  assert.equal(boot.getHandoffActivity().operations, 0);
});

test("remote boot joins cleanup of an unadopted bootstrap forward during shutdown", async t => {
  const completed = Promise.withResolvers();
  const closeStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const version = "0.22.3";
  let boot;
  let closing;
  let forwardCloses = 0;
  const forward = { localPort: 1234, close: () => { forwardCloses++; closeStarted.resolve(); return release.promise; } };
  boot = await fixture(t, {
    log: (_level, message) => {
      if (message === "ssh bootstrap completed") { closing = boot.closeAll(); completed.resolve(); }
    },
    sshBootstrap: {
      buildTransport: () => ({
        exec: async () => ({ code: 0, stdout: "Linux\nx86_64\n", stderr: "" }),
        execWithInput: async () => ({ code: 0, stderr: "", stdout: `PI_HOST_READY ${JSON.stringify({ hostId: "fixture", host: "127.0.0.1", port: 1234, version })}\nPI_HOST_PAIRING_TOKEN ${JSON.stringify({ token: "fixture-token", expiresAt: 1893456000000 })}` }),
        forward: async () => forward, dispose: () => {},
      }),
      fetchChecksum: async () => `${"a".repeat(64)}  pi-host-${version}-linux-x64.tar.gz`,
      uploadArtifact: async () => ({ path: "/home/test/.pi-desktop/pi-host/.upload.ABC123/artifact.tar.gz", cleanup: async () => {} }),
      reservePort: async () => 1234, exchangePairing: async () => "fixture-device-token",
    },
  });
  const pairing = boot.bootstrapHost({ host: "fixture.invalid", label: "Fixture" }).catch(error => error);
  await completed.promise;
  await closeStarted.promise;
  let settled = false;
  void closing.then(() => { settled = true; });
  await turn();
  const early = settled;
  const pending = boot.getHandoffActivity().operations;
  release.resolve();
  assert.ok(await pairing instanceof Error);
  await closing;
  assert.equal(early, false);
  assert.ok(pending > 0);
  assert.equal(forwardCloses, 1);
  assert.equal(boot.getHandoffActivity().operations, 0);
});

test("remote boot refuses idle handoff when an injected owner has no valid inventory", async t => {
  const client = adapter();
  delete client.getHandoffActivity;
  const boot = await fixture(t, { buildAdapter: () => client });
  await boot.addHost(record());
  await boot.closeAll();
  assert.equal(boot.getHandoffActivity().uncontainedResources, Number.MAX_SAFE_INTEGER);
});

test("remote boot cancels an upgrade authentication adapter before draining preparation", async t => {
  const client = adapter({ holdConnect: true });
  const tunnelOwner = tunnels();
  let opens = 0;
  tunnelOwner.open = async () => {
    if (++opens === 1) throw Object.assign(new Error("fixture old version"), { errorCode: "HOST_VERSION_MISMATCH", remoteVersion: "0.21.0" });
    return { url: "ws://127.0.0.1:1/v1/racp/ws" };
  };
  const boot = await fixture(t, { tunnels: tunnelOwner, buildAdapter: () => client });
  await boot.registry.upsert({ ...record(), metadata: { transport: "ssh", ssh: {
    host: "fixture.invalid", remotePort: 1234, version: "0.21.0", hostId: "fixture",
  } } });
  const preparing = boot.prepareHost({ hostKey: "host", requestId: "fixture-upgrade", allowDownload: true }).catch(error => error);
  await client.started.promise;
  let closeRequested = false;
  void client.closeStarted.promise.then(() => { closeRequested = true; });
  const closing = boot.closeAll();
  await turn();
  const requestedBeforeRelease = closeRequested;
  client.connecting.reject(new Error("fixture release"));
  await Promise.all([preparing, closing]);
  assert.equal(requestedBeforeRelease, true);
  assert.equal(boot.getHandoffActivity().operations, 0);
});

test("remote boot records bootstrap transport uncertainty without inventing resources for invalid input", async t => {
  let builds = 0;
  const boot = await fixture(t, { sshBootstrap: { buildTransport: () => {
    builds++;
    throw new Error("fixture transport allocation failed");
  } } });
  await assert.rejects(boot.bootstrapHost({ host: "-invalid", label: "Fixture" }));
  assert.equal(builds, 0);
  assert.equal(boot.getHandoffActivity().uncontainedResources, 0);
  await assert.rejects(boot.bootstrapHost({ host: "fixture.invalid", label: "Fixture" }), /fixture transport allocation failed/);
  assert.equal(builds, 1);
  assert.ok(boot.getHandoffActivity().uncontainedResources > 0);
  await boot.closeAll();
  assert.equal(boot.getHandoffActivity().operations, 0);
  assert.ok(boot.getHandoffActivity().uncontainedResources > 0);
});
