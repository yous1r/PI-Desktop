import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { createSshTunnelManager } = await import("../electron/main/remote/ssh-tunnel.ts");
const ssh = { host: "fixture.invalid", version: "0.22.3", hostId: "fixture-host", remotePort: 4321 };
const ready = transactionId => ({ code: 0, stderr: "", stdout: `PI_HOST_READY ${JSON.stringify({ hostId: ssh.hostId, host: "127.0.0.1", port: 4321, version: ssh.version })}${transactionId ? `\nPI_HOST_DEPLOYMENT_TRANSACTION ${transactionId}` : ""}` });
function fixture(t) {
  const state = { held: false, built: [], forwards: [], errors: [], probe: async () => ready(), reserve: async () => 4322, forward: null, dispose: null, build: null, log: null };
  const manager = createSshTunnelManager({
    isAdmissionClosed: () => state.held,
    log: (level, message) => { state.log?.(level, message); if (level === "warn") state.errors.push(message); },
    reservePort: () => state.reserve(),
    buildTransport: () => {
      const transport = { disposed: 0,
        execWithInput: (...args) => state.probe(...args),
        forward: async options => {
          const forward = { localPort: options.localPort, closes: 0, close: async () => { forward.closes++; } };
          state.forwards.push(forward);
          return state.forward ? state.forward(forward, options) : forward;
        },
        dispose() { transport.disposed++; state.dispose?.(); },
      };
      state.built.push(transport); state.build?.(); return transport;
    },
  });
  t.after(() => manager.dispose());
  return { manager, state };
}
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

test("closed admission refuses fresh and cached tunnel acquisition without disturbing original cleanup", async t => {
  const { manager, state } = fixture(t);
  state.held = true;
  await assert.rejects(manager.open("key", ssh), { code: "HOST_BUSY" });
  assert.equal(state.built.length, 0);
  state.held = false; await manager.open("key", ssh); state.held = true;
  await assert.rejects(manager.open("key", ssh), { code: "HOST_BUSY" });
  await manager.close("key"); assert.equal(state.forwards[0].closes, 1);
});
test("dispose permanently seals new opens and leaves an unaccepted adopted forward with its caller", async t => {
  const { manager, state } = fixture(t); await manager.dispose();
  await assert.rejects(manager.open("key", ssh));
  let closes = 0;
  await assert.rejects(manager.adopt("key", ssh, { localPort: 4322, close: async () => { closes++; } }));
  assert.equal(state.built.length, 0); assert.equal(closes, 0);
});
test("close waits for a late original forward and its asynchronous cleanup", async t => {
  const { manager, state } = fixture(t);
  const started = Promise.withResolvers(), available = Promise.withResolvers(), cleaning = Promise.withResolvers(), cleaned = Promise.withResolvers();
  state.forward = async forward => { forward.close = async () => { forward.closes++; cleaning.resolve(); await cleaned.promise; }; started.resolve(); await available.promise; return forward; };
  const opening = observe(manager.open("key", ssh)); await started.promise;
  let settled = false; const closing = manager.close("key").then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.ok(manager.getHandoffActivity().operations > 0);
  available.resolve(); await cleaning.promise; assert.equal(settled, false);
  cleaned.resolve(); await closing;
  assert.equal((await opening).error?.errorCode, "HOST_DISCONNECTED");
  assert.equal(state.forwards[0].closes, 1); assert.equal(state.built[0].disposed, 1);
  assert.deepEqual(manager.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
});
test("concurrent close calls join the original cleanup after registry retirement", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  const started = Promise.withResolvers(), cleaned = Promise.withResolvers();
  state.forwards[0].close = async () => { state.forwards[0].closes++; started.resolve(); await cleaned.promise; };
  const first = manager.close("key"); await started.promise;
  let settled = false; const second = manager.close("key").then(() => { settled = true; });
  await new Promise(setImmediate); assert.equal(settled, false);
  cleaned.resolve(); await Promise.all([first, second]); assert.equal(state.forwards[0].closes, 1);
});
test("closing the gate after port reservation prevents forwarding", async t => {
  const { manager, state } = fixture(t);
  state.reserve = async () => { state.held = true; return 4322; };
  await assert.rejects(manager.open("key", ssh), { code: "HOST_BUSY" });
  assert.equal(state.forwards.length, 0); assert.equal(state.built[0].disposed, 1);
});
test("original guards reach the transport's asynchronous credential boundary", async t => {
  const { manager, state } = fixture(t);
  state.forward = async (_forward, options) => { state.held = true; options.assertCurrent(); throw new Error("guard failed"); };
  await assert.rejects(manager.open("key", ssh), { code: "HOST_BUSY" });
});
test("a transport factory that reenters close cannot start supervision", async t => {
  const { manager, state } = fixture(t); let closing, probes = 0;
  state.build = () => { closing = manager.close("key"); };
  state.probe = async () => { probes++; return ready(); };
  await assert.rejects(manager.open("key", ssh), { errorCode: "HOST_DISCONNECTED" });
  await closing; assert.equal(probes, 0); assert.equal(state.built[0].disposed, 1);
});
test("dispose cannot be bypassed by adoption waiting for an older forward to close", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  const started = Promise.withResolvers(), cleaned = Promise.withResolvers();
  state.forwards[0].close = async () => { started.resolve(); await cleaned.promise; };
  let adoptedCloses = 0;
  const adoption = observe(manager.adopt("key", ssh, { localPort: 4323, close: async () => { adoptedCloses++; } }));
  await started.promise; const disposal = manager.dispose(); cleaned.resolve();
  await disposal; assert.ok((await adoption).error); assert.equal(adoptedCloses, 1);
  assert.equal(manager.getHandoffActivity().resources, 0);
});
test("a saved deployment completion cannot invoke a transport after tunnel retirement", async t => {
  const { manager, state } = fixture(t); const id = "a".repeat(32); let completions = 0;
  state.probe = async (_cmd, script) => {
    if (script.includes("--complete")) { completions++; return { code: 0, stdout: `PI_HOST_DEPLOYMENT_COMPLETE ${id}` }; }
    return ready(id);
  };
  const tunnel = await manager.open("key", ssh), complete = tunnel.completePreparation;
  await manager.close("key"); await assert.rejects(complete()); assert.equal(completions, 0);
});
test("original deployment completion is retained and coalesced through close", async t => {
  const { manager, state } = fixture(t); const id = "b".repeat(32);
  const started = Promise.withResolvers(), completed = Promise.withResolvers(); let completions = 0;
  state.probe = async (_cmd, script) => {
    if (script.includes("--complete")) { completions++; started.resolve(); await completed.promise; return { code: 0, stdout: `PI_HOST_DEPLOYMENT_COMPLETE ${id}` }; }
    return ready(id);
  };
  const tunnel = await manager.open("key", ssh);
  const first = observe(tunnel.completePreparation()), second = observe(tunnel.completePreparation()); await started.promise;
  let settled = false; const closing = manager.close("key").then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  completed.resolve(); await closing;
  assert.ok((await first).error); assert.ok((await second).error); assert.equal(completions, 1);
});
test("a throwing cleanup observer cannot prevent disposing the original transport", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  state.log = () => { throw new Error("fixture cleanup observer failed"); };
  state.forwards[0].close = async () => { throw new Error("fixture close failed"); };
  const result = await observe(manager.close("key"));
  assert.ok(result.error); assert.equal(state.built[0].disposed, 1);
  assert.ok(manager.getHandoffActivity().uncontainedResources > 0);
});

test("temporary admission closure preserves an existing tunnel for later reuse", async t => {
  const { manager, state } = fixture(t);
  const original = await manager.open("key", ssh);
  state.held = true;
  await assert.rejects(manager.open("key", ssh), { code: "HOST_BUSY" });
  assert.equal(state.forwards[0].closes, 0);
  state.held = false;
  assert.equal(await manager.open("key", ssh), original);
  assert.equal(state.built.length, 1);
});

test("reentrant close and dispose callbacks join the preinstalled original cleanup", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  const done = Promise.withResolvers(); let nestedClose, nestedDispose;
  state.forwards[0].close = async () => {
    state.forwards[0].closes++;
    nestedClose = manager.close("key"); nestedDispose = manager.dispose();
    await done.promise;
  };
  const closing = manager.close("key");
  assert.equal(nestedClose, closing);
  done.resolve(); await Promise.all([closing, nestedDispose]);
  assert.equal(state.forwards[0].closes, 1); assert.equal(state.built[0].disposed, 1);
});

test("new acquisition cannot bypass an original tunnel still closing", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  const done = Promise.withResolvers(); state.forwards[0].close = () => done.promise;
  const closing = manager.close("key");
  await assert.rejects(manager.open("key", ssh), { errorCode: "HOST_DISCONNECTED" });
  assert.equal(state.built.length, 1);
  done.resolve(); await closing; await manager.open("key", ssh);
  assert.equal(state.built.length, 2);
});

test("overlapping adoption retires only original forwards without deleting the newer tunnel", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  const done = Promise.withResolvers(); state.forwards[0].close = () => done.promise;
  let oldCloses = 0, newCloses = 0;
  const old = observe(manager.adopt("key", ssh, { localPort: 4323, close: async () => { oldCloses++; } }));
  const current = manager.adopt("key", ssh, { localPort: 4324, close: async () => { newCloses++; } });
  done.resolve(); const tunnel = await current;
  assert.ok((await old).error); assert.equal(oldCloses, 1); assert.equal(newCloses, 0);
  assert.equal(await manager.open("key", ssh), tunnel);
  await manager.close("key"); assert.equal(newCloses, 1);
});

test("admitted deployment cannot publish completion after a hold and keeps its original command counted", async t => {
  const { manager, state } = fixture(t), id = "c".repeat(32);
  const entered = Promise.withResolvers(), done = Promise.withResolvers();
  state.probe = async (_command, script) => {
    if (!script.includes("--complete")) return ready(id);
    entered.resolve(); await done.promise;
    return { code: 0, stdout: `PI_HOST_DEPLOYMENT_COMPLETE ${id}` };
  };
  const tunnel = await manager.open("key", ssh), completion = observe(tunnel.completePreparation());
  await entered.promise; state.held = true;
  assert.ok(manager.getHandoffActivity().operations > 0);
  done.resolve(); assert.equal((await completion).error?.code, "HOST_BUSY");
  assert.equal(state.forwards[0].closes, 0);
});

test("transport disposal failure is observable and does not strand forward cleanup", async t => {
  const { manager, state } = fixture(t); await manager.open("key", ssh);
  state.dispose = () => { throw new Error("fixture dispose failed"); };
  await assert.rejects(manager.close("key"), /fixture dispose failed/);
  assert.equal(state.forwards[0].closes, 1);
  assert.equal(manager.getHandoffActivity().operations, 0);
  assert.ok(manager.getHandoffActivity().uncontainedResources > 0);
});
