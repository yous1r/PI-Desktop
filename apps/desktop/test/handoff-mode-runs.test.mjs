import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createModeRunCoordinator } = await import("../electron/main/runtime/mode-runs.ts");

const definition = { id: "feature", stages: [{ id: "build" }], returnTo: "agent" };
const run = { id: "run", sessionId: "session", modeId: "feature", revision: 1, state: "running", stageId: "build", input: "work", artifactPaths: {} };
const input = { sessionId: "session", turnId: "turn", sessionMode: "feature", content: "work", origin: "user" };
function deferred() { return Promise.withResolvers(); }
function fixture(overrides = {}) {
  const calls = [], continuations = [], notices = [], aborts = [];
  let closed = false;
  const makeOwner = name => ({
    host: { async call(method, params) {
      calls.push({ owner: name, method, params });
      if (overrides.call) { const value = overrides.call(name, method, params); if (value !== undefined) return value; }
      if (method === "modes.get") return { run: null };
      if (method === "modes.start") return { claimed: true, run, definition, enteredStage: true };
      return { run, continue: false };
    } },
    async startContinuation(...args) { continuations.push({ owner: name, args }); return overrides.continue?.(); },
    async abortTurn(...args) { aborts.push({ owner: name, args }); },
    async notifyTurn(...args) { notices.push({ owner: name, args }); },
  });
  const original = makeOwner("original"), replacement = makeOwner("replacement");
  let current = original;
  const coordinator = createModeRunCoordinator({
    getOwner: () => current,
    catalog: { definition: async () => overrides.definition ? overrides.definition() : definition },
    isAdmissionClosed: () => closed,
    isQuitting: () => false,
    logger: { app() {} },
  });
  return { coordinator, calls, continuations, notices, aborts,
    replace() { current = replacement; }, close() { closed = true; } };
}

test("mode ownership rejects replacement during catalog preparation before any write", async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ definition() { entered.resolve(); return pending.promise; } });
  const work = f.coordinator.prepareTurn(input);
  await entered.promise; f.replace(); pending.resolve(definition);
  await assert.rejects(work, { errorCode: "HOST_DISCONNECTED" });
  assert.deepEqual(f.calls, []);
});

test("mode ownership settles the original claim after Host replacement", async () => {
  const f = fixture();
  await f.coordinator.prepareTurn(input); f.replace();
  await f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  const settlement = f.calls.find(call => call.method === "modes.settleTurn");
  assert.equal(settlement.owner, "original");
});

test("mode ownership retains a pending settlement and coalesces duplicate completion", async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ call(_owner, method) { if (method === "modes.settleTurn") { entered.resolve(); return pending.promise; } } });
  await f.coordinator.prepareTurn(input);
  const first = f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  await entered.promise;
  const second = f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  assert.ok(f.coordinator.getHandoffActivity().operations > 0);
  assert.equal(f.coordinator.getHandoffActivity().turns, 1);
  pending.resolve({ run, continue: false });
  await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.method === "modes.settleTurn").length, 1);
  assert.equal(f.coordinator.getHandoffActivity().turns, 0);
});

test("mode ownership keeps admitted continuation work visible until completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(), entered = deferred();
  const f = fixture({ call(_owner, method) { if (method === "modes.settleTurn") return { run, continue: true }; }, continue() { entered.resolve(); return pending.promise; } });
  await f.coordinator.prepareTurn(input);
  await f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  t.mock.timers.tick(0); await entered.promise;
  assert.equal(f.coordinator.getHandoffActivity().queuedTurns, 1);
  pending.resolve();
  await f.coordinator.drain();
  assert.equal(f.coordinator.getHandoffActivity().queuedTurns, 0);
});

test("mode ownership never redirects a queued continuation to a replacement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ call(_owner, method) { if (method === "modes.settleTurn") return { run, continue: true }; } });
  await f.coordinator.prepareTurn(input);
  await f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  f.replace(); t.mock.timers.tick(0);
  assert.deepEqual(f.continuations, []);
});

test("mode ownership checks the shared gate before new work and deferred continuation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ call(_owner, method) { if (method === "modes.settleTurn") return { run, continue: true }; } });
  await f.coordinator.prepareTurn(input);
  await f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  f.close(); t.mock.timers.tick(0);
  assert.deepEqual(f.continuations, []);
  await assert.rejects(f.coordinator.prepareTurn({ ...input, turnId: "next" }), { errorCode: "HOST_BUSY" });
});

test("mode ownership does not send an old pause notification to a replacement runtime", async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ call(_owner, method) { if (method === "modes.control") { entered.resolve(); return pending.promise; } } });
  await f.coordinator.prepareTurn(input);
  const work = f.coordinator.control({ sessionId: "session", runId: "run", expectedRevision: 1, action: "pause" });
  await entered.promise; f.replace(); pending.resolve({ run: { ...run, state: "paused", revision: 2 }, continue: false });
  await work;
  assert.ok(f.notices.every(notice => notice.owner === "original"));
  assert.equal(f.notices.length, 1);
});

test("mode ownership retains failed settlement as refusal evidence", async () => {
  const f = fixture({ call(_owner, method) { if (method === "modes.settleTurn") return Promise.reject(new Error("write unconfirmed")); } });
  await f.coordinator.prepareTurn(input);
  await assert.rejects(f.coordinator.settleTurn("session", "turn", { reason: "completed" }), /write unconfirmed/);
  assert.ok(f.coordinator.getHandoffActivity().turns > 0);
  assert.ok(f.coordinator.getHandoffActivity().uncontainedResources > 0);
});

test("mode disposal cancels queued timers and waits for already started work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(), entered = deferred();
  const f = fixture({ call(_owner, method) { if (method === "modes.settleTurn") return { run, continue: true }; }, continue() { entered.resolve(); return pending.promise; } });
  await f.coordinator.prepareTurn(input);
  await f.coordinator.settleTurn("session", "turn", { reason: "completed" });
  t.mock.timers.tick(0); await entered.promise;
  let disposed = false;
  const closing = f.coordinator.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  assert.equal(f.coordinator.getHandoffActivity().queuedTurns, 1);
  await assert.rejects(f.coordinator.prepareTurn(input), { errorCode: "HOST_BUSY" });
  pending.resolve(); await closing;
  assert.equal(f.coordinator.getHandoffActivity().operations, 0);
  const queued = fixture({ call(_owner, method) { if (method === "modes.settleTurn") return { run, continue: true }; } });
  await queued.coordinator.prepareTurn(input);
  await queued.coordinator.settleTurn("session", "turn", { reason: "completed" });
  await queued.coordinator.dispose(); t.mock.timers.tick(0);
  assert.deepEqual(queued.continuations, []);
  assert.equal(queued.coordinator.getHandoffActivity().queuedTurns, 0);
});

test("a claim acknowledged after replacement is abandoned through its original owner", async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ call(_owner, method) { if (method === "modes.start") { entered.resolve(); return pending.promise; } } });
  const preparing = f.coordinator.prepareTurn(input);
  await entered.promise; f.replace();
  pending.resolve({ claimed: true, run, definition, enteredStage: true });
  await assert.rejects(preparing, { errorCode: "HOST_DISCONNECTED" });
  assert.equal(f.coordinator.getHandoffActivity().turns, 0);
  assert.equal(f.calls.find(call => call.method === "modes.settleTurn").owner, "original");
  assert.equal(f.coordinator.getHandoffActivity().turns, 0);
});
