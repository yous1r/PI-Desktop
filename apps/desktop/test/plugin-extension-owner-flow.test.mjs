import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { PluginExtensionOwnerBroker } = await import("../electron/main/plugin-extension-owner-broker.ts");
const { DesktopAgentRuntime } = await import("../../../packages/agent-runtime/src/runtime.ts");
const { clearTrustedExtensionCache } = await import("../../../packages/agent-runtime/src/extensions/runner.ts");
const { routeExtensionRequest } = await import("../../../packages/host-runtime/src/extension-owner-routing.ts");
const operations = [{ name: "recall", readOnly: true }, { name: "capture", readOnly: false }, { name: "retire", readOnly: true }];
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, { mode = "agent", remote = false, dispatch } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-owner-flow-"));
  const entry = join(root, "extension.ts");
  writeFileSync(entry, `export default function(pi) {
    let oldOwner;
    pi.on("session_start", async (_event, ctx) => {
      oldOwner = ctx.owner;
      await ctx.owner.call("recall", { event: "start", context: {
        runtimeId: ctx.runtimeId, sessionId: ctx.sessionId, turnId: ctx.turnId,
        projectPath: ctx.projectPath, workspaceRoot: ctx.workspaceRoot, remoteWorkspace: ctx.remoteWorkspace,
      }});
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      await ctx.owner.call("recall", { event: "before", turnId: ctx.turnId });
    });
    pi.on("context", async (event, ctx) => {
      const recalled = await ctx.owner.call("recall", { event: "context", turnId: ctx.turnId });
      return { messages: [...event.messages, {role:"user",content:"Historical memory: " + recalled.text,timestamp:0}] };
    });
    pi.on("session_shutdown", async (event, ctx) => {
      await ctx.owner.call("retire", { event: "shutdown", reason: event.retirementReason, contextReason: ctx.retirementReason });
    });
    pi.registerCommand("expired", {handler: async (_args,ctx) => {
      let rejected = false;
      try { await oldOwner.call("capture", {event:"expired"}); } catch { rejected = true; }
      await ctx.owner.call("recall", {event:"expired-result",rejected});
    }});
    pi.registerCommand("write", {handler: async (_args,ctx) => {
      await ctx.owner.call("capture", {event:"write"});
    }});
    pi.registerCommand("slow", {handler: async (_args,ctx) => {
      try { await ctx.owner.call("recall", {event:"slow"}); } catch {}
      await ctx.owner.call("capture", {event:"late-write"});
    }});
  }`);
  const spec = { id: entry, entry, label: "Owner fixture", root, source: "plugin", ownerPluginId: "demo.owner", ownerOperations: operations };
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "Remembered" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const session = { sessionId: "session", mode, projectPath: remote ? "remote:ssh/project" : root,
    workspaceRoot: remote ? "/remote/worktree" : root,
    ...(remote ? { remoteWorkspace: { hostKey: "ssh", path: "/remote/worktree" } } : {}),
    extensions: [{ id: entry, ownerPluginId: "demo.owner", operations }] };
  const sessions = new Map([[session.sessionId, session]]);
  const calls = [];
  const broker = new PluginExtensionOwnerBroker({
    isAdmissionClosed: () => false, assertOwner() {},
    resolveSession: async (id) => sessions.has(id) ? structuredClone(sessions.get(id)) : undefined,
    acceptRuntime: async () => true,
    dispatch: async (plugin, operation, payload, context) => {
      calls.push({ plugin, operation, payload, context });
      return dispatch ? dispatch(operation, payload, context) : { text: "remember the fixture" };
    },
  });
  const bridge = { publishCommands() {}, publishDiagnostics() {}, requestUi: async () => ({}), configureModel: async () => ({}),
    queuePush: async () => ({}), queuePrioritize: async () => ({}),
    callOwner: (p) => broker.callOwner(p), cancelOwner: (p) => broker.cancelOwner(p),
    registerRuntime: (p) => broker.registerRuntime(p), retireRuntime: (p) => broker.retireRuntime(p) };
  const runtimes = [];
  const configs = new Map();
  const create = (identity = session) => {
    sessions.set(identity.sessionId, identity);
    const config = {
      host: { call: async (method, params) => method.startsWith("extensions.") ? routeExtensionRequest(bridge, method, params) : {},
        onNotification: () => () => {} },
      sessionId: identity.sessionId, mode: identity.mode, projectPath: identity.projectPath,
      workspaceRoot: identity.workspaceRoot, remoteWorkspace: identity.remoteWorkspace,
      thinkingLevel: "off", trustedExtensions: [spec], onEvent() {},
      provider: { id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    };
    const runtime = new DesktopAgentRuntime(config);
    configs.set(runtime, config);
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    broker.dispose(); await new Promise((resolve) => server.close(resolve));
    clearTrustedExtensionCache(); rmSync(root, { recursive: true, force: true });
  });
  return { create, session, calls, requests, broker, configs };
}

test("real runtime loads, recalls into model context, rejects expired callback and retires with stable host identity", async (t) => {
  const f = await fixture(t); const runtime = f.create(); await runtime.loadTrustedExtensions();
  assert.equal(f.calls[0].payload.context.runtimeId, runtime.runtimeId);
  assert.equal(f.calls[0].context.turnId, undefined);
  await runtime.runTrustedExtensionCommand("expired", "");
  assert.equal(f.calls.find((call) => call.payload.event === "expired-result").payload.rejected, true);
  f.session.turnId = "host-turn";
  await runtime.prompt("Recall the fixture", undefined, "host-turn");
  assert.ok(f.requests.length > 0);
  assert.ok(JSON.stringify(f.requests[0]).includes("Historical memory: remember the fixture"));
  for (const event of ["before", "context"]) {
    const call = f.calls.find((item) => item.payload.event === event);
    assert.equal(call.context.turnId, "host-turn"); assert.equal(call.payload.turnId, "host-turn");
    assert.equal(call.context.runtimeId, runtime.runtimeId);
  }
  await runtime.dispose("reconfigure");
  const shutdown = f.calls.find((call) => call.payload.event === "shutdown");
  assert.equal(shutdown.context.retirementReason, "reconfigure");
  assert.equal(shutdown.payload.contextReason, "reconfigure");
  delete f.session.turnId;
  const replacement = f.create(); await replacement.loadTrustedExtensions();
  assert.notEqual(replacement.runtimeId, runtime.runtimeId);
  assert.equal(f.calls.filter((call) => call.payload.event === "start").length, 2);
  await replacement.dispose("session-close");
  assert.equal(f.calls.at(-1).context.retirementReason, "session-close");
});

for (const mode of ["plan", "goal"]) test(`real ${mode} runtime permits recall and refuses owner capture`, async (t) => {
  const f = await fixture(t, { mode }); const runtime = f.create();
  await runtime.loadTrustedExtensions(); await runtime.runTrustedExtensionCommand("write", "");
  assert.equal(f.calls.filter((call) => call.operation === "capture").length, 0);
  await runtime.dispose("app-quit"); assert.equal(f.calls.at(-1).context.retirementReason, "app-quit");
});

test("runtime carries remote durable project identity separately from actual remote workspace", async (t) => {
  const f = await fixture(t, { remote: true }); const runtime = f.create(); await runtime.loadTrustedExtensions();
  const { context } = f.calls[0].payload;
  assert.equal(context.projectPath, "remote:ssh/project");
  assert.equal(context.workspaceRoot, "/remote/worktree");
  assert.deepEqual(context.remoteWorkspace, { hostKey: "ssh", path: "/remote/worktree" });
});

test("Stop aborts owner service work and prevents the old handler from capturing afterwards", async (t) => {
  const entered = deferred(); const result = deferred(); let signal;
  const f = await fixture(t, { dispatch: async (_op, payload, context) => {
    if (payload.event !== "slow") return { text: "fixture" };
    signal = context.signal; entered.resolve(); return result.promise;
  } });
  const runtime = f.create(); await runtime.loadTrustedExtensions();
  const command = runtime.runTrustedExtensionCommand("slow", ""); await entered.promise;
  await runtime.abort(); await command;
  assert.equal(signal.aborted, true); result.resolve({ text: "stale" });
  await runtime.runTrustedExtensionCommand("expired", "");
  assert.equal(f.calls.filter((call) => call.operation === "capture").length, 0);
});

test("two sessions using the same cached extension keep factory state and routing isolated", async (t) => {
  const f = await fixture(t);
  const first = f.create();
  const second = f.create({ ...f.session, sessionId: "second", projectPath: "second-project", workspaceRoot: "second-worktree" });
  await Promise.all([first.loadTrustedExtensions(), second.loadTrustedExtensions()]);
  await Promise.all([first.runTrustedExtensionCommand("expired", ""), second.runTrustedExtensionCommand("expired", "")]);
  const starts = f.calls.filter((call) => call.payload.event === "start");
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts.map((call) => call.context.sessionId)), new Set(["session", "second"]));
  assert.equal(starts.find((call) => call.context.sessionId === "second").context.projectPath, "second-project");
  assert.notEqual(first.runtimeId, second.runtimeId);
  assert.equal(f.calls.filter((call) => call.payload.event === "expired-result" && call.payload.rejected).length, 2);
});

test("normal shutdown bounds a stalled owner handler and aborts its descendant work", async (t) => {
  const entered = deferred(); const result = deferred(); let signal;
  const f = await fixture(t, { dispatch: async (_op, payload, context) => {
    if (payload.event !== "shutdown") return { text: "fixture" };
    signal = context.signal; entered.resolve(); return result.promise;
  } });
  const runtime = f.create(); await runtime.loadTrustedExtensions();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const closing = runtime.dispose("app-quit"); await entered.promise;
  t.mock.timers.tick(2_001); await closing;
  assert.equal(signal.aborted, true); result.resolve({ text: "late" });
});

test("runtime reuse rejects changed owner grants and remote durable identity", async (t) => {
  const f = await fixture(t, { remote: true }); const runtime = f.create();
  const config = { ...f.configs.get(runtime), workspaceRoot: undefined };
  assert.equal(runtime.matches(config), true);
  assert.equal(runtime.matches({ ...config, projectPath: "remote:ssh/different-project" }), false);
  assert.equal(runtime.matches({ ...config, parentSessionId: "different-parent" }), false);
  assert.equal(runtime.matches({ ...config, trustedExtensions: config.trustedExtensions.map((spec) => ({ ...spec,
    ownerOperations: [{ name: "recall", readOnly: false }] })) }), false);
});

test("concurrent runtime disposal callers both await the same shutdown work", async (t) => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { dispatch: async (_op, payload) => {
    if (payload.event === "shutdown") { entered.resolve(); await release.promise; }
    return { text: "fixture" };
  } });
  const runtime = f.create(); await runtime.loadTrustedExtensions();
  const first = runtime.dispose("app-quit"); await entered.promise;
  let settled = false; const second = runtime.dispose("session-close").then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release.resolve(); await Promise.all([first, second]);
  assert.equal(f.calls.filter((call) => call.payload.event === "shutdown").length, 1);
  assert.equal(f.calls.at(-1).context.retirementReason, "app-quit");
});
