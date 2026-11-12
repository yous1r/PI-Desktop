#!/usr/bin/env node
// Real Rust SQLite + production HostProcess + authenticated loopback RACP.
// The model/runtime edge acknowledges deterministically; no provider is called.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostProcess } from '../packages/host-runtime/dist/host-process.js';
import { createCommandCenterHost } from '../packages/host-runtime/dist/command-center-host.js';
import { createRustCommandCenterAdmissionPort } from '../packages/host-runtime/dist/command-center-admission.js';
import { createCommandCenterMonitorRpcPort } from '../packages/host-runtime/dist/command-center-monitor-rpc.js';
import { AgentHost } from '../packages/agent-host/dist/index.js';
import { RACP_WS_PATH } from '../packages/shared/dist/racp.js';
import {
  RacpServer, RacpClient, MemoryCredentialStore, DeviceTokenAuthenticator,
  hashToken, newDeviceToken, createCommandCenterDispatch, bindRacpWebSocket,
  wsClientTransport,
} from '../packages/racp/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.PI_DESKTOP_HOST_BIN, 'PI_DESKTOP_HOST_BIN must identify the tested binary');
assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR must identify isolated test state');
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
await mkdir(process.env.PI_SCRATCH_DIR, { recursive: true });
const directory = await mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR), 'cc-control-'));
for (const name of ['profile', 'home', 'temp']) await mkdir(join(directory, name));
const profile = join(directory, 'profile');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// A verification clone may carry only the request branch; record the base when known.
function baseMainRef() {
  try { return execFileSync('git', ['rev-parse', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const result = {
  status: 'FAIL', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  baseMain: baseMainRef(),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  hostBinarySha256: hash(await readFile(binary)),
  platform: process.platform, node: process.version, checks: [], cleanupConfirmed: false,
  scope: 'real private RPC + SQLite + loopback WebSocket; deterministic external runtime acknowledgements',
};
const check = (name, verify) => { verify(); result.checks.push(name); };
const resources = [];
const processes = [];
const environment = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)']) {
  if (process.env[key] !== undefined) environment[key] = process.env[key];
}
Object.assign(environment, {
  HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), RUST_LOG: 'error',
  PI_DESKTOP_ELECTRON_PID: '',
});
let host;
let binding;
let failNextAckReply = false;
let viewerAccess = true;
const workspaceIds = [randomUUID(), randomUUID(), randomUUID()];
const workspaceSessions = new Map(workspaceIds.map(id => [id, new Set()]));
const owner = { subject: 'cc-test-owner', roles: ['owner'] };
let dispatches = 0;
const authorize = async (principal, access) => {
  if (principal.subject === owner.subject) return true;
  if (principal.subject !== 'cc-test-viewer' || !viewerAccess || access.permission !== 'read') return false;
  return access.kind === 'workspace' ? access.id === workspaceIds[0] : workspaceSessions.get(workspaceIds[0]).has(access.id);
};
const rpc = {
  async call(method, params) {
    const response = await host.call(method, params);
    // A real committed SQLite result is dropped once at the transport edge.
    if (method === 'commandCenter.intervention.ack' && failNextAckReply) {
      failNextAckReply = false;
      throw new Error('isolated test dropped a committed ACK response');
    }
    return response;
  },
};
async function startRust() {
  const process = new HostProcess({ binaryPath: binary, dataDir: profile, env: environment, onStderr: () => undefined });
  processes.push(process);
  await process.handshake();
  const handshake = await process.call('app.handshake', { protocolVersion: 11 });
  assert.equal(handshake.commandCenter?.version, 1);
  assert.match(handshake.commandCenter.hostEpoch, /^[0-9a-f-]{36}$/);
  host = process;
  binding = { hostId: 'host_cc_isolated_test', hostEpoch: handshake.commandCenter.hostEpoch };
  return process;
}
const deadline = setTimeout(() => {
  result.timeout = true;
  for (const process of processes) void process.dispose();
}, 90_000);
try {
  await startRust();
  const admission = createRustCommandCenterAdmissionPort(rpc, () => binding);
  const controlHost = createCommandCenterHost({
    transport: rpc, hostIdentity: () => binding, authorizer: authorize,
    mutationsClosed: () => false, clock: { now: Date.now }, createDispatch: createCommandCenterDispatch,
    admission, runtimeMode: 'required', runtime: {
      canRecord: () => true,
      dispatch: async () => { dispatches += 1; return { status: 'accepted' }; },
    },
  });
  resources.push(() => controlHost.dispose());
  const monitor = createCommandCenterMonitorRpcPort({
    transport: rpc, hostIdentity: () => binding, authorize, clock: { now: Date.now }, pageRows: 2,
  });
  resources.push(() => monitor.dispose());
  const passiveHost = new AgentHost({
    runtime: {
      prompt: async () => { throw new Error('monitoring must not start a turn'); },
      stop: async () => ({ requested: false }), abort: async () => undefined,
      respondInput: async () => undefined,
    },
    sessions: { get: async () => null, history: async () => ({ items: [], hasMore: false }) },
    approvals: {
      resolveTool: async () => undefined, resolveContract: async () => undefined,
      listPendingTools: async () => [],
    },
  });
  const credentials = new MemoryCredentialStore();
  const ownerToken = newDeviceToken();
  const viewerToken = newDeviceToken();
  for (const [deviceId, roles, token] of [[owner.subject, ['owner'], ownerToken], ['cc-test-viewer', ['viewer'], viewerToken]]) {
    await credentials.saveDevice({ deviceId, roles, label: 'isolated test', tokenHash: hashToken(token), createdAt: new Date().toISOString() });
  }
  const authenticator = new DeviceTokenAuthenticator(credentials);
  const server = new RacpServer({
    agentHost: passiveHost, operations: { commandCenter: controlHost.control, commandCenterMonitorPage: monitor },
    authenticator, hostId: binding.hostId, serverVersion: 'isolated-test', advertiseCommandCenter: true,
    log: () => undefined,
  });
  const socket = await bindRacpWebSocket({ server, authenticator, port: 0, log: () => undefined });
  resources.push(() => socket.close());
  const url = `ws://${socket.address.host}:${socket.address.port}${RACP_WS_PATH}`;
  const clients = [];
  async function connect(token) {
    const client = new RacpClient({ transport: wsClientTransport({ url, token }),
      client: { name: 'isolated cc test', version: '1' }, reconnect: { enabled: false }, requestTimeoutMs: 10_000 });
    clients.push(client); resources.push(() => client.close());
    const initialized = await client.connect();
    assert.equal(initialized.capabilities.commandCenter, true);
    return client;
  }
  const client = await connect(ownerToken);
  const viewer = await connect(viewerToken);
  const read = { version: 1, hostId: binding.hostId };
  const mutation = () => ({ ...read, expectedHostEpoch: binding.hostEpoch });
  for (const [index, id] of workspaceIds.entries()) {
    await client.request('commandCenter/workspace/create', { ...mutation(), commandWorkspaceId: id, name: `Workspace ${index + 1}`, enabled: true });
  }
  const persistedWorkspaces = await client.request('commandCenter/workspace/list', read);
  check('authenticated WS reaches real Rust workspace transactions', () =>
    assert.deepEqual(persistedWorkspaces.workspaces.map(row => row.id).sort(), [...workspaceIds].sort()));
  const visible = await viewer.request('commandCenter/workspace/list', read);
  check('viewer workspace list is ACL filtered', () => assert.deepEqual(visible.workspaces.map(row => row.id), [workspaceIds[0]]));
  await assert.rejects(viewer.request('commandCenter/workspace/create', { ...mutation(), commandWorkspaceId: randomUUID(), name: 'denied', enabled: false }), { code: 'FORBIDDEN' });
  result.checks.push('viewer mutation is denied before persistence');
  const executions = [];
  for (let index = 0; index < 36; index += 1) {
    const workspaceId = workspaceIds[Math.floor(index / 12)];
    const { session } = await host.call('session.create', { title: `Isolated task ${index}`, mode: 'agent' });
    workspaceSessions.get(workspaceId).add(session.id);
    const { turnId } = await host.call('session.beginTurn', { sessionId: session.id, providerId: 'fixture', modelId: 'fixture' });
    await client.request('commandCenter/membership/bind', { ...mutation(), commandWorkspaceId: workspaceId, sessionId: session.id, expectedRevision: null });
    const request = { ...mutation(), commandWorkspaceId: workspaceId, expectedMembershipRevision: 1,
      target: { kind: 'session', sessionId: session.id, turnId } };
    const reserved = await controlHost.control.admitExecution(owner, request);
    assert.equal(reserved.hostLive, index + 1);
    executions.push(request);
    if (index === 11) {
      await assert.rejects(controlHost.control.admitExecution(owner, { ...request, target: { ...request.target, turnId: `overflow-${randomUUID()}` } }), { code: 'RESOURCE_EXHAUSTED' });
      result.checks.push('13th workspace reservation refused by Rust');
    }
  }
  const counts = await controlHost.control.admissionState(owner, workspaceIds);
  check('36 reservations span three workspaces in one authority', () => {
    assert.equal(counts.hostLive, 36);
    assert.deepEqual(counts.workspaces.map(row => row.live).sort(), [12, 12, 12]);
  });
  await assert.rejects(controlHost.control.admitExecution(owner, { ...executions[0], target: { ...executions[0].target, turnId: `host-overflow-${randomUUID()}` } }), { code: 'RESOURCE_EXHAUSTED' });
  result.checks.push('37th Host reservation refused by Rust');
  await controlHost.control.admitExecution(owner, executions[0]);
  const afterDuplicate = await controlHost.control.admissionState(owner, workspaceIds);
  check('duplicate reservation does not consume capacity twice', () => assert.equal(afterDuplicate.hostLive, 36));
  const first = executions[0];
  for (const [from, to] of [['reserved', 'starting'], ['starting', 'running']]) {
    await controlHost.control.holdExecution(owner, { ...mutation(), commandWorkspaceId: first.commandWorkspaceId, target: first.target, from, to, evidence: 'isolated runtime boundary' });
  }
  const requestId = randomUUID();
  const intervention = { ...first, requestId, expectedGoalRevision: 0, intent: { kind: 'reviseGoal', objective: 'Isolated goal revision', constraints: [] } };
  const receipt = await client.request('commandCenter/intervention/record', intervention);
  assert.equal(receipt.receipt.status, 'accepted');
  const replayed = await client.request('commandCenter/intervention/record', intervention);
  check('single durable request dispatches once', () => { assert.equal(replayed.replayed, true); assert.equal(dispatches, 1); });
  await assert.rejects(client.request('commandCenter/intervention/record', { ...intervention, intent: { ...intervention.intent, objective: 'changed payload' } }), { code: 'CONFLICT' });
  result.checks.push('requestId with a changed payload conflicts');
  const consumption = await controlHost.control.acknowledgeConsumption(owner, {
    ...mutation(), requestId, expectedRevision: receipt.receipt.revision,
    consumption: { version: 1, requestId, target: first.target, consumedRevision: 1, boundary: 'turn.boundary' },
  });
  check('Rust persists the evidenced consumed revision', () => {
    assert.equal(consumption.receipt.status, 'consumed');
    assert.equal(consumption.receipt.effectiveGoalRevision, 1);
  });
  failNextAckReply = true;
  const appendedId = randomUUID();
  const appended = await client.request('commandCenter/intervention/record', {
    ...first, requestId: appendedId, expectedGoalRevision: 1, intent: { kind: 'append', text: 'one appended input' },
  });
  check('lost committed ACK is reconciled without repeating dispatch', () => {
    assert.equal(appended.receipt.status, 'accepted'); assert.equal(appended.replayed, true); assert.equal(dispatches, 2);
  });
  const restored = await client.request('commandCenter/receipt/get', { ...read, requestId: appendedId });
  assert.equal(restored.status, 'accepted');
  check('another principal cannot read the retained receipt', () => assert.notEqual(owner.subject, 'cc-test-viewer'));
  assert.equal(await viewer.request('commandCenter/receipt/get', { ...read, requestId: appendedId }), null);
  const page = await viewer.request('commandCenter/monitorPage', read);
  check('monitor reads real reservations through Rust and WS', () => {
    assert.equal(page.cursor.epoch, binding.hostEpoch); assert.equal(page.rows.length, 2);
    assert.ok(page.rows.every(row => row.commandWorkspaceId === workspaceIds[0])); assert.ok(page.nextPage);
  });
  await assert.rejects(client.request('commandCenter/monitorPage', { ...read, token: page.nextPage }), { code: 'FORBIDDEN' });
  result.checks.push('monitor continuation cannot cross authenticated connections');
  viewerAccess = false;
  await assert.rejects(viewer.request('commandCenter/monitorPage', { ...read, token: page.nextPage }), { code: 'FORBIDDEN' });
  result.checks.push('ACL revocation invalidates a retained monitor page');
  viewerAccess = true;
  await controlHost.control.holdExecution(owner, { ...mutation(), commandWorkspaceId: first.commandWorkspaceId,
    target: first.target, from: 'running', to: 'outcome_unknown', evidence: 'uncertain transport' });
  const held = await controlHost.control.admissionState(owner, workspaceIds);
  check('outcome_unknown retains its capacity', () => assert.equal(held.hostLive, 36));
  const release = { ...mutation(), commandWorkspaceId: first.commandWorkspaceId, target: first.target, to: 'completed', evidence: 'confirmed runtime closure' };
  assert.deepEqual(await controlHost.control.releaseExecution(owner, release), { released: true });
  assert.deepEqual(await controlHost.control.releaseExecution(owner, release), { released: false });
  check('terminal release decrements exactly once', () => assert.equal(dispatches, 2));
  assert.equal((await controlHost.control.admissionState(owner, workspaceIds)).hostLive, 35);
  // Close the real peer, reopen the existing database and challenge the new
  // process with the old epoch. No credentials or real profile are involved.
  const oldEpoch = binding.hostEpoch;
  await host.dispose(); assert.equal(await host.confirmExit(), true);
  await startRust();
  assert.notEqual(binding.hostEpoch, oldEpoch);
  const retained = await client.request('commandCenter/receipt/get', { ...read, requestId: appendedId });
  assert.equal(retained.status, 'accepted');
  await assert.rejects(host.call('commandCenter.workspace.create', {
    binding: { hostId: binding.hostId, hostEpoch: oldEpoch },
    auth: { subject: owner.subject, roles: ['owner'], sessionIds: [], workspaceIds: [] },
    input: { ...read, expectedHostEpoch: oldEpoch, commandWorkspaceId: randomUUID(), name: 'stale', enabled: false },
  }), /CC_EPOCH_CONFLICT/);
  result.checks.push('populated reopen preserves receipts and rejects stale owner epoch');
  result.status = 'PASS';
} catch (error) {
  result.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const dispose of resources.reverse()) {
    try { await dispose(); } catch (error) { result.cleanupError = String(error); result.status = 'FAIL'; process.exitCode = 1; }
  }
  for (const process of processes) await process.dispose();
  result.cleanupConfirmed = (await Promise.all(processes.map(process => process.confirmExit()))).every(Boolean);
  if (!result.cleanupConfirmed) { result.status = 'FAIL'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, report: join(directory, 'report.json') }, null, 2));
}
