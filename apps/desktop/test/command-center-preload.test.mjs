import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";


/**
 * Fixed command-center renderer bridge.
 *
 * The preload bundle is executed against a fake Electron API (no window, no
 * socket). The main IPC module is loaded from source and driven through a fake
 * registrar and remote-host bridge port, so channel names, validation and
 * Result unwrapping are covered without Electron.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const requireFromAgentRuntime = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = requireFromAgentRuntime("esbuild");

const CHANNELS = {
  capability: "pi-desktop/command-center/capability",
  selection: "pi-desktop/command-center/selection",
  observationHost: "pi-desktop/command-center/observationHost",
  monitorPage: "pi-desktop/command-center/monitorPage",
  ping: "pi-desktop/command-center/ping",
  workspaceList: "pi-desktop/command-center/workspaceList",
  receiptList: "pi-desktop/command-center/receiptList",
};

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
      assert.equal(name, "electron", "preload must only require electron");
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

test("the preload bridge exposes only fixed command-center channels and unwraps Result", async () => {
  const calls = [];
  const bridge = await loadPreload(async (channel, ...args) => {
    calls.push({ channel, args });
    if (channel === CHANNELS.capability) {
      return { ok: true, data: [{ hostKey: "remote:one", label: "One", hostId: "host_1", expectedHostEpoch: "e", commandCenter: true }] };
    }
    if (channel === CHANNELS.ping) return { ok: true, data: { ok: true, serverTime: "2026-01-01T00:00:00.000Z" } };
    return { ok: true, data: { echoed: channel, args } };
  });

  assert.ok(bridge.commandCenter, "the dedicated commandCenter bridge is exposed");
  assert.deepEqual(await bridge.commandCenter.hosts(), [
    { hostKey: "remote:one", label: "One", hostId: "host_1", expectedHostEpoch: "e", commandCenter: true },
  ]);
  assert.deepEqual(await bridge.commandCenter.monitorPage("remote:one", { version: 1, token: "page-token-9" }), {
    echoed: CHANNELS.monitorPage, args: ["remote:one", { version: 1, token: "page-token-9" }],
  });
  assert.deepEqual(await bridge.commandCenter.ping("remote:one"), { ok: true, serverTime: "2026-01-01T00:00:00.000Z" });
  assert.equal((await bridge.commandCenter.selectHost("remote:one")).echoed, CHANNELS.selection);
  assert.equal((await bridge.commandCenter.observationHost()).echoed, CHANNELS.observationHost);
  assert.equal((await bridge.commandCenter.selectHost(null)).echoed, CHANNELS.selection);
  await bridge.commandCenter.workspaceList("remote:one");
  await bridge.commandCenter.receiptList("remote:one", { afterSequence: 0, limit: 10 });
  assert.deepEqual(calls.map((call) => call.channel), [
    CHANNELS.capability, CHANNELS.monitorPage, CHANNELS.ping,
    CHANNELS.selection, CHANNELS.observationHost, CHANNELS.selection,
    CHANNELS.workspaceList, CHANNELS.receiptList,
  ]);

  // Dedicated channels are not reachable through the generic whitelist.
  await assert.rejects(bridge.invoke(CHANNELS.capability), /IPC channel not allowed/);
  await assert.rejects(bridge.invoke("electron/unsafe"), /IPC channel not allowed/);
});

test("the preload bridge turns an error Result into a coded Error", async () => {
  const bridge = await loadPreload(async () => ({
    ok: false,
    error: { code: "CAPABILITY_UNAVAILABLE", message: "not offered", retriable: false },
  }));
  await assert.rejects(bridge.commandCenter.monitorPage("remote:one", { version: 1 }), (error) => {
    assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(error.message, "not offered");
    return true;
  });
  await assert.rejects(bridge.commandCenter.hosts(), (error) => {
    assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
    return true;
  });
});

async function loadModule(entry) {
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
    require: () => { throw new Error("unexpected external require"); },
    process,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console,
  };
  vm.runInNewContext(result.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}

function register(registerCommandCenterIpc, boot) {
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
  return handlers;
}

test("the main IPC module validates inputs and forwards only to the bridge port", async () => {
  const { registerCommandCenterIpc } = await loadModule("apps/desktop/electron/main/ipc/command-center-ipc.ts");
  const contract = await loadModule("apps/desktop/electron/preload/command-center-contract.ts");
  const calls = [];
  const boot = {
    commandCenterHosts: () => [{ hostKey: "remote:one", label: "One", hostId: "host_1", expectedHostEpoch: "e", commandCenter: true }],
    commandCenterMonitorPage: async (hostKey, request) => { calls.push(["page", hostKey, request]); return { page: true }; },
    commandCenterPing: async (hostKey) => { calls.push(["ping", hostKey]); return { ok: true, serverTime: "2026-01-01T00:00:00.000Z" }; },
    commandCenterWorkspaceList: async (hostKey) => { calls.push(["workspaces", hostKey]); return { workspaces: [] }; },
    commandCenterReceiptList: async (hostKey, request) => { calls.push(["receipts", hostKey, request]); return { receipts: [], nextAfterSequence: null }; },
  };
  const handlers = register(registerCommandCenterIpc, boot);
  assert.deepEqual([...handlers.keys()].sort(), Object.values(contract.COMMAND_CENTER_IPC).sort());

  assert.equal((await handlers.get(contract.COMMAND_CENTER_IPC.capability)()).length, 1);
  assert.deepEqual(await handlers.get(contract.COMMAND_CENTER_IPC.monitorPage)("remote:one", { version: 1, token: "t1" }), { page: true });
  await handlers.get(contract.COMMAND_CENTER_IPC.ping)("remote:one");
  await handlers.get(contract.COMMAND_CENTER_IPC.workspaceList)("remote:one");
  await handlers.get(contract.COMMAND_CENTER_IPC.receiptList)("remote:one", { afterSequence: 2, limit: 50 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["page", "remote:one", { version: 1, token: "t1" }],
    ["ping", "remote:one"],
    ["workspaces", "remote:one"],
    ["receipts", "remote:one", { afterSequence: 2, limit: 50 }],
  ]);

  for (const [channel, args] of [
    [contract.COMMAND_CENTER_IPC.monitorPage, ["", { version: 1 }]],
    [contract.COMMAND_CENTER_IPC.monitorPage, ["remote:one", { version: 2 }]],
    [contract.COMMAND_CENTER_IPC.monitorPage, ["remote:one", { version: 1, extra: true }]],
    [contract.COMMAND_CENTER_IPC.receiptList, ["remote:one", { afterSequence: -1, limit: 10 }]],
    [contract.COMMAND_CENTER_IPC.receiptList, ["remote:one", { afterSequence: 0, limit: 101 }]],
  ]) {
    await assert.rejects(handlers.get(channel)(...args), (error) => {
      assert.equal(error.errorCode, "INVALID_ARGUMENT");
      return true;
    });
  }
});

test("the main IPC module stays unavailable when no remote-host bridge is wired", async () => {
  const { registerCommandCenterIpc } = await loadModule("apps/desktop/electron/main/ipc/command-center-ipc.ts");
  const contract = await loadModule("apps/desktop/electron/preload/command-center-contract.ts");
  const handlers = register(registerCommandCenterIpc, null);
  assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get(contract.COMMAND_CENTER_IPC.capability)())), []);
  await assert.rejects(handlers.get(contract.COMMAND_CENTER_IPC.monitorPage)("remote:one", { version: 1 }), (error) => {
    assert.equal(error.errorCode, "AGENT_UNAVAILABLE");
    return true;
  });
});
