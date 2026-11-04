import test from 'node:test';
import assert from 'node:assert/strict';
import binary332 from '../fixtures/upstream/v3.3.2-binary.json';
import binary333 from '../fixtures/upstream/v3.3.3-binary.json';
import { inspectCapabilities } from '../../src/upstream/capabilities.js';
import { decodeRpc, unwrapTool, McpTransport } from '../../src/upstream/transport.js';
import { normalizePage, V3Adapter } from '../../src/upstream/adapters/v3.js';
import { HOOK_EXTENSION, hookParts, hookKind, observationMatches } from '../../src/upstream/hook.js';
import { record } from '../../src/contracts.js';
import { context, harness, TEST_CATALOG } from '../helpers.js';
import { Outbox } from '../../src/capture/outbox.js';

for (const fixture of [binary332, binary333]) test(`${fixture.provenance.release} real binary schemas/page/JSON-RPC conflict agree with adapter`, () => {
  const report = inspectCapabilities(fixture.initialize, fixture.tools);
  for (const operation of ['query', 'readPage', 'briefing', 'listHandoffs', 'writePage', 'acceptHandoff', 'beginHandoff', 'cancelHandoff', 'observations'] as const) assert.equal(report.tools[operation]?.available, true, operation);
  const read = fixture.records.find(item => item.label === 'read-page')!;
  const wire = record(read.wire); const json = record(wire.json);
  const page = normalizePage(unwrapTool(record(json.result)), { connectionId: 'fixture', connectionRevision: 1, workspace: 'contract', project: 'synthetic-pages' });
  assert.equal(page.path, 'notes/contract.md'); assert.match(page.body, /Alpha fact/);
  const conflict = fixture.records.find(item => item.label === 'write-stale')!;
  const rpc = record(record(conflict.wire).json); rpc.id = 'test-id';
  assert.throws(() => decodeRpc({ status: 200, connectionRevision: 1, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify(rpc) }, 'test-id'), /PAGE_CONFLICT/);
  const hook = fixture.records.find(item => item.label === 'hook-session-start')!;
  assert.equal(hook.wire.status, 202); assert.equal(record(hook.wire).body, 'queued');
});
test('202 accepted remains remote-queued until exact read-only observation confirms persistence; no replay', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context());
    await h.service.call('capture', { type: 'prompt', eventId: 'event', data: { prompt: 'content' } }, context());
    let visible = false; let sent = 0; let now = Date.now();
    const outbox = new Outbox(h.journal, async () => ({ report: undefined, deliver: async event => { sent++; return `queued:${event.id}`; }, verifyDelivery: async event => visible ? `observation:${event.id}` : null }), () => now);
    await outbox.drain(context().signal);
    assert.equal(h.journal.snapshot().events[0].state, 'remote-queued'); assert.equal(sent, 1);
    await assert.rejects(outbox.retry(h.journal.snapshot().events[0].id), /RECONCILIATION_REQUIRED/);
    visible = true; now += 1001; await outbox.drain(context().signal);
    assert.equal(sent, 2); assert.ok(h.journal.snapshot().events.every(item => item.state === 'delivered'));
  } finally { await h.cleanup(); }
});
test('actual adapter handles text queued receipt, captures completion metadata without paid pre-compact and verifies marker', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context());
    await h.service.call('capture', { type: 'agent_end', eventId: 'end', data: { outcome: 'cancelled', cancelled: true } }, context());
    const event = h.journal.snapshot().events[1];
    const scope = event.scope;
    const original = h.network.request.bind(h.network);
    h.network.request = async input => input.path.startsWith('/hook?') ? { status: 202, headers: { 'content-type': 'text/plain' }, connectionRevision: 1, bodyText: 'queued' } : original(input);
    const adapter = new V3Adapter(new McpTransport(h.network, scope), TEST_CATALOG); await adapter.discover(context().signal);
    assert.equal(await adapter.deliver(event, context().signal), `queued:${event.id}`);
    assert.equal(hookKind(event), 'stop');
    const part = hookParts(event).find(item => item.kind === 'other')!;
    assert.match(String(part.body.body), /cancelled/);
    const observation = { kind: 'other', extension: HOOK_EXTENSION, source_event: part.source, body: part.body.body };
    assert.equal(observationMatches(observation, event, part), true);
    assert.equal(observationMatches({ ...observation, source_event: 'another-event' }, event, part), false);
    assert.equal(observationMatches({ ...observation, body: 'truncated' }, event, part), false);
    assert.equal(observationMatches({ kind: 'session-start' }, { ...event, event: { ...event.event, type: 'session_start' } }), false);
    assert.deepEqual(hookParts({ ...event, event: { ...event.event, type: 'compact' } }).map(item => item.kind), ['other']);
  } finally { await h.cleanup(); }
});
