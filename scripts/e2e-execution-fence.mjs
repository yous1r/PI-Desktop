#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connect } from 'node:net';

assert.equal(process.platform, 'win32', 'Windows native acceptance required');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'execution-fence-'));
const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
await build({ entryPoints: ['host-process', 'agent-sidecar'].map(name => join(root, `packages/host-runtime/src/${name}.ts`)),
  outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node',
  alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts') },
  banner: { js: "import {createRequire as __require} from 'node:module'; const require=__require(import.meta.url);" }, logLevel: 'warning' });
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
for (const name of ['home', 'temp', 'appdata']) await mkdir(join(directory, name));
Object.assign(env, { USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'), RUST_LOG: 'error' });
const children = [];
function launch(command, args, extra = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...env, ...extra } });
  child.stderrText = '';
  child.stdoutText = '';
  child.stderr.on('data', data => { child.stderrText += data; });
  child.stdout.on('data', data => { child.stdoutText += data; });
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  children.push(child);
  console.error(`fixture started: ${child.pid}`);
  return child;
}
async function until(predicate, description, timeout = 8000) {
  console.error(`waiting: ${description}`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error(`timeout: ${description}`);
}
async function closed(child) {
  let timer;
  try { return await Promise.race([child.closed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`process ${child.pid} did not close: ${child.stderrText}`)), 8000);
  })]); } finally { clearTimeout(timer); }
}
async function host(name, enabled = true) {
  const child = launch(binary, enabled ? ['--execution-fence'] : [], { PI_DESKTOP_DATA_DIR: join(directory, name) });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  child.once('exit', () => { for (const entry of pending.values()) {
    clearTimeout(entry.timer); entry.reject(new Error(`host exited: ${child.stderrText}`));
  } pending.clear(); });
  const call = (method, params = {}) => new Promise((resolveResult, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}; ${child.stderrText}`)); }, method === 'app.handshake' ? 45000 : 10000);
    pending.set(id, { resolve: resolveResult, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await call('app.handshake', { protocolVersion: 11 });
  return { child, call };
}
async function observe(pids) {
  const observer = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(root, 'scripts/e2e/execution-fence-observer.ps1'), '-ProcessIds', pids.join(',')]);
  await until(() => observer.stdoutText.includes('captured'), `capture process handles: ${pids}`, 15000);
  return async () => { assert.equal((await closed(observer)).code, 0, observer.stderrText); assert.match(observer.stdoutText, /exited/); };
}
const fixture = join(directory, 'runtime.mjs');
await writeFile(fixture, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const marker=process.argv[2];
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
writeFileSync(marker,JSON.stringify({pid:process.pid,child:child.pid,ticketLeaked:!!process.env.PI_EXECUTION_TICKET}));
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{ok:true}})+'\\n');});
setInterval(()=>{},1000);
`);
const runner = (ticket, marker, extra = {}) => launch(binary, ['--internal-execution-runner', '--', process.execPath, fixture, marker], { PI_EXECUTION_TICKET: JSON.stringify(ticket), ...extra });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), checks: [], cleanupConfirmed: false };
try {
  const owner = await host('owner');
  const ticket = await owner.call('executionFence.prepare');
  assert.equal(ticket.version, 1);
  const pending = await owner.call('executionFence.status', { generation: ticket.generation });
  assert.equal(pending.state, 'pending'); assert.equal(pending.confirmed, false);
  await assert.rejects(owner.call('executionFence.prepare'), /EXECUTION_FENCE_BUSY/);
  report.checks.push('one pending execution generation; empty pending job is not closure proof');
  const marker = join(directory, 'runtime.json');
  const runtime = runner(ticket, marker);
  await until(() => existsSync(marker), 'contained runtime starts');
  const ids = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(ids.ticketLeaked, false);
  const active = await owner.call('executionFence.status', { generation: ticket.generation });
  assert.equal(active.state, 'running'); assert.ok(active.activeProcesses >= 3); assert.equal(active.confirmed, false);
  const unrelated = launch(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const replayMarker = join(directory, 'replay.json');
  const replay = runner(ticket, replayMarker);
  assert.notEqual((await closed(replay)).code, 0); assert.equal(existsSync(replayMarker), false);
  report.checks.push('startup barrier admits one authenticated runtime; descendants contained; ticket not inherited or replayed');
  const stopped = await owner.call('executionFence.stop', { generation: ticket.generation, timeoutMs: 2000 });
  assert.equal(stopped.confirmed, true); assert.equal(stopped.activeProcesses, 0); assert.equal(stopped.rootExited, true);
  await closed(runtime);
  assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  assert.equal((await owner.call('executionFence.stop', { generation: ticket.generation, timeoutMs: 0 })).confirmed, true);
  report.checks.push('stop proves original root exit and empty job, repeats safely, preserves unrelated process');
  const next = await owner.call('executionFence.prepare');
  await assert.rejects(owner.call('executionFence.status', { generation: ticket.generation }), /EXECUTION_FENCE_STALE/);
  await owner.call('executionFence.stop', { generation: next.generation, timeoutMs: 2000 });
  const blockedMarker = join(directory, 'blocked.json');
  const blocked = runner(next, blockedMarker);
  assert.notEqual((await closed(blocked)).code, 0); assert.equal(existsSync(blockedMarker), false);
  report.checks.push('stale generation and cancelled startup ticket refuse before runtime effects');
  for (const mutation of [ticket => ({ ...ticket, capability: randomUUID() }), ticket => ({ ...ticket, ownerCreatedAt: '1' })]) {
    const invalid = await owner.call('executionFence.prepare');
    const invalidMarker = join(directory, `invalid-${invalid.generation}.json`);
    assert.notEqual((await closed(runner(mutation(invalid), invalidMarker))).code, 0);
    assert.equal(existsSync(invalidMarker), false);
    await owner.call('executionFence.stop', { generation: invalid.generation, timeoutMs: 2000 });
  }
  const wrongParent = await owner.call('executionFence.prepare');
  const wrongMarker = join(directory, 'wrong-parent.json');
  const intermediary = launch(process.execPath, ['-e', "const c=require('node:child_process').spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));",
    binary, '--internal-execution-runner', '--', process.execPath, fixture, wrongMarker], { PI_EXECUTION_TICKET: JSON.stringify(wrongParent) });
  assert.notEqual((await closed(intermediary)).code, 0); assert.equal(existsSync(wrongMarker), false);
  await owner.call('executionFence.stop', { generation: wrongParent.generation, timeoutMs: 2000 });
  report.checks.push('altered capability, wrong owner creation identity and unexpected parent refuse before Node starts');
  const nodeTicket = await owner.call('executionFence.prepare');
  let received = 0;
  await new Promise((resolveClose, reject) => {
    const socket = connect(nodeTicket.address); socket.on('data', bytes => { received += bytes.length; });
    socket.on('error', reject); socket.on('close', resolveClose); socket.setTimeout(8000, () => socket.destroy(new Error('counterfeit client not rejected')));
  });
  assert.equal(received, 0);
  await owner.call('executionFence.stop', { generation: nodeTicket.generation, timeoutMs: 2000 });
  const expired = await owner.call('executionFence.prepare');
  await until(async () => (await owner.call('executionFence.status', { generation: expired.generation })).confirmed, 'pending startup expires');
  const expiredMarker = join(directory, 'expired.json');
  assert.notEqual((await closed(runner(expired, expiredMarker))).code, 0); assert.equal(existsSync(expiredMarker), false);
  report.checks.push('same-user Node client refused before greeting; expired startup remains closed');
  const rootTicket = await owner.call('executionFence.prepare');
  const rootMarker = join(directory, 'launcher-crash.json');
  const rootRuntime = runner(rootTicket, rootMarker);
  await until(() => existsSync(rootMarker), 'runtime before launcher crash');
  const rootIds = JSON.parse(await readFile(rootMarker, 'utf8'));
  const rootCrashObserved = await observe([rootRuntime.pid, rootIds.pid, rootIds.child]);
  rootRuntime.kill('SIGKILL');
  await rootCrashObserved(); await closed(rootRuntime);
  await until(async () => (await owner.call('executionFence.status', { generation: rootTicket.generation })).confirmed, 'launcher crash native closure');
  assert.equal((await owner.call('app.health')).ok, true);
  report.checks.push('launcher crash terminates runtime and detached descendant while the owning Host remains available');
  const crashOwner = await host('crash-owner');
  const crashTicket = await crashOwner.call('executionFence.prepare');
  const crashMarker = join(directory, 'crash.json');
  const crashRuntime = runner(crashTicket, crashMarker);
  await until(() => existsSync(crashMarker), 'runtime before Host crash');
  const crashIds = JSON.parse(await readFile(crashMarker, 'utf8'));
  const hostCrashObserved = await observe([crashRuntime.pid, crashIds.pid, crashIds.child]);
  crashOwner.child.kill('SIGKILL'); await closed(crashOwner.child);
  await hostCrashObserved(); await closed(crashRuntime);
  assert.equal(unrelated.exitCode, null);
  report.checks.push('abrupt Host death closes native job and original launcher/runtime/detached descendant handles');
  for (const mode of ['stop', 'crash']) {
    const coordinatorMarker = join(directory, `coordinator-${mode}.json`);
    const coordinator = launch(process.execPath, [join(root, 'scripts/e2e/execution-fence-coordinator.mjs'), directory, binary,
      join(directory, `coordinator-profile-${mode}`), fixture, coordinatorMarker]);
    await until(() => coordinator.stdoutText.includes('"ready":true'), `production coordinator ready: ${coordinator.stderrText}`, 45000);
    const runtimeIds = JSON.parse(await readFile(coordinatorMarker, 'utf8'));
    const ownerIds = JSON.parse(coordinator.stdoutText.trim());
    const observeClosure = await observe([ownerIds.host, ownerIds.launcher, runtimeIds.pid, runtimeIds.child]);
    if (mode === 'stop') coordinator.stdin.write('stop\n'); else coordinator.kill('SIGKILL');
    const result = await closed(coordinator);
    if (mode === 'stop') assert.equal(result.code, 0, coordinator.stderrText);
    await observeClosure();
    assert.equal(unrelated.exitCode, null);
    report.checks.push(`production HostProcess/AgentSidecar RPC path: coordinator ${mode} confirms entire owned process family exits`);
  }
  const ordinary = await host('ordinary', false);
  await assert.rejects(ordinary.call('executionFence.prepare'), /EXECUTION_FENCE_UNAVAILABLE/);
  report.checks.push('ordinary Host compatibility; execution fencing requires explicit launch mode');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  const cleanup = await Promise.allSettled(children.map(async child => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed(child);
  }));
  report.cleanupConfirmed = cleanup.every(result => result.status === 'fulfilled');
  report.childCount = children.length;
  if (!report.cleanupConfirmed) { report.status = 'FAIL'; process.exitCode = 1; report.cleanupErrors = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason)); }
}
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: join(directory, 'report.json') }, null, 2));
