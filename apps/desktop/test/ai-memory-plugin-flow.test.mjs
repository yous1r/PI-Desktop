import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { eventually, upstreamFixture } from './helpers/ai-memory-upstream.mjs';

const binaryRoot = process.env.AI_MEMORY_TEST_BINARIES;
const suiteRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'ai-memory-host-flow-'));
process.env.PI_DESKTOP_DATA_DIR = join(suiteRoot, 'desktop-profile');
process.env.PI_DESKTOP_AGENTS_DIR = join(suiteRoot, 'isolated-agents');
register(new URL('./helpers/owner-runtime-import-hooks.mjs', import.meta.url));
const { PluginRuntime } = await import('../electron/main/plugin-runtime.ts');
const { createPluginExtensionOwnerBridge } = await import('../electron/main/plugin-extension-owner-bridge.ts');
const { PluginExtensionLaunchBindings } = await import('../electron/main/plugin-extension-launch-bindings.ts');
const { createOwnerFileReader } = await import('../electron/main/plugin-owner-files.ts');
const { DesktopAgentRuntime } = await import('../../../packages/agent-runtime/src/runtime.ts');
const { routeExtensionRequest } = await import('../../../packages/host-runtime/src/extension-owner-routing.ts');
const { candidateSidecar } = await import('./helpers/ai-memory-candidate-sidecar.mjs');
const pluginPath = process.env.AI_MEMORY_TEST_PLUGIN_PATH ?? fileURLToPath(new URL('../../../examples/plugins/ai-memory/dist/', import.meta.url));
const hostEntry = fileURLToPath(new URL('../electron/main/plugin-host-process.mjs', import.meta.url));

async function fixture(t, version) {
  const root = join(suiteRoot, version); await mkdir(root, { recursive: true });
  process.env.PI_DESKTOP_DATA_DIR = join(root, 'desktop-profile');
  const project = join(root, 'project'); await mkdir(project);
  const projectB = join(root, 'project-b'); await mkdir(projectB);
  const upstream = await upstreamFixture(t, root, version, binaryRoot, version === '3.3.3');
  const scope = { workspace: 'isolated-integration', project: 'project-a' };
  await upstream.tool('memory_write_page', { ...scope, path: 'notes/transactions.md', title: 'Transactions',
    body: 'Synthetic durable fact: transaction boundaries preserve ownership.', create_only: true });
  await upstream.tool('memory_write_page', { ...scope, project: 'project-b', path: 'notes/transactions.md', title: 'Transactions',
    body: 'Synthetic second-project-only transaction fact.', create_only: true });
  const records = new Map();
  const host = { call: async (method, params) => {
    if (method === 'session.get') return { session: records.get(params.id) ?? null };
    if (method === 'tools.list') return { tools: [] };
    return {};
  } };
  const secrets = new Map(); const audits = []; const pluginLogs = [];
  const events = []; const sidecarLogs = [];
  const plugins = new PluginRuntime({ hostEntry, getWorkspacePath: () => project,
    connectionSecrets: { read: async key => secrets.get(key) ?? null, write: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
    readOwnerFile: createOwnerFileReader({ getHost: () => host, getRemote: () => null, isPluginActive: () => true }),
    audit: entry => audits.push(entry),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true,
        ...(process.env.AI_MEMORY_TEST_NODE ? { execPath: process.env.AI_MEMORY_TEST_NODE, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}) });
      child.stdout.on('data', value => pluginLogs.push(value.toString()));
      child.stderr.on('data', value => pluginLogs.push(value.toString()));
      return { postMessage: message => { if (child.connected) child.send(message); },
        onMessage: handler => child.on('message', handler), onExit: handler => child.on('exit', code => handler(code ?? 0)), kill: () => child.kill() };
    },
  });
  const manifest = JSON.parse(await readFile(join(pluginPath, 'manifest.json'), 'utf8'));
  await plugins.loadFromPath(pluginPath, manifest.permissions);
  const connection = await plugins.connections.save({ pluginId: manifest.id, label: 'Isolated fixture', baseUrl: upstream.baseUrl,
    token: upstream.token, allowHttp: false, routes: [{ path: '/mcp', methods: ['POST'] }, { path: '/hook', methods: ['POST'] }] });
  const settings = { schemaVersion: 1, mode: 'managed', paused: false,
    bindings: [{ projectPath: project, connectionId: connection.id, ...scope, capture: true },
      { projectPath: projectB, connectionId: connection.id, workspace: scope.workspace, project: 'project-b', capture: true }],
    policy: { prompts: true, toolArguments: true, toolResults: true, assistant: true, maxChars: 8000, ignorePaths: [] },
    recall: { deadlineMs: 3000, maxChars: 6000 } };
  await plugins.invokePanelBridge(manifest.id, 'memory.settings', { settings, confirmed: true });
  const candidate = process.env.AI_MEMORY_TEST_SIDECAR ? candidateSidecar({ entry: process.env.AI_MEMORY_TEST_SIDECAR,
    executable: process.env.AI_MEMORY_TEST_NODE, host, events, logs: sidecarLogs }) : undefined;
  const launches = candidate?.launches ?? new PluginExtensionLaunchBindings();
  const owner = createPluginExtensionOwnerBridge({ launches, getHost: () => host, plugins, pluginActiveInProject: () => true });
  const confirms = []; const diagnostics = []; const modelRequests = []; let nextTools = [];
  let stalledRequest;
  const stallNext = () => { const state = { entered: false }; stalledRequest = state; return () => state.entered; };
  const bridge = { ...owner, publishCommands() {}, publishDiagnostics: params => diagnostics.push(params),
    requestUi: async params => { confirms.push(params); return { kind: 'confirm', value: true }; },
    configureModel: async () => ({}), queuePush: async () => ({}), queuePrioritize: async () => ({}) };
  candidate?.attach(bridge);
  const model = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    modelRequests.push(JSON.parse(body));
    if (stalledRequest) { stalledRequest.entered = true; stalledRequest = undefined; return; }
    const tool = nextTools.shift();
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${modelRequests.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: 'Synthetic completed response.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}`,
      'data: [DONE]',
    ].join('\n\n') + '\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const runtimes = []; let turn = 0;
  function create(sessionId = 'desktop-session', mode = 'agent', projectPath = project) {
    records.set(sessionId, { id: sessionId, mode, projectPath });
    const trustedExtensions = plugins.getAgentExtensions().map(item => ({ ...item, source: 'plugin', label: item.pluginName,
      ownerPluginId: item.pluginId, ownerOperations: item.ownerOperations }));
    const config = { host: { call: async (method, params) => method.startsWith('extensions.') ? routeExtensionRequest(bridge, method, params) : {},
      onNotification: () => () => {} }, sessionId, mode, projectPath, workspaceRoot: projectPath,
      trustedExtensions, thinkingLevel: 'off', onEvent: event => events.push(event),
      provider: { id: 'fixture', name: 'Fixture', apiKey: '', authKind: 'none', baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        modelId: 'fixture', supportsReasoning: false, supportedThinkingLevels: ['off'] },
      commandShell: { id: 'bash', label: 'Bash', dialect: 'posix', available: true, isDefault: true } };
    launches.observe('agent.prompt', config);
    const runtime = candidate ? candidate.create(config) : new DesktopAgentRuntime(config); runtimes.push(runtime);
    return { runtime, config };
  }
  async function prompt(agent, text, tool) {
    const turnId = `turn-${++turn}`;
    nextTools = tool ? [{ name: 'ToolSearch', args: { query: tool.name } }, tool] : [];
    launches.observe('agent.prompt', { ...agent.config, turnId });
    await agent.runtime.prompt(text, undefined, turnId);
    return turnId;
  }
  const panel = (channel, payload = {}) => plugins.invokePanelBridge(manifest.id, `memory.${channel}`, payload);
  const stateFile = join(process.env.PI_DESKTOP_DATA_DIR, 'plugins/data/local.ai-memory/memory-v1/state-v1.json');
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  t.after(async () => {
    await Promise.all(runtimes.map(runtime => runtime.dispose('app-quit')));
    await candidate?.close();
    owner.dispose(); await plugins.unload(manifest.id);
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ version, runtime: process.versions, modelRequests,
      diagnostics, confirms, audits, pluginLogs, sidecarLogs, sidecar: process.env.AI_MEMORY_TEST_SIDECAR ?? null }, null, 2).replaceAll(upstream.token, '<redacted>'));
  });
  return { root, upstream, scope, project, projectB, settings, connection, plugins, create, prompt, panel, state, stallNext,
    modelRequests, confirms, diagnostics, events, owner, records, manifests: manifest };
}

for (const version of ['3.3.2', '3.3.3']) test(`complete plugin process and Runner user path against ai-memory ${version}`,
  { skip: !binaryRoot && 'Set AI_MEMORY_TEST_BINARIES to verified isolated binaries', timeout: 240000 }, async t => {
    const f = await fixture(t, version);
    const agent = f.create(); await agent.runtime.loadTrustedExtensions();
    const initialTurn = await f.prompt(agent, 'Recall the transaction boundaries from project memory.');
    const initialStatus = await f.owner.callOwner({ requestId: 'initial-status', sessionId: 'desktop-session', turnId: initialTurn,
      runtimeId: agent.runtime.runtimeId, extensionId: agent.config.trustedExtensions[0].id, operation: 'status' });
    assert.equal(initialStatus.mode, 'managed');
    assert.equal(initialStatus.connectionsVersion, 1);
    const first = JSON.stringify(f.modelRequests[0]);
    assert.match(first, /Synthetic durable fact: transaction boundaries/);
    assert.match(first, /aim_writePage/, 'managed tool is discoverable in the real model request');
    assert.equal((first.match(/ai-memory historical context v1:/g) ?? []).length, 1);
    assert.ok(!JSON.stringify(f.events).includes('ai-memory historical context v1:'), 'memory is not persisted as a chat event');
    assert.ok(!first.includes(f.upstream.token));
    assert.equal((await f.panel('status')).connectionsVersion, 1);

    await f.prompt(agent, 'Save the explicitly confirmed synthetic fact.', { name: 'aim_writePage',
      args: { path: 'notes/confirmed.md', body: 'Synthetic explicit saved fact.', createOnly: true } });
    assert.ok(f.confirms.some(item => item.request.kind === 'confirm'), 'write reached the actual confirmation bridge');
    const saved = await f.upstream.tool('memory_read_page', { ...f.scope, path: 'notes/confirmed.md' });
    assert.match(JSON.stringify(saved), /Synthetic explicit saved fact/);
    await f.prompt(agent, 'Try a stale revision without overwriting.', { name: 'aim_writePage',
      args: { path: 'notes/confirmed.md', body: 'Must not overwrite.', expectedPageId: '00000000-0000-4000-8000-000000000000' } });
    assert.ok(!JSON.stringify(await f.upstream.tool('memory_read_page', { ...f.scope, path: 'notes/confirmed.md' })).includes('Must not overwrite'));
    assert.ok((await f.state()).mutations.some(item => item.operation === 'writePage' && item.state === 'rejected' && item.error === 'PAGE_CONFLICT'));

    const handoff = await f.upstream.tool('memory_handoff_begin', { ...f.scope, summary: 'Synthetic exact handoff recovery.' });
    const handoffId = handoff.handoff?.id ?? handoff.id ?? handoff.handoff_id;
    assert.equal(typeof handoffId, 'string', JSON.stringify(handoff));
    await f.prompt(agent, 'Preview the available handoff.');
    assert.ok((await f.upstream.tool('memory_handoff_list', f.scope)).handoffs.some(item => item.id === handoffId));
    await f.prompt(agent, 'Continue the selected synthetic task.', { name: 'aim_acceptHandoff', args: { handoffId } });
    assert.ok(!(await f.upstream.tool('memory_handoff_list', f.scope)).handoffs.some(item => item.id === handoffId));
    await agent.runtime.dispose('reconfigure');
    const restored = f.create(); await restored.runtime.loadTrustedExtensions();
    await f.prompt(restored, 'Resume the accepted synthetic task.');
    assert.notEqual(restored.runtime.runtimeId, agent.runtime.runtimeId);
    assert.match(JSON.stringify(f.modelRequests.at(-1)), /Synthetic exact handoff recovery/);
    const state = await f.state(); assert.equal(state.sessions.length, 1);
    assert.ok(state.events.length >= 3, 'actual extension callbacks persisted captures');
    assert.ok(!state.events.some(event => event.event.type === 'session-end'), 'runtime rebuild did not end the durable session');
    const remoteSession = state.sessions[0].id;
    await eventually(() => f.state(), current => current.events.every(event => ['delivered', 'discarded'].includes(event.state)), 'durable outbox confirmation', 40000);
    const observations = await f.upstream.tool('memory_read_session_observations', { ...f.scope, session_id: remoteSession, limit: 200 });
    assert.ok(observations.total >= 3); assert.equal(observations.session.ended_at, null);
    assert.match(JSON.stringify(observations), /Recall the transaction boundaries/);
    await f.upstream.stop(); await f.upstream.start();
    assert.equal((await f.upstream.tool('memory_read_session_observations', { ...f.scope, session_id: remoteSession, limit: 200 })).total, observations.total);

    await restored.runtime.dispose('reconfigure');
    const plan = f.create('plan-session', 'plan'); await plan.runtime.loadTrustedExtensions();
    const before = (await f.state()).events.length;
    await f.prompt(plan, 'Read project transaction history in Plan mode.');
    assert.match(JSON.stringify(f.modelRequests.at(-1)), /ai-memory historical context v1:/);
    assert.equal((await f.state()).events.length, before, 'Plan mode remains read-only');
    const diagnostics = JSON.stringify(await f.panel('diagnostics'));
    assert.ok(!diagnostics.includes('Synthetic explicit saved fact')); assert.ok(!diagnostics.includes(f.upstream.token));

    const other = f.create('other-project-session', 'agent', f.projectB);
    await other.runtime.loadTrustedExtensions();
    const requestStart = f.modelRequests.length;
    await Promise.all([f.prompt(plan, 'Project A transaction check.'), f.prompt(other, 'Project B transaction check.')]);
    const concurrent = f.modelRequests.slice(requestStart);
    const forB = concurrent.find(request => JSON.stringify(request.messages).includes('Project B transaction check.'));
    const forA = concurrent.find(request => JSON.stringify(request.messages).includes('Project A transaction check.'));
    assert.match(JSON.stringify(forB), /second-project-only/);
    assert.ok(!JSON.stringify(forB).includes('transaction boundaries preserve ownership'));
    assert.ok(!JSON.stringify(forA).includes('second-project-only'));

    const cancelled = f.create('cancelled-session'); await cancelled.runtime.loadTrustedExtensions();
    const modelEntered = f.stallNext();
    const cancelling = f.prompt(cancelled, 'Synthetic request to cancel.');
    await eventually(async () => modelEntered(), Boolean, 'model request ready to cancel');
    await cancelled.runtime.abort(); await cancelling;
    await cancelled.runtime.dispose('reconfigure');

    const online = f.create('offline-session'); await online.runtime.loadTrustedExtensions();
    await f.prompt(online, 'Establish verified offline recovery scope.');
    await f.upstream.stop();
    const beforeOffline = (await f.state()).events.length;
    await f.prompt(online, 'Synthetic prompt retained during network outage.');
    assert.ok((await f.state()).events.length > beforeOffline, 'offline chat still durably admits enabled capture');
    await online.runtime.dispose('reconfigure'); await other.runtime.dispose('reconfigure'); await plan.runtime.dispose('reconfigure');
    await f.plugins.unload('local.ai-memory');
    const retained = await f.state();
    assert.ok(retained.events.some(event => !['delivered', 'discarded'].includes(event.state)), 'unload retains pending events');
    await f.upstream.start();
    await f.plugins.loadFromPath(pluginPath, f.manifests.permissions);
    const reopened = f.create('offline-session'); await reopened.runtime.loadTrustedExtensions();
    await f.prompt(reopened, 'Resume after plugin and server restart.');
    assert.equal((await f.state()).installationId, retained.installationId);
    await eventually(() => f.state(), current => current.events.every(event => ['delivered', 'discarded'].includes(event.state)), 'restart outbox recovery', 60000);
    const offlineSession = (await f.state()).sessions.find(session => session.desktopId === 'offline-session');
    const recovered = await f.upstream.tool('memory_read_session_observations', { ...f.scope, session_id: offlineSession.id, limit: 200 });
    assert.match(JSON.stringify(recovered), /Synthetic prompt retained during network outage/);
    const cancelledSession = (await f.state()).sessions.find(session => session.desktopId === 'cancelled-session');
    const cancelledObservations = await f.upstream.tool('memory_read_session_observations', { ...f.scope, session_id: cancelledSession.id, limit: 200 });
    assert.match(JSON.stringify(cancelledObservations), /cancelled/);
    const handoffsBeforeClose = await f.upstream.tool('memory_handoff_list', f.scope);
    await reopened.runtime.dispose('session-close');
    assert.equal((await f.state()).sessions.find(session => session.desktopId === 'offline-session').state, 'closed');
    const closed = await eventually(() => f.upstream.tool('memory_read_session_observations', { ...f.scope, session_id: offlineSession.id, limit: 200 }),
      current => JSON.stringify(current.observations).includes('session-close'), 'explicit session close boundary persists', 20000);
    assert.equal(closed.session.ended_at, null, 'native session-end is not sent because it can create an automatic handoff');
    assert.deepEqual((await f.upstream.tool('memory_handoff_list', f.scope)).handoffs, handoffsBeforeClose.handoffs);
  });
