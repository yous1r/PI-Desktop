#!/usr/bin/env node
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN, 'Candidate binary and scratch directory required');
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'exit-confirmation-'));
const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
await build({
  entryPoints: ['host-process', 'agent-sidecar'].map(name => join(root, `packages/host-runtime/src/${name}.ts`)),
  outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node',
  alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts') },
  banner: { js: "import {createRequire as __require} from 'node:module'; const require=__require(import.meta.url);" },
  logLevel: 'warning',
});
const children = [];
const spawn = childProcess.spawn;
const { HostProcess } = await import(pathToFileURL(join(directory, 'host-process.mjs')));
const { AgentSidecar } = await import(pathToFileURL(join(directory, 'agent-sidecar.mjs')));
// Capture actual children during construction, without replacing their behavior.
const construct = factory => {
  childProcess.spawn = function(command, args, options) {
    const child = spawn.call(this, command, args, options);
    const closed = new Promise(resolveClose => child.once('close', () => resolveClose()));
    children.push({ child, closed });
    return child;
  };
  syncBuiltinESMExports();
  try { return factory(); }
  finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
};
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ProgramFiles(x86)']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), RUST_LOG: 'error',
});
for (const name of ['home', 'appdata', 'temp', 'profile']) await mkdir(join(directory, name));
const fixture = join(directory, 'sidecar.mjs');
await writeFile(fixture, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n', () => {
    if (request.method === 'agent.shutdown') process.exit(0);
  });
});
`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = {
  status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, platform: process.platform,
  binarySha256: hash(await readFile(binary)),
  hostTransportSha256: hash(await readFile(join(directory, 'host-process.mjs'))),
  sidecarTransportSha256: hash(await readFile(join(directory, 'agent-sidecar.mjs'))),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), checks: [], cleanupConfirmed: false,
};
const wrappers = [];
const watchdog = setTimeout(() => {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 90_000);
try {
  const host = construct(() => new HostProcess({ binaryPath: binary, dataDir: join(directory, 'profile'), env, onStderr: () => undefined }));
  wrappers.push(host);
  await host.handshake();
  assert.equal(await host.confirmExit(10), false);
  const hostExited = host.confirmExit(10_000);
  await host.dispose();
  assert.equal(await hostExited, true);
  assert.equal(await host.confirmExit(0), true);
  report.checks.push('live Rust Host is unconfirmed; graceful EOF/dispose confirms its exit');
  const sidecar = construct(() => new AgentSidecar({ launch: { command: process.execPath, args: [fixture], env }, onStderr: () => undefined }));
  wrappers.push(sidecar);
  assert.equal((await sidecar.call('fixture.ping', {}, 5_000)).ok, true);
  assert.equal(await sidecar.confirmExit(10), false);
  const sidecarExited = sidecar.confirmExit(10_000);
  await sidecar.shutdown();
  assert.equal(await sidecarExited, true);
  assert.equal(await sidecar.confirmExit(0), true);
  report.checks.push('live sidecar fixture is unconfirmed; shutdown/dispose confirms its exit');
  assert.equal(children.length, 2);
  report.pids = children.map(({ child }) => child.pid);
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  const disposals = await Promise.allSettled(wrappers.map(wrapper => wrapper.dispose()));
  const disposalErrors = disposals.filter(result => result.status === 'rejected')
    .map(result => String(result.reason));
  if (disposalErrors.length > 0) {
    report.disposalErrors = disposalErrors;
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  const cleanup = await Promise.allSettled(children.map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('owned child did not close')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  }));
  report.cleanupConfirmed = cleanup.every(result => result.status === 'fulfilled');
  const cleanupErrors = cleanup.filter(result => result.status === 'rejected')
    .map(result => String(result.reason));
  if (cleanupErrors.length > 0) report.cleanupErrors = cleanupErrors;
  if (!report.cleanupConfirmed) { report.status = 'FAIL'; process.exitCode = 1; }
  clearTimeout(watchdog);
}
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: join(directory, 'report.json') }, null, 2));
