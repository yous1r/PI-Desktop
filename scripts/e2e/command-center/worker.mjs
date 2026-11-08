import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { AgentHost } from '../../../packages/agent-host/src/agent-host.ts';
import { HostProcess } from '../../../packages/host-runtime/src/host-process.ts';
import { AgentSidecar } from '../../../packages/host-runtime/src/agent-sidecar.ts';
import { RuntimeService } from '../../../packages/host-runtime/src/runtime-service.ts';
import { createHostSessionPort, createHostQueueStore } from '../../../packages/host-runtime/src/host-ports.ts';
import { startProvider } from './provider.mjs';
import { runRound } from './run-round.mjs';

const config = JSON.parse(await readFile(process.env.P0_CONFIG_PATH, 'utf8'));
if (!process.send) throw new Error('Must run under the isolated baseline coordinator');
const send = message => { if (process.connected) process.send(message); };
const commands = new Map(), received = new Set();
process.on('message', message => { received.add(message?.kind); commands.get(message?.kind)?.(); });
const waitCommand = kind => received.has(kind) ? Promise.resolve() : new Promise(resolve => commands.set(kind, resolve));
let host, sidecar, runtime, provider, closing, normalExit = false;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    const failures = [];
    for (const release of [() => provider?.close(), () => sidecar?.dispose(), () => runtime?.dispose(), () => host?.dispose()]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Baseline cleanup failed');
  })();
  return closing;
}
process.once('disconnect', () => { if (!normalExit) void close().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { send({ kind: 'outcome', error: 'Worker deadline exceeded' }); void close().finally(() => process.exit(1)); }, config.deadlineMs);
const outcome = { completed: 0, verified: 0, inputVerified: 0, verifiedBeforeDispose: false, unexpectedEvents: 0, outputBytes: 0 };
const rounds = [];
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let telemetry;
const diagnostics = [];
const log = (level, message, detail) => { if (level !== 'info') { diagnostics.push({ level, message, detail }); if (diagnostics.length > 30) diagnostics.shift(); } };
const stderr = role => chunk => process.stderr.write(`[${role}] ${String(chunk).slice(-4000)}`);
try {
  const dataDir = join(config.runDir, 'data'); const projectPath = join(config.runDir, 'workspace');
  await mkdir(dataDir); await mkdir(projectPath);
  host = new HostProcess({ binaryPath: config.hostBin, dataDir, env: { PI_DESKTOP_DATA_DIR: dataDir }, onStderr: stderr('host') });
  await host.handshake();
  const commandShell = (await host.call('commandShells.list')).effective;
  assert.ok(commandShell?.available, 'Host must provide an available command shell');
  sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ['--max-old-space-size=2048', config.sidecarEntry],
    cwd: projectPath, env: { ...process.env, NODE_OPTIONS: '', PI_DESKTOP_DATA_DIR: dataDir } }, onStderr: stderr('sidecar') });
  sidecar.setHost(host);
  await sidecar.call('sidecar.configure', { hostBinary: config.hostBin, dataDir });
  const keys = Array.from({ length: config.sessions }, (_, i) => `session-${i}`);
  const openProvider = () => startProvider({ keys, ticks: config.ticks, intervalMs: config.intervalMs, contextBytes: config.contextBytes, contextKind: config.contextKind, deadlineMs: config.ticks * config.intervalMs + 90000 });
  provider = await openProvider();
  const providerConfig = { id: 'p0-fixture', name: 'P0 local fixture', modelId: 'p0-fixture', baseUrl: provider.baseUrl,
    apiKey: '', authKind: 'none', apiStyle: 'openai-chat', supportsReasoning: false, supportedThinkingLevels: ['off'],
    modelConfig: { source: 'generic', name: 'P0 fixture', baseUrl: provider.baseUrl, reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 32768 } };
  // Explicit fixture configuration avoids global HOME discovery on Windows.
  // Execution, history, admission and persistence still use production modules.
  const launch = { resolve: async sessionId => ({ providerId: 'p0-fixture', modelId: 'p0-fixture', projectPath,
    sidecarParams: { sessionId, mode: 'agent', provider: providerConfig, projectPath, workspaceRoot: projectPath, commandShell,
      scratchDir: join(dataDir, 'scratch', sessionId), thinkingLevel: 'off',
      projectInstructions: { entries: [{ source: 'P0 fixture', content: 'Deterministic local baseline. Do not invoke any tools.' }] }, projectMemory: '',
      pluginTools: [], pluginSkills: [], trustedExtensions: [], subagents: [], subagentProviders: {}, subagentModelKeys: [] } }) };
  runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, launch, log });
  const agent = new AgentHost({ runtime, sessions: createHostSessionPort(() => host), queueStore: createHostQueueStore(() => host),
    approvals: { resolveTool: async () => { throw new Error('Unexpected permission'); },
      resolveContract: async () => { throw new Error('Unexpected plan'); }, listPendingTools: async () => [] } });
  runtime.attachHost(host); runtime.attachSidecar(sidecar); await agent.start();
  const sessions = [];
  for (const key of keys) {
    const { session } = await host.call('session.create', { title: key, mode: 'agent', projectPath, permissionMode: 'ask' });
    sessions.push({ key, id: session.id });
  }
  const run = waitCommand('run'); send({ kind: 'ready' }); await run;
  const started = performance.now();
  outcome.loadStartedAt = Date.now();
  loopDelay.enable();
  telemetry = setInterval(() => {
    send({ kind: 'telemetry', timestampMs: Date.now(), elapsedMs: performance.now() - started,
      round: rounds.length + 1, pendingWrites: runtime.pendingWrites(),
      eventLoopP99Ms: loopDelay.percentile(99) / 1e6, eventLoopMaxMs: loopDelay.max / 1e6 });
    loopDelay.reset();
  }, 1000);
  do {
    const round = await runRound({ config, sessions, runtime, agent, host, provider });
    rounds.push(round); Object.assign(outcome, round);
    send({ kind: 'round', index: rounds.length, ...round });
    if (round.error) throw new Error(round.error);
    if (diagnostics.length) throw new Error('Runtime diagnostics during load');
    if (performance.now() - started >= config.durationSeconds * 1000) break;
    // Fixed context fixture: reset only verified synthetic history, using public
    // APIs. Services, event caches, Host and sidecar processes stay alive.
    await provider.close();
    for (const session of sessions) {
      assert.equal(runtime.isBusy(session.id), false);
      await sidecar.call('agent.disposeSession', { sessionId: session.id, reason: 'session-close' });
      sidecar.clearProjectInstructionRoot(session.id);
      await host.call('session.replaceMessages', { sessionId: session.id, messages: [] });
    }
    provider = await openProvider();
    providerConfig.baseUrl = provider.baseUrl;
    providerConfig.modelConfig.baseUrl = provider.baseUrl;
  } while (true);
  outcome.elapsedMs = performance.now() - started;
  outcome.loadEndedAt = Date.now();
  await runtime.dispose();
  runtime = undefined;
} catch (error) {
  outcome.error = String(error.message ?? error);
  process.stderr.write(`${error.stack ?? error}\n`);
} finally {
  clearInterval(telemetry); loopDelay.disable();
  outcome.rounds = rounds;
  outcome.fixture = provider?.stats;
  outcome.diagnostics = diagnostics;
  const release = waitCommand('release'); send({ kind: 'outcome', ...outcome });
  await release;
  try { await close(); } catch (error) { send({ kind: 'cleanup-error', message: String(error) }); process.exitCode = 1; }
  send({ kind: 'disposed' });
  await waitCommand('disconnect');
  clearTimeout(deadline); normalExit = true; process.disconnect();
}
