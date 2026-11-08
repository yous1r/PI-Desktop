#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Host } from './e2e/host.mjs';
import { configureSession, createSession } from './e2e/session.mjs';

assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN, 'Candidate binary and scratch required');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'remote-path-permissions-'));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ProgramFiles(x86)']) env[key] = process.env[key];
for (const name of ['home', 'appdata', 'temp']) await mkdir(join(directory, name));
Object.assign(env, { USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), RUST_LOG: 'error' });
const host = new Host(binary, join(directory, 'data'), { env, quiet: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, platform: process.platform,
  binarySha256: hash(await readFile(binary)), scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  checks: [], cleanupConfirmed: false };
const pending = [];
const notification = async cursor => {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const found = host.notifications.slice(cursor).find(note => ['permissions.request', 'tools.remoteExecute', 'tools.remoteAbort'].includes(note.method));
    if (found) return found;
    await delay(10);
  }
  throw new Error('Missing permission/remote dispatch notification');
};
try {
  await host.start();
  const { group } = await host.call('project.group.createRemote', {
    name: 'POSIX permissions fixture', remote: { hostKey: 'fixture-host', path: '/srv/work' },
  });
  const session = await createSession(host, group.primaryPath, 'Remote path permissions');
  await configureSession(host, session, 'agent', 'ask');
  let sequence = 0;
  const begin = (toolName, args) => {
    const cursor = host.notifications.length;
    const toolCallId = `remote-fixture-${sequence++}`;
    const result = host.call('tools.execute', { sessionId: session.id, toolCallId, toolName, args, mode: 'agent' });
    // Observe rejections during failure cleanup without hiding the awaited result.
    result.catch(() => undefined);
    pending.push(result);
    return { cursor, toolCallId, result };
  };
  for (const path of ['README.md', '/srv/work/nested/file', 'dir/../file']) {
    const operation = begin('Read', { path });
    const dispatch = await notification(operation.cursor);
    assert.equal(dispatch.method, 'tools.remoteExecute', JSON.stringify(dispatch));
    assert.equal(dispatch.params.remoteWorkspace.path, '/srv/work');
    await host.call('tools.remoteComplete', { requestId: dispatch.params.requestId, result: { ok: true, content: { text: 'remote-only-result' } } });
    assert.equal((await operation.result).content.text, 'remote-only-result');
  }
  report.checks.push('relative and absolute in-project POSIX reads relay without spurious external approval');
  for (const path of ['../outside', '/srv/work-neighbor/file', '/srv/WORK/file']) {
    const operation = begin('Read', { path });
    const approval = await notification(operation.cursor);
    assert.equal(approval.method, 'permissions.request');
    assert(!host.notifications.slice(operation.cursor).some(note => note.method === 'tools.remoteExecute'));
    await host.call('permissions.resolve', { requestId: approval.params.requestId, decision: 'deny' });
    assert.equal((await operation.result).errorCode, 'TOOL_DENIED');
  }
  report.checks.push('traversal, sibling-prefix and case-different paths require approval before relay');
  const write = begin('Write', { path: 'should-not-exist.txt', content: 'forbidden' });
  const approval = await notification(write.cursor);
  assert.equal(approval.method, 'permissions.request');
  await host.call('permissions.resolve', { requestId: approval.params.requestId, decision: 'deny' });
  assert.equal((await write.result).errorCode, 'TOOL_DENIED');
  assert(!host.notifications.slice(write.cursor).some(note => note.method === 'tools.remoteExecute'));
  report.checks.push('denied write never reaches the remote execution boundary');
  const read = begin('Read', { path: 'pending.txt' });
  const dispatch = await notification(read.cursor);
  assert.equal(dispatch.method, 'tools.remoteExecute');
  const abortCursor = host.notifications.length;
  await host.call('tools.abort', { sessionId: session.id, toolCallId: read.toolCallId, toolName: 'Read' });
  assert.equal((await notification(abortCursor)).method, 'tools.remoteAbort');
  assert.equal((await read.result).errorCode, 'TOOL_ABORTED');
  report.checks.push('cancelled remote read propagates abort and never falls back locally');
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try { await host.stop(); report.cleanupConfirmed = true; }
  catch (error) { report.status = 'FAIL'; report.cleanupError = String(error); process.exitCode = 1; }
  await Promise.allSettled(pending);
}
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: join(directory, 'report.json') }, null, 2));
