#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(
  process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN,
  'PI_SCRATCH_DIR and PI_DESKTOP_HOST_BIN are required',
);
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'relocation-capability-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = path => path.replaceAll('\\', '/').replace(/\/$/, '');
const key = project => JSON.stringify({
  kind: 'skills', level: 'project', id: 'analysis', project_path: normalize(project),
});
const globalKey = JSON.stringify({ kind: 'skills', level: 'global', id: 'global-analysis' });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = {
  status: 'FAIL',
  startedAt: new Date().toISOString(),
  platform: process.platform,
  candidate: git('rev-parse', 'HEAD'),
  base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0,
  binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  checks: [],
};
const env = {};
for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'),
});
for (const name of ['home', 'appdata', 'temp']) await mkdir(join(directory, name));
const cli = (source, destination) => {
  const result = spawnSync(binary, ['--relocate-data', source, destination], {
    env, cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.error, undefined, `relocation process failed: ${result.error}`);
  assert.equal(result.signal, null, 'relocation process was terminated');
  return result;
};
try {
  const source = join(directory, 'old profile');
  const destination = join(directory, 'new profile');
  for (const path of [source, destination]) {
    await mkdir(join(path, 'agent-capabilities'), { recursive: true });
  }
  const sourceFile = join(source, 'agent-capabilities/skills.json');
  const copiedFile = join(destination, 'agent-capabilities/skills.json');
  const externalKey = key(join(directory, 'unmoved-project'));
  const before = JSON.stringify({ values: {
    [key(join(source, 'project'))]: false,
    [globalKey]: false,
    [externalKey]: false,
  } });
  await writeFile(sourceFile, before);
  await copyFile(sourceFile, copiedFile);
  const moved = cli(source, destination);
  assert.equal(moved.status, 0, moved.stderr);
  const values = JSON.parse(await readFile(copiedFile, 'utf8')).values;
  assert.equal(values[key(join(destination, 'project'))], false);
  assert.equal(values[key(join(source, 'project'))], undefined);
  assert.equal(values[globalKey], false);
  assert.equal(values[externalKey], false);
  assert.equal(await readFile(sourceFile, 'utf8'), before);
  report.checks.push(
    'project disabled state uses canonical capability key after relocation',
    'global/external settings and source bytes preserved',
  );
  const once = await readFile(copiedFile);
  const retry = cli(source, destination);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await readFile(copiedFile), once);
  report.checks.push('repeated relocation does not rewrite already moved settings');
  const collision = JSON.stringify({ values: {
    [key(join(source, 'project'))]: false,
    [key(join(destination, 'project'))]: true,
  } });
  await writeFile(copiedFile, collision);
  const refused = cli(source, destination);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /relocated capability identity conflicts/);
  assert.equal(await readFile(copiedFile, 'utf8'), collision);
  assert.equal(await readFile(sourceFile, 'utf8'), before);
  report.checks.push('canonical destination collision refuses without rewriting capability file');
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: join(directory, 'report.json') }, null, 2));
