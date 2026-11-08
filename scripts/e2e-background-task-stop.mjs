#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Host } from './e2e/host.mjs';
import { beginTurn, configureSession, createSession, endTurn } from './e2e/session.mjs';

assert.equal(process.platform, 'win32', 'This regression exercises Windows process ownership');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN, 'Candidate binary and scratch directory required');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'background-stop-'));
const workspace = join(directory, 'workspace space π & files');
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = {
  status: 'FAIL', startedAt: new Date().toISOString(), platform: process.platform,
  candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0,
  binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  checks: [], cleanupConfirmed: false,
};
// Host's shared harness merges its environment. Undefined entries remove all
// inherited values except this explicit OS/toolchain allowlist.
const env = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]));
for (const name of ['SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'Path']) {
  env[name] = process.env[name];
}
env.PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
Object.assign(env, {
  USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'),
});
for (const name of ['home', 'appdata', 'temp']) await mkdir(join(directory, name));
await mkdir(workspace);
const fixture = join(workspace, 'tree.mjs');
await writeFile(fixture, `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const role = process.argv[2];
const directory = fileURLToPath(new URL('.', import.meta.url));
if (role === 'root') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], {
    stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error); process.exit(1); });
}
writeFileSync(join(directory, role + '.pid'), String(process.pid));
const started = Date.now();
setInterval(() => {
  if (existsSync(join(directory, 'release')) || Date.now() - started > 120000) process.exit(0);
}, 25);
`);
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const until = async (check, message) => {
  const deadline = performance.now() + 15_000;
  while (!(await check())) {
    assert(performance.now() < deadline, message);
    await delay(25);
  }
};
const host = new Host(binary, join(directory, 'data'), { quiet: true, env });
let unrelated;
let unrelatedExit;
const pids = [];
let taskId;
try {
  unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env, cwd: directory, stdio: 'ignore', windowsHide: true,
  });
  unrelatedExit = once(unrelated, 'exit');
  await once(unrelated, 'spawn');
  await host.start();
  const session = await createSession(host, workspace, 'Background process stop regression');
  await configureSession(host, session, 'agent', 'auto');
  await host.call('settings.set', { defaultCommandShell: 'cmd' });
  const turnId = await beginTurn(host, session.id);
  const { effective: shell } = await host.call('commandShells.list');
  assert.equal(shell.dialect, 'cmd');
  const probe = join(workspace, 'args probe.mjs');
  await writeFile(probe, `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); console.error('stderr π'); process.exit(7);`);
  const foreground = await host.call('tools.execute', {
    sessionId: session.id, turnId, toolCallId: 'quoted-foreground', toolName: 'Bash',
    args: { command: `"${process.execPath}" "${probe}" "literal &|<>^ π" "space value"` },
    mode: 'agent', expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  assert.equal(foreground.ok, false);
  assert.equal(foreground.errorCode, 'TOOL_FAILED');
  assert.equal(foreground.content.exitCode, 7, JSON.stringify(foreground));
  const observed = JSON.parse(foreground.content.stdout.trim());
  assert.deepEqual(observed.args, ['literal &|<>^ π', 'space value']);
  assert.equal(resolve(observed.cwd), resolve(workspace));
  assert.match(foreground.content.stderr, /stderr π/);
  report.checks.push('quoted cmd executable and Unicode/metacharacter arguments preserve cwd, streams and exit code');
  const started = await host.call('tools.execute', {
    sessionId: session.id, turnId, toolCallId: 'owned-tree', toolName: 'Bash',
    args: { command: `"${process.execPath}" "${fixture}" root`, runInBackground: true },
    mode: 'agent', runInBackground: true,
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const id = started.content.backgroundTaskId;
  taskId = id;
  assert.ok(id);
  for (const role of ['root', 'leaf']) {
    let pid;
    await until(async () => {
      try { pid = Number(await readFile(join(workspace, `${role}.pid`), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const output = await host.call('backgroundTasks.output', { id });
        assert.equal(output.state, 'running', JSON.stringify(output));
        return false;
      }
      return Number.isInteger(pid) && pid > 0;
    }, `${role} must start`);
    pids.push(pid);
    assert(alive(pid), `${role} must be alive before Stop`);
  }
  report.pids = { host: host.child.pid, descendants: [...pids], unrelated: unrelated.pid };
  const response = await host.call('backgroundTasks.stop', { id });
  assert.equal(response.found, true);
  await until(async () => {
    const output = await host.call('backgroundTasks.output', { id });
    assert.notEqual(output.state, 'failed', JSON.stringify(output));
    return output.state === 'stopped';
  }, 'Stop must settle the task to stopped');
  await until(() => pids.every(pid => !alive(pid)), 'both command levels must exit');
  assert(alive(unrelated.pid), 'unrelated process must remain alive');
  assert.equal((await host.call('backgroundTasks.stop', { id })).found, false);
  assert.equal((await endTurn(host, turnId)).ok, true);
  report.checks.push('real tools.execute starts command and child through hidden runner',
    'Stop settles to stopped and both command levels exit',
    'unrelated process remains alive', 'repeated Stop is idempotent');
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.stack ?? error);
  if (taskId && !host.exited) {
    report.taskAtFailure = await host.call('backgroundTasks.output', { id: taskId }, 5_000)
      .catch(diagnosticError => ({ error: String(diagnosticError) }));
  }
  report.hostStderr = host.stderr.slice(-2_000);
  process.exitCode = 1;
} finally {
  // Cleanup actions remain independent so a Host cleanup failure cannot strand
  // the unrelated fixture or prevent cooperative release of the tree.
  const cleanupErrors = [];
  try { await writeFile(join(workspace, 'release'), ''); }
  catch (error) { cleanupErrors.push(String(error)); }
  const outcomes = await Promise.allSettled([
    host.stop(),
    (async () => {
      if (unrelated && unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
      if (unrelatedExit) await unrelatedExit;
    })(),
    until(() => pids.every(pid => !alive(pid)), 'fixture cleanup must finish'),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') cleanupErrors.push(String(outcome.reason));
  }
  report.cleanupConfirmed = cleanupErrors.length === 0;
  if (cleanupErrors.length > 0) {
    report.status = 'FAIL';
    report.cleanupErrors = cleanupErrors;
    process.exitCode = 1;
  }
}
report.finishedAt = new Date().toISOString();
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: join(directory, 'report.json') }, null, 2));
