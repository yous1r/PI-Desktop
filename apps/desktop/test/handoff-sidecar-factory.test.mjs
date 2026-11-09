import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { register, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");

// Only OS spawn and the Rust RPC boundary are fixtures. These statuses are not
// native-closure evidence; the isolated process suite verifies that separately.
const generation = "12345678-1234-4234-8234-123456789abc";
const ticket = { version: 1, generation, address: `\\\\.\\pipe\\pi-execution-v1-${generation}`,
  capability: "22345678-1234-4234-8234-123456789abc", ownerPid: 1234, ownerCreatedAt: "134000000000000001" };
const closed = { generation, state: "closed", activeProcesses: 0, rootExited: true, confirmed: true };
function fixture(t, { prepare, stop, bindingFailure, spawnFailure, exits = true } = {}) {
  const calls = [], launches = [], subscriptions = new Set();
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 1234, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { kills++; if (exits) queueMicrotask(exit); return true; },
  });
  function exit() { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); }
  const spawn = t.mock.method(childProcess, "spawn", (command, args, options) => {
    launches.push({ command, args, options });
    if (spawnFailure) throw spawnFailure;
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { exit(); spawn.mock.restore(); syncBuiltinESMExports(); });
  const subscribe = callback => { subscriptions.add(callback); return () => subscriptions.delete(callback); };
  const host = {
    generation: "original",
    async call(method, params) {
      calls.push({ method, params });
      if (method === "executionFence.prepare") return prepare ? prepare.promise : ticket;
      if (method === "executionFence.stop") return stop ? stop() : closed;
      if (method === "executionFence.status") return { ...closed, state: "running", activeProcesses: 1, rootExited: false, confirmed: false };
      throw new Error(method);
    },
    onExit: subscribe,
    onNotification(callback) { if (bindingFailure) throw bindingFailure; return subscribe(callback); },
  };
  const options = { host, binaryPath: "original-host.exe", onStderr() {},
    launch: { command: "node.exe", args: ["original.js"], cwd: "C:/original", env: { ORIGINAL: "yes" } } };
  return { options, host, calls, launches, subscriptions, child, exit, kills: () => kills };
}

test("fenced Desktop factory retains extension owners, original binding and live operation tracking", async t => {
  const f = fixture(t);
  const sidecar = await AgentSidecar.createFenced(f.options);
  t.after(() => sidecar.dispose());
  assert.ok(sidecar instanceof AgentSidecar, "must return the Desktop subclass");
  const binding = sidecar.captureHostBinding(f.host);
  assert.equal(binding(), true);
  let disposed = 0;
  sidecar.setExtensionOwnerLifecycle({ rebindHost() {}, closeSession() {}, dispose() { disposed++; },
    getHandoffActivity: () => ({ operations: 0, runtimes: 2 }) });
  const written = Promise.withResolvers();
  f.child.stdin.once("data", bytes => written.resolve(JSON.parse(bytes.toString())));
  const call = sidecar.call("fixture.wait");
  const request = await written.promise;
  assert.deepEqual(sidecar.getExtensionOwnerActivity(), { operations: 1, runtimes: 2, uncontainedResources: 0 });
  f.child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
  assert.deepEqual(await call, { ok: true });
  assert.equal(sidecar.getExtensionOwnerActivity().operations, 0);
  assert.equal((await sidecar.executionStatus()).generation, generation);
  assert.equal(await sidecar.fenceExecution(), true);
  await sidecar.dispose();
  assert.equal(await sidecar.confirmExit(0), true);
  assert.equal(binding(), false);
  assert.equal(disposed, 1);
  assert.equal(f.subscriptions.size, 0);
});

test("fenced factory captures original Host, launch values and stderr handler before prepare yields", async t => {
  const prepare = Promise.withResolvers();
  const f = fixture(t, { prepare });
  const stderr = [];
  f.options.onStderr = text => stderr.push(text);
  const creating = AgentSidecar.createFenced(f.options);
  f.options.host = { async call() { throw new Error("replacement called"); }, onExit() { throw new Error("replacement bound"); }, onNotification() { throw new Error("replacement bound"); } };
  f.options.binaryPath = "replacement-host.exe";
  f.options.onStderr = () => { throw new Error("replacement logger called"); };
  f.options.launch.command = "replacement-node.exe";
  f.options.launch.args.push("replacement.js");
  f.options.launch.env.ORIGINAL = "changed";
  f.options.launch.cwd = "C:/replacement";
  prepare.resolve(ticket);
  const sidecar = await creating;
  t.after(() => sidecar.dispose());
  assert.equal(f.launches[0].command, "original-host.exe");
  assert.deepEqual(f.launches[0].args, ["--internal-execution-runner", "--", "node.exe", "original.js"]);
  assert.equal(f.launches[0].options.env.ORIGINAL, "yes");
  assert.equal(f.launches[0].options.cwd, "C:/original");
  f.child.stderr.emit("data", "original stderr");
  assert.deepEqual(stderr, ["original stderr"]);
  assert.equal(sidecar.captureHostBinding(f.host)(), true);
  assert.equal(await sidecar.fenceExecution(), true);
});

for (const failureAt of ["spawn", "binding"]) {
  test(`fenced ${failureAt} failure preserves the original error after confirmed cleanup`, async t => {
    const original = new Error(`${failureAt} failed`);
    const f = fixture(t, failureAt === "spawn" ? { spawnFailure: original } : { bindingFailure: original });
    await assert.rejects(AgentSidecar.createFenced(f.options), error => error === original);
    assert.deepEqual(f.calls.map(call => call.method), ["executionFence.prepare", "executionFence.stop"]);
    assert.equal(f.calls[1].params.generation, generation);
    assert.equal(f.subscriptions.size, 0, "partial Desktop Host binding must be released");
    if (failureAt === "binding") {
      assert.equal(f.kills(), 1, "created child is disposed even though publication failed");
      assert.equal(f.child.exitCode, 0);
    }
  });
  for (const outcome of ["unconfirmed", "rejected"]) {
    test(`fenced ${failureAt} failure retains ${outcome} native cleanup and still disposes the child`, async t => {
      const original = new Error(`${failureAt} failed`), stopError = new Error("original stop lost");
      const f = fixture(t, { ...(failureAt === "spawn" ? { spawnFailure: original } : { bindingFailure: original }),
        stop: () => outcome === "rejected" ? Promise.reject(stopError) : { ...closed, confirmed: false } });
      await assert.rejects(AgentSidecar.createFenced(f.options), error => {
        assert.equal(error.message, "EXECUTION_FENCE_CLEANUP_UNCONFIRMED");
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], original);
        if (outcome === "rejected") assert.ok(error.errors.includes(stopError));
        return true;
      });
      assert.equal(f.subscriptions.size, 0);
      if (failureAt === "binding") assert.equal(f.kills(), 1);
    });
  }
}

test("failed binding releases the created transport while original native stop is still pending", async t => {
  const stopped = Promise.withResolvers(), entered = Promise.withResolvers();
  const original = new Error("binding failed");
  const f = fixture(t, { bindingFailure: original, stop: () => { entered.resolve(); return stopped.promise; } });
  const creating = AgentSidecar.createFenced(f.options);
  const rejected = assert.rejects(creating, error => error === original);
  await entered.promise;
  const disposedWhilePending = f.kills() > 0 && f.subscriptions.size === 0;
  stopped.resolve(closed);
  await rejected;
  assert.equal(disposedWhilePending, true);
});

test("lost prepare response starts no child and invents no cleanup generation", async t => {
  const prepare = Promise.withResolvers();
  const f = fixture(t, { prepare });
  const original = new Error("prepare lost");
  const creating = AgentSidecar.createFenced(f.options);
  prepare.reject(original);
  await assert.rejects(creating, error => error === original);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.calls.map(call => call.method), ["executionFence.prepare"]);
});

test("a derived constructor failure after spawn retains and disposes the original transport", async t => {
  const original = new Error("derived initialization failed");
  const f = fixture(t);
  class BrokenSidecar extends AgentSidecar {
    constructor(options) { super(options.onStderr, options.launch); throw original; }
    static create(options) { return this.createFencedWith(options, prepared => new BrokenSidecar(prepared)); }
    dispose() { throw new Error("partially initialized derived disposal must not run"); }
  }
  await assert.rejects(BrokenSidecar.create(f.options), error => error === original);
  assert.equal(f.kills(), 1);
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.child.stdout.listenerCount("data"), 0);
  assert.deepEqual(f.calls.map(call => call.method), ["executionFence.prepare", "executionFence.stop"]);
});

test("transport cleanup rejection retains both errors and still requests original native closure", async t => {
  const original = new Error("binding failed"), disposal = new Error("disposal failed");
  const f = fixture(t, { bindingFailure: original });
  const originalDispose = AgentSidecar.prototype.dispose;
  t.mock.method(AgentSidecar.prototype, "dispose", async function () {
    await originalDispose.call(this);
    throw disposal;
  });
  await assert.rejects(AgentSidecar.createFenced(f.options), error => {
    assert.equal(error.message, "EXECUTION_FENCE_CLEANUP_UNCONFIRMED");
    assert.deepEqual(error.errors, [original, disposal]);
    return true;
  });
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.calls.at(-1).method, "executionFence.stop");
});

test("bounded disposal with no original root exit cannot certify failed creation cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = new Error("binding failed");
  const f = fixture(t, { bindingFailure: original, exits: false });
  const creating = AgentSidecar.createFenced(f.options);
  const rejected = assert.rejects(creating, error => {
    assert.equal(error.message, "EXECUTION_FENCE_CLEANUP_UNCONFIRMED");
    assert.equal(error.errors[0], original);
    return true;
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await rejected;
  assert.equal(f.child.exitCode, null);
  assert.equal(f.kills(), 1);
});
