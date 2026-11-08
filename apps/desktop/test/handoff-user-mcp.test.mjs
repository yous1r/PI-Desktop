import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
register(new URL('./helpers/current-source-import-hooks.mjs', import.meta.url));
const { UserMcpRuntime } = await import('../electron/main/user-mcp.ts');
const { DesktopHandoffAdmission } = await import('../electron/main/runtime/handoff-admission.ts');

const record = (id = 'fixture', transport = 'http') => ({ id, label: id, transport,
  command: transport === 'stdio' ? 'fixture' : undefined, url: 'http://127.0.0.1:9/mcp',
  enabled: true, scope: { mode: 'global', projects: [] } });
const tools = [{ name: 'lookup', description: 'fixture tool' }];
const deferred = () => Promise.withResolvers();
function fixture(t, overrides = {}) {
  const admission = new DesktopHandoffAdmission();
  const created = [];
  const runtime = new UserMcpRuntime({
    isAdmissionClosed: () => admission.isClosed(),
    createClient: () => {
      const client = { connect: async () => tools, getTools: () => tools, isConnected: () => true,
        callTool: async () => ({ value: 'done' }), ping: async () => {}, close() {}, ...overrides.client };
      created.push(client);return client;
    }, ...overrides.options,
  });
  runtime.setRecords([record()]);
  t.after(() => { admission.dispose();runtime.disposeAll(); });
  return { runtime, admission, created };
}
const closed = { errorCode: 'HOST_BUSY' };

test('all MCP work entries refuse a closed application gate before creating clients', async t => {
  const { runtime, admission, created } = fixture(t);
  admission.dispose();
  for (const operation of [() => runtime.toolsForProject('/fixture'), () => runtime.test('fixture'),
    () => runtime.callTool('mcp_fixture_lookup', {}, '/fixture'), () => runtime.refreshStatuses()]) {
    await assert.rejects(operation(), closed);
  }
  assert.equal(created.length, 0);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 0 });
});

test('OAuth setup stays counted and cannot create a client after gate closure', async t => {
  const token = deferred(), entered = deferred();
  const { runtime, admission, created } = fixture(t, { options: {
    oauth: { hasOAuth: async () => true, getValidAccessToken: () => { entered.resolve();return token.promise; } },
  } });
  const pending = runtime.toolsForProject('/fixture');
  const rejected = assert.rejects(pending, closed);
  await entered.promise;
  assert.ok(runtime.getHandoffActivity().mcp > 0);
  assert.equal(runtime.getHandoffActivity().uncontainedResources, 0);
  admission.dispose();
  assert.ok(runtime.getHandoffActivity().mcp > 0);
  token.resolve(null);await rejected;
  assert.equal(created.length, 0);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 0 });
});

test('retired handshake remains busy after invalidation and disposal until its original result', async t => {
  const handshake = deferred(), entered = deferred();
  const { runtime } = fixture(t, { client: { connect() { entered.resolve();return handshake.promise; } } });
  const pending = runtime.toolsForProject('/fixture');
  const rejected = assert.rejects(pending, closed);
  await entered.promise;
  runtime.invalidate('fixture');runtime.disposeAll();
  assert.ok(runtime.getHandoffActivity().mcp > 0);
  assert.equal(runtime.getHandoffActivity().uncontainedResources, 1);
  handshake.resolve(tools);await rejected;
  assert.equal(runtime.hasTool('mcp_fixture_lookup'), false);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
  await assert.rejects(runtime.test('fixture'), closed);
});

test('cancel and close do not erase an unsettled tool call or prove native closure', async t => {
  const result = deferred(), entered = deferred();
  let signal;
  const { runtime } = fixture(t, { client: {
    callTool(_name, _args, value) { signal = value;entered.resolve();return result.promise; },
  } });
  await runtime.toolsForProject('/fixture');
  const pending = runtime.callTool('mcp_fixture_lookup', {}, '/fixture', 'session');
  const rejected = assert.rejects(pending, closed);
  await entered.promise;
  runtime.cancelSessionCalls('session');runtime.disposeAll();
  assert.equal(signal.aborted, true);
  assert.ok(runtime.getHandoffActivity().mcp > 0);
  result.resolve({ value: 'late' });await rejected;
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
});

test('status probe survives cache removal in the activity inventory', async t => {
  const probe = deferred(), entered = deferred();
  const { runtime } = fixture(t, { client: { ping() { entered.resolve();return probe.promise; } } });
  await runtime.toolsForProject('/fixture');
  const pending = runtime.refreshStatuses();
  const rejected = assert.rejects(pending, closed);
  await entered.promise;runtime.disposeAll();
  assert.ok(runtime.getHandoffActivity().mcp > 0);
  probe.resolve();await rejected;
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
});

test('parallel discovery keeps ownership until every admitted setup settles', async t => {
  const handshake = deferred(), entered = deferred();
  const { runtime } = fixture(t, { options: { createClient(config) {
    if (config.server.id === 'failed') throw new Error('client construction failed');
    return { connect() { entered.resolve();return handshake.promise; }, getTools: () => tools,
      isConnected: () => true, close() {}, callTool: async () => ({}), ping: async () => {} };
  } } });
  runtime.setRecords([record('failed'), record('waiting')]);
  let settled = false;
  const pending = runtime.toolsForProject('/fixture').finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /client construction failed/);
  await entered.promise;await Promise.resolve();await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(runtime.getHandoffActivity().mcp > 0);
  handshake.resolve(tools);await rejected;
  assert.equal(runtime.getHandoffActivity().uncontainedResources, 2);
  runtime.disposeAll();
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 2 });
});

test('connection failure, replacement and record deletion retain unqualified resources', async t => {
  let fail = true;
  const { runtime } = fixture(t, { client: { async connect() {
    if (fail) throw new Error('handshake timed out');return tools;
  } } });
  assert.deepEqual(await runtime.toolsForProject('/fixture'), []);
  assert.equal(runtime.getHandoffActivity().uncontainedResources, 1);
  fail = false;await runtime.test('fixture');
  assert.equal(runtime.getHandoffActivity().uncontainedResources, 2);
  runtime.setRecords([]);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 2 });
});

test('configured but never initialized MCP records do not invent live resources', async t => {
  const { runtime, created } = fixture(t);
  runtime.setRecords([{ ...record(), enabled: false }]);
  assert.deepEqual(await runtime.toolsForProject('/fixture'), []);
  assert.equal(created.length, 0);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 0 });
});

test('tool setup cannot dispatch through a client retired during its await', async t => {
  let called = false;
  const { runtime } = fixture(t, { client: { async callTool() { called = true;return {}; } } });
  await runtime.toolsForProject('/fixture');
  const pending = runtime.callTool('mcp_fixture_lookup', {}, '/fixture');
  runtime.invalidate('fixture');
  await assert.rejects(pending, { errorCode: 'UNAVAILABLE' });
  assert.equal(called, false);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
});

test('record removal during OAuth cannot resurrect a client', async t => {
  const token = deferred(), entered = deferred();
  const { runtime, created } = fixture(t, { options: {
    oauth: { hasOAuth: async () => true, getValidAccessToken: () => { entered.resolve();return token.promise; } },
  } });
  const pending = runtime.toolsForProject('/fixture');
  await entered.promise;runtime.setRecords([]);token.resolve(null);
  assert.deepEqual(await pending, []);assert.equal(created.length, 0);
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 0 });
});

test('real stdio discovery and call block handoff, and child exit does not erase unqualified ownership', async t => {
  const { McpServerClient } = await import('../electron/main/plugin-mcp.ts');
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'handoff-mcp-'));
  const path = join(directory, 'server.mjs');
  await writeFile(path, `import {createInterface} from 'node:readline';
let waiting;
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}}});
 if(m.method==='tools/list')send(m.id,{tools:[{name:'lookup',inputSchema:{type:'object',properties:{}}}]});
 if(m.method==='tools/call'){waiting=m.id;process.stderr.write('fixture-call-entered\\n');}
 if(m.method==='notifications/fixtureRelease')send(waiting,{content:[{type:'text',text:'fixture-result'}]});
});`);
  const admission = new DesktopHandoffAdmission();
  const entered = deferred(), exited = deferred();
  let child;
  const runtime = new UserMcpRuntime({
    isAdmissionClosed: () => admission.isClosed(),
    createClient: config => new McpServerClient({ ...config, spawnImpl: (command, args, options) => {
      const env = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      Object.assign(env, { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory });
      child = spawn(command, args, { ...options, env });
      child.stderr.on('data', bytes => { if (String(bytes).includes('fixture-call-entered')) entered.resolve(); });
      child.once('close', () => exited.resolve());
      return child;
    } }),
  });
  const confirmExit = async () => {
    let timer;
    try {
      await Promise.race([exited.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture child closure unconfirmed')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    runtime.disposeAll();admission.dispose();
    if (child) await confirmExit();
    await rm(directory, { recursive: true, force: true });
  });
  // All other families are absent in this service fixture, not a Desktop adapter.
  const inspect = async () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0,
    processes: 0, terminals: 0, plugins: 0, admissions: 0, finalizations: 0, writes: 0,
    children: 0, workers: 0, schedules: 0, approvals: 0, inputs: 0, nativeSessions: 0,
    ...runtime.getHandoffActivity() });
  const empty = await admission.gate.acquireHandoff(randomUUID(), inspect);empty.cancel();
  runtime.setRecords([{ ...record('fixture', 'stdio'), command: process.execPath, args: [path], env: {} }]);
  assert.equal((await runtime.toolsForProject(directory))[0].fullName, 'mcp_fixture_lookup');
  const pending = runtime.callTool('mcp_fixture_lookup', {}, directory, 'fixture-session');
  await entered.promise;
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: 'HOST_BUSY' });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/fixtureRelease' }) + '\n');
  assert.deepEqual(await pending, { content: [{ type: 'text', text: 'fixture-result' }] });
  runtime.disposeAll();await confirmExit();
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: 'HOST_BUSY' });
});

test('gate closure during a pinned recovery handshake prevents the tool invocation', async t => {
  const recovery = deferred(), entered = deferred();
  let online = true, recovering = false, called = false;
  const { runtime, admission } = fixture(t, { client: {
    isConnected: () => online,
    connect() { if (!recovering) return Promise.resolve(tools);entered.resolve();return recovery.promise; },
    async callTool() { called = true;return {}; },
  } });
  await runtime.toolsForProject('/fixture');online = false;recovering = true;
  const pending = runtime.callTool('mcp_fixture_lookup', {}, '/fixture');
  const rejected = assert.rejects(pending, closed);
  await entered.promise;admission.dispose();recovery.resolve(tools);await rejected;
  assert.equal(called, false);
  runtime.disposeAll();
  assert.deepEqual(runtime.getHandoffActivity(), { mcp: 0, uncontainedResources: 1 });
});
