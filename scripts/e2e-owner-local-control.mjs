#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as Value from 'typebox/value';
import { OwnerControlResponseSchema } from '../packages/shared/dist/owner-control.js';

assert.equal(process.platform, 'win32');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'owner-control-'));
const profile = join(directory, 'profile');
for (const name of ['profile', 'home', 'appdata', 'temp']) await mkdir(join(directory, name));
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ProgramFiles(x86)']) if (process.env[key] !== undefined) env[key] = process.env[key];
Object.assign(env, { USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), PI_DESKTOP_DATA_DIR: profile, RUST_LOG: 'error' });
const children = [];
const bounded = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
};
function start(args, dataDir = profile) {
  const child = spawn(binary, args, { env: { ...env, PI_DESKTOP_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const record = { child, stdout: '', stderr: '', closed: once(child, 'close') };
  child.stdout.on('data', bytes => { record.stdout += bytes; });
  child.stderr.on('data', bytes => { record.stderr += bytes; });
  children.push(record);
  return record;
}
async function query(args = [], dataDir = profile) {
  const record = start(['--owner-status', ...args], dataDir);
  record.child.stdin.end();
  const [code] = await bounded(record.closed, 10_000, 'owner query timeout');
  return { ...record, code, value: record.stdout.trim() ? JSON.parse(record.stdout) : null };
}
async function owner(enabled = true) {
  const record = start(enabled ? ['--owner-control'] : []);
  const lines = createInterface({ input: record.child.stdout });
  const handshake = new Promise((resolveReply, reject) => {
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === 'handshake') message.error ? reject(new Error(JSON.stringify(message.error))) : resolveReply(message.result);
    });
    record.child.once('exit', () => reject(new Error(record.stderr)));
  });
  record.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'handshake', method: 'app.handshake', params: { protocolVersion: 11 } }) + '\n');
  await bounded(handshake, 45_000, 'owner handshake timeout');
  lines.close();
  return record;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: sha(await readFile(binary)), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  checks: [], cleanupConfirmed: false };
let fakeServer;
const sockets = new Set();
try {
  const absent = join(directory, 'absent');
  assert.notEqual((await query([], absent)).code, 0);
  await assert.rejects(access(absent));
  report.checks.push('query does not create an absent profile or start an owner');
  const first = await owner();
  const discovered = await query();
  assert.equal(discovered.code, 0, discovered.stderr);
  assert(Value.Check(OwnerControlResponseSchema, discovered.value));
  const status = discovered.value.status;
  assert.equal(status.processId, first.child.pid);
  assert.deepEqual(status.operations, ['status']);
  const stale = await query(['00000000-0000-4000-8000-000000000000']);
  assert.notEqual(stale.code, 0);
  assert.equal(stale.value.error, 'STALE_OWNER');
  assert.equal((await query([status.ownerEpoch])).code, 0);
  report.checks.push('same executable discovers live owner and rejects stale owner epoch');
  const alias = join(directory, 'profile-alias');
  await symlink(profile, alias, 'junction');
  assert.equal((await query([], alias)).value.status.profileId, status.profileId);
  report.checks.push('directory junction resolves to the same native profile identity');
  const pipe = `\\\\.\\pipe\\pi-desktop-owner-v1-${status.profileId}`;
  const unauthorized = createConnection(pipe);
  sockets.add(unauthorized);
  const denied = new Promise(resolveDenied => { unauthorized.once('error', () => resolveDenied()); unauthorized.once('close', () => resolveDenied()); });
  let leaked = '';
  unauthorized.on('data', bytes => { leaked += bytes; });
  await bounded(denied, 5_000, 'different executable must be refused');
  assert.equal(leaked, '');
  unauthorized.destroy(); sockets.delete(unauthorized);
  assert.equal((await query()).code, 0);
  report.checks.push('same-user Node client cannot use the Host-only control channel');
  first.child.stdin.end();
  await bounded(first.closed, 10_000, 'owner graceful shutdown');
  assert.notEqual((await query()).code, 0);
  const ordinary = await owner(false);
  assert.notEqual((await query()).code, 0);
  ordinary.child.stdin.end();
  await bounded(ordinary.closed, 10_000, 'ordinary Host shutdown');
  report.checks.push('default Host launch does not enable the control pipe');
  const second = await owner();
  assert.notEqual((await query()).value.status.ownerEpoch, status.ownerEpoch);
  second.child.kill('SIGKILL');
  await bounded(second.closed, 5_000, 'owned crash exit');
  report.checks.push('graceful/crash close releases pipe; restart issues a fresh owner epoch');
  let received = 0;
  fakeServer = createServer(socket => { sockets.add(socket); socket.on('data', bytes => { received += bytes.length; }); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  fakeServer.listen(pipe);
  await once(fakeServer, 'listening');
  const spoof = await query();
  assert.notEqual(spoof.code, 0);
  assert.match(spoof.stderr, /OWNER_CONTROL_AUTH_FAILED/);
  assert.equal(received, 0);
  report.checks.push('client rejects a same-user counterfeit server before sending the request');
  const database = join(profile, 'pi.sqlite');
  const before = sha(await readFile(database));
  const collision = start(['--owner-control']);
  const [collisionCode] = await bounded(collision.closed, 10_000, 'pipe collision refusal');
  assert.notEqual(collisionCode, 0);
  assert.match(collision.stderr, /OWNER_CONTROL_IN_USE_OR_UNAVAILABLE/);
  assert.equal(sha(await readFile(database)), before);
  report.checks.push('pipe-name collision refuses before database mutation');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const socket of sockets) socket.destroy();
  if (fakeServer) await new Promise(resolveClose => fakeServer.close(resolveClose));
  const cleanup = await Promise.allSettled(children.map(async record => {
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
    await bounded(record.closed, 5_000, 'owned process cleanup');
  }));
  report.cleanupConfirmed = cleanup.every(result => result.status === 'fulfilled');
  if (!report.cleanupConfirmed) { report.status = 'FAIL'; process.exitCode = 1; }
}
report.processCount = children.length;
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: join(directory, 'report.json') }, null, 2));
