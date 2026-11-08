import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginWebSocketRegistry } = await import("../electron/main/plugin-websocket.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const runner = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Original fixture resource did not settle")), 5000);
  })]); } finally { clearTimeout(timer); }
}

test("real plugin websocket traffic, admission closure and unload retain original resource evidence", { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "plugin-external-path-")), id = "test.external-handoff";
  const previous = process.env.PI_DESKTOP_DATA_DIR; process.env.PI_DESKTOP_DATA_DIR = root;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const peers = [], records = [], admission = new DesktopHandoffAdmission();
  const sockets = new PluginWebSocketRegistry({ isAdmissionClosed: () => admission.isClosed(),
    onEvent: (pluginId, event) => runtime.deliverSocketEvent(pluginId, event) });
  const runtime = new PluginRuntime({ isAdmissionClosed: () => admission.isClosed(), hostEntry: runner, pluginSockets: sockets,
    spawnProcess: ({ entry, assertCurrent }) => {
      assertCurrent?.(); const env = {};
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key] !== undefined) env[key] = process.env[key];
      Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, APPDATA: root, LOCALAPPDATA: root,
        PI_DESKTOP_DATA_DIR: root, PI_DESKTOP_AGENTS_DIR: join(root, "agents") });
      const child = fork(entry, [], { cwd: root, env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = { child, closed: Promise.withResolvers(), exited: false, stderr: "" }; records.push(record);
      child.stdout.resume(); child.stderr.on("data", bytes => { record.stderr = (record.stderr + bytes).slice(-8192); });
      child.on("error", error => record.closed.reject(error)); child.on("exit", () => { record.exited = true; });
      child.on("close", () => record.closed.resolve());
      return { postMessage: message => child.send(message), onMessage: handler => child.on("message", handler),
        onExit: handler => child.on("exit", code => handler(code ?? 0)), kill: () => child.kill() };
    } });
  server.on("connection", socket => {
    const closed = Promise.withResolvers(); peers.push({ socket, closed }); socket.once("close", closed.resolve);
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  t.after(async () => {
    admission.dispose(); await runtime.disposeAll(); sockets.dispose();
    for (const record of records) { if (!record.exited) record.child.kill(); await bounded(record.closed.promise); assert.equal(record.stderr, ""); }
    for (const peer of peers) { if (peer.socket.readyState !== 3) peer.socket.terminate(); await bounded(peer.closed.promise); }
    await bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR; else process.env.PI_DESKTOP_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ originalProcesses: records.length, originalExitsObserved: records.every(record => record.exited),
      closedLoopbackPeers: peers.length, qualifiedNativeFamilyClosure: false, socketActivity: sockets.getHandoffActivity(), activity: runtime.getHandoffActivity() }));
  });
  await bounded(new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); }));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: "External fixture", version: "1.0.0",
    main: "main.js", permissions: ["net.websocket"], net: { domains: ["127.0.0.1"] } }));
  writeFileSync(join(root, "main.js"), `let socketId, answer;
module.exports = {
  onLoad() { pi.events.on('net:websocket:message', event => { answer?.(event.data); answer = undefined; }); },
  async onPanelInvoke(channel, payload) {
    if (channel === 'connect') { ({ socketId } = await pi.net.websocket.connect({ url: payload.url })); return socketId; }
    if (channel === 'echo') { const received = new Promise(resolve => { answer = resolve; }); await pi.net.websocket.send({ socketId, data: payload }); return received; }
  },
  onUnload() { return socketId ? pi.net.websocket.close({ socketId }) : undefined; }
};\n`);
  // Zeroes describe only absent owners in this isolated fixture, never the Desktop inventory.
  const inspect = async () => { const activity = runtime.getHandoffActivity(); return {
    clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: activity.plugins,
    admissions: activity.operations, finalizations: 0, writes: 0, children: 0, workers: 0, schedules: activity.schedules,
    approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: activity.uncontainedResources }; };
  const hold = await admission.gate.acquireHandoff(randomUUID(), inspect);
  await assert.rejects(runtime.loadFromPath(root), { code: "HOST_BUSY" }); assert.equal(records.length, 0); hold.cancel();
  await runtime.loadFromPath(root);
  await runtime.invokePanelBridge(id, "connect", { url: `ws://127.0.0.1:${server.address().port}/fixture` });
  assert.equal(await runtime.invokePanelBridge(id, "echo", "original payload"), "original payload");
  assert.equal(sockets.getHandoffActivity().resources, 1); assert.ok(runtime.getHandoffActivity().operations > 0);
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
  admission.dispose(); await assert.rejects(runtime.invokePanelBridge(id, "echo", "refused"), { code: "HOST_BUSY" });
  await runtime.unload(id); await bounded(records[0].closed.promise); await bounded(peers[0].closed.promise);
  assert.deepEqual(sockets.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
  assert.equal(runtime.getHandoffActivity().operations, 0); assert.equal(runtime.getHandoffActivity().plugins, 0);
  assert.ok(runtime.getHandoffActivity().uncontainedResources >= 2);
});
