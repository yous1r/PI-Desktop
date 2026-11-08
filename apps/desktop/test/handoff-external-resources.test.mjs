import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { PluginWebSocketRegistry } = await import("../electron/main/plugin-websocket.ts");
const { WorkspacePorts } = await import("../electron/main/remote/workspace-ports.ts");
const { WorkspaceResources } = await import("../electron/main/remote/workspace-resources.ts");

const deferred = () => Promise.withResolvers();
const context = { workspaceId: "w", projectId: "p", authority: { kind: "remote", hostKey: "host" },
  roots: [{ path: "/workspace", name: "work", primary: true }], platform: "linux", connectionState: "connected", generation: 1 };
const portInput = { ownerId: "plugin", context, sessionId: "session", port: 3000, validate: async () => {} };

function sockets(t, autoOpen = false) {
  let closed = false;
  const transports = [], events = [];
  const registry = new PluginWebSocketRegistry({ isAdmissionClosed: () => closed,
    onEvent: (id, event) => events.push({ id, event }),
    createSocket: (_input, handlers) => {
      const socket = { handlers, sends: [], terminations: 0, send(data) { this.sends.push(data); },
        close() {}, terminate() { this.terminations++; }, bufferedAmount: () => 0 };
      transports.push(socket);
      if (autoOpen) queueMicrotask(() => handlers.onOpen({ protocol: "" }));
      return socket;
    } });
  t.after(() => registry.releasePlugin("plugin"));
  return { registry, transports, events, closeGate: () => { closed = true; },
    connect: () => registry.connect({ pluginId: "plugin", url: "ws://fixture.invalid/" }) };
}

function ports(t, overrides = {}) {
  let closed = false;
  const events = [];
  const service = new WorkspacePorts({ isAdmissionClosed: () => closed,
    connect: async (_context, _port, owner) => { owner?.nativeAttempt(); events.push("connect");
      return { url: "http://127.0.0.1:43210", close: async () => { events.push("close"); } }; },
    openBrowser: async () => { events.push("browser"); }, ...overrides });
  t.after(() => service.dispose());
  return { service, events, closeGate: () => { closed = true; } };
}

function resources(t, overrides = {}) {
  let closed = false, reads = 0, url;
  const content = Buffer.from("<h1>fixture</h1>");
  const service = new WorkspaceResources({ isAdmissionClosed: () => closed,
    chooseCopy: async () => null, openCopy: async () => {}, reveal: async () => {},
    openBrowser: async value => { url = value; }, ...overrides });
  const input = { ownerId: "plugin", pluginName: "Fixture", context, sessionId: "session", path: "index.html", api: "fs.openInBrowser",
    validate: async () => {}, read: async (api) => { reads++; return api === "fs.stat"
      ? { size: content.length, mtimeMs: 1 } : { bytes: [...content], totalSize: content.length }; } };
  t.after(() => service.dispose());
  return { service, input, get url() { return url; }, get reads() { return reads; }, closeGate: () => { closed = true; } };
}

test("handoff refuses plugin socket creation at its resource boundary", async t => {
  const f = sockets(t, true); f.closeGate();
  await assert.rejects(f.connect(), { code: "HOST_BUSY" });
  assert.equal(f.transports.length, 0);
});

test("a plugin socket handshake cannot publish after admission closes", async t => {
  const f = sockets(t); const pending = f.connect(); const rejected = assert.rejects(pending, { code: "HOST_BUSY" });
  f.closeGate(); f.transports[0].handlers.onOpen({ protocol: "" }); await rejected;
  assert.equal(f.transports[0].terminations, 1); assert.deepEqual(f.events, []);
});

test("closed admission refuses new socket frames while retaining cleanup", async t => {
  const f = sockets(t, true); const { socketId } = await f.connect(); f.closeGate();
  assert.throws(() => f.registry.send({ pluginId: "plugin", socketId, data: "late" }), { code: "HOST_BUSY" });
  f.registry.close({ pluginId: "plugin", socketId }); f.registry.releasePlugin("plugin");
  assert.deepEqual(f.transports[0].sends, []);
});

test("released socket events cannot reach a replacement plugin installation", async t => {
  const f = sockets(t, true); await f.connect(); const old = f.transports[0];
  f.registry.releasePlugin("plugin"); await f.connect(); const accepted = [...f.events];
  old.handlers.onError({ code: "SOCKET_ERROR", message: "late" });
  old.handlers.onClose({ code: 1006, reason: "late", wasClean: false });
  old.handlers.onMessage("late");
  assert.deepEqual(f.events, accepted); assert.equal(f.registry.list("plugin").length, 1);
});

test("releasing a connecting socket settles its caller without waiting for timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sockets(t); let settled = false;
  const pending = f.connect().then(() => { settled = true; }, () => { settled = true; });
  try { f.registry.releasePlugin("plugin"); await nextTurn(); assert.equal(settled, true); }
  finally { t.mock.timers.tick(10001); await pending; }
});

test("socket disposal seals creation and retains resource uncertainty after close", async t => {
  const f = sockets(t, true); await f.connect();
  f.registry.dispose();
  await assert.rejects(f.connect(), { code: "HOST_BUSY" });
  f.transports[0].handlers.onClose({ code: 1000, reason: "", wasClean: true });
  assert.deepEqual(f.registry.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});

test("handoff refuses workspace forwards before connection work", async t => {
  const f = ports(t); f.closeGate();
  await assert.rejects(f.service.open(portInput), { code: "HOST_BUSY" }); assert.deepEqual(f.events, []);
});

test("workspace forward validation cannot cross a closed admission", async t => {
  const f = ports(t), entered = deferred(), release = deferred();
  const pending = f.service.open({ ...portInput, validate: async () => { entered.resolve(); await release.promise; } });
  const rejected = assert.rejects(pending, { code: "HOST_BUSY" });
  await entered.promise; f.closeGate(); release.resolve(); await rejected; assert.deepEqual(f.events, []);
});

test("a late workspace forward is closed on its original owner without browser publication", async t => {
  const entered = deferred(), release = deferred(); let closes = 0;
  const f = ports(t, { connect: async () => { entered.resolve(); return release.promise; } });
  const pending = f.service.open(portInput), rejected = assert.rejects(pending, { code: "HOST_BUSY" });
  await entered.promise; f.closeGate(); release.resolve({ url: "http://127.0.0.1:43210", close: async () => { closes++; } });
  await rejected; assert.equal(closes, 1); assert.deepEqual(f.events, []);
});

test("retired unfinished forwards retain the existing eight-resource limit", async t => {
  const releases = [], ready = deferred();
  const f = ports(t, { connect: async () => { const release = deferred(); releases.push(release);
    if (releases.length === 8) ready.resolve();
    return releases.length > 8 ? { url: "http://127.0.0.1:43210", close: async () => {} } : release.promise; } });
  const pending = Array.from({ length: 8 }, () => f.service.open(portInput).catch(error => error));
  await ready.promise; f.service.closeOwner("plugin");
  try { await assert.rejects(f.service.open(portInput), { code: "LIMIT_EXCEEDED" }); }
  finally { for (const release of releases) release.resolve({ url: "http://127.0.0.1:43210", close: async () => {} }); await Promise.all(pending); }
});

test("retired forward cleanup stays counted and duplicate close joins its original work", async t => {
  const entered = deferred(), release = deferred(); let closes = 0;
  const f = ports(t, { connect: async (_context, _port, owner) => { owner.nativeAttempt();
    return { url: "http://127.0.0.1:43210", close: async () => { closes++; entered.resolve(); await release.promise; } }; } });
  await f.service.open(portInput); f.service.closeOwner("plugin"); await entered.promise; f.service.dispose();
  try { assert.ok(f.service.getHandoffActivity().operations > 0); assert.equal(closes, 1); }
  finally { release.resolve(); await nextTurn(); }
  assert.equal(f.service.getHandoffActivity().operations, 0); assert.ok(f.service.getHandoffActivity().uncontainedResources > 0);
});

test("handoff refuses workspace resource calls before reading or revealing", async t => {
  let reveals = 0; const f = resources(t, { reveal: async () => { reveals++; } }); f.closeGate();
  await assert.rejects(f.service.open({ ...f.input, api: "fs.reveal" }), { code: "HOST_BUSY" });
  assert.equal(f.reads, 0); assert.equal(reveals, 0);
});

test("workspace resource validation cannot publish across closed admission", async t => {
  let reveals = 0; const entered = deferred(), release = deferred();
  const f = resources(t, { reveal: async () => { reveals++; } });
  const pending = f.service.open({ ...f.input, api: "fs.reveal", validate: async () => { entered.resolve(); await release.promise; } });
  const rejected = assert.rejects(pending, { code: "HOST_BUSY" });
  await entered.promise; f.closeGate(); release.resolve(); await rejected; assert.equal(reveals, 0);
});

test("retained HTTP preview refuses new file reads while admission is closed", async t => {
  const f = resources(t); await f.service.open(f.input);
  assert.equal(await (await fetch(f.url)).text(), "<h1>fixture</h1>"); const before = f.reads;
  f.closeGate(); const response = await fetch(f.url); assert.equal(response.status, 404); await response.text();
  assert.equal(f.reads, before);
});

test("a late download selection cannot create a file or open an external application", async t => {
  const root = await mkdtemp(join(tmpdir(), "handoff-copy-")); t.after(() => rm(root, { recursive: true, force: true }));
  const entered = deferred(), release = deferred(); let launches = 0;
  const f = resources(t, { chooseCopy: async () => { entered.resolve(); return release.promise; }, openCopy: async () => { launches++; } });
  const pending = f.service.open({ ...f.input, api: "fs.openDefault" }); const rejected = assert.rejects(pending, { code: "HOST_BUSY" });
  await entered.promise; f.closeGate(); release.resolve(join(root, "copy.html")); await rejected;
  assert.equal(launches, 0); await assert.rejects(access(join(root, "copy.html")), { code: "ENOENT" });
});

test("HTTP reads remain owned after response destruction and owner retirement", async t => {
  const entered = deferred(), release = deferred(); const f = resources(t); let blocked = false;
  await f.service.open({ ...f.input, read: async (api, args) => {
    if (blocked && api === "fs.readRange") { entered.resolve(); await release.promise; }
    return f.input.read(api, args);
  } });
  blocked = true; const response = fetch(f.url).then(res => res.text()).catch(() => undefined);
  await entered.promise; f.service.closeOwner("plugin");
  try { assert.ok(f.service.getHandoffActivity().operations > 0, "original remote read must remain owned"); }
  finally { release.resolve(); await response; await nextTurn(); }
  assert.equal(f.service.getHandoffActivity().operations, 0); assert.ok(f.service.getHandoffActivity().uncontainedResources > 0);
});

test("SSH forward rechecks its original owner after environment preparation", async () => {
  const { createSystemSshTransport } = await import("../electron/main/remote/ssh-transport.ts");
  const transport = createSystemSshTransport({ host: "fixture.invalid" }, { binary: join(tmpdir(), "handoff-fixture-no-such-ssh.exe") });
  let closed = false, attempts = 0;
  const pending = transport.forward({ localPort: 1, remoteHost: "127.0.0.1", remotePort: 3000,
    assertCurrent: () => { if (closed) throw Object.assign(new Error("Host admission is closed"), { code: "HOST_BUSY" }); },
    beforeSpawn: () => { attempts++; } });
  closed = true;
  try { await assert.rejects(pending, { code: "HOST_BUSY" }); assert.equal(attempts, 0); }
  finally { transport.dispose(); }
});

test("workspace forward rechecks synchronously after awaited validation", async t => {
  let attempts = 0;
  const f = ports(t, { connect: async () => { attempts++; return { url: "http://127.0.0.1:43210", close: async () => {} }; } });
  const validate = async () => { queueMicrotask(() => queueMicrotask(f.closeGate)); };
  await assert.rejects(f.service.open({ ...portInput, validate }), { code: "HOST_BUSY" });
  assert.equal(attempts, 0); assert.deepEqual(f.events, []);
});

test("workspace file reads recheck synchronously after awaited validation", async t => {
  const f = resources(t);
  const validate = async () => { queueMicrotask(() => queueMicrotask(f.closeGate)); };
  await assert.rejects(f.service.open({ ...f.input, api: "fs.reveal", validate }), { code: "HOST_BUSY" });
  assert.equal(f.reads, 0);
});

test("temporary handoff admission does not stop an already active workspace forward", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = ports(t); await f.service.open(portInput); f.closeGate();
  t.mock.timers.tick(5000); await nextTurn();
  assert.deepEqual(f.events, ["connect", "browser"]);
  assert.equal(f.service.getHandoffActivity().resources, 1);
});

test("an in-flight forward validation remains owned when admission closes", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred(), release = deferred(); let polling = false;
  const f = ports(t);
  await f.service.open({ ...portInput, validate: async () => { if (polling) { entered.resolve(); await release.promise; } } });
  polling = true; t.mock.timers.tick(5000); await entered.promise; f.closeGate();
  try { assert.ok(f.service.getHandoffActivity().operations > 0); }
  finally { release.resolve(); await nextTurn(); }
  assert.deepEqual(f.events, ["connect", "browser"]);
  assert.equal(f.service.getHandoffActivity().operations, 0); assert.equal(f.service.getHandoffActivity().resources, 1);
});

test("configured external resource services without activity reporting fail closed", async () => {
  const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
  const runtime = new PluginRuntime({ isAdmissionClosed: () => false, openWorkspaceResource: async () => {} });
  try { assert.equal(runtime.getHandoffActivity().uncontainedResources, 1); }
  finally { await runtime.disposeAll(); }
});
