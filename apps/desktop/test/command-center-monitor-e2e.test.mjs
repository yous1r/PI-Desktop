import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

/**
 * End-to-end monitor path through the real main IPC handler and preload
 * contract, over a fake RACP-backed remote Host. No socket, no Electron and no
 * renderer RACP access: the only boundary is the fixed preload bridge.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const requireFromAgentRuntime = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = requireFromAgentRuntime("esbuild");
const summaryFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const workspaces = summaryFixture.workspaces.workspaces;
const receiptFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);

async function loadModule(entry, globals = {}) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    external: ["electron"],
  });
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (name) => { throw new Error(`unexpected external require: ${name}`); },
    process,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console,
    ...globals,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(result.outputFiles[0].text, context);
  return { exports: sandbox.module.exports, sandbox, context };
}

async function loadPreload(invoke) {
  const result = await build({
    entryPoints: [join(root, "apps/desktop/electron/preload/index.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    external: ["electron"],
  });
  let bridge;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "piDesktop"); bridge = value; } },
    ipcRenderer: { invoke, on() {}, removeListener() {} },
    webUtils: { getPathForFile: () => null },
  };
  vm.runInNewContext(result.outputFiles[0].text, {
    module: { exports: {} },
    exports: {},
    require: (name) => {
      assert.equal(name, "electron");
      return electron;
    },
    process: { platform: "win32", argv: [] },
    window: {},
    document: {},
    URL,
    URLSearchParams,
    File: class {},
  });
  return bridge;
}

const contractModule = await loadModule("apps/desktop/electron/preload/command-center-contract.ts");
const contract = contractModule.exports;
const ipcModule = await loadModule("apps/desktop/electron/main/ipc/command-center-ipc.ts");
const { registerCommandCenterIpc } = ipcModule.exports;

const server = await createServer({
  root: `${root}/apps/desktop`,
  configFile: false,
  logLevel: "silent",
  resolve: { alias: currentSourceAliases(root) },
  server: { middlewareMode: true, hmr: false, ws: false },
  esbuild: { jsx: "automatic" },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
test.after(() => server.close());

const TRANSPORT_ENTRY = "apps/desktop/src/features/command-center/command-center-transport.ts";
const bootstrap = await server.ssrLoadModule("/src/features/command-center/command-center-bootstrap.ts");

function rowsFor(id, workspaceId) {
  return {
    ...structuredClone(summaryFixture.snapshot.rows[0]),
    target: { kind: "session", sessionId: `sess-${id}` },
    execution: { kind: "session", sessionId: `sess-${id}`, turnId: `turn-${id}` },
    commandWorkspaceId: workspaceId,
    label: `Task ${id}`,
  };
}

function pageFor(epoch, letters, nextPage) {
  return {
    version: 1,
    cursor: { epoch, sequence: 7 },
    generatedAt: "2026-01-01T00:00:00.000Z",
    rows: letters.map((letter) => rowsFor(letter, workspaces[0].id)),
    ...(nextPage === undefined ? {} : { nextPage }),
  };
}

function fakeHost(hostKey, label, { paged = false } = {}) {
  const calls = [];
  return {
    hostKey, label,
    commandCenter: true,
    hostId: `host-${hostKey}`,
    expectedHostEpoch: "66666666-6666-4666-8666-666666666666",
    calls,
    async page(request) {
      calls.push(["monitorPage", request]);
      if (!paged) return pageFor(`epoch-${hostKey}`, ["b"]);
      if (request.token === undefined) return pageFor(`epoch-${hostKey}`, ["a1"], "cursor-a-2");
      if (request.token === "cursor-a-2") return pageFor(`epoch-${hostKey}`, ["a2"]);
      throw Object.assign(new Error("cursor expired"), { errorCode: "INVALID_ARGUMENT" });
    },
  };
}

function makeBoot(hostList) {
  const removed = new Set();
  const boot = {
    hosts: hostList,
    close(hostKey) { removed.add(hostKey); },
    capabilityHosts() {
      return hostList.filter((host) => !removed.has(host.hostKey) && host.commandCenter);
    },
    calls: [],
    commandCenterHosts() {
      return boot.capabilityHosts().map(({ calls: _calls, ...descriptor }) => descriptor);
    },
    async commandCenterMonitorPage(hostKey, request) {
      const host = hostList.find((candidate) => candidate.hostKey === hostKey && !removed.has(hostKey));
      if (!host) throw Object.assign(new Error("host closed"), { errorCode: "AGENT_UNAVAILABLE" });
      boot.calls.push(["page", hostKey, request]);
      return host.page(request);
    },
    async commandCenterPing(hostKey) {
      if (!hostList.some((host) => host.hostKey === hostKey && !removed.has(hostKey))) {
        throw Object.assign(new Error("host closed"), { errorCode: "AGENT_UNAVAILABLE" });
      }
      return { ok: true, serverTime: "2026-01-01T00:00:00.000Z" };
    },
    async commandCenterWorkspaceList(hostKey) {
      boot.calls.push(["workspaces", hostKey]);
      return { workspaces: [structuredClone(workspaces[hostKey === "b" ? 1 : 0])] };
    },
    async commandCenterReceiptList(hostKey, request) {
      boot.calls.push(["receipts", hostKey, request]);
      return { receipts: [structuredClone(receiptFixture.receipts.accepted)], nextAfterSequence: null };
    },
  };
  return boot;
}

async function bridgeOver(boot) {
  const handlers = new Map();
  registerCommandCenterIpc({
    registrar: {
      ipcMain: {},
      handle: (channel, handler) => handlers.set(channel, handler),
      handleWithEvent: () => {},
      assertMainWindowSender: () => {},
    },
    getBoot: () => boot,
  });
  const invoke = async (channel, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) return { ok: false, error: { code: "NOT_FOUND", message: `missing channel ${channel}` } };
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.errorCode ?? "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  const bridge = await loadPreload(invoke);
  const transportModule = await loadModule(TRANSPORT_ENTRY, {
    window: { piDesktop: bridge },
  });
  const transport = transportModule.exports.commandCenterTransportFromWindow();
  assert.ok(transport, "the renderer transport must be built from the preload bridge");
  return { bridge, transport };
}

test("no capable Host keeps the offline fixture with no monitor fetch", async () => {
  const boot = makeBoot([{ ...fakeHost("c", "C"), commandCenter: false }]);
  const { bridge, transport } = await bridgeOver(boot);
  assert.deepEqual(JSON.parse(JSON.stringify(await bridge.commandCenter.hosts())), []);
  assert.equal(await bridge.commandCenter.observationHost(), null);
  const cleanup = await bootstrap.bootstrapCommandCenterFromTransport(transport);
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
  assert.deepEqual(boot.calls, []);
  cleanup();
});

test("capability present renders monitor rows, forwards cursor/bounds, and selection switches source", async () => {
  const hostA = fakeHost("a", "Alpha", { paged: true });
  const hostB = fakeHost("b", "Beta");
  const boot = makeBoot([hostA, hostB]);
  const { bridge, transport } = await bridgeOver(boot);

  const cleanupA = await bootstrap.bootstrapCommandCenterFromTransport(transport);
  const providerA = bootstrap.getCommandCenterLiveProvider();
  assert.ok(providerA);
  await new Promise((done) => setImmediate(done));
  assert.equal((await providerA.refresh()).kind, "published");
  const stateA = providerA.getState();
  assert.equal(stateA.host.state, "connected");
  assert.deepEqual(stateA.snapshot.rows.map((row) => row.label), ["Task a1", "Task a2"]);
  assert.deepEqual(stateA.workspaces.map((workspace) => workspace.name), [workspaces[0].name]);
  assert.equal(stateA.receipts.length, 1);

  // First page then the continuation token from the Host, plus bounded receipt paging.
  const pageCalls = hostA.calls.filter((call) => call[0] === "monitorPage");
  assert.deepEqual(JSON.parse(JSON.stringify(pageCalls.map((call) => call[1]))), [
    { version: 1 }, { version: 1, token: "cursor-a-2" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(boot.calls.filter((call) => call[0] === "receipts").map((call) => call[2]))), [
    { afterSequence: 0, limit: 100 },
  ]);
  await assert.rejects(bridge.commandCenter.receiptList("a", { afterSequence: 0, limit: 101 }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
  await assert.rejects(bridge.commandCenter.monitorPage("a", { version: 1, token: "x".repeat(513) }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });

  cleanupA();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);

  const selected = await bridge.commandCenter.selectHost("b");
  assert.equal(selected.hostKey, "b");
  assert.equal((await bridge.commandCenter.observationHost()).hostKey, "b");
  const cleanupB = await bootstrap.bootstrapCommandCenterFromTransport(transport);
  const providerB = bootstrap.getCommandCenterLiveProvider();
  assert.ok(providerB);
  await new Promise((done) => setImmediate(done));
  assert.equal((await providerB.refresh()).kind, "published");
  assert.deepEqual(providerB.getState().snapshot.rows.map((row) => row.label), ["Task b"]);
  assert.deepEqual(providerB.getState().workspaces.map((workspace) => workspace.name), [workspaces[1].name]);
  cleanupB();

  assert.equal((await bridge.commandCenter.selectHost(null)).hostKey, "a");
  assert.equal((await bridge.commandCenter.observationHost()).hostKey, "a", "clearing selection restores the first capable Host");
});

test("closing the selected Host falls back and the provider fails closed", async () => {
  const boot = makeBoot([fakeHost("a", "Alpha"), fakeHost("b", "Beta")]);
  const { bridge, transport } = await bridgeOver(boot);
  await bridge.commandCenter.selectHost("b");
  const cleanup = await bootstrap.bootstrapCommandCenterFromTransport(transport);
  const provider = bootstrap.getCommandCenterLiveProvider();
  assert.ok(provider);
  await new Promise((done) => setImmediate(done));
  assert.equal((await provider.refresh()).kind, "published");
  const before = provider.getState().snapshot;

  boot.close("b");
  assert.equal((await bridge.commandCenter.observationHost()).hostKey, "a", "selection falls back after close");
  assert.equal((await provider.refresh()).kind, "failed", "the old provider cannot read the closed Host");
  assert.deepEqual(
    JSON.parse(JSON.stringify(provider.getState().snapshot)),
    JSON.parse(JSON.stringify(before)),
    "no rows are invented after close",
  );
  cleanup();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
});
