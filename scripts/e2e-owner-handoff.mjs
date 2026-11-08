#!/usr/bin/env node
// Inject durable fault states only in task-owned temporary profiles. This suite
// qualifies recovery/bootstrap; it does not claim source idle-orchestration UI coverage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { database, durableState, harness, until } from './e2e/owner-handoff-fixture.mjs';

assert.equal(process.platform, 'win32');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'owner-handoff-'));
const h = await harness(directory, binary, root);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  helperSha256: hash(await readFile(new URL('./e2e/owner-handoff-fixture.mjs', import.meta.url))),
  checks: [], cleanupConfirmed: false, fixtureMode: 'durable fault injection; production restricted bootstrap' };
const build = { sha256: report.binarySha256, schema: 30, protocol: 1 };
const runtime = join(directory, 'runtime.mjs');
await writeFile(runtime, `import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const db = new DatabaseSync(process.argv[2], {readOnly:true});
const owner = JSON.parse(db.prepare('SELECT record_json FROM execution_owners WHERE retired=0').get().record_json);
const registration = JSON.parse(db.prepare('SELECT record_json FROM execution_generations WHERE owner_epoch=? AND closed=0').get(owner.epoch).record_json);
assert.equal(registration.root.pid, process.ppid);
assert.equal(registration.ownerEpoch, owner.epoch);
assert.equal(typeof registration.root.createdAt, 'string');
db.close();
const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
writeFileSync(process.argv[3],JSON.stringify({pid:process.pid,child:child.pid,registered:true}));
setInterval(()=>{},1000);
`);
function seed(profile, source, phase, capability) {
  const record = { version: 1, id: randomUUID(), profile: source.profile, sourceEpoch: source.epoch,
    targetEpoch: randomUUID(), sourceBuild: build, targetBuild: build, requester: source.coordinator,
    capabilityHash: hash(capability), revision: 1, phase, recoveryAttempt: 0, lastFailure: null };
  database(profile, db => {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO owner_handoffs(id,profile,source_epoch,target_epoch,revision,phase,record_json) VALUES(?,?,?,?,?,?,?)')
      .run(record.id, record.profile, record.sourceEpoch, record.targetEpoch, record.revision, phase, JSON.stringify(record));
    db.exec("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('kept','Keep',1,1); INSERT INTO turns(id,session_id,status,started_at) VALUES('running','kept','running',1); COMMIT;");
  }, false);
  return record;
}
function command(operation, record, capability, target = record.targetEpoch) {
  return { operation, version: 1, request_id: randomUUID(), transfer_id: record.id, source_epoch: record.sourceEpoch,
    expected_revision: record.revision, target_epoch: target, capability };
}
async function ordinaryRefuses(profile) {
  const before = durableState(profile);
  const child = h.launch(binary, [], profile);
  assert.notEqual((await h.closed(child)).code, 0);
  assert.match(child.stderrText, /HANDOFF_RECOVERY_REQUIRED/);
  assert.deepEqual(durableState(profile), before);
}
function originalOwner(profile) {
  return database(profile, db => JSON.parse(db.prepare('SELECT record_json FROM execution_owners WHERE retired=0').get().record_json));
}
function turnUnchanged(profile) {
  assert.equal(database(profile, db => db.prepare("SELECT status FROM turns WHERE id='running'").get().status), 'running');
}
function passed(message) { report.checks.push(message); console.error(`PASS: ${message}`); }
let last;
try {
  const missing = join(directory, 'missing');
  const absent = h.launch(binary, ['--owner-handoff'], missing);
  assert.notEqual((await h.closed(absent)).code, 0); assert.equal(existsSync(missing), false);
  passed('restricted mode refuses missing profiles without creating a database');
  const beforePrepare = join(directory, 'before-prepare');
  const old = await h.host(beforePrepare);
  const oldOwner = originalOwner(beforePrepare);
  const oldTicket = await old.call('executionFence.prepare');
  const oldMarker = join(directory, 'before-prepare.json');
  const oldRunner = h.launch(binary, ['--internal-execution-runner', '--', process.execPath, runtime, join(beforePrepare, 'pi.sqlite'), oldMarker], beforePrepare,
    { PI_EXECUTION_TICKET: JSON.stringify(oldTicket) });
  await until(() => existsSync(oldMarker), 'runtime before prepare');
  const oldIds = JSON.parse(await readFile(oldMarker, 'utf8'));
  const oldObserved = await h.observe([old.child.pid, oldRunner.pid, oldIds.pid, oldIds.child], beforePrepare);
  await h.stop(old.child, true); await oldObserved(); await h.closed(oldRunner);
  const restarted = await h.host(beforePrepare);
  assert.notEqual(originalOwner(beforePrepare).epoch, oldOwner.epoch);
  assert.equal(database(beforePrepare, db => db.prepare('SELECT retired FROM execution_owners WHERE epoch=?').get(oldOwner.epoch).retired), 1);
  assert.equal(database(beforePrepare, db => db.prepare('SELECT count(*) AS n FROM execution_generations WHERE owner_epoch=?').get(oldOwner.epoch).n), 1);
  await h.stop(restarted.child);
  passed('crash before transfer prepare still proves retained native owner/containment before ordinary restart');
  for (const phase of ['prepared', 'source_fencing', 'source_fenced', 'release_pending']) {
    console.error(`phase: ${phase}`);
    const profile = join(directory, phase);
    const source = await h.host(profile);
    const owner = originalOwner(profile);
    const ticket = await source.call('executionFence.prepare');
    const marker = join(directory, `${phase}.json`);
    const runner = h.launch(binary, ['--internal-execution-runner', '--', process.execPath, runtime, join(profile, 'pi.sqlite'), marker], profile,
      { PI_EXECUTION_TICKET: JSON.stringify(ticket) });
    await until(() => existsSync(marker), 'registration precedes runtime effects');
    const ids = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(ids.registered, true);
    const capability = randomUUID();
    let record = seed(profile, owner, phase, capability);
    const locked = h.launch(binary, ['--owner-handoff'], profile);
    assert.notEqual((await h.closed(locked)).code, 0); assert.match(locked.stderrText, /HOST_DATA_DIR_IN_USE/);
    const observed = await h.observe([source.child.pid, runner.pid, ids.pid, ids.child], profile);
    await h.stop(source.child, true); await observed(); await h.closed(runner);
    await ordinaryRefuses(profile);
    const target = h.restricted(profile);
    const status = await target.call({ operation: 'status', version: 1, transfer_id: record.id });
    assert.deepEqual(status.record, record);
    assert.equal(JSON.stringify(status).includes(capability), false);
    let launchCapability = capability;
    if (phase !== 'release_pending') {
      launchCapability = randomUUID();
      const recover = command('recover', record, launchCapability, randomUUID());
      const response = await target.call(recover); assert.ok(response.record, JSON.stringify(response)); record = response.record;
      assert.equal(record.phase, 'release_pending');
      assert.deepEqual((await target.call(recover)).record, record);
      assert.equal((await target.call(command('claim', record, capability))).error.code, 'HANDOFF_CAPABILITY_MISMATCH');
    }
    const claiming = command('claim', record, launchCapability);
    const response = await target.call(claiming); assert.ok(response.record, JSON.stringify(response)); record = response.record;
    assert.equal(record.phase, 'target_claimed');
    assert.equal(originalOwner(profile).host.pid, target.child.pid);
    assert.deepEqual((await target.call(claiming)).record, record);
    const contender = h.launch(binary, ['--owner-handoff'], profile);
    assert.notEqual((await h.closed(contender)).code, 0); assert.match(contender.stderrText, /HOST_DATA_DIR_IN_USE/);
    turnUnchanged(profile);
    const targetObserved = await h.observe([target.child.pid], profile);
    await h.stop(target.child, true); await targetObserved();
    await ordinaryRefuses(profile);
    const recovery = h.restricted(profile);
    const replacementCapability = randomUUID();
    const replace = command('recover', record, replacementCapability, randomUUID());
    const recovered = await recovery.call(replace); assert.ok(recovered.record, JSON.stringify(recovered));
    assert.notEqual(recovered.record.targetEpoch, record.targetEpoch);
    assert.equal((await recovery.call(claiming)).error.code, 'HANDOFF_CAPABILITY_MISMATCH');
    assert.equal(database(profile, db => db.prepare('SELECT count(*) AS n FROM execution_owners WHERE retired=0').get().n), 0);
    turnUnchanged(profile);
    assert.equal((await h.stop(recovery.child)).code, 0, recovery.child.stderrText);
    last = { profile, record: recovered.record, capability: replacementCapability };
    passed(`${phase}: durable registration before Node effects; source crash closure; ordinary startup blocked; one native target; target crash rotates recovery without replay`);
  }
  const { profile, record, capability } = last;
  const before = durableState(profile);
  const restricted = h.restricted(profile);
  for (const invalid of [
    { ...command('claim', record, capability), version: 2 },
    { ...command('claim', record, capability), expected_revision: record.revision - 1 },
    { ...command('claim', record, capability), adopt_pid: process.pid },
  ]) assert.ok((await restricted.call(invalid)).error);
  assert.deepEqual(durableState(profile), before);
  await h.stop(restricted.child);
  database(profile, db => db.exec('PRAGMA user_version=31;'), false);
  const newer = h.restricted(profile);
  assert.equal((await newer.call(command('recover', record, randomUUID(), randomUUID()))).error.code, 'HANDOFF_UNSUPPORTED_SCHEMA');
  await h.stop(newer.child);
  assert.equal(database(profile, db => db.prepare('PRAGMA user_version').get().user_version), 31);
  database(profile, db => db.exec('PRAGMA user_version=30;'), false);
  assert.deepEqual(durableState(profile), before);
  passed('unsupported versions, stale revisions and unknown fields refuse without journal/turn mutation');

  const liveProfile = join(directory, 'live-native-proof');
  const liveHost = await h.host(liveProfile);
  const liveIdentity = originalOwner(liveProfile).host;
  const sourceRaw = database(profile, db => db.prepare('SELECT record_json FROM execution_owners WHERE epoch=?').get(record.sourceEpoch).record_json);
  for (const createdAt of [liveIdentity.createdAt, (BigInt(liveIdentity.createdAt) - 1n).toString()]) {
    const changed = { ...JSON.parse(sourceRaw), host: { ...liveIdentity, createdAt } };
    database(profile, db => db.prepare('UPDATE execution_owners SET record_json=? WHERE epoch=?').run(JSON.stringify(changed), record.sourceEpoch), false);
    const unchanged = durableState(profile);
    const denied = h.restricted(profile);
    const result = await denied.call(command('recover', record, randomUUID(), randomUUID()));
    assert.match(result.error.code, /HANDOFF_(PREVIOUS_PROCESS_ALIVE|PROCESS_IDENTITY_CHANGED)/);
    assert.deepEqual(durableState(profile), unchanged);
    await h.stop(denied.child);
  }
  database(profile, db => db.prepare('UPDATE execution_owners SET record_json=? WHERE epoch=?').run(sourceRaw, record.sourceEpoch), false);
  await h.stop(liveHost.child);
  passed('live original process and mismatched creation identity fail closed without retirement');

  for (const length of [0, 16385]) {
    const invalid = h.launch(binary, ['--owner-handoff'], profile);
    const frame = Buffer.alloc(4); frame.writeUInt32LE(length); invalid.stdin.write(frame);
    assert.notEqual((await h.closed(invalid)).code, 0); assert.match(invalid.stderrText, /HANDOFF_INVALID_FRAME/);
  }
  const truncated = h.launch(binary, ['--owner-handoff'], profile);
  truncated.stdin.write(Buffer.from([5, 0, 0, 0, 123]));
  assert.notEqual((await h.closed(truncated, 40000)).code, 0);
  assert.match(truncated.stderrText, /HANDOFF_IO_TIMEOUT/);
  assert.doesNotMatch(truncated.stderrText, /CLEANUP_UNCONFIRMED/);
  assert.deepEqual(durableState(profile), before);
  const reopened = h.restricted(profile);
  assert.deepEqual((await reopened.call({ operation: 'status', version: 1, transfer_id: record.id })).record, record);
  assert.equal((await h.stop(reopened.child)).code, 0);
  passed('zero/oversized/truncated frames refuse; blocked read cancels and releases directory lock');
  const blockedOutput = h.launch(binary, ['--owner-handoff'], profile);
  blockedOutput.stdout.pause();
  const statusBytes = Buffer.from(JSON.stringify({ operation: 'status', version: 1, transfer_id: record.id }));
  const statusFrame = Buffer.alloc(statusBytes.length + 4); statusFrame.writeUInt32LE(statusBytes.length); statusBytes.copy(statusFrame, 4);
  const outputExit = new Promise(resolveExit => blockedOutput.once('exit', resolveExit));
  blockedOutput.stdin.write(Buffer.concat(Array(4000).fill(statusFrame)));
  await until(() => blockedOutput.exitCode !== null || blockedOutput.signalCode !== null, 'blocked output cancellation', 20000);
  await outputExit; blockedOutput.stdout.resume();
  assert.notEqual((await h.closed(blockedOutput)).code, 0);
  assert.match(blockedOutput.stderrText, /HANDOFF_IO_TIMEOUT/);
  assert.doesNotMatch(blockedOutput.stderrText, /CLEANUP_UNCONFIRMED/);
  assert.deepEqual(durableState(profile), before);
  passed('unresponsive response reader cancels blocked output and releases ownership without journal writes');

  const coordinatorFile = join(directory, 'restricted-coordinator.mjs');
  await writeFile(coordinatorFile, `import {spawn} from 'node:child_process';
const child=spawn(process.argv[2],['--owner-handoff'],{env:process.env,stdio:['pipe','pipe','pipe'],windowsHide:true});
child.stdin.on('error',()=>{});
child.stdin.write(Buffer.from([5,0,0,0,123]));
process.stdout.write(JSON.stringify({host:child.pid})+'\\n');
setInterval(()=>{},1000);
`);
  const coordinator = h.launch(process.execPath, [coordinatorFile, binary], profile);
  await until(() => coordinator.stdoutText.includes('host'), 'restricted coordinator starts');
  const coordinatorHost = JSON.parse(coordinator.stdoutText.trim()).host;
  const observeCoordinator = await h.observe([coordinatorHost], profile);
  await h.stop(coordinator, true); await observeCoordinator();
  const afterCoordinator = h.restricted(profile);
  assert.deepEqual((await afterCoordinator.call({ operation: 'status', version: 1, transfer_id: record.id })).record, record);
  assert.equal((await h.stop(afterCoordinator.child)).code, 0);
  assert.deepEqual(durableState(profile), before);
  passed('coordinator crash closes restricted original Host and permits a new restricted owner');
  report.status = 'PASS';
} catch (error) {
  report.error = error.stack ?? String(error);
} finally {
  report.cleanupConfirmed = await h.cleanup();
  report.childCount = h.children.length;
  if (!report.cleanupConfirmed) report.status = 'FAIL';
  report.report = join(directory, 'report.json');
  await writeFile(report.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
if (report.status !== 'PASS') process.exitCode = 1;
