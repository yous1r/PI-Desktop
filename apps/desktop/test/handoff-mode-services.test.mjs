import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createModeServices } = await import("../electron/main/runtime/mode-services.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { IPC } = await import("@pi-desktop/shared");
const { modeContinuationOrigin } = await import("../electron/main/runtime/mode-runs.ts");

for (const action of ["pause", "stop"]) {
  test(`mode services preserve the admitted ${action} target across runtime replacement`, async t => {
    const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mode-owner-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entered = Promise.withResolvers(), result = Promise.withResolvers();
    const calls = [], notices = [], interrupts = [];
    const gate = new DesktopHandoffAdmission();
    t.after(() => gate.dispose());
    let target = "turn";
    let state = { id: "run", sessionId: "session", modeId: "goal", state: "running", revision: 1, stageId: "work", input: "work", artifactPaths: {} };
    const originalHost = { generation: "original", async call(method, params) {
      calls.push({ owner: "original", method, params });
      if (method === "modes.get") return { run: null };
      if (method === "modes.start") return { claimed: true, run: state, enteredStage: true };
      if (method === "modes.control") { entered.resolve(); return result.promise; }
      if (method === "modes.settleTurn") return { run: state, continue: false };
      throw new Error(method);
    } };
    const originalSidecar = { captureHostBinding: () => () => true, async call(method, params) { notices.push({ owner: "original", method, params }); } };
    const originalBridge = { observeWorkTarget: () => target,
      agentHost: { async interruptTurn(_principal, turnId) { interrupts.push({ owner: "original", turnId }); } },
      async startModeContinuation() { throw new Error("unexpected continuation"); } };
    let host = originalHost, sidecar = originalSidecar, bridge = originalBridge;
    const services = createModeServices({ getHost: () => host, getSidecar: () => sidecar,
      getAgentHostBridge: () => bridge, sendToRenderer() {}, logger: { app() {} },
      isQuitting: () => false, isAdmissionClosed: () => gate.isClosed(), modeDirectory: directory });
    t.after(() => services.runs.dispose());
    const definition = await services.runs.definitionForPrompt("goal");
    assert.ok(definition.stages.length > 0, "real builtin definition reaches the coordinator");
    state = { ...state, stageId: definition.stages[0].id };
    const prepared = await services.runs.prepareTurn({ sessionId: "session", turnId: "turn", sessionMode: "goal", content: "work", origin: "user" });
    assert.equal(prepared.modeTurn.runId, "run");
    const controlling = services.runs.control({ sessionId: "session", runId: "run", expectedRevision: 1, action });
    await entered.promise;
    assert.ok(services.runs.getHandoffActivity().operations > 0);
    host = { generation: "replacement", async call(method) { throw new Error(`replacement called: ${method}`); } };
    sidecar = { captureHostBinding: () => () => true, async call() { throw new Error("replacement notified"); } };
    bridge = { observeWorkTarget: () => "replacement-turn", agentHost: { async interruptTurn() { throw new Error("replacement interrupted"); } } };
    if (action === "stop") target = "later-turn";
    result.resolve({ run: { ...state, state: action === "pause" ? "paused" : "stopped", revision: 2 }, continue: false });
    await controlling;
    if (action === "pause") assert.deepEqual(notices, [{ owner: "original", method: "agent.modeTurnNotice", params: { sessionId: "session", turnId: "turn", runId: "run", action: "closeout" } }]);
    else assert.deepEqual(interrupts, [], "Stop must not interrupt a later turn on the original bridge");
    await services.runs.settleTurn("session", "turn", { reason: "aborted" });
    assert.equal(calls.at(-1).method, "modes.settleTurn");
    assert.equal(calls.at(-1).owner, "original");
    assert.equal(services.runs.getHandoffActivity().turns, 0);
    gate.dispose();
    await assert.rejects(services.runs.prepareTurn({ sessionId: "session", turnId: "next", sessionMode: "goal", content: "work", origin: "user" }), { errorCode: "HOST_BUSY" });
  });
}

const childSource = `
const calls = [];
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'agent.modeTurnNotice') calls.push(message.params);
  console.log(JSON.stringify({id:message.id,result:message.method === 'fixture.calls' ? calls : {ok:true}}));
});`;

for (const action of ["pause", "stop", "remove"]) {
  for (const change of ["replacement", "away-and-back", "dispose"]) {
    test(`mode ${action} cannot use a Sidecar binding after ${change}`, async t => {
      const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mode-binding-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const entered = Promise.withResolvers(), result = Promise.withResolvers();
      const calls = [], interrupts = [], warnings = [];
      const state = { id: "run", sessionId: "session", modeId: "goal", state: "running", revision: 1, stageId: "work", input: "work", artifactPaths: {} };
      const host = { generation: "original", onNotification: () => () => {}, onExit: () => () => {}, async call(method, params) {
        calls.push({ method, params });
        if (method === "modes.get") return { run: null };
        if (method === "modes.start") return { claimed: true, run: state, enteredStage: true };
        if (method === "modes.control") { entered.resolve(); return result.promise; }
        if (method === "modes.settleTurn") return { run: state, continue: false };
        throw new Error(method);
      } };
      const sidecar = new AgentSidecar(() => {}, { command: process.execPath, args: ["-e", childSource] });
      sidecar.setHost(host);
      await sidecar.call("fixture.ready");
      t.after(async () => { await sidecar.dispose(); assert.equal(await sidecar.confirmExit(2_000), true); });
      const bridge = { observeWorkTarget: () => "turn", agentHost: { async interruptTurn(_principal, turnId) { interrupts.push(turnId); } } };
      const services = createModeServices({ getHost: () => host, getSidecar: () => sidecar,
        getAgentHostBridge: () => bridge, sendToRenderer() {}, logger: { app(...args) { warnings.push(args); } },
        isQuitting: () => false, isAdmissionClosed: () => false, modeDirectory: directory });
      t.after(() => services.runs.dispose());
      await services.runs.prepareTurn({ sessionId: "session", turnId: "turn", sessionMode: "goal", content: "work", origin: "user" });
      const controlling = services.runs.control({ sessionId: "session", runId: "run", expectedRevision: 1, action });
      await entered.promise;
      if (change === "dispose") await sidecar.dispose();
      else {
        sidecar.setHost({ ...host, generation: "replacement" });
        if (change === "away-and-back") sidecar.setHost(host);
      }
      result.resolve({ run: { ...state, state: action === "pause" ? "paused" : "stopped", revision: 2 }, continue: false });
      await controlling;
      assert.deepEqual(interrupts, [], "old Stop must not reach a rebound execution bridge");
      if (change !== "dispose") assert.deepEqual(await sidecar.call("fixture.calls"), [], "old notices must not reach a rebound sidecar");
      assert.equal(warnings.length, 1, "the refused original effect remains observable");
      assert.equal(services.runs.getHandoffActivity().uncontainedResources, 1);
      await services.runs.settleTurn("session", "turn", { reason: "aborted" });
      assert.equal(calls.at(-1).method, "modes.settleTurn", "original Host settlement does not borrow the Sidecar binding");
      assert.equal(services.runs.getHandoffActivity().turns, 0);
    });
  }
}

test("Sidecar binding guards expire before callbacks, survive identical binding, and never revive", async t => {
  const exits = new Set();
  const host = { generation: "one", async call() {}, onNotification: () => () => {},
    onExit(callback) { exits.add(callback); return () => exits.delete(callback); } };
  const sidecar = new AgentSidecar(() => {}, { command: process.execPath, args: ["-e", childSource] });
  t.after(() => sidecar.dispose());
  sidecar.setHost(host);
  const original = sidecar.captureHostBinding(host);
  assert.equal(original(), true);
  sidecar.setHost(host);
  assert.equal(original(), true);
  assert.equal(sidecar.captureHostBinding({ ...host })(), false);
  let observed;
  sidecar.setExtensionOwnerLifecycle({ rebindHost() { observed = original(); }, closeSession() {}, dispose() {}, getHandoffActivity: () => ({ operations: 0, runtimes: 0 }) });
  sidecar.setHost({ ...host });
  assert.equal(observed, false, "invalidate before extension callbacks");
  sidecar.setHost(host);
  assert.equal(original(), false, "returning to the original Host cannot revive a guard");
  const returned = sidecar.captureHostBinding(host);
  host.generation = "two";
  assert.equal(returned(), false);
  sidecar.setHost(host);
  const renewed = sidecar.captureHostBinding(host);
  assert.equal(renewed(), true);
  for (const exit of [...exits]) exit(0, null);
  assert.equal(renewed(), false, "Host exit invalidates the binding");
  sidecar.setHost(host);
  const beforeDispose = sidecar.captureHostBinding(host);
  await sidecar.dispose();
  assert.equal(beforeDispose(), false);
});

for (const holdRead of [0, 1, 2]) test(`mode continuation retains its binding through bridge session read ${holdRead}`, async t => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mode-start-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), invoked = Promise.withResolvers();
  const prompts = [], warnings = [], replacementCalls = [];
  let reads = 0;
  const host = { generation: "original", onNotification: () => () => {}, onExit: () => () => {}, async call(method) {
    if (method === "modes.resolve") return { run: null, continue: true };
    if (method === "session.get") {
      if (++reads === holdRead) { entered.resolve(); await release.promise; }
      return { session: { id: "session", title: "Session", mode: "goal", permissionMode: "ask", createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z" } };
    }
    if (method === "session.queueList") return { entries: [] };
    throw new Error(method);
  } };
  let currentHost = host;
  const sidecar = new AgentSidecar(() => {}, { command: process.execPath, args: ["-e", childSource] });
  sidecar.setHost(host);
  t.after(() => sidecar.dispose());
  const bridge = createAgentHostBridge({ getHost: () => currentHost, channels: IPC.invoke, log() {},
    async invoke(channel, [request]) {
      prompts.push({ channel, origin: modeContinuationOrigin(request), permissionMode: request.permissionMode });
      invoked.resolve();
      return { accepted: true, turnId: "continued" };
    } });
  const services = createModeServices({ getHost: () => currentHost, getSidecar: () => sidecar,
    getAgentHostBridge: () => bridge, sendToRenderer() {}, logger: { app(...args) { warnings.push(args); } },
    isQuitting: () => false, isAdmissionClosed: () => false, modeDirectory: directory });
  t.after(() => services.runs.dispose());
  await services.runs.resolve({ sessionId: "session", runId: "run", expectedRevision: 1, decision: "approve" });
  if (holdRead) {
    await entered.promise;
    assert.equal(services.runs.getHandoffActivity().queuedTurns, 1);
    currentHost = { ...host, generation: "replacement", async call(method) { replacementCalls.push(method); return host.call(method); } };
    sidecar.setHost(currentHost);
    release.resolve();
  } else await invoked.promise;
  await services.runs.drain();
  assert.deepEqual(replacementCalls, []);
  assert.deepEqual(prompts, holdRead ? [] : [{ channel: IPC.invoke.agentPrompt, origin: "approval", permissionMode: undefined }]);
  assert.equal(warnings.length, holdRead ? 1 : 0);
  assert.equal(services.runs.getHandoffActivity().queuedTurns, 0);
});
