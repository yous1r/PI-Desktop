import test from 'node:test';
import assert from 'node:assert/strict';
import { context, harness, settings } from '../helpers.js';
import { Outbox } from '../../src/capture/outbox.js';
import { UnexpectedHandoffError } from '../../src/upstream/errors.js';
import { readHostMarker } from '../../src/main.js';
import { record } from '../../src/contracts.js';

const capture = { type: 'prompt', eventId: 'p', data: {} };
test('legacy claimed response is retained for explicit recovery, excludes diagnostic bodies, and prevents new upload', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', capture, context());
    const worker = new Outbox(h.journal, async () => ({ report: undefined, deliver: async () => { throw new UnexpectedHandoffError({ handoff: { id: 'h', summary: 'RECOVERY BODY', token: 'synthetic-secret' } }); }, verifyDelivery: async () => null }));
    await worker.drain(context().signal);
    const first = h.journal.snapshot().events[0];
    assert.equal(first.state, 'delivery-uncertain'); assert.equal(first.error, 'SESSION_START_CONSUMED_HANDOFF');
    const recovery = await h.service.panel('memory.recovery', { id: first.id });
    assert.match(JSON.stringify(recovery), /RECOVERY BODY/); assert.equal(JSON.stringify(recovery).includes('synthetic-secret'), false);
    assert.equal(JSON.stringify(await h.service.panel('memory.diagnostics', {})).includes('RECOVERY BODY'), false);
    await h.service.tick(); assert.equal(h.network.hooks.length, 0);
  } finally { await h.cleanup(); }
});
test('unconfirmed async acceptance reaches uncertainty without replay or body removal', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', capture, context());
    let now = Date.now(); let sent = 0;
    const worker = new Outbox(h.journal, async () => ({ report: undefined, deliver: async event => { sent++; return `queued:${event.id}`; }, verifyDelivery: async () => null }), () => now);
    await worker.drain(context().signal); now += 61_000; await worker.drain(context().signal);
    assert.equal(sent, 1); assert.equal(h.journal.snapshot().events[0].state, 'delivery-uncertain');
    assert.equal(h.journal.snapshot().events[1].state, 'queued');
  } finally { await h.cleanup(); }
});
test('pause prevents capture/retirement uploads while retaining queued data', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', capture, context());
    await h.service.saveSettings({ ...settings(), paused: true }, true);
    await assert.rejects(h.service.call('recall', { query: 'task' }, context()), /CAPTURE_PAUSED/);
    await assert.rejects(h.service.call('capture', { ...capture, eventId: 'new' }, context()), /CAPTURE_PAUSED/);
    await h.service.call('retire', {}, context()); await h.service.tick();
    assert.equal(h.journal.snapshot().events.length, 2); assert.equal(h.network.hooks.length, 0);
  } finally { await h.cleanup(); }
});
test('owner status does not expose another project/session queue or recall sources', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', capture, context());
    const status = record(await h.service.call('status', {}, context({ sessionId: 'other', projectPath: '/other', workspaceRoot: '/other' })));
    assert.deepEqual(status.capabilities, []); assert.equal(record(status.queue).count, 0); assert.equal(status.lastRecall, undefined);
  } finally { await h.cleanup(); }
});
test('remote markers route only through host preview and remote failure never selects local cwd', async () => {
  const h = await harness();
  try {
    const remote = context({ projectPath: 'remote:host/project', workspaceRoot: '/srv/project', remoteWorkspace: { hostKey: 'host', path: '/srv/project' } });
    let calls = 0;
    h.host.fs.readPreview = async (path, options) => { calls++; assert.equal(path, '.ai-memory.toml'); assert.equal(options?.workspacePath, remote.projectPath); return { kind: 'text', content: 'workspace="team"', size: 16 }; };
    assert.equal(await readHostMarker(h.host, remote), 'workspace="team"'); assert.equal(calls, 1);
    h.host.fs.readPreview = async () => { throw new Error('remote unavailable'); };
    await assert.rejects(readHostMarker(h.host, remote), /REMOTE_MARKER_UNAVAILABLE/);
  } finally { await h.cleanup(); }
});
test('panel reconciliation checks durable evidence without replaying uncertain events', async () => {
  const h = await harness();
  try {
    await h.service.call('capture', { type: 'prompt', eventId: 'reconcile', data: {} }, context());
    await h.service.tick();
    const id = h.journal.snapshot().events[0].id;
    // Simulate interruption after upstream persistence, before the local acknowledgement.
    await h.journal.update(state => { state.events[0].state = 'delivery-uncertain'; });
    const before = h.network.hooks.length;
    assert.deepEqual(await h.service.panel('memory.reconcile', { id }), { verified: true });
    assert.equal(h.network.hooks.length, before);
    assert.equal(h.journal.snapshot().events[0].state, 'delivered');
  } finally { await h.cleanup(); }
});
test('operator reconciliation and worker delivery cannot race a discard', async () => {
  const h = await harness();
  try {
    await h.service.call('capture', capture, context());
    const id = h.journal.snapshot().events[0].id;
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const worker = new Outbox(h.journal, async () => ({ report: undefined, deliver: async event => { started(); await gate; return `queued:${event.id}`; }, verifyDelivery: async () => null }));
    const draining = worker.drain(context().signal); await ready;
    await assert.rejects(worker.resolve(id, 'discard', true), /DELIVERY_IN_PROGRESS/);
    release(); await draining; await worker.resolve(id, 'discard', true);
    assert.equal(h.journal.snapshot().events[0].state, 'discarded');
  } finally { await h.cleanup(); }
});
