import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Journal } from '../../src/storage/journal.js';
import { context, harness } from '../helpers.js';

const prompt = (id: string) => ({ type: 'prompt', eventId: id, data: { prompt: 'synthetic project task' } });
test('capture accepts durably, orders one session, deduplicates start across runtime rebuild, and emits no final handoff', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'transactions' }, context());
    await h.service.call('capture', prompt('p1'), context());
    await h.service.call('capture', prompt('p1'), context());
    await h.service.call('retire', {}, context({ retirementReason: 'reconfigure' }));
    await h.service.call('capture', prompt('p2'), context({ runtimeId: 'runtime-b' }));
    assert.deepEqual(h.journal.snapshot().events.map(item => item.event.type), ['session_start', 'prompt', 'retire', 'prompt']);
    const persisted = JSON.parse(await readFile(h.journal.file, 'utf8'));
    assert.deepEqual(persisted.events.map((item: { sequence: number }) => item.sequence), [1, 2, 3, 4]);
    assert.equal(h.network.hooks.length, 0);
    await h.service.tick();
    assert.deepEqual(h.journal.snapshot().events.map(item => item.state), ['delivered', 'delivered', 'delivered', 'delivered']);
    assert.equal(h.network.hooks.length, 7);
    assert.ok(h.network.requests.every(item => !item.path.includes('session-end') && !item.path.startsWith('/handoff')));
  } finally { await h.cleanup(); }
});
test('response loss blocks later events and retains immutable idempotent retry across restart', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context());
    await h.service.call('capture', prompt('p1'), context());
    h.network.loseResponse = true; await h.service.tick();
    const events = h.journal.snapshot().events;
    assert.equal(events[0].state, 'queued'); assert.equal(events[1].state, 'queued');
    h.network.loseResponse = false; await h.service.tick(); assert.equal(h.network.hooks.length, 1);
    assert.ok(events[0].nextAttempt > Date.now());
    await h.service.stop(); await h.journal.close();
    const recovered = new Journal(h.directory); await recovered.initialize();
    assert.equal(recovered.snapshot().events[0].state, 'queued');
    assert.equal(recovered.snapshot().sessions[0].state, 'interrupted');
    await recovered.close();
  } finally { await h.cleanup(); }
});
test('crash during sending/pending is uncertain, never successful or automatically replayed', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', prompt('p'), context());
    await h.journal.update(state => { state.events[0].state = 'sending'; });
    await h.service.stop(); await h.journal.close();
    const restarted = new Journal(h.directory); await restarted.initialize();
    assert.equal(restarted.snapshot().events[0].state, 'delivery-uncertain');
    await restarted.close();
  } finally { await h.cleanup(); }
});
test('capacity exhaustion preserves existing events and declines new receipt atomically', async () => {
  const h = await harness({ limits: { events: 2 } });
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', prompt('p1'), context());
    await assert.rejects(h.service.call('capture', prompt('p2'), context()), /QUEUE_FULL/);
    assert.equal(h.journal.snapshot().events.length, 2); assert.equal(h.journal.snapshot().sessions[0].sequence, 2);
  } finally { await h.cleanup(); }
});
test('credential revision changes quarantine old scope and never retarget events', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', prompt('p'), context());
    h.network.connection.revision = 2; await h.service.tick();
    assert.equal(h.journal.snapshot().events[0].state, 'quarantined'); assert.equal(h.journal.snapshot().events[0].scope.connectionRevision, 1);
    assert.equal(h.network.hooks.length, 0);
  } finally { await h.cleanup(); }
});
test('401 pauses authentication delivery; 429 records bounded backoff without falsely acknowledging', async () => {
  const h = await harness();
  try {
    await h.service.call('recall', { query: 'task' }, context()); await h.service.call('capture', prompt('p'), context());
    h.network.status = 401; await h.service.tick();
    const id = h.journal.snapshot().events[0].id;
    assert.equal(h.journal.snapshot().events[0].state, 'auth-required');
    await h.service.outbox.retry(id); h.network.status = 429; await h.service.tick();
    const event = h.journal.snapshot().events[0]; assert.equal(event.state, 'queued'); assert.ok(event.nextAttempt > Date.now());
  } finally { await h.cleanup(); }
});
test('future local schema is refused without modifying user state', async () => {
  const h = await harness();
  try {
    await h.service.stop(); await h.journal.close();
    const future = '{"schemaVersion":99,"privateData":"preserve"}'; await writeFile(h.journal.file, future);
    const next = new Journal(h.directory);
    await assert.rejects(next.initialize(), /STATE_VERSION_UNSUPPORTED/);
    assert.equal(await readFile(h.journal.file, 'utf8'), future);
  } finally { await h.cleanup(); }
});
