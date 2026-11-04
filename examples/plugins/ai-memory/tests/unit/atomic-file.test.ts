import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceSnapshot } from '../../src/storage/atomic-file.js';

test('snapshot replacement retries transient Windows locks using the same complete snapshot', async () => {
  const waits: number[] = [], moves: string[][] = [];
  let canonical = 'old-valid-state';
  await replaceSnapshot('new-complete.tmp', 'canonical.json', async (from, to) => {
    moves.push([String(from), String(to)]);
    assert.equal(canonical, 'old-valid-state');
    if (moves.length < 3) throw Object.assign(new Error('locked'), { code: moves.length === 1 ? 'EPERM' : 'EBUSY' });
    canonical = 'new-valid-state';
  }, async ms => { waits.push(ms); });
  assert.equal(canonical, 'new-valid-state');
  assert.deepEqual(waits, [25, 50]);
  assert.deepEqual(moves, Array.from({ length: 3 }, () => ['new-complete.tmp', 'canonical.json']));
});

test('persistent lock and non-transient write failure remain bounded and observable', async () => {
  for (const code of ['EPERM', 'ENOSPC']) {
    let attempts = 0; const waits: number[] = [];
    await assert.rejects(replaceSnapshot('new.tmp', 'canonical.json', async () => {
      attempts++; throw Object.assign(new Error('private filesystem path'), { code });
    }, async ms => { waits.push(ms); }), error => error instanceof Error && error.message === 'STATE_UNWRITABLE');
    assert.equal(attempts, code === 'EPERM' ? 6 : 1);
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 775);
  }
});
