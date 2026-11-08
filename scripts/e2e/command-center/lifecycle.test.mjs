import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { observeExit } from './lifecycle.mjs';

test('a failed spawn completes without waiting for an exit event', { timeout: 5000 }, async () => {
  let failure;
  const child = spawn(join(tmpdir(), `missing-p0-${randomUUID()}.exe`), [], { stdio: 'ignore' });
  const result = await observeExit(child, error => { failure = error; });
  assert.equal(failure.code, 'ENOENT');
  assert.match(result.error, /ENOENT/);
  assert.notEqual(result.code, 0);
});

test('completion waits for child output to close and records nonzero exit', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.stderr.write('fixture-failure'); process.exitCode=3"], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = observeExit(child);
  let output = '';
  child.stderr.on('data', data => { output += data; });
  assert.equal((await exited).code, 3);
  assert.equal(output, 'fixture-failure');
});
