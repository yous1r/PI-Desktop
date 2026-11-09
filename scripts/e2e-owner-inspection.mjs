#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { database, harness, until } from './e2e/owner-handoff-fixture.mjs';

assert.equal(process.platform, 'win32');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'owner-inspection-'));
const h = await harness(directory, binary, root);
const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
const bundle = join(directory, 'consumer.mjs');
const built = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents:
  'export { HostProcess } from "./packages/host-runtime/src/host-process.ts"; export { inspectOwnerHandoff } from "./packages/host-runtime/src/owner-handoff-inspection.ts";' },
  outfile: bundle, bundle: true, format: 'esm', platform: 'node', metafile: true,
  alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts') }, logLevel: 'warning' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = [];
for (const input of Object.keys(built.metafile.inputs).filter(input => input !== '<stdin>').sort()) {
  inputs.push({ path: input.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(root, input))) });
}
await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
const { HostProcess, inspectOwnerHandoff } = await import(pathToFileURL(bundle));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), bundleSha256: hash(await readFile(bundle)),
  inputs: inputs.length, inputsSha256: hash(JSON.stringify(inputs)), checks: [], cleanupConfirmed: false,
  scope: 'Production stdio Rust inspection and TypeScript consumer; not complete Desktop inventory or handoff readiness' };
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) env[key] = process.env[key];
Object.assign(env, { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), TEMP: join(directory, 'temp'),
  TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  PI_DESKTOP_AGENTS_DIR: join(directory, 'agents'), RUST_LOG: 'error' });
const hosts = [];
let stderr = '';
function host(profile, executionFence) {
  const child = new HostProcess({ binaryPath: binary, dataDir: profile, executionFence, env: { ...env, PI_DESKTOP_DATA_DIR: profile },
    onStderr: text => { stderr = (stderr + text).slice(-16000); } });
  hosts.push(child); return child;
}
const passed = text => { report.checks.push(text); console.error(`PASS: ${text}`); };
let ticket;
try {
  const profile = join(directory, 'profile');
  const source = host(profile, true);
  await source.handshake();
  assert.ok((await readFile(join(profile, 'pi.sqlite'))).length > 0, 'Host must create its database in the explicit isolated profile');
  const owner = database(profile, db => JSON.parse(db.prepare('SELECT record_json FROM execution_owners WHERE retired=0').get().record_json));
  ticket = await source.call('executionFence.prepare', {});
  const runner = h.launch(binary, ['--internal-execution-runner', '--', process.execPath, '-e', 'process.stdin.resume()'], profile,
    { PI_EXECUTION_TICKET: JSON.stringify(ticket) });
  await until(async () => (await source.call('executionFence.status', { generation: ticket.generation })).state === 'running', 'native registration');
  const binding = { sourceEpoch: owner.epoch, profileId: owner.profile, generation: ticket.generation, host: source };
  const current = () => binding;
  let inspected;
  await until(async () => {
    try { inspected = await inspectOwnerHandoff(current); }
    catch (error) { if (error.errorCode === 'HANDOFF_UNAVAILABLE') return false; throw error; }
    return inspected.activity.requests === 0 && inspected.activity.backgroundTasks === 0 && inspected.activity.writes === 0;
  }, 'startup obligations settle');
  assert.equal(inspected.native.state, 'running');
  assert.equal(inspected.native.confirmed, false);
  assert.ok(inspected.native.activeProcesses >= 1);
  assert.equal(inspected.nativeCoverage, 'execution_generation_only');
  assert.equal(inspected.activity.uncertain, false);
  passed('production stdio inspection excludes its own admission and binds a real live native generation');

  const { session } = await source.call('session.create', { title: 'Isolated inspection fixture' });
  const { turnId } = await source.call('session.beginTurn', { sessionId: session.id });
  const busy = await inspectOwnerHandoff(current);
  assert.equal(busy.durable.turns, true);
  await source.call('session.saveInflightMessage', { sessionId: session.id, turnId,
    message: { id: 'partial-fixture', role: 'assistant', content: 'retained reply', createdAt: '2026-11-09T00:00:00.000Z', status: 'streaming' } });
  await source.call('session.endTurn', { turnId, status: 'aborted', createNotification: false, recoverInflight: true });
  const idle = await inspectOwnerHandoff(current);
  assert.equal(idle.durable.turns, false);
  assert.equal(idle.activity.uncertain, false);
  const detail = await source.call('session.get', { id: session.id });
  assert.equal(detail.session.messages[0].content, 'retained reply');
  assert.equal(detail.session.messages[0].status, 'aborted');
  passed('real begin/checkpoint/end/recovery path updates read-only obligations and preserves the reply');

  const generation = database(profile, db => db.prepare('SELECT record_json FROM execution_generations WHERE id=?').get(ticket.generation).record_json);
  const replaceRoot = root => database(profile, db => db.prepare('UPDATE execution_generations SET record_json=? WHERE id=?')
    .run(JSON.stringify({ ...JSON.parse(generation), root }), ticket.generation), false);
  try {
    for (const root of [null, owner.host]) {
      replaceRoot(root);
      await assert.rejects(inspectOwnerHandoff(current), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
    }
  } finally {
    database(profile, db => db.prepare('UPDATE execution_generations SET record_json=? WHERE id=?').run(generation, ticket.generation), false);
  }
  assert.equal((await inspectOwnerHandoff(current)).native.state, 'running');
  passed('missing or mismatched journal roots refuse the original live native generation');

  for (const change of [{ sourceEpoch: randomUUID() }, { profileId: 'f'.repeat(64) }, { generation: randomUUID() }]) {
    await assert.rejects(inspectOwnerHandoff(() => ({ ...binding, ...change })), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
  }
  await assert.rejects(source.call('ownerHandoff.inspect', { version: 1, requestId: randomUUID(), sourceEpoch: owner.epoch,
    profileId: owner.profile, generation: ticket.generation, idle: true }), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
  const ordinary = host(join(directory, 'ordinary'), false);
  await ordinary.handshake();
  await assert.rejects(inspectOwnerHandoff(() => ({ ...binding, host: ordinary })), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
  assert.equal((await source.call('executionFence.stop', { generation: ticket.generation, timeoutMs: 2000 })).confirmed, true);
  await h.closed(runner);
  assert.ok(!stderr.includes(ticket.capability));
  passed('stale identities, caller inventory and absent native authority refuse; original native closure is confirmed');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  const cleanup = [];
  for (const child of hosts) {
    try { await child.dispose(); assert.equal(await child.confirmExit(), true); }
    catch (error) { cleanup.push(String(error)); }
  }
  report.cleanupConfirmed = await h.cleanup() && cleanup.length === 0;
  if (!report.cleanupConfirmed) { report.status = 'FAIL'; report.cleanupErrors = cleanup; }
  report.hostProcesses = hosts.length;
  report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
