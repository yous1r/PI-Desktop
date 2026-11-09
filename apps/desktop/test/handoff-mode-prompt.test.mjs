import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { createModeServices } = await import("../electron/main/runtime/mode-services.ts");
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");

for (const phase of ["ordinary", "lock", "launch", "begin", "claim"]) test(`mode continuation prompt owns ${phase} through finalization`, async t => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mode-prompt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), dispatched = Promise.withResolvers();
  const calls = [], replacementCalls = [], prompts = [], warnings = [];
  const wait = async point => { if (phase === point) { entered.resolve(); await release.promise; } };
  const gate = new DesktopHandoffAdmission();
  t.after(() => gate.dispose());
  const activeTurns = new Map();
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const session = { id: "session", title: "Session", mode: "goal", permissionMode: "ask", messages: [], createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z" };
  const run = { id: "run", sessionId: "session", modeId: "goal", state: "running", revision: 1, stageId: "work", input: "work", artifactPaths: {} };
  const host = { generation: "original", async call(method, params) {
    calls.push({ method, params });
    switch (method) {
      case "settings.get": return {};
      case "session.get": return { session };
      case "session.queueList": return { entries: [] };
      case "session.beginTurn": await wait("begin"); return { turnId: "turn" };
      case "session.endTurn": return { ok: true };
      case "modes.resolve": return { run, continue: true };
      case "modes.get": return { run };
      case "modes.claimTurn": await wait("claim"); return { claimed: true, run, enteredStage: false };
      case "modes.settleTurn": return { run, continue: false };
      default: throw new Error(`unexpected Host call ${method}`);
    }
  } };
  let currentHost = host;
  const sidecar = { captureHostBinding: expected => () => currentHost === expected,
    setProjectInstructionRoot() {}, async call(method, params) { prompts.push({ method, params }); dispatched.resolve(); return { accepted: true, turnId: "turn" }; } };
  const handlers = new Map();
  const logger = { app(...args) { warnings.push(args); } };
  const bridge = createAgentHostBridge({ getHost: () => currentHost, channels: IPC.invoke, gate, log() {},
    invoke: (channel, [request]) => handlers.get(channel)(request) });
  const runtimeState = { host, sidecar, agentHostBridge: bridge, handoffAdmission: gate };
  const services = createModeServices({ getHost: () => currentHost, getSidecar: () => sidecar, getAgentHostBridge: () => bridge,
    sendToRenderer() {}, logger, isQuitting: () => false, isAdmissionClosed: () => gate.isClosed(), modeDirectory: directory });
  t.after(() => services.runs.dispose());
  const launch = async () => { await wait("launch"); return { providerId: "fixture", modelId: "fixture", sidecarParams: { sessionId: "session", provider: { modelConfig: { input: ["text"] } } } }; };
  const plans = createPlanRuntime({ runtimeState, planState: { approvedExecutionDrain: null }, logger, sendToRenderer() {}, coordination,
    scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(), dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(), pendingExecutionFinishes: new Map(), announceTurnEnded() {}, emitAgentEvent() {},
    acquireSessionOperation: coordination.acquireSessionOperation, resolveAgentRuntimeLaunch: launch, isQuitting: () => false,
    onTurnEnded: (sessionId, turnId, end) => services.runs.settleTurn(sessionId, turnId, end) });
  t.after(() => plans.dispose());
  registerAgentIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => currentHost, getSidecar: () => sidecar, getAgentHostBridge: () => bridge, logger, agentExtensions: {},
    cancelSessionTools() {}, persistenceOutbox: {}, dataDir: directory, activeTurns, completionNoticeTurns: new Set(),
    activeTurnUsages: coordination.activeTurnUsages, approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart: coordination.recordTurnStart, isTurnDispatchable: coordination.isTurnDispatchable,
    resolveAgentRuntimeLaunch: launch, acquireSessionOperation: async id => { await wait("lock"); return coordination.acquireSessionOperation(id); },
    finishTurn: plans.finishTurn, modeRuns: services.runs, emitAgentEvent() {}, setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => null, composerCommandService: { buildComposerCommands: async () => [] }, loadComposerTemplatesCached: async () => [] });
  await services.runs.resolve({ sessionId: "session", runId: "run", expectedRevision: 1, decision: "approve" });
  if (phase !== "ordinary") {
    await entered.promise;
    currentHost = { ...host, generation: "replacement", async call(method) { replacementCalls.push(method); throw new Error("replacement must not be used"); } };
    runtimeState.host = currentHost;
    release.resolve();
  } else await dispatched.promise;
  await services.runs.drain();
  assert.deepEqual(replacementCalls, []);
  assert.equal(prompts.length, phase === "ordinary" ? 1 : 0);
  if (phase === "ordinary") {
    assert.equal(prompts[0].params.modeTurn.runId, "run");
    assert.equal(prompts[0].params.userMessageId, undefined);
    await plans.finishTurn("session", "completed", undefined, { turnId: "turn" });
    await services.runs.drain();
  }
  assert.equal(calls.filter(call => call.method === "session.endTurn").length, ["ordinary", "begin", "claim"].includes(phase) ? 1 : 0);
  assert.equal(services.runs.getHandoffActivity().turns, 0);
  assert.equal(activeTurns.size, 0);
  assert.equal(calls.some(call => call.method === "session.appendMessage"), false, "continuations never invent user messages");
});
