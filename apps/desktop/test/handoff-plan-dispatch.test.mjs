import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");

const execution = { id: "execution", proposalId: "proposal", sessionId: "session", kind: "plan", title: "Plan",
  question: "Proceed?", plan: "Run approved work", state: "queued", targetPermissionMode: "ask",
  artifact: { relativePath: "plan.md", sha256: "0".repeat(64), sizeBytes: 1 } };
const idle = () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0,
  plugins: 0, admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
  approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0 });
const deferred = () => Promise.withResolvers();
function fixture(t) {
  const admission = new DesktopHandoffAdmission();const calls = [];const activeTurns = new Map();
  let record = { ...execution };let beforeLaunch = async () => {};let beforeBegin = async () => {};
  let failFinish = false;
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const host = { generation: "original-host", async call(method, params) {
    calls.push(method);
    switch (method) {
      case "plans.queuedExecutions": return { executions: record.state === "queued" ? [record] : [] };
      case "plans.claimExecution": record = { ...record, state: "running" };return { execution: record };
      case "settings.get": return {};
      case "session.get": return { session: { id: execution.sessionId, mode: "agent", permissionMode: "ask" } };
      case "session.beginTurn": await beforeBegin();return { turnId: "turn" };
      case "session.endTurn": return { ok: true };
      case "plans.finishExecution":
        if (failFinish) throw new Error("storage unavailable");
        record = { ...record, state: params.status };return { execution: record };
      default: throw new Error(`unexpected Host call ${method}`);
    }
  } };
  const sidecar = { async call(method) { calls.push(method);return { accepted: true }; } };
  const runtimeState = { host, sidecar, agentHostBridge: null, handoffAdmission: admission };
  const pendingExecutionFinishes = new Map();
  const plans = createPlanRuntime({ runtimeState, planState: { approvedExecutionDrain: null },
    logger: { app() {} }, sendToRenderer() {}, coordination, scheduledRunsBySession: new Map(), activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    approvedExecutionTurns: new Map(), startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(), inFlightExecutionFinishes: new Set(), pendingExecutionFinishes,
    announceTurnEnded() {}, emitAgentEvent() {}, acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => { await beforeLaunch();return { providerId: "fixture", modelId: "fixture", sidecarParams: { sessionId: execution.sessionId } }; },
    isQuitting: () => false,
  });
  t.after(() => { plans.dispose();admission.dispose(); });
  return { admission, coordination, plans, calls, activeTurns, runtimeState, pendingExecutionFinishes, host, sidecar,
    record: () => record, beforeLaunch: callback => { beforeLaunch = callback; }, beforeBegin: callback => { beforeBegin = callback; },
    failFinish: (value = true) => { failFinish = value; },
    hold: () => admission.gate.acquireHandoff("transfer", async () => ({ ...idle(), admissions: admission.inFlightCount(), plans: plans.inFlightCount() })),
  };
}

test("approved-plan user path claims, launches once and settles the existing durable execution", async t => {
  const f = fixture(t);
  await f.plans.dispatchExecutionForProposal(execution.proposalId);
  assert.equal(f.record().state, "running");assert.equal(f.activeTurns.get(execution.sessionId), "turn");
  await f.plans.dispatchApprovedPlan(execution);
  assert.equal(f.calls.filter(method => method === "agent.executeApprovedPlan").length, 1);
  await f.plans.finishTurn(execution.sessionId, "completed", undefined, { turnId: "turn" });
  await f.plans.finishApprovedExecution(execution.id, "completed");
  assert.equal(f.record().state, "completed");assert.equal(f.activeTurns.size, 0);
  assert.equal(f.pendingExecutionFinishes.size, 0);
  assert.equal(f.plans.inFlightCount(), 0);
  assert.deepEqual(f.calls, ["plans.queuedExecutions", "plans.claimExecution", "settings.get", "session.get", "session.beginTurn", "agent.executeApprovedPlan", "session.endTurn", "plans.finishExecution"]);
});

test("closed admission refuses direct, proposal and recovery-drain plan starts", async t => {
  const f = fixture(t);await f.hold();
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.dispatchExecutionForProposal(execution.proposalId);
  await f.plans.drainApprovedPlanExecutions();
  assert.deepEqual(f.calls, []);assert.equal(f.record().state, "queued");
});

test("a dispatcher waiting for the real session lock remains visible to idle inspection", async t => {
  const f = fixture(t);const release = await f.coordination.acquireSessionOperation(execution.sessionId);
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  try { await assert.rejects(f.hold(), { code: "HOST_BUSY" }); }
  finally { release();await dispatch; }
});

test("closure while waiting for the session lock prevents a later durable claim", async t => {
  const f = fixture(t);const release = await f.coordination.acquireSessionOperation(execution.sessionId);
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  f.admission.dispose();release();await dispatch;
  assert.deepEqual(f.calls, []);assert.equal(f.record().state, "queued");
});

test("claimed launch setup keeps admission busy and executes exactly once after a refused handoff", async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();
  f.beforeLaunch(async () => { entered.resolve();await pending.promise; });
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  try { await entered.promise;await assert.rejects(f.hold(), { code: "HOST_BUSY" }); }
  finally { pending.resolve();await dispatch; }
  assert.equal(f.calls.filter(method => method === "agent.executeApprovedPlan").length, 1);
});

test("a replaced Host receives no calls from an older admitted launch", async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();const replacementCalls = [];
  f.beforeLaunch(async () => { entered.resolve();await pending.promise; });
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  await entered.promise;
  f.runtimeState.host = { async call(method) { replacementCalls.push(method);throw new Error("replacement must not be used"); } };
  pending.resolve();await dispatch;
  assert.deepEqual(replacementCalls, []);
  assert.equal(f.calls.includes("agent.executeApprovedPlan"), false);
  assert.equal(f.record().state, "interrupted");
});

for (const replacement of ["closed", "sidecar"]) {
test(`a late beginTurn reply cannot launch after ${replacement} changes`, async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();const replacementCalls = [];
  f.beforeBegin(async () => { entered.resolve();await pending.promise; });
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  await entered.promise;
  if (replacement === "closed") f.admission.dispose();
  else f.runtimeState.sidecar = { async call(method) { replacementCalls.push(method);return { accepted: true }; } };
  pending.resolve();await dispatch;
  assert.deepEqual(replacementCalls, []);assert.equal(f.calls.includes("agent.executeApprovedPlan"), false);
  assert.equal(f.calls.includes("session.endTurn"), true);assert.equal(f.record().state, "interrupted");
  assert.equal(f.activeTurns.size, 0);
});
}

test("late beginTurn cleanup stays on the original Host and preserves a replacement turn", async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();const replacementCalls = [];
  f.beforeBegin(async () => { entered.resolve();await pending.promise; });
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  await entered.promise;
  f.runtimeState.host = { generation: "replacement", async call(method) { replacementCalls.push(method); } };
  f.activeTurns.set(execution.sessionId, "replacement-turn");
  pending.resolve();await dispatch;
  assert.deepEqual(replacementCalls, []);assert.equal(f.activeTurns.get(execution.sessionId), "replacement-turn");
  assert.equal(f.record().state, "interrupted");assert.equal(f.plans.inFlightCount(), 0);
});

test("normal terminal finalization uses the execution's original Host and bridge", async t => {
  const f = fixture(t);const replacementCalls = [];
  await f.plans.dispatchApprovedPlan(execution);
  f.runtimeState.host = { async call(method) { replacementCalls.push(method); } };
  f.runtimeState.agentHostBridge = { endTurn() { replacementCalls.push("bridge.endTurn"); }, agentHost: { kick() { replacementCalls.push("bridge.kick"); } } };
  await f.plans.finishTurn(execution.sessionId, "completed", undefined, { turnId: "turn" });
  await f.plans.finishApprovedExecution(execution.id, "completed");
  assert.deepEqual(replacementCalls, []);assert.equal(f.record().state, "completed");
  assert.equal(f.plans.inFlightCount(), 0);
});

test("failed execution finalization stays busy and never borrows a replacement Host", async t => {
  const f = fixture(t);const replacementCalls = [];
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.finishTurn(execution.sessionId, "completed", undefined, { turnId: "turn" });
  f.failFinish();await f.plans.finishApprovedExecution(execution.id, "completed");
  await assert.rejects(f.hold(), { code: "HOST_BUSY" });
  f.runtimeState.host = { async call(method) { replacementCalls.push(method);return { executions: [] }; } };
  await f.plans.drainApprovedPlanExecutions();
  assert.deepEqual(replacementCalls, ["plans.queuedExecutions"]);
  assert.equal(f.pendingExecutionFinishes.size, 1);
  f.failFinish(false);await f.plans.finishApprovedExecution(execution.id, "completed");
  assert.equal(f.record().state, "completed");assert.equal(f.plans.inFlightCount(), 0);
});

for (const outcome of ["reject", "invalid"]) {
test(`unconfirmed turn cleanup (${outcome}) survives successful execution finalization and disposal`, async t => {
  const f = fixture(t);const original = f.host.call;
  f.host.call = async (method, params) => {
    if (method !== "session.endTurn") return original(method, params);
    if (outcome === "invalid") return { ok: false };
    throw new Error("endTurn acknowledgement lost");
  };
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.finishTurn(execution.sessionId, "completed", undefined, { turnId: "turn" });
  await f.plans.finishApprovedExecution(execution.id, "completed");
  assert.equal(f.record().state, "completed");assert.equal(f.activeTurns.size, 0);
  assert.equal(f.plans.inFlightCount(), 1);
  f.plans.dispose();await assert.rejects(f.hold(), { code: "HOST_BUSY" });
});
}

for (const method of ["plans.claimExecution", "session.beginTurn"]) {
test(`lost ${method} reply stays visible and is never replayed`, async t => {
  const f = fixture(t);const original = f.host.call;
  f.host.call = async (name, params) => {
    const result = await original(name, params);
    if (name === method) throw new Error("reply lost after durable write");
    return result;
  };
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.drainApprovedPlanExecutions();
  assert.equal(f.calls.filter(name => name === method).length, 1);
  assert.equal(f.calls.includes("agent.executeApprovedPlan"), false);
  assert.equal(f.plans.inFlightCount(), 1);
  await assert.rejects(f.hold(), { code: "HOST_BUSY" });
});
}

test("lost sidecar acceptance stays busy even after durable rows close", async t => {
  const f = fixture(t);
  f.sidecar.call = async method => { f.calls.push(method);throw new Error("acceptance reply lost"); };
  await f.plans.dispatchApprovedPlan(execution);
  assert.equal(f.record().state, "interrupted");assert.equal(f.activeTurns.size, 0);
  await f.plans.dispatchApprovedPlan(execution);
  assert.equal(f.calls.filter(name => name === "agent.executeApprovedPlan").length, 1);
  assert.equal(f.plans.inFlightCount(), 1);await assert.rejects(f.hold(), { code: "HOST_BUSY" });
});

test("a mismatched terminal acknowledgement cannot release the execution", async t => {
  const f = fixture(t);const original = f.host.call;
  f.host.call = async (method, params) => {
    const result = await original(method, params);
    return method === "plans.finishExecution" ? { execution: { ...result.execution, id: "other-execution" } } : result;
  };
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.finishTurn(execution.sessionId, "completed", undefined, { turnId: "turn" });
  await f.plans.finishApprovedExecution(execution.id, "completed");
  assert.equal(f.pendingExecutionFinishes.size, 1);await assert.rejects(f.hold(), { code: "HOST_BUSY" });
});

for (const action of ["dispose", "replace", "retry"]) {
test(`owned queued-plan retry handles ${action} without duplicate execution`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);const replacementCalls = [];
  f.activeTurns.set(execution.sessionId, "another-turn");
  await f.plans.dispatchApprovedPlan(execution);
  await f.plans.dispatchApprovedPlan(execution);
  assert.equal(f.plans.inFlightCount(), 1);await assert.rejects(f.hold(), { code: "HOST_BUSY" });
  f.activeTurns.clear();
  if (action === "dispose") f.plans.dispose();
  if (action === "replace") f.runtimeState.host = { async call(method) { replacementCalls.push(method); } };
  t.mock.timers.tick(250);await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replacementCalls, []);
  assert.equal(f.calls.filter(method => method === "agent.executeApprovedPlan").length, action === "retry" ? 1 : 0);
  if (action !== "retry") assert.equal(f.plans.inFlightCount(), 0);
});
}

for (const entry of ["dispatchExecutionForProposal", "drainApprovedPlanExecutions"]) {
test(`${entry} retains query admission and rejects a late result from a replaced Host`, async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();const original = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "plans.queuedExecutions") { entered.resolve();await pending.promise; }
    return original(method, params);
  };
  const dispatch = f.plans[entry](execution.proposalId);
  await entered.promise;await assert.rejects(f.hold(), { code: "HOST_BUSY" });
  f.runtimeState.host = { async call() { assert.fail("late query cannot use replacement Host"); } };
  pending.resolve();await dispatch;
  assert.deepEqual(f.calls, ["plans.queuedExecutions"]);assert.equal(f.plans.inFlightCount(), 0);
});
}

test("a failed parallel setup read keeps its unfinished peer counted", async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();const original = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "session.get") { entered.resolve();throw new Error("session lookup failed"); }
    if (method === "settings.get") await pending.promise;
    return original(method, params);
  };
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  await entered.promise;await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.admission.inFlightCount() > 0);await assert.rejects(f.hold(), { code: "HOST_BUSY" });
  pending.resolve();await dispatch;
  assert.equal(f.record().state, "interrupted");assert.equal(f.plans.inFlightCount(), 0);
});

test("an aborted execution cannot resume after admitted launch setup returns", async t => {
  const f = fixture(t);const entered = deferred();const pending = deferred();
  f.beforeLaunch(async () => { entered.resolve();await pending.promise; });
  const dispatch = f.plans.dispatchApprovedPlan(execution);
  await entered.promise;
  await f.plans.finishApprovedExecution(execution.id, "interrupted", "TURN_ABORTED");
  pending.resolve();await dispatch;
  assert.equal(f.record().state, "interrupted");
  assert.equal(f.calls.includes("session.beginTurn"), false);
  assert.equal(f.calls.includes("agent.executeApprovedPlan"), false);
  assert.equal(f.plans.inFlightCount(), 0);
});
