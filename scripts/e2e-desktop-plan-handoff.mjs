#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffSourcePlugin } from './e2e/sidecar-handoff-build.mjs';

assert.equal(process.platform, 'win32', 'Windows execution fence required');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'desktop-plan-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), cleanupConfirmed: false,
  scope: 'Desktop plan runtime and launch resolver with real Rust RPC and a contained deterministic sidecar; not complete Desktop ownership transfer' };
try {
  const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
  const entry = join(directory, 'worker.mjs');
  const built = await build({ absWorkingDir: root, entryPoints: [join(root, 'scripts/e2e/desktop-plan-worker.mjs')], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', plugins: [handoffSourcePlugin(root)], metafile: true,
    define: { PI_BUNDLED_NODE: 'true' },
    banner: { js: "import {createRequire as __planCreateRequire} from 'node:module'; const require=__planCreateRequire(import.meta.url);" }, logLevel: 'warning' });
  const inputs = [];
  for (const input of Object.keys(built.metafile.inputs).sort()) {
    const source = input.replace(/^handoff-raw:/, '');
    inputs.push({ path: source.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(root, source))) });
  }
  await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
  report.inputs = inputs.length;report.inputsSha256 = hash(JSON.stringify(inputs));report.bundleSha256 = hash(await readFile(entry));
  for (const name of ['profile', 'workspace', 'home', 'temp', 'appdata']) await mkdir(join(directory, name));
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), TEMP: join(directory, 'temp'),
    TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
    PI_DESKTOP_AGENTS_DIR: join(directory, 'home', '.agents'),
    PI_DESKTOP_DATA_DIR: join(directory, 'profile'), PI_DESKTOP_PLAN_FIXTURE: directory, PI_DESKTOP_HOST_BIN: binary, RUST_LOG: 'error' });
  const child = spawn(process.execPath, [entry], { cwd: join(directory, 'workspace'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-65536); });
  const timer = setTimeout(() => { timedOut = true;child.kill('SIGKILL'); }, 90000);
  let code;
  try { code = await new Promise((done, reject) => { child.once('error', reject);child.once('close', done); }); }
  finally { clearTimeout(timer);await writeFile(join(directory, 'worker.log'), output); }
  Object.assign(report, JSON.parse(await readFile(join(directory, 'worker-report.json'), 'utf8')));
  assert.equal(timedOut, false, 'fixture coordinator timed out');
  assert.equal(code, 0, output);
  assert.equal(report.cleanupConfirmed, true);
} catch (error) { report.status = 'FAIL';report.harnessError = String(error.stack ?? error); }
finally {
  report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS' || !report.cleanupConfirmed) process.exitCode = 1;
}
