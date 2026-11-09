import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
const { InflightCheckpointer } = await import("../../../packages/host-runtime/src/inflight-checkpoint.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const end = { sessionId: "session", turnId: "turn", ts: 2, event: { type: "agent_end", messageIds: ["reply"] } };
const root = { id: "user", role: "user", content: "Regenerate", createdAt: new Date(0).toISOString() };
const reply = { id: "reply", role: "assistant", content: "Completed answer", status: "complete", createdAt: new Date(0).toISOString() };
const idle = { writes: 0, finalizations: 0, uncontainedResources: 0 };

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-event-persistence-"));
  const calls = [], published = [], archived = [], warnings = [], messages = [];
  const host = { generation: "original", isAvailable: () => true, async call(method, params) {
    calls.push(method);
    await options.call?.(method, params);
    if (method === "session.appendMessage") messages.push(params.message);
    if (method === "session.saveActiveRevision") { archived.push([...messages]); return { saved: { root } }; }
    return { ok: true };
  } };
  const replacementCalls = [];
  const replacement = { generation: "replacement", isAvailable: () => true, async call(method) {
    replacementCalls.push(method); return { saved: { root }, ok: true };
  } };
  const admission = new DesktopHandoffAdmission();
  const runtimeState = { host, sidecar: null, agentHostBridge: null, handoffAdmission: admission };
  const activeTurns = new Map([["session", "turn"]]);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const outbox = new PersistenceOutbox(dir, () => {});
  await outbox.flush(() => host);
  const logger = options.logger ?? { app: (_area, level, message) => { if (level === "warn") warnings.push(message); } };
  const checkpoint = new InflightCheckpointer(async () => {});
  const activeToolCalls = new Map(), planSubmissionTurnIds = new Set(), approvedExecutionIdsBySession = new Map();
  const approvedExecutionTurns = new Map(), pendingExecutionFinishes = new Map();
  const plans = createPlanRuntime({ runtimeState, planState: { approvedExecutionDrain: null }, logger, sendToRenderer() {},
    coordination, scheduledRunsBySession: options.scheduled ? new Map([["session", "run"]]) : new Map(), activeToolCalls,
    planSubmissionTurnIds, approvedExecutionIdsBySession, approvedExecutionTurns, pendingExecutionFinishes,
    claimedExecutionSessions: new Map(), startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(), inFlightExecutionFinishes: new Set(), announceTurnEnded() {}, emitAgentEvent() {},
    acquireSessionOperation: coordination.acquireSessionOperation, resolveAgentRuntimeLaunch: async () => { throw new Error("unexpected launch"); },
    ...(options.onTurnEnded ? { onTurnEnded: options.onTurnEnded } : {}),
    isQuitting: () => false,
    ...(options.onTurnSettled ? { onTurnSettled: options.onTurnSettled } : {}),
  });
  const persistence = createEventPersistence({ runtimeState, steeringReplies: new Set(), completionNoticeTurns: new Set(), activeTurns,
    activeToolCalls, activeToolCallKey: coordination.activeToolCallKey, approvedExecutionIdsBySession, approvedExecutionTurns,
    pendingExecutionFinishes, planSubmissionTurnIds, planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: checkpoint, persistenceOutbox: outbox, addActiveTurnUsage() {}, logger,
    finishTurn: options.finishTurn ?? plans.finishTurn, isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    transcriptRewrite: coordination, finishApprovedExecution: plans.finishApprovedExecution,
    emitAgentEvent: envelope => published.push(envelope),
  });
  t.after(async () => {
    options.release?.();
    await persistence.flush(); await outbox.flush(() => null);
    checkpoint.dispose(); plans.dispose(); admission.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { host, replacement, runtimeState, coordination, plans, persistence, outbox, calls, replacementCalls, published, archived, warnings, activeTurns };
}

test("regenerate archive never follows a replacement Host after the original append", async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { release: () => resume.resolve(), call: async method => {
    if (method === "session.appendMessage") { entered.resolve(); await resume.promise; }
  } });
  f.persistence.persistAgentEvent({ ...end, event: { type: "message_end", message: reply } });
  await entered.promise;
  f.persistence.persistAgentEvent(end);
  await new Promise(resolve => setImmediate(resolve));
  f.runtimeState.host = f.replacement;
  resume.resolve();
  await f.persistence.flush();
  assert.deepEqual(f.replacementCalls, [], "an old terminal event cannot archive the replacement session");
  assert.deepEqual(f.published, []);
});

test("regenerate archive suppresses publication if its original RPC completes after Host replacement", async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { release: () => resume.resolve(), call: async method => {
    if (method === "session.saveActiveRevision") { entered.resolve(); await resume.promise; }
  } });
  f.persistence.persistAgentEvent(end);
  await entered.promise;
  f.runtimeState.host = f.replacement;
  assert.equal(f.persistence.getHandoffActivity().writes, 1, "replacement cannot hide the original RPC");
  resume.resolve(); await f.persistence.flush();
  assert.deepEqual(f.replacementCalls, []);
  assert.deepEqual(f.published, [], "an original pager stamp cannot update the replacement session");
  assert.equal(f.persistence.getHandoffActivity().uncontainedResources, 1);
});

test("archive captures its original owner before invoking the finalizer", async t => {
  let f;
  f = await fixture(t, { finishTurn: async () => { f.runtimeState.host = f.replacement; } });
  f.persistence.persistAgentEvent(end); await f.persistence.flush();
  assert.deepEqual(f.replacementCalls, []);
  assert.deepEqual(f.published, []);
});

test("normal regenerate user path persists the final answer before archiving and publishing", async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { release: () => resume.resolve(), call: async method => {
    if (method === "session.saveActiveRevision") { entered.resolve(); await resume.promise; }
  } });
  f.persistence.persistAgentEvent({ ...end, event: { type: "message_end", message: reply } });
  f.persistence.persistAgentEvent(end); await entered.promise;
  assert.equal(f.persistence.getHandoffActivity().writes, 1);
  assert.deepEqual(f.published, []);
  resume.resolve(); await f.persistence.flush();
  assert.deepEqual(f.archived, [[reply]]);
  assert.equal(f.published[0]?.event.type, "user_message_persisted");
  assert.deepEqual(f.persistence.getHandoffActivity(), idle);
});

test("event finalization is reserved before callbacks and remains visible after turn removal", async t => {
  const resume = Promise.withResolvers(); let f;
  f = await fixture(t, { release: () => resume.resolve(), finishTurn: () => {
    assert.equal(f.persistence.getHandoffActivity().finalizations, 1);
    f.activeTurns.clear(); return resume.promise;
  } });
  f.persistence.persistAgentEvent({ ...end, event: { type: "error", error: { code: "TURN_ABORTED", message: "cancelled", retriable: false } } });
  assert.equal(f.persistence.getHandoffActivity().finalizations, 1);
  resume.resolve(); await f.persistence.flush();
  assert.deepEqual(f.persistence.getHandoffActivity(), idle);
});

for (const method of ["session.endTurn", "scheduled.finishRun", "session.saveActiveRevision"]) {
  test(`failed ${method} retains refusal evidence after local records are released`, async t => {
    let fail = true;
    const f = await fixture(t, { scheduled: true, call: async name => { if (fail && name === method) throw new Error("storage outcome unknown"); } });
    f.persistence.persistAgentEvent(end); await f.persistence.flush();
    assert.equal(f.activeTurns.size, 0, "ordinary local finalization still releases the queue");
    const activity = () => method === "session.saveActiveRevision" ? f.persistence.getHandoffActivity() : f.coordination.getHandoffActivity();
    assert.equal(activity().uncontainedResources, 1);
    fail = false; f.activeTurns.set("session", "turn");
    f.persistence.persistAgentEvent(end); await f.persistence.flush();
    assert.equal(activity().uncontainedResources, 1, "later success cannot erase an earlier unconfirmed effect");
  });
}

test("coordination reports waiting session operations and an unresolved transcript rewrite", async t => {
  const f = await fixture(t);
  const first = await f.coordination.acquireSessionOperation("session");
  const waiting = f.coordination.acquireSessionOperation("session");
  const rewrite = f.persistence.beginTranscriptRewrite("session");
  f.coordination.forgetTranscriptRewriteHistory("session");
  assert.ok(f.coordination.getHandoffActivity().admissions > 0);
  assert.equal(f.coordination.getHandoffActivity().writes, 1);
  first(); const second = await waiting;
  assert.ok(f.coordination.getHandoffActivity().admissions > 0);
  second(); rewrite.rollback();
  assert.equal(f.coordination.getHandoffActivity().admissions, 0);
  assert.equal(f.coordination.getHandoffActivity().writes, 0);
});

test("a collaboration settlement remains visible after the finalization record is released", async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { release: () => resume.resolve(), onTurnSettled: async () => { entered.resolve(); await resume.promise; } });
  f.persistence.persistAgentEvent(end); await entered.promise; await f.persistence.flush();
  assert.equal(f.coordination.turnFinalizations.size, 0);
  assert.ok(f.coordination.getHandoffActivity().finalizations > 0);
  resume.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.coordination.getHandoffActivity().finalizations, 0);
});

test("missing archive and finalization Host preserves refusal evidence", async t => {
  const f = await fixture(t); f.runtimeState.host = null;
  f.persistence.persistAgentEvent(end); await f.persistence.flush();
  assert.equal(f.persistence.getHandoffActivity().uncontainedResources, 1);
  assert.equal(f.coordination.getHandoffActivity().uncontainedResources, 1);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.published, []);
});

test("synchronous event finalizer failure remains observable without stranding activity", async t => {
  const f = await fixture(t, { finishTurn() { throw new Error("synchronous finalizer failure"); } });
  assert.throws(() => f.persistence.persistAgentEvent(end), /synchronous finalizer failure/);
  await f.persistence.flush();
  assert.deepEqual(f.persistence.getHandoffActivity(), { ...idle, uncontainedResources: 1 });
});

test("asynchronous event finalizer and logger failures retain uncertainty and settle the original operation", async t => {
  const f = await fixture(t, { finishTurn: async () => { throw new Error("finalizer failure"); },
    logger: { app() { throw new Error("logger failure"); } },
  });
  f.persistence.persistAgentEvent(end); await f.persistence.flush();
  assert.deepEqual(f.persistence.getHandoffActivity(), { ...idle, uncontainedResources: 1 });
});

test("a skipped archive remains uncertain even if its outbox is later emptied", async t => {
  const f = await fixture(t); f.host.isAvailable = () => false;
  await f.outbox.enqueue({ key: "message:session:reply", sessionId: "session", message: reply }, () => null);
  f.persistence.persistAgentEvent(end); await f.persistence.flush();
  assert.ok(f.warnings.includes("skipped regenerate branch archive"));
  await f.outbox.dropSession("session");
  assert.deepEqual(f.persistence.getHandoffActivity(), { ...idle, uncontainedResources: 1 });
  assert.deepEqual(f.archived, []);
});

test("a failed asynchronous collaboration stays uncertain after its original completion", async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { release: () => resume.resolve(), onTurnSettled: async () => { entered.resolve(); await resume.promise; } });
  f.persistence.persistAgentEvent(end); await entered.promise; await f.persistence.flush();
  resume.reject(new Error("collaboration outcome unknown"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.coordination.getHandoffActivity().finalizations, 0);
  assert.equal(f.coordination.getHandoffActivity().uncontainedResources, 1);
  assert.ok(f.warnings.includes("session collaboration settlement failed"));
});

test("the original finalization stays visible while its release callback reenters", async t => {
  const f = await fixture(t);
  f.runtimeState.agentHostBridge = {
    endTurn() {
      assert.equal(f.coordination.turnFinalizations.size, 0);
      assert.ok(f.coordination.getHandoffActivity().finalizations > 0);
    },
    agentHost: { kick() {} },
  };
  await f.plans.finishTurn("session", "completed", undefined, { turnId: "turn" });
  assert.equal(f.coordination.getHandoffActivity().finalizations, 0);
  assert.equal(f.coordination.getHandoffActivity().uncontainedResources, 0);
});

test("mode settlement remains visible after the original turn finalization resolves", async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { release: () => resume.resolve(), onTurnEnded: async () => { entered.resolve(); await resume.promise; } });
  f.persistence.persistAgentEvent(end); await entered.promise; await f.persistence.flush();
  assert.ok(f.coordination.getHandoffActivity().finalizations > 0);
  resume.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.coordination.getHandoffActivity().finalizations, 0);
});
