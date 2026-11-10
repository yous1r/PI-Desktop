import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { register, registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: "test:startup-electron", shortCircuit: true } : next(specifier, context);
}, load(url, context, next) {
  if (url !== "test:startup-electron") return next(url, context);
  return { format: "module", shortCircuit: true, source: `import { EventEmitter } from 'node:events';
    export const app = new EventEmitter(); export const session = {}, net = {}, shell = {}, ipcMain = {},
    protocol = {}, dialog = {}, globalShortcut = {}, screen = {}, systemPreferences = {};
    export class View {} export class WebContentsView {} export class BrowserWindow {} export const Menu = {};` };
} });
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const sourceEntries = Object.fromEntries([
  ["@pi-desktop/plugin-devkit", "plugin-devkit/src/index.ts"],
  ["@pi-desktop/agent-runtime/system-proxy-relay", "agent-runtime/src/system-proxy-relay.ts"],
].map(([name, path]) => [name, new URL(`../../../packages/${path}`, import.meta.url).href]));
register(`data:text/javascript,${encodeURIComponent(`const entries = ${JSON.stringify(sourceEntries)};
  export async function resolve(specifier, context, next) { return next(entries[specifier] ?? specifier, context); }`)}`);
const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { createSidecarRuntime } = await import("../electron/main/runtime/sidecar.ts");
const { createRuntimeLifecycle } = await import("../electron/main/runtime/lifecycle.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");

async function fixture(t, configureFailure = false) {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "backend-wiring-"));
  const oldBinary = process.env.PI_DESKTOP_HOST_BIN;
  process.env.PI_DESKTOP_HOST_BIN = process.execPath;
  const children = [], calls = [], generations = new Map();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const state = { host: null, sidecar: null, agentHostBridge: null, handoffAdmission: new DesktopHandoffAdmission() };
  const spawn = t.mock.method(childProcess, "spawn", (command, args, options) => {
    const sidecar = args.includes("--internal-execution-runner");
    const child = Object.assign(new EventEmitter(), { pid: 10000 + children.length,
      exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      killed: false, kill() { this.killed = true; queueMicrotask(exit); return true; }, sidecar, command, args, options });
    function exit() { if (child.exitCode !== null) return; child.exitCode = 0; child.emit("exit", 0, null); }
    child.exit = exit;
    child.stdin.on("finish", () => queueMicrotask(exit));
    child.stdin.on("data", bytes => {
      for (const line of bytes.toString().trim().split("\n")) {
        const request = JSON.parse(line); if (!request.id) continue;
        calls.push({ child, method: request.method, params: request.params });
        const answer = result => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "executionFence.prepare") {
          const generation = randomUUID(); generations.set(generation, child);
          answer({ version: 1, generation, address: `\\\\.\\pipe\\pi-execution-v1-${generation}`,
            capability: randomUUID(), ownerPid: child.pid, ownerCreatedAt: "134000000000000001" });
        } else if (request.method === "executionFence.stop") {
          assert.equal(generations.get(request.params.generation), child);
          answer({ generation: request.params.generation, state: "closed", activeProcesses: 0, rootExited: true, confirmed: true });
        } else if (request.method === "sidecar.configure") {
          assert.equal(state.sidecar, null, "a configuring instance must not accept new work");
          entered.resolve();
          void release.promise.then(() => {
            if (configureFailure) child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: "fixture configure failure" } })}\n`);
            else answer({ ok: true });
          });
        } else answer({});
      }
    });
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  const logger = { app() {}, child() {}, flushChild() {} };
  const plugins = { setServices() {}, getAgentExtensions: () => [], drainToasts: () => [], onExtensionOwnerUnavailable: () => () => {} };
  let lifecycle;
  const finished = [];
  const common = { runtimeState: state, dataDir: directory, logger, plugins,
    sendToRenderer() {}, activeTurns: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    sessionProjects: new Map(), finishTurn: async (...args) => { finished.push(args); common.activeTurns.delete(args[0]); }, finishApprovedExecution: async () => {},
    pluginActiveInProject: () => false, isQuitting: () => false,
    superviseRestart: kind => lifecycle.superviseRestart(kind) };
  const sidecar = createSidecarRuntime({ ...common, steeringReplies: new Set(), persistAgentEvent() {}, isStaleTerminalEvent: () => false,
    inflightCheckpointer: { flush: async () => {}, settle() {} },
    agentExtensions: { bindSource: () => ({ dispose() {}, getHandoffActivity: () => ({ operations: 0, inputs: 0 }) }) },
    vendorOAuth: {}, listRuntimeProviders: async () => [],
    modelsDevCatalog: {}, effectiveSubagentModelConfig() {}, browserHost: {}, loadUserSkillBody: async () => null,
    activeUserSkills: async () => [], disabledBuiltinSkills: async () => [], currentNetworkProxy: () => ({ mode: "system" }) });
  const host = createHostRuntime({ ...common, wireHandoff() {}, persistenceOutbox: { flush: async () => {} }, activeToolCalls: new Map(),
    activeToolCallKey: (s, c) => `${s}:${c}`, userMcp: {}, settleModeReturn: async () => false, emitAgentEvent() {},
    togglePluginLauncher: async () => {}, isTurnDispatchable: () => false, importLegacyScheduled: async () => {},
    ensureSystemProxyRelay: async () => "http://127.0.0.1:1" });
  lifecycle = createRuntimeLifecycle({ ...common, hostStartup: host.startup, sidecarStartup: sidecar.startup, fenced: host.fenced,
    drainApprovedPlanExecutions: async () => {}, applyNetworkProxyFromAppSettings: async () => {}, setCurrentWorkspacePath() {},
    rememberPluginScopes() {}, refreshUserMcp: async () => {}, getDisplayLocale: () => "en" });
  t.after(async () => {
    release.resolve(); state.handoffAdmission.dispose();
    await lifecycle.backends.closeSidecar().catch(() => {}); await lifecycle.backends.closeHost().catch(() => {});
    for (const child of children) child.exit();
    spawn.mock.restore(); syncBuiltinESMExports();
    if (oldBinary === undefined) delete process.env.PI_DESKTOP_HOST_BIN; else process.env.PI_DESKTOP_HOST_BIN = oldBinary;
    await rm(directory, { recursive: true, force: true });
  });
  return { state, lifecycle, children, calls, entered, release, directory, activeTurns: common.activeTurns, finished };
}

test("production Desktop startup uses a contained Host, real extension owners and publication after configuration", async t => {
  const f = await fixture(t);
  const boot = f.lifecycle.bootBackends(); await Promise.race([f.entered.promise, boot]);
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children[0].args, ["--execution-fence"]);
  assert.equal(f.children[0].options.env.PI_DESKTOP_DATA_DIR, f.directory);
  assert.equal(f.children[1].args[0], "--internal-execution-runner");
  assert.equal(f.children[1].args.includes("--max-old-space-size=2048"), true);
  assert.equal(f.children[1].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(f.state.sidecar, null);
  f.release.resolve(); await boot;
  assert.ok(f.state.sidecar instanceof AgentSidecar);
  assert.equal(f.state.sidecar.captureHostBinding(f.state.host)(), true);
  assert.deepEqual(f.state.sidecar.getExtensionOwnerActivity(), { operations: 0, runtimes: 0, uncontainedResources: 0 });
  assert.deepEqual(f.state.sidecar.getExtensionServiceActivity(), { operations: 0, inputs: 0, uncontainedResources: 0 });
  assert.equal(f.calls.find(c => c.method === "sidecar.configure").params.hostBinary, process.execPath);
  await f.lifecycle.backends.closeSidecar();
  assert.equal(f.children[1].exitCode, 0); assert.equal(f.children[0].exitCode, null);
  await f.lifecycle.backends.closeHost(); assert.equal(f.children[0].exitCode, 0);
});

test("production Desktop configure rejection retires the original child and native generation", async t => {
  const f = await fixture(t, true);
  const boot = f.lifecycle.bootBackends(); await Promise.race([f.entered.promise, boot]); f.release.resolve();
  await assert.rejects(boot, /fixture configure failure/);
  assert.equal(f.state.sidecar, null); assert.equal(f.children[1].exitCode, 0);
  assert.equal(f.calls.filter(c => c.method === "executionFence.stop").length, 1);
});

test("production concurrent Host and Sidecar crash supervisors create one replacement pair", async t => {
  const f = await fixture(t); f.release.resolve(); await f.lifecycle.bootBackends();
  const original = f.state.sidecar;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.children[0].exit(); f.children[1].exit();
  const restarting = Promise.all([f.lifecycle.superviseRestart("host"), f.lifecycle.superviseRestart("sidecar")]);
  t.mock.timers.tick(500);
  try {
    await restarting;
    assert.equal(f.children.length, 4);
    assert.notEqual(f.state.sidecar, original);
    assert.equal(f.state.sidecar.captureHostBinding(f.state.host)(), true);
    assert.equal(f.state.handoffAdmission.inFlightCount(), 0);
  } finally { t.mock.timers.reset(); }
});

test("Host-first crash settles ordinary turns before replacing a still-live Sidecar exactly once", async t => {
  const f = await fixture(t); f.release.resolve(); await f.lifecycle.bootBackends();
  f.activeTurns.set("ordinary-session", "original-turn");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.children[0].exit();
  const restarting = f.lifecycle.superviseRestart("host"); t.mock.timers.tick(500);
  try {
    await restarting;
    assert.equal(f.finished.length, 1);
    assert.equal(f.finished[0][0], "ordinary-session"); assert.equal(f.finished[0][3].turnId, "original-turn");
    assert.equal(f.activeTurns.size, 0); assert.equal(f.children.length, 4);
    f.children[1].exit(); assert.equal(f.finished.length, 1);
  } finally { t.mock.timers.reset(); }
});
