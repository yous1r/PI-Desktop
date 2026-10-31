import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { IPC } from "@pi-desktop/shared";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";

const SERVER = String.raw`
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} } }
    : request.method === "tools/list"
      ? { tools: [{ name: "lookup", description: "Memory fixture lookup", inputSchema: { type: "object", properties: {} } }] }
      : request.method === "tools/call"
        ? { content: [{ type: "text", text: "memory-ready" }] }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;

async function fixture(t, { enabled = true, failLoad = false, market = false, beforeRefresh = async () => {} } = {}) {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-plugin-mcp-install-"));
  const pluginPath = join(root, "plugin");
  const configPath = join(root, "servers", "memory-fixture.json");
  await mkdir(pluginPath);
  await writeFile(join(root, "server.mjs"), SERVER);
  const manifest = { id: "fixture.workflow", name: "Workflow fixture", version: "0.3.0", permissions: [] };
  await writeFile(join(pluginPath, "manifest.json"), JSON.stringify(manifest));
  const plugin = { id: manifest.id, enabled, path: pluginPath, permissions: [], source: "installed" };
  const events = [];
  const handlers = new Map();
  const childExits = [];
  const runtime = new UserMcpRuntime({
    createClient: (config) => new McpServerClient({ ...config, spawnImpl: (...args) => {
      const child = spawn(...args);
      childExits.push(new Promise((resolve) => child.once("close", resolve)));
      return child;
    } }),
    connectTimeoutMs: 5000,
    callTimeoutMs: 5000,
  });
  t.after(async () => {
    runtime.disposeAll();
    await Promise.all(childExits);
    await rm(root, { recursive: true, force: true });
  });
  const record = { id: "memory-fixture", label: "Memory fixture", transport: "stdio", command: "node", args: [join(root, "server.mjs")], env: { PATH: dirname(process.execPath) }, enabled: true, scope: { mode: "global", projects: [] } };
  const file = new URL(market ? "../electron/main/ipc/market-ipc.ts" : "../electron/main/ipc/plugin-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const dependencies = {
    electron: { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [pluginPath] }) } },
    "@pi-desktop/shared": { IPC },
    "@pi-desktop/plugin-devkit": {},
    "../browser-host": { BROWSER_PLUGIN_ID: "pi-desktop/browser" },
    "../builtin-commands": { builtinPaletteItems: () => [] },
    "../plugin-runtime": { readDevPluginDeclaration: () => ({ manifest, permissions: [], fs: {} }), widenedFsScope: () => [] },
    "../plugin-view-host": {},
    "../plugin-renderer-extension": {},
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected IPC dependency: ${id}`);
    return dependencies[id];
  }, module.exports, module);
  (market ? module.exports.registerMarketIpc : module.exports.registerPluginIpc)({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler), handleWithEvent: () => {}, assertMainWindowSender: () => {} },
    getHost: () => ({
      async call(method) {
        if (method === "plugins.installFromPath" || method === "plugins.installFromPackage" || method === "market.install") return { result: { plugin } };
        if (method === "market.applyUpdates") return { results: [{ plugin }] };
        if (method === "plugins.list") return { plugins: [plugin] };
        if (method === "plugins.enable" || method === "plugins.loadDev") return { plugin };
        throw new Error(`Unexpected host call: ${method}`);
      },
    }),
    plugins: {
      async loadFromPath() {
        events.push("load");
        if (failLoad) throw new Error("Fixture onLoad failed");
        // This is the plugin-process boundary: onLoad writes the real config before resolving.
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(record));
        events.push("loaded");
      },
      drainToasts: () => [],
      watchDevPlugin: () => {},
    },
    refreshUserMcp: async () => {
      events.push("refresh");
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      await beforeRefresh();
      runtime.setRecords([saved]);
      return [saved];
    },
    agentExtensions: {}, browserHost: {}, pluginViews: {}, pluginScopes: new Map(),
    rememberPluginScopes: () => {}, logger: { app: () => {} },
    optionalWorkspaceRoot: async () => root, pluginActiveInProject: () => true,
    sendToRenderer(channel) { if (channel === IPC.event.pluginChanged) events.push("changed"); },
  });
  return { runtime, root, events, invoke: (channel, ...args) => handlers.get(channel)(...args) };
}

for (const [name, channel, args, market = false] of [
  ["directory install", IPC.invoke.pluginInstallFromPath, []],
  ["package install", IPC.invoke.pluginInstallFromPackage, []],
  ["enable", IPC.invoke.pluginEnable, ["fixture.workflow"]],
  ["reload", IPC.invoke.pluginReload, ["fixture.workflow"]],
  ["development load", IPC.invoke.pluginLoadDevConfirm, null],
  ["market install", IPC.invoke.marketInstall, [{ id: "fixture.workflow" }], true],
  ["market update", IPC.invoke.marketApplyUpdates, [{ onlyAuto: true }], true],
]) {
  test(`${name} discovers an onLoad-provisioned MCP server before notifying the UI`, async (t) => {
    const { runtime, root, events, invoke } = await fixture(t, { market });
    await invoke(channel, ...(args ?? [{ path: join(root, "plugin"), grantedPermissions: [] }]));
    assert.deepEqual(events, ["load", "loaded", "refresh", "changed"]);
    assert.deepEqual(runtime.listRecords().map((server) => server.id), ["memory-fixture"]);
    assert.equal(runtime.statusFor("memory-fixture").state, "idle", "installation must keep MCP connection lazy");
    const tools = await runtime.toolsForProject(root);
    assert.deepEqual(tools.map((tool) => tool.fullName), ["mcp_memory_fixture_lookup"]);
    const result = await runtime.callTool(tools[0].fullName, {}, root);
    assert.equal(result.content[0].text, "memory-ready", "the tool is usable without manually restarting MCP");
  });
}

test("install awaits the record refresh before resolving or notifying the UI", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { runtime, events, invoke } = await fixture(t, { beforeRefresh: async () => { entered.resolve(); await release.promise; } });
  let settled = false;
  const installing = invoke(IPC.invoke.pluginInstallFromPackage).finally(() => { settled = true; });
  try {
    await entered.promise;
    assert.equal(settled, false);
    assert.deepEqual(runtime.listRecords(), []);
    assert.equal(events.includes("changed"), false);
  } finally { release.resolve(); }
  await installing;
  assert.deepEqual(runtime.listRecords().map((server) => server.id), ["memory-fixture"]);
});

test("a failed onLoad does not refresh or advertise a successful install", async (t) => {
  const { runtime, events, invoke } = await fixture(t, { failLoad: true });
  await assert.rejects(invoke(IPC.invoke.pluginInstallFromPackage), /Fixture onLoad failed/);
  assert.deepEqual(runtime.listRecords(), []);
  assert.deepEqual(events, ["load"]);
});

test("an installed but disabled plugin does not load or start MCP", async (t) => {
  const { runtime, events, invoke } = await fixture(t, { enabled: false });
  await invoke(IPC.invoke.pluginInstallFromPackage);
  assert.deepEqual(runtime.listRecords(), []);
  assert.deepEqual(events, ["changed"]);
});
