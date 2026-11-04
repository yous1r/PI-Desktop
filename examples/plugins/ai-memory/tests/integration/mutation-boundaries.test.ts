import test from 'node:test';
import assert from 'node:assert/strict';
import { excluded, redactText, sanitize } from '../../src/capture/policy.js';
import { context, harness } from '../helpers.js';
import { record } from '../../src/contracts.js';

test('quoted secret output and relative shell paths are filtered; pathological nested content stays bounded', () => {
  assert.equal(redactText('{"password":"synthetic secret with spaces"}').includes('synthetic secret'), false);
  assert.equal(redactText("token = 'synthetic-secret'").includes('synthetic-secret'), false);
  assert.equal(excluded('cat private/customer.txt', ['private/**']), true);
  const nested = Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => ({ value: 1, nested: [1, 2, 3] })));
  assert.ok(JSON.stringify(sanitize(nested, 2000)).length < 4000);
});
test('explicit begin/cancel handoff and version-bound maintenance complete through the service', async () => {
  const h = await harness();
  try {
    const started = record(await h.service.call('beginHandoff', { requestId: 'b', summary: 'Finish synthetic test', confirmation: { confirmed: true, intent: 'beginHandoff' } }, context()));
    const cancelled = record(await h.service.call('cancelHandoff', { requestId: 'c', handoffId: started.handoff_id, confirmation: { confirmed: true, intent: 'cancelHandoff' } }, context()));
    assert.equal(cancelled.cancelled, true);
    const page = record(await h.service.call('writePage', { requestId: 'w', path: 'notes/remove.md', body: '# Temporary', createOnly: true, confirmation: { confirmed: true, intent: 'writePage' } }, context()));
    await h.service.call('maintenance', { requestId: 'd', action: 'deletePage', path: 'notes/remove.md', expectedPageId: page.page_id, confirmation: { confirmed: true, intent: 'maintenance' } }, context());
    assert.equal(h.network.pages.size, 0);
    assert.ok(h.journal.snapshot().mutations.every(item => item.state === 'completed'));
  } finally { await h.cleanup(); }
});
test('malformed write response is uncertain, never a successful receipt', async () => {
  const h = await harness();
  try {
    const original = h.network.request.bind(h.network);
    h.network.request = async input => {
      const result = await original(input);
      const body = JSON.parse(input.body ?? '{}');
      if (body.params?.name === 'memory_write_page') result.bodyText = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: {} } });
      return result;
    };
    await assert.rejects(h.service.call('writePage', { requestId: 'w', path: 'notes/a.md', body: '# A', createOnly: true, confirmation: { confirmed: true, intent: 'writePage' } }, context()), /WRITE_RECEIPT_MALFORMED/);
    assert.equal(h.journal.snapshot().mutations[0].state, 'delivery-uncertain');
  } finally { await h.cleanup(); }
});
