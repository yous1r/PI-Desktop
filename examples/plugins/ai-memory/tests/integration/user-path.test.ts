import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { context, harness, settings } from '../helpers.js';
import { record } from '../../src/contracts.js';

test('representative user flow: bind, recall, capture tool error, explicit page create/read/update conflict, exact handoff accept/recover', async () => {
  const config = settings(); config.policy.toolResults = true;
  const h = await harness({ config });
  try {
    const recalled = record(await h.service.call('recall', { query: 'transactions' }, context()));
    assert.match(String(recalled.text), /transaction boundaries/); assert.deepEqual(h.network.claimed, []);
    await h.service.call('capture', { eventId: 'tool1', type: 'tool_result', data: { toolName: 'Read', toolCallId: 'call1', content: 'Access denied', isError: true } }, context());
    assert.equal(h.journal.snapshot().events[1].event.data.isError, true);
    const write = { requestId: 'write1', path: 'notes/new.md', body: '# New\nDurable fact', createOnly: true, confirmation: { confirmed: true, intent: 'writePage' } };
    const saved = record(await h.service.call('writePage', write, context()));
    const page = record(await h.service.call('readPage', { path: 'notes/new.md' }, context()));
    assert.equal(page.body, write.body); assert.equal(page.pageId, saved.page_id);
    await assert.rejects(h.service.call('writePage', { ...write, requestId: 'write2', createOnly: undefined, expectedPageId: 'stale-version' }, context()), /PAGE_CONFLICT/);
    const accept = { requestId: 'accept1', handoffId: 'handoff-1', confirmation: { confirmed: true, intent: 'acceptHandoff' } };
    await h.service.call('acceptHandoff', accept, context());
    await h.service.call('acceptHandoff', accept, context());
    assert.deepEqual(h.network.claimed, ['handoff-1']);
    const recovered = record(await h.service.call('recall', { query: 'task', refresh: true }, context({ runtimeId: 'runtime-new' })));
    assert.match(String(recovered.text), /Accepted recovery data/);
    assert.match(await readFile(h.journal.file, 'utf8'), /Accepted recovery data/);
    const diagnostics = JSON.stringify(await h.service.panel('memory.diagnostics', {}));
    assert.equal(diagnostics.includes('Durable fact'), false); assert.equal(diagnostics.includes('Accepted recovery data'), false);
    await h.service.tick();
    assert.ok(h.network.hooks.some(hook => hook.isError === true));
  } finally { await h.cleanup(); }
});
test('lost handoff result requires reconciliation and does not select or consume another row', async () => {
  const h = await harness();
  try {
    h.network.loseResponse = true;
    const args = { requestId: 'accept1', handoffId: 'exact-id', confirmation: { confirmed: true, intent: 'acceptHandoff' } };
    await assert.rejects(h.service.call('acceptHandoff', args, context()), /TRANSPORT_FAILURE/);
    assert.equal(h.journal.snapshot().mutations[0].state, 'delivery-uncertain');
    await assert.rejects(h.service.call('acceptHandoff', { ...args, requestId: 'accept2' }, context()), /RECONCILIATION_REQUIRED/);
    assert.deepEqual(h.network.claimed, ['exact-id']);
  } finally { await h.cleanup(); }
});
test('Plan/Goal and unknown versions fail closed; verified capture requires no server setting change', async () => {
  const h = await harness();
  try {
    for (const mode of ['plan', 'goal'] as const) {
      await h.service.call('recall', { query: 'read' }, context({ mode }));
      await assert.rejects(h.service.call('capture', { type: 'prompt', eventId: 'x', data: {} }, context({ mode })), /AGENT_MODE_REQUIRED/);
      await assert.rejects(h.service.call('beginHandoff', {}, context({ mode })), /AGENT_MODE_REQUIRED/);
    }
    h.network.version = '9.9.9';
    await assert.rejects(h.service.call('writePage', { requestId: 'w', path: 'a.md', body: 'a', createOnly: true, confirmation: { confirmed: true, intent: 'writePage' } }, context()), /WRITES_NOT_VERIFIED/);
    await h.service.saveSettings(settings(), true);
    await assert.rejects(h.service.call('capture', { type: 'prompt', eventId: 'x', data: {} }, context()), /CAPTURE_NOT_VERIFIED/);
    assert.equal(h.network.hooks.length, 0);
  } finally { await h.cleanup(); }
  const production = await harness({ catalog: null });
  try { await production.service.call('capture', { type: 'prompt', eventId: 'x', data: {} }, context()); assert.equal(production.journal.snapshot().events.length, 2); }
  finally { await production.cleanup(); }
});
test('two projects stay isolated through concurrent recall and a conflicting marker pauses capture', async () => {
  const config = settings(); config.bindings.push({ ...config.bindings[0], projectPath: '/project-b', project: 'project-b' });
  const h = await harness({ config });
  try {
    const [a, b] = await Promise.all([h.service.call('recall', { query: 'same' }, context()), h.service.call('recall', { query: 'same' }, context({ sessionId: 'b', runtimeId: 'b', projectPath: '/project-b', workspaceRoot: '/project-b' }))]);
    assert.match(String(record(a).text), /project-a/); assert.match(String(record(b).text), /project-b/);
    h.setMarker('workspace="team"\nproject="unexpected"');
    await assert.rejects(h.service.call('capture', { eventId: 'x', type: 'prompt', data: {} }, context()), /BINDING_CONFLICT/);
    assert.equal(h.journal.snapshot().events.length, 0);
  } finally { await h.cleanup(); }
});
test('recall deadline cancels the host request and never writes partial context', async t => {
  const h = await harness();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    h.network.hang = true;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const request = h.network.request.bind(h.network);
    h.network.request = input => { const pending = request(input); started(); return pending; };
    const work = h.service.call('recall', { query: 'hang' }, context());
    const rejected = assert.rejects(work, /RECALL_DEADLINE/);
    await ready; t.mock.timers.tick(1501); await rejected;
    assert.equal(h.network.pending.size, 0); assert.equal(h.service.status(context()).lastRecall, undefined);
  } finally { t.mock.timers.reset(); await h.cleanup(); }
});
test('missing live host capability yields unsupported even with manifest version satisfied', async () => {
  const h = await harness();
  try {
    h.host.connections = undefined; await h.service.initialize();
    await assert.rejects(h.service.call('recall', { query: 'task' }, context()), /HOST_UPGRADE_REQUIRED/);
  } finally { await h.cleanup(); }
});
