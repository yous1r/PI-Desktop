import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Original plugin process did not close")), 5000);
  })]); } finally { clearTimeout(timer); }
}
function fixture(t, delayed = false, services = {}) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-native-lifecycle-"));
  const id = "test.native-handoff";
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: "Native lifecycle fixture",
    version: "1.0.0", main: "main.js", permissions: ["background.service", "agent.tool.register", "desktop.control"],
    contributes: { services: [{ id: "worker" }], commands: [{ id: "ping", title: "Ping" }] } }));
  writeFileSync(join(root, "main.js"), `module.exports = {
    async onLoad() {
      pi.services.register({ id: "worker", start: () => pi.ui.showToast("started"), stop: () => pi.ui.showToast("stopped") });
      await pi.commands.register({ id: "ping", title: "Ping", run: () => pi.ui.showToast("command") });
      await pi.agent.registerTool({ name: "wait", description: "Wait for host work", schema: { type: "object" },
        execute: () => pi.desktop.invoke({ operation: "session/get", args: ["isolated"] }) });
    },
    onUnload() { return pi.ui.showToast("unloaded"); }
  };\n`);
  const admission = new DesktopHandoffAdmission(), records = [], release = Promise.withResolvers(), spawned = Promise.withResolvers();
  const runtime = new PluginRuntime({ isAdmissionClosed: () => admission.isClosed(), hostEntry,
    spawnProcess: async ({ entry, assertCurrent }) => {
      assertCurrent?.();
      const env = {};
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, APPDATA: root, LOCALAPPDATA: root,
        PI_DESKTOP_DATA_DIR: root, PI_DESKTOP_AGENTS_DIR: join(root, "agents") });
      const child = fork(entry, [], { cwd: root, env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = { child, closed: Promise.withResolvers(), exited: false, initialized: false, stderr: "" };
      records.push(record);
      child.stdout.resume();
      child.stderr.on("data", bytes => { record.stderr = (record.stderr + bytes.toString()).slice(-8192); });
      child.on("error", error => record.closed.reject(error));
      child.on("exit", () => { record.exited = true; });
      child.on("close", () => record.closed.resolve());
      child.once("spawn", () => spawned.resolve());
      const handle = { postMessage(message) { if (message.t === "init") record.initialized = true; child.send(message); },
        onMessage: handler => child.on("message", handler), onExit: handler => child.on("exit", code => handler(code ?? 0)),
        kill: () => { child.kill(); } };
      if (delayed) await release.promise;
      return handle;
    },
    ...services,
  });
  // These absent families describe only this isolated fixture, not the Desktop aggregate.
  const inspect = async () => {
    const activity = runtime.getHandoffActivity();
    return { clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0,
      plugins: activity.plugins, admissions: activity.operations, finalizations: 0, writes: 0, children: 0,
      workers: 0, schedules: activity.schedules, approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0,
      uncontainedResources: activity.uncontainedResources };
  };
  t.after(async () => {
    release.resolve();admission.dispose();await runtime.disposeAll();
    for (const record of records) {
      if (!record.exited) record.child.kill();
      await bounded(record.closed.promise);
      assert.equal(record.stderr, "");
    }
    rmSync(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ originalProcesses: records.length, originalExitsObserved: records.every(record => record.exited),
      qualifiedNativeFamilyClosure: false, activity: runtime.getHandoffActivity() }));
  });
  return { root, id, runtime, admission, records, release, spawned, inspect };
}

test("a real plugin service keeps handoff refused through unload, reload and shutdown", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const hold = await f.admission.gate.acquireHandoff(randomUUID(), f.inspect);
  await assert.rejects(f.runtime.loadFromPath(f.root), { code: "HOST_BUSY" });
  assert.equal(f.records.length, 0);
  hold.cancel();
  await f.runtime.loadFromPath(f.root);
  assert.equal(f.runtime.getServiceStates()[0].state, "running");
  await f.runtime.getCommands()[0].run();
  assert.deepEqual(f.runtime.drainToasts(), ["started", "command"]);
  await assert.rejects(f.admission.gate.acquireHandoff(randomUUID(), f.inspect), { code: "HOST_BUSY" });
  await f.runtime.unload(f.id);
  await bounded(f.records[0].closed.promise);
  assert.deepEqual(f.runtime.drainToasts(), ["stopped", "unloaded"]);
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.equal(f.runtime.getHandoffActivity().plugins, 0);
  await assert.rejects(f.admission.gate.acquireHandoff(randomUUID(), f.inspect), { code: "HOST_BUSY" });
  await f.runtime.loadFromPath(f.root);
  assert.equal(f.records.length, 2);
  f.admission.dispose();
  await f.runtime.disposeAll();
  await bounded(f.records[1].closed.promise);
  assert.deepEqual(f.runtime.drainToasts(), ["started", "stopped", "unloaded"]);
  await assert.rejects(f.runtime.loadFromPath(f.root), { code: "PLUGIN_UNLOADED" });
});

test("shutdown retains and closes an original real child returned after the budget owner retired", { timeout: 15000 }, async t => {
  const f = fixture(t, true);
  const loading = f.runtime.loadFromPath(f.root).then(() => null, error => error);
  await bounded(f.spawned.promise);
  await f.runtime.disposeAll();
  assert.ok(f.runtime.getHandoffActivity().operations > 0);
  f.release.resolve();
  assert.equal((await loading).code, "PLUGIN_UNLOADED");
  await bounded(f.records[0].closed.promise);
  assert.equal(f.records[0].initialized, false);
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.equal(f.runtime.getHandoffActivity().uncontainedResources, 1);
});

test("real tool cancellation and original child exit retain unfinished host callbacks", { timeout: 15000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, false, { desktopControl: { operations: [{ id: "session/get", risk: "read" }],
    invoke: async () => { entered.resolve(); await release.promise; return {}; } } });
  t.after(() => release.resolve());
  await f.runtime.loadFromPath(f.root);
  const tool = f.runtime.getTools().find(item => item.name === "wait"); assert.ok(tool);
  const pending = tool.execute({}, { sessionId: "isolated" });
  const cancelled = assert.rejects(pending, { code: "PLUGIN_TOOL_ABORTED" });
  await bounded(entered.promise);
  f.runtime.cancelSessionTools("isolated"); await cancelled;
  f.admission.dispose(); await f.runtime.unload(f.id);
  await bounded(f.records[0].closed.promise);
  assert.ok(f.runtime.getHandoffActivity().operations > 0);
  release.resolve(); await setImmediate();
  assert.equal(f.runtime.getHandoffActivity().operations, 0);
  assert.ok(f.runtime.getHandoffActivity().uncontainedResources > 0);
  assert.deepEqual(f.runtime.drainToasts(), ["started", "stopped", "unloaded"]);
});
