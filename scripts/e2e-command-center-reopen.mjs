#!/usr/bin/env node
// Reopen only a completed command-center fixture; never use the desktop profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PROTOCOL_VERSION } from '../packages/shared/src/protocol.ts';
import { promptText } from './e2e/command-center/context.mjs';
import { expectedText } from './e2e/command-center/provider.mjs';

assert.equal(process.argv.length, 3, 'Usage: node scripts/e2e-command-center-reopen.mjs <completed-run-directory>');
const directory = resolve(process.argv[2]);
const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
assert.ok(['headless-session-runtime-baseline', 'headless-session-runtime-soak'].includes(report.scope));
assert.equal(report.status, 'PASS', 'Only reopen a successfully cleaned-up fixture');
assert.equal(report.cleanupConfirmed, true, 'The original Host must have exited before reopen');
const binary = join(directory, 'pi-desktop-host-core.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(binary)), report.metadata.hostBinarySha256);
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, { PI_DESKTOP_DATA_DIR: join(directory, 'data'), USERPROFILE: join(directory, 'home'),
  HOME: join(directory, 'home'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), RUST_LOG: 'error' });
const child = spawn(binary, [], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(); let sequence = 0, stderr = '';
const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
child.on('error', fail); child.stdin.on('error', fail);
child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
const closed = new Promise(resolveClose => child.once('close', code => { fail(new Error('Fixture Host closed')); resolveClose(code); }));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  try {
    const reply = JSON.parse(line); const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.error) item.reject(new Error(reply.error.message)); else item.resolve(reply.result);
  } catch (error) { fail(error); }
});
const deadline = setTimeout(() => { fail(new Error('Reopen verification deadline exceeded')); child.kill(); }, 30000);
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = String(++sequence); pending.set(id, { resolve: resolveCall, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const result = { status: 'FAIL', verified: 0, sourceInputsSha256: report.metadata.inputsSha256,
  hostBinarySha256: report.metadata.hostBinarySha256, scriptSha256: hash(await readFile(new URL(import.meta.url))), rows: [] };
try {
  await call('app.handshake', { protocolVersion: PROTOCOL_VERSION });
  const { sessions } = await call('session.list');
  assert.equal(sessions.length, config.sessions);
  for (const session of sessions) {
    const { session: detail } = await call('session.get', { id: session.id, messageLimit: 10 });
    const users = detail.messages.filter(row => row.role === 'user');
    const replies = detail.messages.filter(row => row.role === 'assistant');
    assert.equal(users.length, 1); assert.equal(replies.length, 1);
    assert.equal(users[0].status, 'complete'); assert.equal(replies[0].status, 'complete');
    assert.equal(hash(users[0].content), hash(promptText(session.title, config.contextBytes, config.contextKind)));
    assert.equal(hash(replies[0].content), hash(expectedText(session.title, config.ticks)));
    result.rows.push({ key: session.title, inputSha256: hash(users[0].content), outputSha256: hash(replies[0].content) });
    result.verified++;
  }
  result.status = 'PASS';
} catch (error) { result.error = String(error); process.exitCode = 1; }
finally {
  child.stdin.end();
  result.exitCode = await closed;
  clearTimeout(deadline); lines.close();
  if (result.exitCode !== 0 || stderr) { result.status = 'FAIL'; result.stderr = stderr; process.exitCode = 1; }
  await writeFile(join(directory, 'reopen-report.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, verified: result.verified, exitCode: result.exitCode, error: result.error }));
}
