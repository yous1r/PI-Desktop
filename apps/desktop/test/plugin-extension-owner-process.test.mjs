import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { createPluginExtensionOwnerBridge } = await import("../electron/main/plugin-extension-owner-bridge.ts");
const { PluginExtensionLaunchBindings } = await import("../electron/main/plugin-extension-launch-bindings.ts");
const { createOwnerFileReader } = await import("../electron/main/plugin-owner-files.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, onInvoke) {
  const root = mkdtempSync(join(tmpdir(), "pi-owner-process-"));
  const permissions = ["agent.extension", "desktop.control", "fs.read"];
  const operations = [{ name: "recall", readOnly: true }, { name: "capture", readOnly: false }];
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "demo.owner", name: "Owner", version: "1.0.0",
    main: "main.cjs", permissions, fs: { read: { root: "workspace", scope: [".ai-memory.toml"] } },
    contributes: { agentExtensions: ["extension.mjs"], agentExtensionOperations: operations } }));
  writeFileSync(join(root, "extension.mjs"), "export default function () {};");
  writeFileSync(join(root, ".ai-memory.toml"), 'project="synthetic"');
  writeFileSync(join(root, "main.cjs"), `
    let saved; let release;
    module.exports = {
      async onAgentExtensionCall(operation, payload, context) {
        if (payload.kind === 'preview') return pi.fs.readPreview(payload.path || '.ai-memory.toml');
        if (payload.kind === 'complete') {
          const gate = new Promise(resolve => { release = resolve; });
          saved = gate.then(() => pi.desktop.invoke({operation:'session/create',args:[{title:'late'}]}))
            .catch(error => ({code:error.code}));
          return {sessionId:context.sessionId,turnId:context.turnId,runtimeId:context.runtimeId};
        }
        try { await pi.desktop.invoke({operation:'session/get',args:[context.sessionId]}); } catch {}
        return pi.desktop.invoke({operation:'session/create',args:[{title:'after-abort'}]});
      },
      async onPanelInvoke(channel) {
        release?.(); return await saved;
      }
    };`);
  const calls = [], audits = [];
  const fileHost = { call: async () => ({ session: { projectPath: root } }) };
  const runtime = new PluginRuntime({ hostEntry,
    isAdmissionClosed: () => false,
    audit: (entry) => audits.push(entry),
    readOwnerFile: createOwnerFileReader({ getHost: () => fileHost, getRemote: () => null, isPluginActive: () => true }),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [] });
      return { postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler), onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill() };
    },
    desktopControl: { operations: [{ id: "session/get", risk: "read" }, { id: "session/create", risk: "write" }],
      invoke: async (input) => { calls.push(input); return onInvoke(input); } },
  });
  await runtime.loadFromPath(root, permissions);
  const extension = runtime.getAgentExtensions()[0]; assert.ok(extension);
  const identity = { sessionId: "host-session", turnId: "host-turn", mode: "agent", projectPath: root, workspaceRoot: root };
  const launches = new PluginExtensionLaunchBindings();
  launches.observe("agent.prompt", { ...identity, trustedExtensions: [{ id: extension.id, ownerPluginId: "demo.owner", ownerOperations: operations }] });
  const host = { call: async () => ({ session: { ...identity, id: identity.sessionId } }) };
  const broker = createPluginExtensionOwnerBridge({ launches, getHost: () => host, plugins: runtime, pluginActiveInProject: () => true });
  await broker.registerRuntime({ ...identity, runtimeId: "runtime", extensionIds: [extension.id] });
  t.after(async () => { broker.dispose(); await runtime.unload("demo.owner"); rmSync(root, { recursive: true, force: true }); });
  const request = { requestId: "request", ...identity, runtimeId: "runtime", extensionId: extension.id, operation: "recall" };
  return { broker, runtime, calls, audits, request, launches };
}

test("real plugin process inherits authoritative owner scope and rejects descendant SDK calls after completion", async (t) => {
  const f = await fixture(t, async () => ({}));
  assert.deepEqual(await f.broker.callOwner({ ...f.request, payload: { kind: "complete", sessionId: "forged" } }),
    { sessionId: "host-session", turnId: "host-turn", runtimeId: "runtime" });
  assert.deepEqual(await f.runtime.invokePanelBridge("demo.owner", "late"), { code: "PLUGIN_TOOL_ABORTED" });
  assert.equal(f.calls.length, 0);
});

test("owner cancellation crosses the real plugin process and prevents follow-up host mutation", async (t) => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, async (input) => { entered.resolve(input); return release.promise; });
  const pending = assert.rejects(f.broker.callOwner({ ...f.request, payload: { kind: "wait" } }), { name: "AbortError" });
  const call = await entered.promise;
  assert.equal(call.pluginContext.sessionId, "host-session");
  assert.equal(call.pluginContext.turnId, "host-turn");
  f.broker.cancelOwner(f.request); await pending; release.resolve({ ok: true });
  // The next process round trip fences the cancelled callback's continuation.
  await f.runtime.invokePanelBridge("demo.owner", "late");
  assert.equal(f.calls.filter((input) => input.operation === "session/create").length, 0);
});

test("real PluginRuntime unload invalidates Main ownership and cancels the live subprocess invocation", async (t) => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, async () => { entered.resolve(); return release.promise; });
  const pending = assert.rejects(f.broker.callOwner({ ...f.request, payload: { kind: "wait" } }), { name: "AbortError" });
  await entered.promise;
  await f.runtime.unload("demo.owner"); await pending; release.resolve({ ok: true });
  assert.equal(f.launches.get("host-session"), undefined);
  assert.equal(f.calls.filter((input) => input.operation === "session/create").length, 0);
  await assert.rejects(f.broker.callOwner({ ...f.request, payload: { kind: "complete" } }), /Stale/);
});

test("owner previews through a real plugin process emit bounded success and failure audits", async t => {
  const f = await fixture(t, async () => ({}));
  const result = await f.broker.callOwner({ ...f.request, payload: { kind: "preview" } });
  assert.equal(result.content, 'project="synthetic"');
  const success = f.audits.find(entry => entry.api === "fs.readPreview" && entry.ok);
  assert.ok(success); assert.equal(success.pluginId, "demo.owner"); assert.equal(success.path, ".ai-memory.toml");
  assert.equal(JSON.stringify(success).includes(result.content), false);
  await assert.rejects(f.broker.callOwner({ ...f.request, requestId: "denied", payload: { kind: "preview", path: ".env" } }));
  assert.ok(f.audits.some(entry => entry.api === "fs.readPreview" && !entry.ok));
});
