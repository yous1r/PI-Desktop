import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostProcess } from '../../packages/host-runtime/src/host-process.ts';
import { AgentSidecar } from '../../packages/host-runtime/src/agent-sidecar.ts';
import { createPlanRuntime } from '../../apps/desktop/electron/main/runtime/plans.ts';
import { createSessionCoordination } from '../../apps/desktop/electron/main/runtime/session-coordination.ts';
import { DesktopHandoffAdmission } from '../../apps/desktop/electron/main/runtime/handoff-admission.ts';
import { createSessionLaunchRuntime } from '../../apps/desktop/electron/main/runtime/session-launch.ts';
import { capabilitiesFromModelConfig, modelConfigWithBinding } from '../../packages/agent-runtime/src/index.ts';
import { submitPlan, resolvePlan } from './plan.mjs';
import { bounded } from './owner-handoff-fixture.mjs';

const directory = process.env.PI_DESKTOP_PLAN_FIXTURE;
assert.ok(directory && process.env.PI_DESKTOP_HOST_BIN);
const profile = join(directory, 'profile'), workspace = join(directory, 'workspace');
const report = { status: 'FAIL', checks: [], cleanupConfirmed: false };
const admission = new DesktopHandoffAdmission();
const activeTurns = new Map();
const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
const logger = { app(_area, level, message) { if (level === 'warn') process.stderr.write(`${message}\n`); } };
let host, sidecar, reopened, plans, releaseBegin;
const runtimeState = { host: null, sidecar: null, agentHostBridge: null, handoffAdmission: admission };
const fixturePath = join(directory, 'sidecar-fixture.mjs');
await writeFile(fixturePath, `import {createInterface} from 'node:readline';
let executions=[];
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);let result;
 if(method==='agent.executeApprovedPlan'){executions.push({executionId:params.execution.id,turnId:params.turnId});result={accepted:true};}
 else if(method==='fixture.stats')result={executions,ticketLeaked:!!process.env.PI_EXECUTION_TICKET};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'unsupported fixture operation'}})+'\\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
});
`);
async function closeSidecar() {
  if (!sidecar) return;
  assert.equal(await sidecar.fenceExecution(), true);
  assert.equal(await sidecar.confirmExit(), true);
  await sidecar.dispose();sidecar = undefined;
}
const inspect = async () => ({ clients: 0, turns: activeTurns.size, queuedTurns: 0, plans: plans.inFlightCount(),
  tools: 0, processes: 0, terminals: 0, plugins: 0, admissions: admission.inFlightCount(), finalizations: coordination.turnFinalizations.size,
  writes: 0, children: 0, workers: 0, schedules: 0, approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0 });
// Zero families above are absent only in this isolated fixture, never a Desktop inventory adapter.
try {
  host = new HostProcess({ binaryPath: process.env.PI_DESKTOP_HOST_BIN, dataDir: profile, executionFence: true, onStderr: text => process.stderr.write(text) });
  await host.handshake();runtimeState.host = host;
  assert.deepEqual((await host.call('mcp.active', { projectPath: workspace })).servers, []);
  assert.deepEqual((await host.call('skills.active', { projectPath: workspace })).skills, []);
  assert.deepEqual((await host.call('agents.active', { projectPath: workspace })).subagents, []);
  report.isolatedExtensionRegistries = true;
  sidecar = await AgentSidecar.createFenced({ host, binaryPath: process.env.PI_DESKTOP_HOST_BIN,
    launch: { command: process.execPath, args: [fixturePath], cwd: workspace, env: {} }, onStderr: text => process.stderr.write(text) });
  runtimeState.sidecar = { call: (...args) => sidecar.call(...args), setVendorAuthBindings(_id, bindings) { assert.deepEqual(bindings, []); } };
  const { provider } = await host.call('providers.create', { name: 'Plan fixture', authKind: 'none',
    baseUrl: 'http://127.0.0.1:9/v1', apiStyle: 'chat_completions', defaultModelId: 'fixture',
    models: [{ id: 'fixture', thinkingLevels: ['off'], defaultThinkingLevel: 'off' }] });
  await host.call('settings.set', { defaultProviderId: provider.id, defaultModelId: 'fixture' });
  const launch = createSessionLaunchRuntime({ runtimeState, logger, dataDir: profile, sessionProjects: new Map(),
    userMcp: { setRecords(records) { assert.deepEqual(records, []); }, async toolsForProject() { return []; } },
    plugins: { listLoaded: () => [], getSkills: () => [], getAgentExtensions: () => [], getToolsForSession: async () => [] },
    vendorOAuth: { bindingFor: async () => { throw new Error('no vendor provider in fixture'); } },
    modelsDevCatalog: { ensureLoaded: async () => {}, configureAccount() {}, findModel: () => undefined },
    getWorkspacePath: () => workspace, pluginActiveInProject: () => false,
    bindingForModel: (row, id) => row.models?.find(model => model.id === id),
    effectiveSubagentModelConfig: (_row, _id, catalog) => {
      const modelConfig = modelConfigWithBinding(catalog, undefined);return { modelConfig, capabilities: capabilitiesFromModelConfig(modelConfig) };
    }, normalizeThinkingLevel: () => 'off' });
  plans = createPlanRuntime({ runtimeState, planState: { approvedExecutionDrain: null }, logger, coordination,
    sendToRenderer() {}, scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(), dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(), pendingExecutionFinishes: new Map(), announceTurnEnded() {}, emitAgentEvent() {},
    acquireSessionOperation: coordination.acquireSessionOperation, resolveAgentRuntimeLaunch: launch.resolveAgentRuntimeLaunch, isQuitting: () => false });
  const createApproved = async title => {
    const { session } = await host.call('session.create', { title, mode: 'plan', projectPath: workspace, permissionMode: 'ask' });
    const { turnId } = await host.call('session.beginTurn', { sessionId: session.id });
    const proposal = await submitPlan(host, session.id, turnId, randomUUID(), title, `# ${title}\n\nFixture approved work.\n`, 'Proceed?');
    await host.call('session.appendMessage', { sessionId: session.id, turnId, message: {
      id: randomUUID(), role: 'tool', content: 'Plan submitted', createdAt: proposal.createdAt,
      toolName: 'SubmitPlan', toolCallId: proposal.toolCallId, toolStatus: 'success', toolResult: { details: { proposal } },
    } });
    const resolved = await resolvePlan(host, proposal, 'approve', 'ask');
    await host.call('session.endTurn', { turnId, status: 'completed', createNotification: false });
    assert.equal(resolved.execution.state, 'queued');
    return { session, proposal, execution: resolved.execution };
  };
  const first = await createApproved('Completed plan');
  const hold = await admission.gate.acquireHandoff(randomUUID(), inspect);
  await plans.dispatchExecutionForProposal(first.proposal.id);
  assert.equal((await host.call('plans.queuedExecutions')).executions.length, 1);
  assert.deepEqual(await sidecar.call('fixture.stats'), { executions: [], ticketLeaked: false });
  hold.cancel();
  report.checks.push('closed admission leaves the approved durable execution queued and sends no sidecar request');

  const release = await coordination.acquireSessionOperation(first.session.id);
  const dispatch = plans.dispatchExecutionForProposal(first.proposal.id);
  try { await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), error => error.code === 'HOST_BUSY'); }
  finally { release();await bounded(dispatch, 'approved plan launch', 30000); }
  const stats = await sidecar.call('fixture.stats');
  assert.equal(stats.executions.length, 1);assert.equal(stats.executions[0].executionId, first.execution.id);
  await plans.dispatchApprovedPlan(first.execution);
  assert.equal((await sidecar.call('fixture.stats')).executions.length, 1);
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), error => error.code === 'HOST_BUSY');
  await plans.finishTurn(first.session.id, 'completed', undefined, { turnId: stats.executions[0].turnId });
  await plans.finishApprovedExecution(first.execution.id, 'completed');
  assert.equal(plans.inFlightCount(), 0);assert.equal(activeTurns.size, 0);
  const idle = await admission.gate.acquireHandoff(randomUUID(), inspect);idle.cancel();
  report.checks.push('real Rust claim, production launch resolution, one contained sidecar dispatch and acknowledged turn/execution finalization');

  const second = await createApproved('Interrupted setup');
  const entered = Promise.withResolvers(), waiting = Promise.withResolvers();releaseBegin = waiting.resolve;
  const originalCall = host.call.bind(host);
  let delayedTurn;
  host.call = async (method, ...args) => {
    const result = await originalCall(method, ...args);
    if (method === 'session.beginTurn') { delayedTurn = result.turnId;entered.resolve();await waiting.promise; }
    return result;
  };
  const delayed = plans.dispatchApprovedPlan(second.execution);
  await bounded(entered.promise, 'durable beginTurn');
  admission.dispose();waiting.resolve();releaseBegin = undefined;
  await bounded(delayed, 'late turn cleanup');host.call = originalCall;
  assert.ok(delayedTurn);assert.equal(plans.inFlightCount(), 0);assert.equal(activeTurns.size, 0);
  assert.equal((await sidecar.call('fixture.stats')).executions.length, 1);
  report.checks.push('gate closure after durable beginTurn closes the original turn and execution without a second sidecar launch');

  plans.dispose();await closeSidecar();
  await host.dispose();assert.equal(await host.confirmExit(), true);host = undefined;
  reopened = new HostProcess({ binaryPath: process.env.PI_DESKTOP_HOST_BIN, dataDir: profile, onStderr: text => process.stderr.write(text) });
  await reopened.handshake();
  const outcomes = [];
  for (const [item, expected] of [[first, 'completed'], [second, 'interrupted']]) {
    const { session } = await reopened.call('session.get', { id: item.session.id });
    const proposal = session.planHistory.find(entry => entry.proposal.id === item.proposal.id).proposal;
    assert.equal(proposal.executionState, expected);
    assert.equal(await readFile(join(workspace, proposal.artifact.relativePath), 'utf8'), item.proposal.markdown);
    outcomes.push({ executionId: item.execution.id, state: proposal.executionState });
  }
  assert.deepEqual((await reopened.call('plans.queuedExecutions')).executions, []);
  report.outcomes = outcomes;
  report.checks.push('independent Host reopen retains completed/interrupted outcomes and exact approved artifact bytes; no execution replay');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  releaseBegin?.();admission.dispose();plans?.dispose();
  const errors = [];
  try { await closeSidecar(); } catch (error) { errors.push(String(error)); }
  for (const child of [host, reopened]) if (child) {
    try { await child.dispose();assert.equal(await child.confirmExit(), true); } catch (error) { errors.push(String(error)); }
  }
  report.cleanupConfirmed = errors.length === 0;
  if (errors.length) { report.status = 'FAIL';report.cleanupErrors = errors; }
  await writeFile(join(directory, 'worker-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.status === 'PASS' && report.cleanupConfirmed ? 0 : 1;
}
