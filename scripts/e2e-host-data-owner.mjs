#!/usr/bin/env node
// Isolated ownership regression using the production HostProcess transport.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN, 'Explicit scratch and candidate Host binary required');
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'host-owner-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
const transport = join(directory, 'host-process.mjs');
await build({ entryPoints: [join(root, 'packages/host-runtime/src/host-process.ts')], outfile: transport,
  bundle: true, format: 'esm', platform: 'node', alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts') },
  banner: { js: "import {createRequire as __require} from 'node:module'; const require=__require(import.meta.url);" }, logLevel: 'warning' });
const originalSpawn = childProcess.spawn;
const children = [];
childProcess.spawn = function(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (resolve(String(command)) === binary) {
    const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
    children.push({ child, closed });
  }
  return child;
};
syncBuiltinESMExports();
const { HostProcess } = await import(pathToFileURL(transport));
const isolated = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH','Path','SystemRoot','WINDIR','windir','ComSpec','PATHEXT','PROGRAMFILES','ProgramFiles','PROGRAMFILES(X86)','ProgramFiles(x86)']) {
  if (process.env[key] !== undefined) isolated[key] = process.env[key];
}
Object.assign(isolated, { PI_DESKTOP_DATA_DIR: '', PI_DESKTOP_ELECTRON_PID: '',
  USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), RUST_LOG: 'error' });
for (const name of ['home','appdata','temp','profile','other','source']) await mkdir(join(directory, name));
const hosts = [];
function start(dataDir) {
  let stderr = '';
  const host = new HostProcess({ binaryPath: binary, dataDir, env: { ...isolated, PI_DESKTOP_DATA_DIR: dataDir },
    onStderr: text => { stderr = (stderr + text).slice(-4000); } });
  const record = { host, observed: children.at(-1), stderr: () => stderr };
  hosts.push(record); return record;
}
async function close(record) { await record.host.dispose(); await record.observed.closed; }
const result = { status: 'FAIL', checks: [], candidate: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  base: execFileSync('git', ['rev-parse','origin/main'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status','--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  hostBinarySha256: hash(await readFile(binary)), transportSha256: hash(await readFile(transport)), platform: process.platform };
const watchdog = setTimeout(() => { for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 90000);
try {
  const profile = join(directory, 'profile');
  const owner = start(profile); await owner.host.handshake();
  const { session } = await owner.host.call('session.create', { title: 'Owner fixture', mode: 'agent' });
  const { turnId } = await owner.host.call('session.beginTurn', { sessionId: session.id, providerId: 'fixture', modelId: 'fixture' });
  const second = start(profile);
  await assert.rejects(second.host.handshake(), { errorCode: 'HOST_DATA_DIR_IN_USE' });
  assert.match(second.stderr(), /HOST_DATA_DIR_IN_USE/);
  await close(second);
  // endTurn only acknowledges a running turn; a second boot's recovery sweep
  // would already have aborted it and return ok:false.
  const ended = await owner.host.call('session.endTurn', { turnId, status: 'completed', createNotification: false });
  assert.equal(ended.ok, true, 'Rejected contender must not recover the live owner turn');
  result.checks.push('same-directory refusal before turn recovery');
  const other = start(join(directory, 'other')); await other.host.handshake(); await close(other);
  result.checks.push('different directories remain independent');
  const alias = join(directory, 'profile-alias');
  await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = start(alias); await assert.rejects(aliased.host.handshake(), { errorCode: 'HOST_DATA_DIR_IN_USE' }); await close(aliased);
  result.checks.push('directory aliases share one lock');
  const metadataPath = join(profile, 'session-message-outbox.json');
  const before = JSON.stringify([{ path: join(directory, 'source', 'fixture') }]);
  await writeFile(metadataPath, before);
  const relocation = childProcess.spawn(binary, ['--relocate-data', join(directory, 'source'), profile], { env: isolated, stdio: ['ignore','pipe','pipe'], windowsHide: true });
  let relocationStderr = ''; relocation.stdout.resume(); relocation.stderr.on('data', data => { relocationStderr += data; });
  const relocated = await children.at(-1).closed;
  assert.notEqual(relocated.code, 0); assert.match(relocationStderr, /HOST_DATA_DIR_IN_USE/);
  assert.equal(await readFile(metadataPath, 'utf8'), before);
  result.checks.push('offline relocation refuses a live destination');
  await owner.host.call('session.appendMessage', { sessionId: session.id, message: {
    id: 'retained', role: 'assistant', content: 'durable owner fixture', createdAt: '2026-11-08T00:00:00.000Z', status: 'complete',
  } });
  await close(owner);
  const successor = start(profile); await successor.host.handshake();
  const detail = await successor.host.call('session.get', { id: session.id });
  assert.equal(detail.session.messages[0].content, 'durable owner fixture');
  result.checks.push('graceful release preserves existing transcript');
  successor.observed.child.kill('SIGKILL'); await successor.observed.closed; await successor.host.dispose();
  const recovered = start(profile); await recovered.host.handshake(); await close(recovered);
  result.checks.push('OS releases lock after forced termination');
  const contenders = [start(profile), start(profile)];
  const attempts = await Promise.allSettled(contenders.map(record => record.host.handshake()));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason.errorCode === 'HOST_DATA_DIR_IN_USE').length, 1);
  for (const record of contenders) await close(record);
  result.checks.push('simultaneous starts elect exactly one owner');
  result.status = 'PASS';
} catch (error) { result.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const record of hosts) { try { await close(record); } catch (error) { result.cleanupError = String(error); result.status = 'FAIL'; process.exitCode = 1; } }
  clearTimeout(watchdog); childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  result.exits = await Promise.all(children.map(record => record.closed));
  result.cleanupConfirmed = children.every(({child}) => child.exitCode !== null || child.signalCode !== null);
  await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, report: join(directory, 'report.json') }, null, 2));
}
