#!/usr/bin/env node
// P0 runtime baseline only. Never attaches to the user's app or uses provider secrets.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { cpus, totalmem, release } from 'node:os';
import { parseOptions, assessRun } from './e2e/command-center/report.mjs';
import { buildCandidate } from './e2e/command-center/build.mjs';
import { observeExit } from './e2e/command-center/lifecycle.mjs';
import { assessSoak } from './e2e/command-center/soak-report.mjs';
import { hasPostOutcomeSample } from './e2e/command-center/sampling-coverage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2));
if (options.help) {
  console.log('node scripts/e2e-command-center-baseline.mjs --host-bin <candidate.exe> --scratch-dir <directory> [--sessions 1..36] [--ticks 2..600] [--interval-ms 20..1000] [--context-bytes 0..1048576] [--context-kind ascii|utf8] [--budget-bytes N] [--target-bytes N] [--duration-seconds 0..3600] [--sample-ms 100..1000]');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('This baseline collector currently requires Windows Private Bytes; no processes started.');
const scratch = options.scratchDir ?? process.env.PI_SCRATCH_DIR;
const hostSource = options.hostBin ?? process.env.PI_DESKTOP_HOST_BIN;
if (!scratch || !hostSource) throw new Error('Explicit scratch directory and candidate Host binary are required.');
if (!(await stat(resolve(scratch))).isDirectory()) throw new Error('Invalid scratch directory');
const runDir = await mkdtemp(join(resolve(scratch), `command-center-p0-${options.sessions}-`));
console.log(`P0 artifacts: ${runDir}`);
const writeJson = (name, data) => writeFile(join(runDir, name), JSON.stringify(data, null, 2) + '\n');
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
let metadata;
try {
  metadata = { head: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
    dirty: git('status', '--porcelain').length > 0, recordedAt: new Date().toISOString(),
    platform: process.platform, osRelease: release(), node: process.version,
    cpus: cpus().length, totalMemoryBytes: totalmem() };
  execFileSync('git', ['merge-base', '--is-ancestor', metadata.base, 'HEAD'], { cwd: root });
  if (!(await stat(resolve(hostSource))).isFile()) throw new Error('Invalid Host binary');
  const hostBin = join(runDir, 'pi-desktop-host-core.exe');
  await copyFile(resolve(hostSource), hostBin);
  metadata.hostBinarySha256 = createHash('sha256').update(await readFile(hostBin)).digest('hex');
  const bundle = await buildCandidate(root, runDir);
  Object.assign(metadata, { inputsSha256: bundle.inputsSha256 });
  const config = { ...options, ...bundle, runDir, hostBin, deadlineMs: options.durationSeconds * 1000 + options.ticks * options.intervalMs + 180_000 };
  await writeJson('config.json', config);
  const report = await measure(config);
  await writeJson('report.json', { ...report, metadata });
  console.log(JSON.stringify({ status: report.status, failures: report.failures, sessions: options.sessions,
    peakPrivateBytes: report.memory.peakConcurrentBytes, maxSampleGapMs: report.memory.maxGapMs,
    overlapMs: report.outcome?.fixture?.overlapMs, verified: report.outcome?.verified, report: join(runDir, 'report.json') }));
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  await writeJson('report.json', { status: 'FAIL', phase: 'preparation-or-harness', fullWorkbenchAcceptance: 'NOT_RUN',
    metadata, options, error: String(error.message ?? error) });
  console.error(String(error.stack ?? error)); process.exitCode = 1;
}

async function measure(config) {
  await mkdir(join(runDir, 'home'));
  await mkdir(join(runDir, 'temp'));
  await mkdir(join(runDir, 'appdata'));
  // Allowlist environment: no inherited model keys, NODE_OPTIONS or proxy credentials.
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','windir','ComSpec','PATHEXT','PROGRAMFILES','ProgramFiles','PROGRAMFILES(X86)','ProgramFiles(x86)']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { USERPROFILE: join(runDir, 'home'), HOME: join(runDir, 'home'),
    TEMP: join(runDir, 'temp'), TMP: join(runDir, 'temp'), APPDATA: join(runDir, 'appdata'), LOCALAPPDATA: join(runDir, 'appdata'),
    P0_CONFIG_PATH: join(runDir, 'config.json'), P0_HOST_BINARY: config.hostBin, P0_SIDECAR_ENTRY: config.sidecarEntry,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost', RUST_LOG: 'error' });
  const worker = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'scripts/e2e/command-center/process-observer.mjs')).href, config.workerEntry],
    { cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let workerTail = '', collectorTail = '', collector, collectorExit, outcome, collectingFailure, stopping = false;
  const inventory = [{ role: 'coordinator', pid: worker.pid }], samples = [], messages = [], wakeups = new Set();
  const telemetry = [], rounds = [];
  let lastLive = 0, peakBytes = 0;
  const notify = () => { for (const wake of [...wakeups]) wake(); };
  const fail = error => { collectingFailure ??= error; notify(); };
  const workerExit = observeExit(worker, fail).then(result => { messages.push({ kind: 'exit', ...result }); notify(); return result; });
  worker.stdout.resume(); worker.stderr.on('data', chunk => { workerTail = (workerTail + chunk).slice(-10000); });
  worker.on('message', message => {
    if (message.kind === 'telemetry') { telemetry.push(message); appendFileSync(join(runDir, 'telemetry.ndjson'), JSON.stringify(message) + '\n'); return; }
    if (message.kind === 'round') { rounds.push(message); appendFileSync(join(runDir, 'rounds.ndjson'), JSON.stringify(message) + '\n'); console.log(JSON.stringify({ kind: 'round', index: message.index, verified: message.verified, durationMs: message.durationMs, error: message.error })); return; }
    messages.push(message);
    if (message.kind === 'owned-process') inventory.push({ role: message.role, pid: message.pid });
    if (message.kind === 'outcome') outcome = { ...message, measurementEndedAt: Date.now() };
    if (message.kind === 'cleanup-error') fail(new Error(message.message));
    if (message.kind === 'owned-process-exit' && !stopping) fail(new Error(`${message.role} exited before cleanup`));
    if (stopping && ['disposed', 'owned-process-exit'].includes(message.kind)
      && messages.some(m => m.kind === 'disposed')
      && inventory.filter(p => p.role !== 'coordinator').every(p => messages.some(m => m.kind === 'owned-process-exit' && m.pid === p.pid))) send('disconnect');
    notify();
  });
  const send = kind => { if (worker.connected) worker.send({ kind }, error => { if (error) fail(error); }); };
  const interrupted = () => fail(new Error('Baseline interrupted'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  function until(predicate, label, timeoutMs = config.deadlineMs) {
    return new Promise((resolveWait, reject) => {
      const finish = error => { clearTimeout(timer); wakeups.delete(check); error ? reject(error) : resolveWait(); };
      const check = () => {
        if (collectingFailure) return finish(collectingFailure);
        if (predicate()) return finish();
        if (messages.some(m => m.kind === 'exit')) return finish(new Error(`Worker exited before ${label}`));
      };
      const timer = setTimeout(() => finish(new Error(`Deadline: ${label}`)), timeoutMs);
      wakeups.add(check); check();
    });
  }
  const stopFile = join(runDir, 'stop-sampler');
  async function terminateOwned() {
    stopping = true;
    // Finish sampling while the measured processes still exist.
    if (collector) {
      try { await writeFile(stopFile, 'stop'); } catch (error) { fail(error); }
      const timer = setTimeout(() => { fail(new Error('Sampler forced cleanup')); collector.kill(); }, 3000);
      const result = await collectorExit; clearTimeout(timer);
      if (result.code !== 0) fail(new Error(`Sampler cleanup failed: ${result.error ?? result.code}`));
    }
    send('release');
    const timer = setTimeout(() => {
      // Only this test's still-running process tree, never a name-based system kill.
      if (worker.exitCode === null && worker.signalCode === null && worker.pid) {
        fail(new Error('Worker forced cleanup'));
        try { execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); }
        catch { worker.kill(); }
      }
    }, 8000);
    const result = await workerExit; clearTimeout(timer);
    if (result.code !== 0) fail(new Error(`Worker cleanup failed: ${result.error ?? result.code}`));
    for (const child of inventory.filter(p => p.role !== 'coordinator')) {
      if (!messages.some(m => m.kind === 'owned-process-exit' && m.pid === child.pid)) fail(new Error(`Missing exit confirmation: ${child.role}`));
    }
  }
  try {
    await until(() => messages.some(m => m.kind === 'ready') || outcome, 'worker ready');
    if (outcome) throw new Error(outcome.error ?? 'Worker ended before load');
    if (inventory.length !== 3 || new Set(inventory.map(p => p.role)).size !== 3) throw new Error('Unexpected process inventory');
    await writeJson('sampler.json', { processes: inventory, stopFile, deadlineMs: config.deadlineMs, sampleMs: config.sampleMs });
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    collector = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/e2e/command-center/sample-processes.ps1'), '-ConfigPath', join(runDir, 'sampler.json')],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    collectorExit = observeExit(collector, fail).then(result => {
      if (!stopping) fail(new Error(`Sampler exited early: ${result.code}`));
      return result;
    });
    collector.stderr.on('data', chunk => { collectorTail = (collectorTail + chunk).slice(-5000); });
    createInterface({ input: collector.stdout }).on('line', line => {
      try {
        if (samples.length >= 60000) throw new Error('Sample limit exceeded');
        const sample = JSON.parse(line.replace(/^\uFEFF/, ''));
        samples.push(sample);
        appendFileSync(join(runDir, 'memory.ndjson'), JSON.stringify(sample) + '\n');
        const total = sample.processes.reduce((sum, p) => sum + (p.privateBytes ?? 0), 0);
        peakBytes = Math.max(peakBytes, total);
        if (total > config.budgetBytes) throw new Error(`Memory hard limit exceeded: ${total} > ${config.budgetBytes}`);
        if (sample.processes.some(p => p.missing)) throw new Error('Measured process missing');
        if (sample.timestampMs - lastLive >= 5000) {
          lastLive = sample.timestampMs;
          writeFileSync(join(runDir, 'live.json'), JSON.stringify({ status: 'RUNNING', timestampMs: sample.timestampMs,
            privateBytes: total, peakPrivateBytes: peakBytes, targetExceeded: peakBytes > config.targetBytes,
            completedRounds: rounds.length, sampleCount: samples.length, telemetry: telemetry.at(-1) }, null, 2));
        }
      } catch (error) { fail(error); }
      notify();
    });
    await until(() => samples.length >= 2, 'memory baseline', 15000);
    send('run');
    await until(() => Boolean(outcome), 'runtime completion');
    // The provider can finish before transcript verification and runtime disposal.
    // Wait for a fresh sample after the worker's final result, while all PIDs live.
    await until(() => hasPostOutcomeSample(samples.at(-1), outcome), 'final memory sample', 3000);
  } catch (error) {
    outcome = { ...(outcome ?? {}), error: outcome?.error ?? String(error.message ?? error) };
  } finally {
    await terminateOwned();
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
  if (collectingFailure) outcome = { ...(outcome ?? {}), error: outcome?.error ?? String(collectingFailure.message), cleanupError: String(collectingFailure.message) };
  await writeFile(join(runDir, 'worker-stderr.log'), workerTail);
  await writeFile(join(runDir, 'collector-stderr.log'), collectorTail);
  const assessed = config.durationSeconds ? assessSoak({ config, inventory, samples, outcome, rounds, telemetry }) : assessRun({ config, inventory, samples, outcome });
  await writeJson('live.json', { status: assessed.status, peakPrivateBytes: peakBytes, completedRounds: rounds.length, error: outcome?.error });
  return { ...assessed, inventory, outcome,
    exits: messages.filter(m => ['owned-process-exit', 'exit'].includes(m.kind)), cleanupConfirmed: !collectingFailure };
}
