#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'Windows containment acceptance required');
assert.ok(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'handoff-admission-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { status: 'FAIL', candidate: git('rev-parse', 'HEAD'), base: git('rev-parse', 'origin/main'),
  dirty: git('status', '--porcelain').length > 0, binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), checks: [], cleanupConfirmed: false,
  scope: 'Production admission/runtime/transports with a deterministic contained sidecar; not full application handoff' };
const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
const entry = join(directory, 'candidate.mjs');
const result = await build({
  absWorkingDir: root,
  stdin: { contents: [
    "export {AgentHost, MaintenanceAdmission} from './packages/agent-host/src/index.ts';",
    ...['host-process', 'agent-sidecar', 'runtime-service', 'host-ports'].map(name => `export * from './packages/host-runtime/src/${name}.ts';`),
  ].join('\n'), resolveDir: root, loader: 'ts' },
  outfile: entry, bundle: true, format: 'esm', platform: 'node', metafile: true,
  alias: { '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts'), '@pi-desktop/agent-host': join(root, 'packages/agent-host/src/index.ts') },
  banner: { js: "import {createRequire as __require} from 'node:module'; const require=__require(import.meta.url);" }, logLevel: 'warning',
});
const inputs = [];
for (const input of Object.keys(result.metafile.inputs).filter(input => input !== '<stdin>').sort()) {
  inputs.push({ path: input.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(root, input))) });
}
await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
report.inputsSha256 = hash(JSON.stringify(inputs));
report.bundleSha256 = hash(await readFile(entry));
const { AgentHost, MaintenanceAdmission, HostProcess, AgentSidecar, RuntimeService, createHostSessionPort, createHostQueueStore } = await import(pathToFileURL(entry));
const profile = join(directory, 'profile');
const projectPath = join(directory, 'workspace');
for (const name of ['profile', 'workspace', 'home', 'temp', 'appdata']) await mkdir(join(directory, name));
// Only the fixture's child environment is overridden. No live profile discovery.
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) env[key] = process.env[key];
Object.assign(env, { USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'), TEMP: join(directory, 'temp'),
  TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'appdata'), RUST_LOG: 'error' });
env.PI_DESKTOP_DATA_DIR = profile;
const fixture = join(directory, 'fixture.mjs');
await writeFile(fixture, `import {createInterface} from 'node:readline';
let current, prompts=0;
const write=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line); let result;
 if(method==='agent.prompt'){current=params;prompts++;result={accepted:true,turnId:params.turnId};}
 else if(method==='fixture.stats')result={prompts,ticketLeaked:!!process.env.PI_EXECUTION_TICKET};
 else if(method==='fixture.complete' && current){
  const {sessionId,turnId}=current; current=undefined;
  const message={id:'reply-'+turnId,role:'assistant',content:'fixture response',createdAt:new Date().toISOString(),status:'complete'};
  for(const event of [{type:'message_end',message},{type:'agent_end',messageIds:[message.id]}])
   write({jsonrpc:'2.0',method:'agent.event',params:{sessionId,turnId,ts:Date.now(),event}});
  result={ok:true};
 } else {write({jsonrpc:'2.0',id,error:{code:-32601,message:'unsupported fixture operation'}});return;}
 write({jsonrpc:'2.0',id,result});
});
`);
const stderr = text => process.stderr.write(String(text).slice(-4000));
let host, sidecar, runtime, reopened;
let now = Date.now();
const gate = new MaintenanceAdmission(() => now);
async function bounded(promise, label, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function close() {
  const errors = [];
  gate.dispose();
  if (sidecar) {
    try { assert.equal(await sidecar.fenceExecution(), true); } catch (error) { errors.push(error); }
    try { await sidecar.dispose(); assert.equal(await sidecar.confirmExit(), true); } catch (error) { errors.push(error); }
  }
  try { await bounded(runtime?.dispose(), 'runtime cleanup'); } catch (error) { errors.push(error); }
  for (const process of [host, reopened]) if (process) {
    try { await process.dispose(); assert.equal(await process.confirmExit(), true); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'fixture cleanup unconfirmed');
}
try {
  host = new HostProcess({ binaryPath: binary, dataDir: profile, executionFence: true, env, onStderr: stderr });
  await host.handshake();
  sidecar = await AgentSidecar.createFenced({ host, binaryPath: binary,
    launch: { command: process.execPath, args: [fixture], env, cwd: projectPath }, onStderr: stderr });
  assert.deepEqual(await sidecar.call('fixture.stats'), { prompts: 0, ticketLeaked: false });
  const launch = { resolve: async sessionId => ({ providerId: 'fixture', modelId: 'fixture', projectPath,
    sidecarParams: { sessionId, mode: 'agent', provider: { id: 'fixture', name: 'Fixture', modelId: 'fixture',
      apiKey: '', supportsReasoning: false, supportedThinkingLevels: ['off'] } } }) };
  runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, launch,
    log: (level, message) => { if (level !== 'info') process.stderr.write(`${level}: ${message}\n`); } });
  const agent = new AgentHost({ runtime, gate, sessions: createHostSessionPort(() => host), queueStore: createHostQueueStore(() => host),
    approvals: { resolveTool: async () => { throw new Error('unexpected approval'); },
      resolveContract: async () => { throw new Error('unexpected plan'); }, listPendingTools: async () => [] } });
  runtime.attachHost(host); runtime.attachSidecar(sidecar); runtime.onEvent(envelope => agent.ingest(envelope));
  await agent.start();
  const { session } = await host.call('session.create', { title: 'Handoff admission fixture', mode: 'agent', projectPath, permissionMode: 'ask' });
  // Absent families are explicit for this isolated fixture only. Application adapters
  // must inventory their own live owners and cannot reuse this fixture declaration.
  const inspect = async () => {
    const a = agent.handoffBusyCounts(), r = runtime.handoffBusyCounts();
    return { clients: 0, turns: a.turns + r.turns, queuedTurns: a.queuedTurns, plans: 0, tools: r.tools,
      processes: 0, terminals: 0, plugins: 0, admissions: a.admissions + r.operations, finalizations: r.finalizations,
      writes: r.writes, children: 0, workers: 0, schedules: 0, approvals: a.approvals, inputs: a.inputs,
      nativeSessions: 0, mcp: 0, uncontainedResources: 0 };
  };
  const owner = { subject: 'fixture', roles: ['owner'], pairedDevice: true };
  const request = () => ({ sessionId: session.id, input: { text: 'fixture request' }, context: { requestId: randomUUID() } });
  const hold = await gate.acquireHandoff(randomUUID(), inspect);
  now += 10 * 120000;
  await assert.rejects(agent.startTurn(owner, request()), error => error.code === 'HOST_BUSY');
  await assert.rejects(agent.enqueueTurn(owner, request()), error => error.code === 'HOST_BUSY');
  assert.equal((await sidecar.call('fixture.stats')).prompts, 0);
  assert.equal((await host.call('session.get', { id: session.id })).session.messages.length, 0);
  report.checks.push('closed handoff admission outlives maintenance expiry; no prompt or transcript mutation');
  hold.cancel();
  await agent.startTurn(owner, request());
  await assert.rejects(gate.acquireHandoff(randomUUID(), inspect), error => error.code === 'HOST_BUSY');
  assert.equal(gate.isClosed(), false);
  assert.equal((await sidecar.call('fixture.stats')).prompts, 1);
  report.checks.push('explicit cancellation permits one user turn; active work refuses idle handoff');
  const ended = Promise.withResolvers();
  const detachEnded = runtime.onTurnEnded(info => ended.resolve(info));
  await sidecar.call('fixture.complete');
  const terminal = await bounded(ended.promise, 'durable turn settlement');
  detachEnded();
  assert.equal(terminal.settled, true);
  assert.deepEqual(runtime.handoffBusyCounts(), { turns: 0, operations: 0, finalizations: 0, writes: 0, tools: 0 });
  report.afterSettlement = await inspect();
  // Terminal persistence and the AgentHost's asynchronous queue drain are distinct.
  // Observe the owner's idle state rather than waiting an arbitrary fixed delay.
  const idleDeadline = Date.now() + 15000;
  while (Object.values(await inspect()).some(count => count !== 0)) {
    if (Date.now() >= idleDeadline) throw new Error(`owner remained busy: ${JSON.stringify(await inspect())}`);
    await new Promise(resolveIdle => setTimeout(resolveIdle, 10));
  }
  const next = await gate.acquireHandoff(randomUUID(), inspect);
  next.beginFencing();
  assert.throws(() => next.cancel(), error => error.code === 'HOST_BUSY');
  await assert.rejects(agent.startTurn(owner, request()), error => error.code === 'HOST_BUSY');
  assert.equal(await sidecar.fenceExecution(), true);
  assert.equal(await sidecar.confirmExit(), true);
  await sidecar.dispose(); sidecar = undefined;
  await runtime.dispose(); runtime = undefined;
  await host.dispose(); assert.equal(await host.confirmExit(), true); host = undefined;
  report.checks.push('settlement precedes fencing; sealed admission cannot reopen; native containment and original child exits confirmed');
  reopened = new HostProcess({ binaryPath: binary, dataDir: profile, env, onStderr: stderr });
  await reopened.handshake();
  const restored = (await reopened.call('session.get', { id: session.id })).session.messages;
  assert.deepEqual(restored.map(message => [message.role, message.content]), [['user', 'fixture request'], ['assistant', 'fixture response']]);
  report.checks.push('independent Host reopen preserves exact user/assistant history without launching a successor runtime');
  report.status = 'PASS';
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  try { await close(); report.cleanupConfirmed = true; } catch (error) { report.status = 'FAIL'; report.cleanupError = String(error); }
  report.report = join(directory, 'report.json');
  await writeFile(report.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS' || !report.cleanupConfirmed) process.exitCode = 1;
}
