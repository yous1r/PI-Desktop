#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { bounded, database, harness } from './e2e/owner-handoff-fixture.mjs';

assert.equal(process.platform, 'win32');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'owner-source-'));
const h = await harness(directory, binary, root);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), checks: [], cleanupConfirmed: false,
  scope: 'Authenticated running-source preflight/status only; no quiescence, journal transitions or transfer readiness' };
const { build } = createRequire(join(root, 'packages/shared/package.json'))('esbuild');
const bundle = join(directory, 'source-contract.mjs');
await build({ absWorkingDir: root, entryPoints: ['packages/shared/src/owner-handoff-source.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: bundle, logLevel: 'warning' });
const { parseOwnerHandoffSourceRequest, parseOwnerHandoffSourceReply } = await import(pathToFileURL(bundle));
const passed = text => { report.checks.push(text); console.error(`PASS: ${text}`); };
async function query(profile, value, valid = true) {
  const child = h.launch(binary, ['--owner-source'], profile);
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  const chunks = []; child.stdout.on('data', bytes => chunks.push(bytes));
  child.stdin.end(Buffer.concat([header, body]));
  const exit = await h.closed(child, 15000);
  if (!valid) { assert.notEqual(exit.code, 0); return; }
  assert.equal(exit.code, 0, child.stderrText);
  const result = Buffer.concat(chunks); assert.ok(result.length > 4); assert.equal(result.readUInt32LE(), result.length - 4);
  assert.ok(result.length <= 16388);
  return JSON.parse(result.subarray(4).toString('utf8'));
}
function rows(profile) {
  return database(profile, db => Object.fromEntries(['execution_owners', 'execution_generations', 'owner_handoffs', 'owner_handoff_receipts']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
try {
  const profile = join(directory, 'profile');
  const source = await h.host(profile);
  assert.ok((await readFile(join(profile, 'pi.sqlite'))).length > 0);
  const identity = await source.call('ownerHandoff.identity', { version: 1, requestId: randomUUID() });
  const before = rows(profile);
  const request = parseOwnerHandoffSourceRequest({ protocol: 'owner-transfer', version: 1, command: {
    version: 1, operation: 'preflight', requestId: randomUUID(), sourceEpoch: identity.sourceEpoch,
    targetBuild: { sha256: report.binarySha256, schema: 30, protocol: 1 } } });
  const reply = parseOwnerHandoffSourceReply(await query(profile, request), request, identity.profileId);
  assert.equal(reply.result.requiresIdle, true);
  assert.deepEqual(rows(profile), before);
  passed('same-image native source client preflights a running locked owner without a new owner, transfer or receipt');
  for (const command of [{ ...request.command, sourceEpoch: randomUUID() },
    { ...request.command, targetBuild: { ...request.command.targetBuild, sha256: 'a'.repeat(64) } },
    { version: 1, requestId: randomUUID(), sourceEpoch: identity.sourceEpoch, operation: 'status', transferId: randomUUID() }]) {
    const value = { ...request, command }; const result = parseOwnerHandoffSourceReply(await query(profile, value), value, identity.profileId);
    assert.ok(['HANDOFF_OWNER_CHANGED', 'HANDOFF_INCOMPATIBLE_BUILD', 'HANDOFF_UNAVAILABLE'].includes(result.result.error.code));
  }
  for (const command of [{ ...request.command, idle: true }, { ...request.command, operation: 'prepare' },
    { ...request.command, requestId: 'x'.repeat(17000) }]) await query(profile, { ...request, command }, false);
  assert.deepEqual(rows(profile), before);
  const record = JSON.parse(await readFile(join(root, 'packages/shared/test/fixtures/owner-handoff.json'), 'utf8')).response.record;
  const owner = JSON.parse(before.execution_owners[0].record_json);
  Object.assign(record, { id: randomUUID(), profile: identity.profileId, sourceEpoch: identity.sourceEpoch,
    targetEpoch: randomUUID(), phase: 'cancelled', revision: 2, requester: owner.host,
    sourceBuild: request.command.targetBuild, targetBuild: request.command.targetBuild });
  // Test-only terminal record injection; the source API has no mutation path.
  database(profile, db => db.prepare('INSERT INTO owner_handoffs(id,profile,source_epoch,target_epoch,revision,phase,record_json) VALUES(?,?,?,?,?,?,?)')
    .run(record.id, record.profile, record.sourceEpoch, record.targetEpoch, record.revision, record.phase, JSON.stringify(record)), false);
  const status = { ...request, command: { version: 1, requestId: randomUUID(), operation: 'status',
    sourceEpoch: identity.sourceEpoch, transferId: record.id } };
  const recorded = rows(profile);
  assert.deepEqual(parseOwnerHandoffSourceReply(await query(profile, status), status, identity.profileId).result.record, record);
  assert.deepEqual(rows(profile), recorded);
  passed('authenticated status returns the exact original-owner terminal record without advancing or replaying it');
  passed('stale epochs, mismatched builds, absent transfers, caller inventory, mutation commands and oversized input refuse without writes');
  const socket = createConnection(`\\\\.\\pipe\\pi-desktop-transfer-v1-${identity.profileId}`);
  let received = 0; socket.on('data', bytes => { received += bytes.length; });
  try {
    await bounded(new Promise(resolve => { socket.once('error', resolve); socket.once('close', resolve); }), 'wrong executable refusal', 5000);
    assert.equal(received, 0);
  } finally { socket.destroy(); }
  assert.equal((await source.call('ownerHandoff.identity', { version: 1, requestId: randomUUID() })).sourceEpoch, identity.sourceEpoch);
  passed('non-Host executable receives no greeting and leaves ordinary original-owner RPC available');
  await h.stop(source.child);
  await query(profile, request, false);
  const successor = await h.host(profile);
  const rejected = await query(profile, request);
  assert.equal(rejected.result.error.code, 'HANDOFF_OWNER_CHANGED');
  await h.stop(successor.child);
  passed('source exit removes its endpoint and a restarted owner rejects the previous epoch');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  report.cleanupConfirmed = await h.cleanup();
  if (!report.cleanupConfirmed) report.status = 'FAIL';
  report.processes = h.children.length; report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
