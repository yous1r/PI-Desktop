#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { database, durableState, harness } from './e2e/owner-handoff-fixture.mjs';

assert.equal(process.platform, 'win32');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'owner-handoff-client-'));
const h = await harness(directory, binary, root);
const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
const bundle = join(directory, 'client.mjs');
const built = await build({ absWorkingDir: root, entryPoints: [join(root, 'packages/host-runtime/src/owner-handoff-process.ts')],
  outfile: bundle, bundle: true, format: 'esm', platform: 'node', metafile: true,
  alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts') }, logLevel: 'warning' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = [];
for (const input of Object.keys(built.metafile.inputs).sort()) inputs.push({ path: input.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(root, input))) });
await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
const { OwnerHandoffProcess } = await import(pathToFileURL(bundle));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), bundleSha256: hash(await readFile(bundle)),
  inputs: inputs.length, inputsSha256: hash(JSON.stringify(inputs)), checks: [], cleanupConfirmed: false,
  scope: 'Production restricted bootstrap consumer with injected durable fault state; not full handoff readiness' };
const profile = join(directory, 'profile');
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) env[key] = process.env[key];
Object.assign(env, { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), TEMP: join(directory, 'temp'),
  TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'), RUST_LOG: 'error' });
const clients = [];
let stderr = '';
function client(profileId, options = {}) {
  const result = new OwnerHandoffProcess({ binaryPath: binary, dataDir: profile, profileId, env,
    onStderr: text => { stderr = (stderr + text).slice(-16000); }, ...options });
  clients.push(result); return result;
}
const passed = text => { report.checks.push(text); console.error(`PASS: ${text}`); };
function change(operation, record, capability, target = record.targetEpoch) {
  return { operation, version: 1, request_id: randomUUID(), transfer_id: record.id, source_epoch: record.sourceEpoch,
    expected_revision: record.revision, target_epoch: target, capability };
}
try {
  const source = await h.host(profile);
  const owner = database(profile, db => JSON.parse(db.prepare('SELECT record_json FROM execution_owners WHERE retired=0').get().record_json));
  const pending = await source.call('executionFence.prepare');
  assert.equal((await source.call('executionFence.stop', { generation: pending.generation, timeoutMs: 2000 })).confirmed, true);
  const locked = client(owner.profile);
  await assert.rejects(locked.call({ version: 1, operation: 'status', transfer_id: randomUUID() }), /HANDOFF_TRANSPORT_CLOSED/);
  assert.equal(await locked.confirmExit(), true); await locked.dispose();
  assert.match(stderr, /HOST_DATA_DIR_IN_USE/);
  await h.stop(source.child);
  passed('production client refuses a live directory owner and confirms the original restricted child exit');

  const capability = randomUUID();
  const buildIdentity = { sha256: report.binarySha256, schema: 28, protocol: 1 };
  let record = { version: 1, id: randomUUID(), profile: owner.profile, sourceEpoch: owner.epoch, targetEpoch: randomUUID(),
    sourceBuild: buildIdentity, targetBuild: buildIdentity, requester: owner.coordinator, capabilityHash: hash(capability),
    revision: 1, phase: 'prepared', recoveryAttempt: 0, lastFailure: null };
  database(profile, db => {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO owner_handoffs(id,profile,source_epoch,target_epoch,revision,phase,record_json) VALUES(?,?,?,?,?,?,?)')
      .run(record.id, record.profile, record.sourceEpoch, record.targetEpoch, record.revision, record.phase, JSON.stringify(record));
    db.exec("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('kept','Keep',1,1); INSERT INTO turns(id,session_id,status,started_at) VALUES('running','kept','running',1); COMMIT;");
  }, false);
  const status = { version: 1, operation: 'status', transfer_id: record.id };
  const before = durableState(profile);
  const wrong = client('f'.repeat(64));
  await assert.rejects(wrong.call(status), /HANDOFF_RESPONSE_MISMATCH/);
  await wrong.dispose(); assert.equal(await wrong.confirmExit(), true);
  assert.deepEqual(durableState(profile), before);
  passed('response profile mismatch closes the consumer channel without changing journal or turns');

  const current = client(owner.profile);
  const initial = await current.call(status); assert.deepEqual(initial.record, record);
  await assert.rejects(current.call({ ...status, operation: 'ready' }), /HANDOFF_INVALID_REQUEST/);
  assert.deepEqual((await current.call(status)).record, record);
  assert.equal((await current.call(change('claim', record, randomUUID()))).error.code, 'HANDOFF_CAPABILITY_MISMATCH');
  const replacement = randomUUID();
  const recover = change('recover', record, replacement, randomUUID());
  const recovered = await current.call(recover); assert.ok(recovered.record); record = recovered.record;
  assert.equal(record.phase, 'release_pending'); assert.equal(record.revision, 2);
  assert.deepEqual((await current.call(recover)).record, record);
  assert.equal(JSON.stringify(recovered).includes(replacement), false);
  const claim = change('claim', record, replacement);
  const claimed = await current.call(claim); assert.ok(claimed.record); record = claimed.record;
  assert.equal(record.phase, 'target_claimed'); assert.equal(record.revision, 3);
  assert.deepEqual((await current.call(claim)).record, record);
  assert.equal(database(profile, db => db.prepare("SELECT status FROM turns WHERE id='running'").get().status), 'running');
  passed('strict production recover/claim preserves FILETIME and durable receipts without ordinary turn recovery');

  const contender = client(owner.profile);
  await assert.rejects(contender.call(status), /HANDOFF_TRANSPORT_CLOSED/);
  assert.equal(await contender.confirmExit(), true); await contender.dispose();
  const ordinary = h.launch(binary, [], profile); assert.notEqual((await h.closed(ordinary)).code, 0);
  await current.dispose(); assert.equal(await current.confirmExit(), true);
  const restored = client(owner.profile);
  assert.deepEqual((await restored.call(status)).record, record);
  const nextCapability = randomUUID();
  const next = await restored.call(change('recover', record, nextCapability, randomUUID())); assert.ok(next.record);
  assert.equal(next.record.revision, 4); assert.notEqual(next.record.targetEpoch, record.targetEpoch);
  assert.equal((await restored.call(claim)).error.code, 'HANDOFF_CAPABILITY_MISMATCH');
  assert.equal(database(profile, db => db.prepare("SELECT status FROM turns WHERE id='running'").get().status), 'running');
  assert.equal(database(profile, db => db.prepare('SELECT count(*) AS n FROM owner_handoff_receipts').get().n), 3);
  assert.ok(!stderr.includes(capability) && !stderr.includes(replacement) && !stderr.includes(nextCapability));
  await restored.dispose(); assert.equal(await restored.confirmExit(), true);
  passed('one restricted owner; independent reopen and explicit rotation preserve history without replay or capability logging');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  const cleanup = [];
  for (const child of clients) { try { await child.dispose(); assert.equal(await child.confirmExit(), true); } catch (error) { cleanup.push(String(error)); } }
  const harnessClosed = await h.cleanup();
  report.cleanupConfirmed = harnessClosed && cleanup.length === 0;
  if (!report.cleanupConfirmed) { report.status = 'FAIL'; report.cleanupErrors = cleanup; }
  report.restrictedProcesses = clients.length;
  report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
