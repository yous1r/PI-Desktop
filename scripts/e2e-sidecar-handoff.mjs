#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSidecarHandoff } from './e2e/sidecar-handoff-build.mjs';

assert.equal(process.platform, 'win32', 'Windows native execution fence required');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'sidecar-handoff-'));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), checks: [], cleanupConfirmed: false,
  scope: 'Real sidecar private quiescence and native closure; not complete Desktop ownership transfer' };
Object.assign(report, await buildSidecarHandoff(root, directory));
const { HostProcess } = await import(pathToFileURL(join(directory, 'host-process.mjs')));
const { AgentSidecar } = await import(pathToFileURL(join(directory, 'agent-sidecar.mjs')));
const { SidecarHandoffClient } = await import(pathToFileURL(join(directory, 'sidecar-handoff-client.mjs')));
for (const name of ['profile', 'workspace', 'home', 'temp', 'appdata']) await mkdir(join(directory, name));
const profile = join(directory, 'profile'), workspace = join(directory, 'workspace');
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) env[key] = process.env[key];
Object.assign(env, { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), TEMP: join(directory, 'temp'),
  TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'), PI_DESKTOP_DATA_DIR: profile, RUST_LOG: 'error' });
let host, sidecar, server, finishStream, releaseRestore;
let providerRequests = 0;
const stderr = text => process.stderr.write(String(text).slice(-4000));
const identity = () => ({ version: 1, transferId: randomUUID(), sourceEpoch: randomUUID(), revision: 1 });
const errorCode = error => error?.errorCode ?? error?.data?.errorCode;
async function bounded(promise, label, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function closeSidecar() {
  if (!sidecar) return;
  assert.equal(await sidecar.fenceExecution(), true, 'native family exit');
  assert.equal(await sidecar.confirmExit(), true, 'original launcher exit');
  await sidecar.dispose();
  sidecar = undefined;
}
try {
  host = new HostProcess({ binaryPath: binary, dataDir: profile, executionFence: true, env, onStderr: stderr });
  await host.handshake();
  const commandShell = (await host.call('commandShells.list')).effective;
  assert.equal(commandShell.available, true);
  const { session } = await host.call('session.create', { title: 'Sidecar handoff', mode: 'agent', permissionMode: 'ask', projectPath: workspace });
  const spawnSidecar = async () => {
    sidecar = await AgentSidecar.createFenced({ host, binaryPath: binary,
      launch: { command: process.execPath, args: [join(directory, 'sidecar.mjs')], cwd: workspace, env }, onStderr: stderr });
    const health = await sidecar.call('sidecar.health', {}, 30000);
    assert.equal(health.capabilities.idleHandoff, 1);
  };
  await spawnSidecar();
  const firstIdentity = identity();
  const client = new SidecarHandoffClient(sidecar, firstIdentity);
  await assert.rejects(client.status(), error => errorCode(error) === 'HANDOFF_STALE');
  await assert.rejects(sidecar.call('sidecar.handoff', { ...firstIdentity, operation: 'acquire', pid: 1 }), error => errorCode(error) === 'HANDOFF_INVALID_REQUEST');
  const held = await client.acquire();
  assert.deepEqual(await client.status(), held);
  for (const method of ['agent.prompt', 'agent.steer', 'extensions.command.prepare', 'native.session.list', 'sidecar.configure', 'future.mutation', 'agent.shutdown']) {
    await assert.rejects(sidecar.call(method, {}), error => errorCode(error) === 'HANDOFF_BUSY');
  }
  assert.equal((await sidecar.call('sidecar.health')).capabilities.idleHandoff, 1);
  assert.equal((await client.cancel(held.holdId)).state, 'cancelled');
  report.checks.push('strict identity-bound acquisition; lost-reply status; held RPC families blocked; explicit cancellation');

  const providerStarted = Promise.withResolvers();
  server = createServer((req, res) => {
    providerRequests += 1;
    req.resume();
    req.once('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: 'assistant' });
      finishStream = () => { chunk({ content: 'Handoff fixture response.' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); finishStream = undefined; };
      providerStarted.resolve();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const params = { sessionId: session.id, mode: 'agent', commandShell, projectPath: workspace, workspaceRoot: workspace,
    thinkingLevel: 'off', pluginTools: [], pluginSkills: [], trustedExtensions: [], subagents: [],
    projectInstructions: { entries: [{ source: 'fixture', content: 'Answer with one short sentence. Do not call tools.' }] },
    provider: { id: 'fixture', name: 'Fixture', modelId: 'fixture', apiKey: '', authKind: 'none', apiStyle: 'openai-chat', baseUrl,
      supportsReasoning: false, supportedThinkingLevels: ['off'], modelConfig: { source: 'generic', name: 'Fixture', baseUrl,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } } };
  const restoreEntered = Promise.withResolvers();
  const restore = Promise.withResolvers(); releaseRestore = restore.resolve;
  let blockRestore = true;
  sidecar.setHost({
    call: async (method, input) => {
      if (method === 'session.get' && blockRestore) { blockRestore = false; restoreEntered.resolve(); await restore.promise; }
      return host.call(method, input);
    },
    onNotification: callback => host.onNotification(callback), onExit: callback => host.onExit(callback),
  });
  const preparing = sidecar.call('extensions.command.prepare', params, 30000);
  await bounded(restoreEntered.promise, 'runtime history request');
  await assert.rejects(client.acquire(), error => errorCode(error) === 'HANDOFF_BUSY');
  restore.resolve(); await preparing; releaseRestore = undefined;
  assert.equal(providerRequests, 0);
  report.checks.push('runtime initialization and reverse Host requests stay busy before runtime registration');

  const terminal = Promise.withResolvers();
  const detachEvents = sidecar.onNotification((method, envelope) => {
    if (method !== 'agent.event') return;
    if (envelope.event.type === 'agent_end') terminal.resolve(envelope);
    if (envelope.event.type === 'error') terminal.reject(new Error(`runtime error: ${envelope.event.error.code}`));
  });
  const turnId = (await host.call('session.beginTurn', { sessionId: session.id, providerId: 'fixture', modelId: 'fixture' })).turnId;
  const started = await sidecar.call('agent.prompt', { ...params, turnId, content: 'Reply once.', userMessageId: randomUUID() }, 30000);
  assert.equal(started.accepted, true);
  await bounded(providerStarted.promise, 'local provider stream');
  await assert.rejects(client.acquire(), error => errorCode(error) === 'HANDOFF_BUSY');
  assert.equal(providerRequests, 1);
  finishStream(); await bounded(terminal.promise, 'runtime completion'); detachEvents();
  await host.call('session.endTurn', { turnId, status: 'completed', createNotification: false });
  // The terminal event can precede async runtime cleanup; retry only explicit
  // busy refusals, never a timeout or a transmitted request with unknown result.
  let idleHold;
  const deadline = Date.now() + 15000;
  while (!idleHold) {
    try { idleHold = await client.acquire(); } catch (error) {
      if (errorCode(error) !== 'HANDOFF_BUSY' || Date.now() > deadline) throw error;
      await new Promise(resolveIdle => setTimeout(resolveIdle, 10));
    }
  }
  assert.equal(Object.values(idleHold.counts).every(count => count === 0), true);
  report.checks.push('real runtime and controlled local model stream refuse idle transfer until execution and cleanup end');
  assert.equal((await client.seal(idleHold.holdId)).state, 'sealed');
  await assert.rejects(client.cancel(idleHold.holdId), error => errorCode(error) === 'HANDOFF_BUSY');
  await assert.rejects(sidecar.call('agent.prompt', params), error => errorCode(error) === 'HANDOFF_BUSY');
  assert.equal(providerRequests, 1);
  assert.equal((await sidecar.call('agent.shutdown', {}, 10000)).ok, true);
  await closeSidecar();
  report.checks.push('sealed source cannot cancel or start a second model request; shutdown plus original-handle and native Job closure confirmed');

  await spawnSidecar();
  const nativeClient = new SidecarHandoffClient(sidecar, identity());
  await sidecar.call('native.session.list', { projectPaths: [workspace] }, 30000);
  await assert.rejects(nativeClient.acquire(), error => errorCode(error) === 'HANDOFF_BUSY');
  await closeSidecar();
  report.checks.push('initialized native-session service refuses unqualified handoff, even with no running model');
  report.providerRequests = providerRequests;
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  releaseRestore?.(); finishStream?.();
  const cleanup = [];
  try { await closeSidecar(); } catch (error) { cleanup.push(String(error)); }
  try { if (host) { await host.dispose(); assert.equal(await host.confirmExit(), true); } } catch (error) { cleanup.push(String(error)); }
  try { if (server) { server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); } } catch (error) { cleanup.push(String(error)); }
  report.cleanupConfirmed = cleanup.length === 0;
  if (cleanup.length) { report.status = 'FAIL'; report.cleanupErrors = cleanup; }
  report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS' || !report.cleanupConfirmed) process.exitCode = 1;
}
