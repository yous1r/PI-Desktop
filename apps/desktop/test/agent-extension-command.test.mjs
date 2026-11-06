import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { runAgentExtensionCommand } = await import("../electron/main/agent-extension-command.ts");
const { registerAgentExtensionIpc } = await import("../electron/main/agent-extensions-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

function fixture({ running = false, missing = false, prepareError, launchError } = {}) {
  const calls = [];
  let locked = false;
  let ready = running;
  const session = { id: "cold-session", mode: "plan", projectPath: "/project" };
  const settings = { defaultProviderId: "provider" };
  const launch = {
    projectPath: "/project", workspaceRoot: "/isolated-worktree",
    sidecarParams: { sessionId: session.id, mode: "plan", provider: { modelId: "fixture" }, trustedExtensions: [{ id: "fixture-extension" }] },
  };
  const deps = {
    acquireSessionOperation: async (id) => {
      assert.equal(id, session.id);
      assert.equal(locked, false);
      locked = true;
      return () => { locked = false; };
    },
    getHost: () => ({ call: async (method, input) => {
      assert.equal(locked, true);
      if (method === "session.get") {
        assert.deepEqual(input, { id: session.id, messageLimit: 1 });
        return { session: missing ? undefined : session };
      }
      assert.equal(method, "settings.get");
      return settings;
    } }),
    resolveAgentRuntimeLaunch: async (...args) => {
      assert.equal(locked, true);
      assert.deepEqual(args, [session.id, session, settings]);
      if (launchError) throw launchError;
      return launch;
    },
    getSidecar: () => ({
      setProjectInstructionRoot: (id, root) => {
        assert.equal(id, session.id);
        assert.equal(root, launch.workspaceRoot);
      },
      call: async (method, input) => {
        calls.push({ method, input });
        if (method === "agent.getStatus") return { status: { isRunning: running } };
        if (method === "extensions.command.prepare") {
          assert.equal(locked, true);
          assert.deepEqual(input, launch.sidecarParams);
          if (prepareError) throw prepareError;
          ready = true;
          return { ready: true };
        }
        assert.equal(method, "extensions.command.run");
        assert.equal(locked, false, "interactive commands and queued turns must not hold the session lock");
        if (!ready) throw new Error("runtime not found for session");
        return { handled: input.name === "sc:implement" };
      },
    }),
  };
  const handlers = new Map();
  registerAgentExtensionIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    bridge: {},
    runCommand: (input) => runAgentExtensionCommand(input, deps),
  });
  return {
    run: (name = "/sc:implement") => handlers.get(IPC.invoke.extensionsCommandRun)({ sessionId: session.id, name, args: "task arguments" }),
    calls, deps, isLocked: () => locked, dispose: () => { ready = false; },
  };
}

test("a slash command prepares a cold session and runs without a seed prompt", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { ok: true });
  assert.deepEqual(f.calls.map(c => c.method), ["agent.getStatus", "extensions.command.prepare", "extensions.command.run"]);
  assert.deepEqual(f.calls.at(-1).input, { sessionId: "cold-session", name: "sc:implement", args: "task arguments" });
});

test("commands restore disposed runtimes and refresh idle session configuration", async () => {
  const f = fixture();
  await f.run();
  f.dispose();
  assert.deepEqual(await f.run(), { ok: true });
  assert.equal(f.calls.filter(c => c.method === "extensions.command.prepare").length, 2);
});

test("a running turn keeps its runtime and command behavior", async () => {
  const f = fixture({ running: true });
  f.deps.resolveAgentRuntimeLaunch = () => assert.fail("must not reconfigure a running turn");
  assert.deepEqual(await f.run(), { ok: true });
  assert.deepEqual(f.calls.map(c => c.method), ["agent.getStatus", "extensions.command.run"]);
});

test("missing sessions and preparation failures release admission without executing a command", async () => {
  for (const options of [
    { missing: true },
    { launchError: new Error("model not configured") },
    { prepareError: new Error("sidecar unavailable") },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), options.missing ? { errorCode: "NOT_FOUND" } : options.launchError ?? options.prepareError);
    assert.equal(f.isLocked(), false);
    assert.equal(f.calls.some(c => c.method === "extensions.command.run"), false);
  }
});

test("an unregistered command keeps the IPC not-found error after preparation", async () => {
  const f = fixture();
  await assert.rejects(f.run("missing"), { errorCode: "NOT_FOUND" });
  assert.equal(f.isLocked(), false);
});

test("native Pi sessions do not enter the Desktop runtime path", async () => {
  await assert.rejects(runAgentExtensionCommand({ sessionId: "native-pi:fixture", name: "sc:implement", args: "" }, {}), { errorCode: "NATIVE_PI_UNSUPPORTED" });
});
