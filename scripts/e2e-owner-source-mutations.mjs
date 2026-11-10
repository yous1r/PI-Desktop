#!/usr/bin/env node
// Negative user flow for the original source: this suite proves that an
// authenticated framed `--owner-source` client can reach the real Rust source
// service, that the real Rust exchange notifies the real Desktop coordinator,
// and that the declared qualification gaps refuse the hold with HANDOFF_BUSY
// without any durable write. It never completes a handoff, never certifies
// native closure and never acquires a Sidecar. No live Desktop, default
// profile, production binary, provider or network endpoint is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { database, harness, until } from './e2e/owner-handoff-fixture.mjs';

assert.equal(process.platform, 'win32', 'Windows containment and named pipes are required');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN, 'PI_SCRATCH_DIR and PI_DESKTOP_HOST_BIN are required');
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'owner-source-mutations-'));
const h = await harness(directory, binary, root);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  helperSha256: hash(await readFile(new URL('./e2e/owner-source-mutations.mjs', import.meta.url))),
  checks: [], cleanupConfirmed: false,
  scope: 'original source -> authenticated framed stdio -> real Rust exchange -> Desktop coordinator NEGATIVE only; '
    + 'no handoff completes, no native closure is certified, no Sidecar is acquired' };
const build = { sha256: report.binarySha256, schema: 30, protocol: 1 };

// Bundle the current production sources instead of a built artifact: the
// Desktop coordinator, the exchange subscription, the inventory and the shared
// wire contract all come from this candidate tree.
const { build: esbuild } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
const bundle = join(directory, 'candidate.mjs');
const runtimeExports = join(directory, 'runtime-exports.mjs');
await writeFile(runtimeExports, [
  'export * from ' + JSON.stringify(join(root, 'packages/host-runtime/src/owner-handoff-coordinator.ts').replaceAll('\\', '/')) + ';',
  'export * from ' + JSON.stringify(join(root, 'packages/host-runtime/src/owner-handoff-query.ts').replaceAll('\\', '/')) + ';',
  'export * from ' + JSON.stringify(join(root, 'packages/host-runtime/src/owner-handoff-inspection.ts').replaceAll('\\', '/')) + ';',
  'export * from ' + JSON.stringify(join(root, 'packages/host-runtime/src/owner-handoff-exchange.ts').replaceAll('\\', '/')) + ';',
  'export * from ' + JSON.stringify(join(root, 'packages/host-runtime/src/owner-handoff-ports.ts').replaceAll('\\', '/')) + ';',
  'export { decodeBinaryStorage, encodeBinaryStorage } from ' + JSON.stringify(join(root, 'packages/host-runtime/src/binary-storage.ts').replaceAll('\\', '/')) + ';',
].join('\n'));
const built = await esbuild({ absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', metafile: true,
  outfile: bundle, write: false, logLevel: 'warning',
  stdin: { resolveDir: root, contents: [
    'export { HostProcess } from "./packages/host-runtime/src/host-process.ts";',
    'export { parseOwnerHandoffSourceRequest, parseOwnerHandoffSourceReply } from "./packages/shared/src/owner-handoff-source.ts";',
    'export { createOwnerSourceDesktop, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES, OWNER_SOURCE_MUTATION_SCOPE } from "./scripts/e2e/owner-source-mutations.mjs";',
  ].join('\n') },
  alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts'),
    '@pi-desktop/host-runtime': runtimeExports,
    '@pi-desktop/agent-host': join(root, 'packages/agent-host/src/maintenance-admission.ts') } });
assert.equal(built.outputFiles.length, 1);
await writeFile(bundle, built.outputFiles[0].contents);
const inputs = [];
for (const input of Object.keys(built.metafile.inputs).filter(input => input !== '<stdin>').sort()) {
  inputs.push({ path: input.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(root, input))) });
}
await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
report.bundleSha256 = hash(await readFile(bundle));
report.inputs = inputs.length;
report.inputsSha256 = hash(JSON.stringify(inputs));
const { HostProcess, parseOwnerHandoffSourceRequest, parseOwnerHandoffSourceReply, createOwnerSourceDesktop,
  DESKTOP_HANDOFF_UNQUALIFIED_SOURCES, OWNER_SOURCE_MUTATION_SCOPE } = await import(pathToFileURL(bundle));
report.scope = OWNER_SOURCE_MUTATION_SCOPE;

// Only fixture children get an overridden environment. TEMP/TMP/AGENTS and any
// final PI_DESKTOP_DATA_DIR stay inside this scratch directory.
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) env[key] = process.env[key];
Object.assign(env, { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), TEMP: join(directory, 'temp'),
  TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'),
  PI_DESKTOP_AGENTS_DIR: join(directory, 'agents'), RUST_LOG: 'error' });

const passed = text => { report.checks.push(text); console.error(`PASS: ${text}`); };
const tables = profile => database(profile, db => Object.fromEntries(
  ['execution_owners', 'execution_generations', 'owner_handoffs', 'owner_handoff_receipts']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
function assertNoHandoffRecords(profile, label, expected) {
  const current = tables(profile);
  assert.deepEqual(current, expected, `${label}: durable handoff state changed`);
  assert.equal(current.owner_handoffs.length, 0, `${label}: a transfer record was written`);
  assert.equal(current.owner_handoff_receipts.length, 0, `${label}: a source receipt was written`);
}
const forbidden = new Set(['sid', 'pid', 'requester', 'host', 'coordinator', 'caller', 'principal', 'image']);
function assertNoCallerIdentity(value, label) {
  const text = JSON.stringify(value);
  for (const secret of [OWNER.host.sid, OWNER.coordinator.sid, OWNER.host.image]) {
    assert.equal(text.includes(secret), false, `${label}: payload exposed an original process identity`);
  }
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbidden.has(key.toLowerCase()), false, `${label}: payload exposes the "${key}" field`);
      walk(child);
    }
  };
  walk(value);
}

function request(operation, extra = {}) {
  const base = { version: 1, requestId: randomUUID(), sourceEpoch: IDENTITY.sourceEpoch };
  if (operation === 'preflight') return { protocol: 'owner-transfer', version: 1,
    command: { ...base, operation, targetBuild: build, ...extra } };
  if (operation === 'prepare') return { protocol: 'owner-transfer', version: 1, command: { ...base, operation,
    transferId: randomUUID(), expectedRevision: 0, targetEpoch: randomUUID(),
    capabilityHash: hash(randomUUID()), targetBuild: build, ...extra } };
  return { protocol: 'owner-transfer', version: 1, command: { ...base, operation,
    transferId: randomUUID(), expectedRevision: 1, ...extra } };
}
/** One bounded framed exchange with a fresh same-image `--owner-source` client. */
function begin(profile, value) {
  const child = h.launch(binary, ['--owner-source'], profile);
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  const chunks = [];
  child.stdout.on('data', bytes => chunks.push(bytes));
  child.stdin.end(Buffer.concat([header, body]));
  return { child, done: h.closed(child, 60000).then(exit => ({ exit, chunks })) };
}
async function source(profile, value, expectedCode) {
  const request = parseOwnerHandoffSourceRequest(value);
  const { child, done } = begin(profile, request);
  const { exit, chunks } = await done;
  assert.equal(exit.code, 0, child.stderrText);
  const frame = Buffer.concat(chunks);
  assert.ok(frame.length > 4 && frame.length <= 16388, 'one bounded reply frame');
  assert.equal(frame.readUInt32LE(), frame.length - 4, 'length-prefixed reply only');
  const reply = parseOwnerHandoffSourceReply(JSON.parse(frame.subarray(4).toString('utf8')), request, IDENTITY.profileId);
  assertNoCallerIdentity(reply, `source ${request.command.operation}`);
  if (expectedCode) assert.equal(reply.result.error?.code, expectedCode, JSON.stringify(reply.result));
  return { reply, frame };
}

let host, runner, desktop, ticket, OWNER, IDENTITY;
try {
  const profile = join(directory, 'profile');
  host = new HostProcess({ binaryPath: binary, dataDir: profile, executionFence: true,
    env: { ...env, PI_DESKTOP_DATA_DIR: profile },
    onStderr: text => { report.stderr = ((report.stderr ?? '') + text).slice(-8000); } });
  await host.handshake();
  assert.ok((await readFile(join(profile, 'pi.sqlite'))).length > 0, 'Host must create its database in the explicit scratch profile');
  IDENTITY = await host.call('ownerHandoff.identity', { version: 1, requestId: randomUUID() });
  OWNER = JSON.parse(database(profile, db => db.prepare('SELECT record_json FROM execution_owners WHERE retired=0').get().record_json));

  // A real bound original generation: the native runner registers itself to the
  // retained lease, so the journal root is the launcher this suite started.
  ticket = await host.call('executionFence.prepare', {});
  runner = h.launch(binary, ['--internal-execution-runner', '--', process.execPath, '-e', 'process.stdin.resume()'], profile,
    { PI_EXECUTION_TICKET: JSON.stringify(ticket) });
  const native = async () => host.call('executionFence.status', { generation: ticket.generation });
  await until(async () => (await native()).state === 'running', 'native generation registration');
  const bound = await native();
  assert.equal(bound.confirmed, false);
  assert.equal(bound.rootExited, false);
  assert.ok(bound.activeProcesses >= 1, 'the bound root is contained');
  assert.equal(IDENTITY.profileId, OWNER.profile);

  desktop = createOwnerSourceDesktop({ host, directory: join(directory, 'desktop'),
    binding: { sourceEpoch: IDENTITY.sourceEpoch, profileId: IDENTITY.profileId, generation: ticket.generation } });
  // Startup obligations must settle before the inventory can be read as idle.
  let idle;
  await until(async () => {
    try { idle = await desktop.inspect(); } catch (error) { if (error.errorCode === 'HANDOFF_UNAVAILABLE') return false; throw error; }
    return idle.turns === 0 && idle.writes === 0 && idle.admissions === 0;
  }, 'startup obligations settle');
  assert.equal(DESKTOP_HANDOFF_UNQUALIFIED_SOURCES.length, 10, 'the declared qualification gaps stay declared');
  assert.deepEqual([...DESKTOP_HANDOFF_UNQUALIFIED_SOURCES], ['rust-background-admission',
    'native-resources-outside-execution-generation', 'updater', 'model-catalog', 'vendor-oauth', 'mcp-control',
    'personal-todos', 'electron-surfaces-and-listeners', 'worker-execution-classification', 'voice-and-live-voice']);
  assert.equal(Object.keys(idle).length, 19, 'all nineteen inventory families are reported');
  assert.equal(idle.uncontainedResources, 10, 'every declared gap is counted against idleness');
  assert.equal(await desktop.probeGate(), 'HOST_BUSY', 'the real admission refuses the current inventory');
  assert.equal(desktop.admission.isClosed(), false);
  passed('a real fenced Host binds one original generation and the real Desktop inventory reports all ten declared gaps');

  // A. A drifted target build is refused by the original source before any
  // source->Desktop exchange. This also caches the source Controller, so the
  // busy path below performs no further AppState capture.
  const before = tables(profile);
  const notifications = desktop.counts.notifications, completions = desktop.counts.completions;
  const drifted = request('prepare', { targetBuild: { ...build, sha256: 'a'.repeat(64) } });
  const drift = await source(profile, drifted, 'HANDOFF_INCOMPATIBLE_BUILD');
  const preflight = request('preflight', { targetBuild: { ...build, sha256: 'b'.repeat(64) } });
  const preflightDrift = await source(profile, preflight, 'HANDOFF_INCOMPATIBLE_BUILD');
  assert.equal(drift.reply.requestId, drifted.command.requestId);
  assert.equal(preflightDrift.reply.requestId, preflight.command.requestId);
  assert.equal(desktop.counts.notifications, notifications, 'a drifted build never reaches the quiescence exchange');
  assertNoHandoffRecords(profile, 'build drift', before);
  passed('a drifted target build is refused by the original source before any stdio exchange, for prepare and preflight');

  // B. The real notify + completion path, refused by the real coordinator.
  const prepare = request('prepare');
  const refused = await source(profile, prepare, 'HANDOFF_BUSY');
  assert.equal(desktop.counts.notifications, notifications + 1, 'exactly one quiescence notification per prepare');
  assert.equal(desktop.counts.completions, completions + 1, 'exactly one completion per notification');
  assert.equal(desktop.notifications.at(-1).request.operation, 'hold');
  assert.equal(desktop.notifications.at(-1).request.holdId, undefined, 'a hold request carries no hold id');
  assert.equal(desktop.completions.at(-1).outcome.error.code, 'HANDOFF_BUSY');
  assert.equal(desktop.acks.at(-1).accepted, true, 'the original Rust owner accepted the completion ACK');
  assert.equal(desktop.acks.at(-1).exchangeId, desktop.completions.at(-1).request.exchangeId);
  assertNoCallerIdentity(desktop.notifications.at(-1), 'quiescence notification');
  assertNoCallerIdentity(desktop.acks.at(-1), 'completion ack');
  assertNoHandoffRecords(profile, 'busy hold', before);
  assert.equal(refused.reply.result.error.code, 'HANDOFF_BUSY');
  assert.equal(desktop.admission.isClosed(), false, 'Desktop admission reopens after a confirmed busy refusal');
  assert.equal(desktop.counts.sidecarCalls, 0, 'no Sidecar hold was requested');
  passed('all ten qualification gaps refuse the real source hold with HANDOFF_BUSY over one notified and acknowledged exchange, without a transfer, receipt or Sidecar acquire');

  // C. The identical request is a fresh, still-refused attempt.
  const retried = await source(profile, prepare, 'HANDOFF_BUSY');
  assert.equal(retried.reply.requestId, prepare.command.requestId, 'the reply correlates to the identical request');
  assert.equal(desktop.counts.notifications, notifications + 2);
  assert.equal(desktop.counts.completions, completions + 2);
  assertNoHandoffRecords(profile, 'busy retry', before);
  assert.equal(desktop.admission.isClosed(), false);
  passed('the identical request after a confirmed busy is refused busy again with no durable record and an open admission');

  // D. A stale source epoch never reaches the exchange either.
  const stale = request('prepare', { sourceEpoch: randomUUID() });
  await source(profile, stale, 'HANDOFF_OWNER_CHANGED');
  assert.equal(desktop.counts.notifications, notifications + 2, 'a stale epoch never reaches the quiescence exchange');
  assertNoHandoffRecords(profile, 'stale epoch', before);
  passed('a stale source epoch is refused by the original source without an exchange or a durable write');

  // E. Well-formed cancel/fence/release for a transfer the source never owned.
  for (const operation of ['cancel', 'fence', 'release']) {
    await source(profile, request(operation), 'HANDOFF_INVALID_TRANSITION');
  }
  assert.equal(desktop.counts.notifications, notifications + 2, 'an unowned transfer never reaches the exchange');
  assertNoHandoffRecords(profile, 'unowned transitions', before);
  passed('valid cancel, fence and release without a retained entry change no durable state and contact no owner');

  // F. Both admissions stay open and ordinary persistence still works.
  let after;
  await until(async () => {
    after = await desktop.inspect();
    return after.turns === 0 && after.writes === 0 && after.admissions === 0 && after.uncontainedResources === 10;
  }, 'inventory settles after the refusals');
  assert.equal(desktop.admission.isClosed(), false);
  const { session } = await host.call('session.create', { title: 'Isolated source mutation fixture' });
  const { turnId } = await host.call('session.beginTurn', { sessionId: session.id });
  await host.call('session.saveInflightMessage', { sessionId: session.id, turnId,
    message: { id: 'refused-source-partial', role: 'assistant', content: 'retained reply',
      createdAt: '2026-11-09T00:00:00.000Z', status: 'streaming' } });
  await host.call('session.endTurn', { turnId, status: 'aborted', createNotification: false, recoverInflight: true });
  const detail = await host.call('session.get', { id: session.id });
  assert.equal(detail.session.messages[0].content, 'retained reply');
  assert.equal(detail.session.messages[0].status, 'aborted');
  const confirmedIdentity = await host.call('ownerHandoff.identity', { version: 1, requestId: randomUUID() });
  assert.equal(confirmedIdentity.sourceEpoch, IDENTITY.sourceEpoch, 'the original source epoch is unchanged');
  assert.equal(confirmedIdentity.profileId, IDENTITY.profileId);
  const stillBound = await native();
  assert.equal(stillBound.generation, ticket.generation, 'the bound generation is unchanged');
  assert.equal(stillBound.state, 'running');
  assert.equal(stillBound.confirmed, false);
  assertNoHandoffRecords(profile, 'after ordinary persistence', before);
  passed('both admissions stay open, the source epoch and bound generation are unchanged and ordinary session persistence still works');

  // G. Optional: a lost framed waiter must not commit, close or wedge the source.
  const heldBefore = { notifications: desktop.counts.notifications, completions: desktop.counts.completions };
  desktop.deferInspection();
  const abandoned = begin(profile, parseOwnerHandoffSourceRequest(request('prepare')));
  await until(() => desktop.counts.notifications === heldBefore.notifications + 1, 'lost waiter reaches the exchange');
  await until(() => desktop.counts.inspectionWaits >= 1, 'the real inventory for this exchange is still pending');
  await h.stop(abandoned.child, true);
  const abandonedExit = await abandoned.done;
  // Windows terminates the exact child handle; the close reports a code, and
  // no reply frame may exist because the waiter was gone before the exchange
  // finished.
  assert.notEqual(abandonedExit.exit.code, 0, 'the abandoned client was terminated on its exact handle');
  assert.equal(Buffer.concat(abandonedExit.chunks).length, 0, 'the abandoned client received no reply frame');
  desktop.releaseInspection();
  await until(() => desktop.counts.completions === heldBefore.completions + 1, 'lost waiter still completes');
  assert.equal(desktop.completions.at(-1).outcome.error.code, 'HANDOFF_BUSY');
  assert.equal(desktop.acks.at(-1).accepted, true);
  assertNoHandoffRecords(profile, 'lost waiter', before);
  assert.equal(desktop.admission.isClosed(), false);
  assert.equal(host.isAvailable(), true, 'the original Host survives a lost framed waiter');
  // The next request must reach the exchange again, proving the lost flight
  // settled instead of leaving the source permanently busy.
  await until(async () => {
    await source(profile, request('prepare'), 'HANDOFF_BUSY');
    return desktop.counts.notifications === heldBefore.notifications + 2;
  }, 'the next request reaches the exchange again', 20000);
  assertNoHandoffRecords(profile, 'after lost waiter', before);
  passed('a lost framed waiter commits nothing: the original source completes the exchange, keeps both admissions open and refuses the next request');
  report.status = 'PASS';
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  const cleanup = [];
  try { desktop?.dispose(); } catch (error) { cleanup.push(String(error)); }
  try {
    // Native closure is cleanup hygiene for this suite, never a scope claim.
    if (ticket && host?.isAvailable()) {
      const stop = await host.call('executionFence.stop', { generation: ticket.generation, timeoutMs: 2000 });
      report.nativeClosure = stop?.confirmed === true;
    }
  } catch (error) { cleanup.push(String(error)); }
  try { if (runner) { await h.stop(runner); await h.closed(runner); } } catch (error) { cleanup.push(String(error)); }
  try { if (host) { await host.dispose(); assert.equal(await host.confirmExit(), true); } } catch (error) { cleanup.push(String(error)); }
  const harnessClosed = await h.cleanup();
  report.cleanupConfirmed = harnessClosed && cleanup.length === 0;
  if (!report.cleanupConfirmed) { report.status = 'FAIL'; report.cleanupErrors = cleanup; }
  report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
