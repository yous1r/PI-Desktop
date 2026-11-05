import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, eventually, hashes } from './fixture.js';
import { Journal } from '../../src/storage/journal.js';
import { SessionCoordinator } from '../../src/service/session-coordinator.js';
import { Outbox } from '../../src/capture/outbox.js';
import { normalize } from '../../src/capture/policy.js';
import { V3Adapter } from '../../src/upstream/adapters/v3.js';
import { McpTransport } from '../../src/upstream/transport.js';
import { Mutations } from '../../src/recall/handoff.js';
import { HOOK_EXTENSION, hookParts, observationMatches } from '../../src/upstream/hook.js';
import { DEFAULT_SETTINGS, record, type Connections, type OwnerContext } from '../../src/contracts.js';

for (const version of ['3.3.2', '3.3.3']) test(`official ${version}: production adapter/outbox writes, observation reconciliation, restart, exact handoff`, { skip: !process.env.AI_MEMORY_TEST_BINARIES, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(process.env.AI_MEMORY_TEST_SCRATCH!, 'r-'));
  const server = await fixture(t, root, version);
  const connection: Connections = { getCapabilities: async () => ({ version: 1 }), list: async () => [], request: server.request, cancel: server.cancel };
  const scope = { connectionId: 'synthetic', connectionRevision: 1, workspace: 'contract', project: 'plugin' };
  const context: OwnerContext = { sessionId: 'synthetic-desktop-session', runtimeId: 'synthetic-runtime', turnId: 'synthetic-turn', projectPath: root, workspaceRoot: root, mode: 'agent', signal: AbortSignal.timeout(80000) };
  let adapter = new V3Adapter(new McpTransport(connection, scope));
  const report = await adapter.discover(context.signal);
  assert.equal(report.version, version); assert.equal(report.writes, true); assert.equal(report.capture, true); assert.equal(report.hookIdempotent, true);
  assert.ok(Object.values(report.tools).every(item => item.available), JSON.stringify(report));
  const journal = new Journal(join(root, 'journal')); await journal.initialize(); t.after(() => journal.close());
  const sessions = new SessionCoordinator(journal); const mutations = new Mutations(journal);
  let clock = Date.now(); const outbox = new Outbox(journal, async () => adapter, () => clock);
  const confirm = (intent: string) => ({ confirmed: true, intent });
  const created = record(await mutations.execute('writePage', { requestId: 'create', path: 'architecture/synthetic.md', body: '# Synthetic\nZephyrtest durable fact.', createOnly: true, confirmation: confirm('writePage') }, context, scope, adapter));
  assert.ok(created.page_id);
  const page = await adapter.readPage('architecture/synthetic.md', context.signal); assert.match(page.body, /Zephyrtest/);
  assert.ok((await adapter.query('Zephyrtest', context.signal)).some(item => item.path === page.path));
  await assert.rejects(mutations.execute('writePage', { requestId: 'stale', path: page.path, body: 'must not replace', expectedPageId: '00000000-0000-4000-8000-000000000000', confirmation: confirm('writePage') }, context, scope, adapter), /PAGE_CONFLICT/);
  assert.equal((await adapter.readPage(page.path, context.signal)).body, page.body);
  await mutations.execute('writePage', { requestId: 'replace', path: page.path, body: '# Synthetic\nZephyrtest revised fact.', expectedPageId: page.pageId, confirmation: confirm('writePage') }, context, scope, adapter);
  const handoff = record(await mutations.execute('beginHandoff', { requestId: 'begin', summary: 'Synthetic exact recovery body', confirmation: confirm('beginHandoff') }, context, scope, adapter));
  const policy = { ...DEFAULT_SETTINGS.policy, prompts: true, toolArguments: true, toolResults: true, assistant: true, maxChars: 16000 };
  const captures = [
    { type: 'prompt', eventId: 'prompt', data: { prompt: 'Synthetic project request' } },
    { type: 'tool_call', eventId: 'call', data: { toolName: 'Bash', toolCallId: 'synthetic-call', input: { command: 'synthetic argument value' } } },
    { type: 'tool_result', eventId: 'result', data: { toolName: 'Bash', toolCallId: 'synthetic-call', isError: true, content: [{ type: 'text', text: 'Synthetic failed result' }] } },
    { type: 'agent_end', eventId: 'assistant', data: { content: [{ type: 'text', text: `Synthetic assistant ${'边界'.repeat(900)} END-OF-ASSISTANT` }], cancelled: true } },
    { type: 'compact', eventId: 'compact', data: { reason: 'synthetic compaction' } },
  ];
  for (const input of captures) await sessions.receive(normalize(input, policy)!, scope, context);
  await sessions.retire({ ...context, retirementReason: 'reconfigure' });
  const original = journal.snapshot().events;
  const hookRequests = () => server.requests.filter(item => item.path.startsWith('/hook?'));
  // Delay the observation read only. Real server accepts and persists, but admission alone
  // must leave content intact and must prevent the next session event from being uploaded.
  server.controls.hideObservations = true; await outbox.drain(context.signal);
  assert.equal(journal.snapshot().events[0].state, 'remote-queued');
  assert.equal(journal.snapshot().events[1].state, 'queued');
  assert.equal(hookRequests().length, hookParts(original[0]).length);
  assert.deepEqual(journal.snapshot().events[0].event.data, original[0].event.data);
  server.controls.hideObservations = false;
  await eventually(async () => { clock += 6000; await outbox.drain(context.signal); return journal.snapshot().events.map(item => ({ state: item.state, error: item.error })); }, states => states.every(item => item.state === 'delivered'), 'all events durably observed');
  assert.ok(journal.snapshot().events.every(item => item.receipt?.startsWith('observations:') && Object.keys(item.event.data).length === 0));
  const observations = await adapter.call('observations', { session_id: original[0].sessionId, limit: 200, offset: 0, body_max_chars: 2000, order: 'asc' }, context.signal);
  assert.equal(record(observations.session).cwd, root);
  assert.equal(record(observations.session).ended_at, null, 'retirement and agent end leave remote session open');
  assert.equal(record(observations.session).agent_kind, 'pi');
  const items = observations.observations as Record<string, unknown>[];
  assert.equal(items.length, original.reduce((count, event) => count + hookParts(event).length, 0));
  for (const event of original) for (const part of hookParts(event)) assert.equal(items.filter(item => observationMatches(item, event, part)).length, 1, `unique durable part ${part.source}`);
  const bodies = items.map(item => item.body).join('\n');
  assert.match(bodies, /synthetic argument value/); assert.match(bodies, /Synthetic failed result/); assert.match(bodies, /END-OF-ASSISTANT/); assert.match(bodies, /outcome: error/);
  assert.ok(items.every(item => item.extension === HOOK_EXTENSION));
  assert.equal((await adapter.listHandoffs(context.signal)).find(item => item.id === handoff.handoff_id)?.state, 'open', 'session-start never claims');
  // A server restart retains ingest-key deduplication for identical immutable payloads.
  await server.stop(); await server.start(); adapter = new V3Adapter(new McpTransport(connection, scope)); await adapter.discover(context.signal);
  for (const event of original) await adapter.deliver(event, context.signal);
  await eventually(async () => adapter.verifyDelivery(original.at(-1)!, context.signal), Boolean, 'restart reconciliation');
  const afterRestart = await adapter.call('observations', { session_id: original[0].sessionId, limit: 200, offset: 0, body_max_chars: 2000, order: 'asc' }, context.signal);
  assert.equal(afterRestart.total, observations.total);
  // Native side effects also remain non-consuming across start replay.
  assert.equal((await adapter.listHandoffs(context.signal)).find(item => item.id === handoff.handoff_id)?.state, 'open');
  const accepted = record(await mutations.execute('acceptHandoff', { requestId: 'accept', handoffId: handoff.handoff_id, confirmation: confirm('acceptHandoff') }, context, scope, adapter));
  assert.equal(accepted.status, 'claimed'); assert.equal(record(accepted.handoff).state, 'open');
  const persisted = JSON.parse(await readFile(journal.file, 'utf8'));
  assert.equal(persisted.mutations.find((item: { id: string }) => item.id === 'accept').result.status, 'claimed');
  const calls = server.requests.length;
  assert.deepEqual(await mutations.execute('acceptHandoff', { requestId: 'accept', handoffId: handoff.handoff_id, confirmation: confirm('acceptHandoff') }, context, scope, adapter), accepted);
  assert.equal(server.requests.length, calls, 'local confirmed recovery never accepts twice');
  assert.equal((await adapter.call('acceptHandoff', { handoff_id: handoff.handoff_id }, context.signal)).status, 'none_pending');
  const cancel = record(await mutations.execute('beginHandoff', { requestId: 'begin-cancel', summary: 'Synthetic cancellable handoff', confirmation: confirm('beginHandoff') }, context, scope, adapter));
  await mutations.execute('cancelHandoff', { requestId: 'cancel', handoffId: cancel.handoff_id, confirmation: confirm('cancelHandoff') }, context, scope, adapter);
  const revision = await adapter.readPage(page.path, context.signal);
  await mutations.execute('maintenance', { requestId: 'delete', action: 'deletePage', path: page.path, expectedPageId: revision.pageId, confirmation: confirm('maintenance') }, context, scope, adapter);
  await assert.rejects(adapter.readPage(page.path, context.signal));
  const lostHandoff = record(await mutations.execute('beginHandoff', { requestId: 'begin-lost', summary: 'Synthetic lost claim body', confirmation: confirm('beginHandoff') }, context, scope, adapter));
  const lostArgs = { requestId: 'accept-lost', handoffId: lostHandoff.handoff_id, confirmation: confirm('acceptHandoff') };
  server.controls.loseToolResponse = 'memory_handoff_accept';
  await assert.rejects(mutations.execute('acceptHandoff', lostArgs, context, scope, adapter), /TRANSPORT_FAILURE/);
  assert.equal(journal.snapshot().mutations.find(item => item.id === 'accept-lost')?.state, 'delivery-uncertain');
  const beforeLostRetry = server.requests.length;
  await assert.rejects(mutations.execute('acceptHandoff', lostArgs, context, scope, adapter), /RECONCILIATION_REQUIRED/);
  assert.equal(server.requests.length, beforeLostRetry);
  assert.equal((await adapter.call('acceptHandoff', { handoff_id: lostHandoff.handoff_id }, context.signal)).status, 'none_pending');
  // Lose one hook response after the actual server receives it; production retry uses the
  // exact same key/body, then verifies every part before acknowledging or advancing.
  await sessions.receive(normalize({ type: 'prompt', eventId: 'lost', data: { prompt: 'Synthetic loss recovery' } }, policy)!, scope, { ...context, runtimeId: 'new-runtime' });
  server.controls.loseHookResponse = true; clock += 10000; await outbox.drain(context.signal);
  assert.equal(journal.snapshot().events.at(-1)?.state, 'queued');
  await eventually(async () => { clock += 10000; await outbox.drain(context.signal); return journal.snapshot().events.at(-1)?.state; }, state => state === 'delivered', 'lost-response retry verified');
  const lastHooks = hookRequests().slice(-3); assert.equal(lastHooks[0].path, lastHooks[1].path); assert.equal(lastHooks[0].body, lastHooks[1].body);
  assert.ok(server.requests.every(item => !item.path.startsWith('/handoff') && !item.path.includes('session-end')));
  for (const request of server.requests.filter(item => item.path === '/mcp')) {
    const rpc = JSON.parse(request.body!); if (rpc.params?.name === 'memory_query') { assert.equal(rpc.params.arguments.answer, false); assert.equal(rpc.params.arguments.reasoning, undefined); }
  }
  if (process.env.AI_MEMORY_PLUGIN_EVIDENCE) {
    const evidence = { release: version, binarySha256: hashes[version], platform: process.platform,
      implementation: 'Production V3Adapter, McpTransport, Outbox, Journal, SessionCoordinator, Mutations; no injected catalog',
      observations: items.map(({ id, session_id, created_at, ...item }) => item),
      assertions: ['guarded create/read/replace/conflict/delete', 'explicit no-synthesis query', '202 admission retains queue and blocks next event', 'all native and detail observations uniquely reconciled', 'tool arguments/results and long Unicode assistant text persisted', 'native tool error preserved', 'runtime retirement leaves session open', 'session-start does not consume handoff', 'immutable ingest-key deduplication across restart', 'hook response loss recovers without duplicate event', 'exact accept persisted before return; replay served locally', 'lost handoff response stays uncertain; never blindly retried'] };
    await writeFile(join(process.env.AI_MEMORY_PLUGIN_EVIDENCE, `plugin-${version}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

for (const version of ['3.3.2', '3.3.3']) test(`official ${version}: production transport stateful SSE`, { skip: !process.env.AI_MEMORY_TEST_BINARIES, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(process.env.AI_MEMORY_TEST_SCRATCH!, 'stateful-'));
  const server = await fixture(t, root, version, true);
  const adapter = new V3Adapter(new McpTransport({ getCapabilities: async () => ({ version: 1 }), list: async () => [], request: server.request, cancel: server.cancel }, { connectionId: 'synthetic', connectionRevision: 1, workspace: 'contract', project: 'sse' }));
  const signal = AbortSignal.timeout(15000); await adapter.discover(signal);
  await adapter.call('writePage', { path: 'synthetic.md', body: 'Stateful synthetic body', create_only: true }, signal);
  assert.match((await adapter.readPage('synthetic.md', signal)).body, /Stateful synthetic/);
  const initialized = server.requests.find(item => JSON.parse(item.body!).method === 'notifications/initialized')!;
  assert.ok(initialized.headers?.['Mcp-Session-Id']);
  assert.ok(server.requests.slice(1).every(item => item.headers?.['Mcp-Session-Id'] === initialized.headers?.['Mcp-Session-Id']));
  const previousSession = initialized.headers?.['Mcp-Session-Id'];
  await server.stop(); await server.start();
  assert.match((await adapter.readPage('synthetic.md', signal)).body, /Stateful synthetic/);
  const latestInit = server.requests.filter(item => JSON.parse(item.body!).method === 'notifications/initialized').at(-1)!;
  assert.notEqual(latestInit.headers?.['Mcp-Session-Id'], previousSession);
  // Mutations are never automatically replayed on transport-session loss.
  await server.stop(); await server.start();
  const beforeWrite = server.requests.length;
  await assert.rejects(adapter.call('writePage', { path: 'never-replayed.md', body: 'No implicit replay', create_only: true }, signal), /MCP_SESSION_EXPIRED/);
  assert.equal(server.requests.slice(beforeWrite).filter(item => JSON.parse(item.body!).params?.name === 'memory_write_page').length, 1);
});
