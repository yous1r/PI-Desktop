#!/usr/bin/env node
/** Actual isolated Desktop journey; requires built candidate/plugin and verified upstream. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { pack } from '../../../packages/plugin-devkit/dist/pack.js';
import { connectControl, connectRenderer } from './e2e/plugin-ui-slots/clients.mjs';
import { eventually, upstreamFixture } from './helpers/ai-memory-upstream.mjs';
import { connectPanel, freePort, isolatedEnvironment, modelFixture, processFixture, saveEvidence, seedHost, sha256 } from './helpers/ai-memory-desktop-fixture.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR required');
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'ai-memory-desktop-'));
const desktop = join(repository, 'apps', 'desktop');
const plugin = join(repository, 'examples', 'plugins', 'ai-memory', 'dist');
const hostBinary = resolve(process.env.PI_DESKTOP_HOST_BIN ?? join(repository, 'target', 'debug', 'pi-desktop-host-core.exe'));
const electronBinary = resolve(process.env.AI_MEMORY_TEST_ELECTRON ?? join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'));
const binaryRoot = process.env.AI_MEMORY_TEST_BINARIES ?? join(process.env.PI_SCRATCH_DIR, 'aim');
const scope = { workspace: 'synthetic-desktop', project: 'desktop-project' };
const project = join(root, 'project').replaceAll('\\', '/'); await mkdir(project);
const cleanup = []; const evidence = { root, platform: process.platform, checks: [], limitations: [], stages: [] };
let model; let upstream; let app; let renderer; let panel; let control;
function check(name, actual, expected = true) {
  const passed = isDeepStrictEqual(actual, expected); evidence.checks.push({ name, passed, ...(passed ? {} : { actual, expected }) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
}
function stage(name) { evidence.stages.push(name); console.log(`STAGE ${name}`); }
async function invoke(channel, ...args) {
  const value = await renderer.run(async ({ channel, args }) => window.piDesktop.invoke(channel, ...args), { channel, args });
  if (value?.ok === false && value.error) throw new Error(`${channel}: ${JSON.stringify(value.error)}`);
  return value?.ok === true && 'data' in value ? value.data : value;
}
async function launch(env) {
  const cdpPort = await freePort(); const mcpPort = await freePort();
  app = processFixture(electronBinary, [`--user-data-dir=${join(root, 'profile')}`, `--remote-debugging-port=${cdpPort}`, desktop], {
    cwd: root, env: { ...env, PI_DESKTOP_HOST_BIN: hostBinary, PI_DESKTOP_MCP_CONTROL: '1', PI_DESKTOP_MCP_PORT: String(mcpPort) },
  }, cleanup);
  await eventually(async () => {
    if (app.child.exitCode !== null) throw new Error(`Electron exited: ${app.output()}`);
    try { const info = JSON.parse(await readFile(join(root, 'data', 'mcp-control.json'), 'utf8')); return info.active && new URL(info.url).port === String(mcpPort); } catch { return false; }
  }, Boolean, 'isolated Desktop control ready', 60000);
  await eventually(async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).ok; } catch { return false; } }, Boolean, 'CDP ready');
  renderer = await connectRenderer(cdpPort); const current = renderer; cleanup.push(async () => current.close());
  await renderer.until(() => !!window.piDesktop && !!document.querySelector('[data-nav="plugins"]'), null, 'Desktop shell ready', 30000);
  control = await connectControl(join(root, 'data'));
  const mcp = await invoke('pi-desktop/mcp/list'); assert.deepEqual(mcp.servers ?? [], [], 'No imported MCP server in isolated profile');
  return cdpPort;
}
async function promptTurn(sessionId, content) {
  const before = model.requests.length;
  const accepted = await control.tool('pi_agent_prompt', { sessionId, content }); assert.ok(accepted.turnId);
  await eventually(() => control.tool('pi_agent_status', { sessionId }), result => {
    const status = result.status ?? result; return status.currentTurnId === accepted.turnId && status.isRunning === false;
  }, 'model turn completed', 60000);
  await eventually(() => control.messages(sessionId), messages => {
    const at = messages.findLastIndex(item => item.role === 'user' && JSON.stringify(item).includes(content));
    return at >= 0 && messages.slice(at + 1).some(item => item.role === 'assistant' && JSON.stringify(item).includes('Synthetic Desktop answer.'));
  }, 'current assistant reply persisted');
  return model.requests.slice(before);
}
try {
  stage('isolation and package installation');
  const env = await isolatedEnvironment(root); model = await modelFixture(cleanup);
  upstream = await upstreamFixture({ after: callback => cleanup.push(callback) }, root, '3.3.3', binaryRoot);
  await upstream.tool('memory_write_page', { ...scope, path: 'notes/transactions.md', body: '# Synthetic durable fact\nTransaction boundaries preserve ownership.', create_only: true });
  const manifest = JSON.parse(await readFile(join(plugin, 'manifest.json'), 'utf8'));
  const packaged = await pack(plugin, { outDir: join(root, 'package') }); evidence.package = { sha256: packaged.shasum, bytes: packaged.byteLength };
  evidence.build = { desktopMain: await sha256(join(desktop, 'out', 'main', 'index.js')), pluginMain: await sha256(join(plugin, 'main.cjs')), host: await sha256(hostBinary) };
  const seeded = await seedHost({ root, hostBinary, env, packagePath: packaged.packagePath, permissions: manifest.permissions, modelUrl: model.url, cleanup });
  check('package installed by Rust Host', seeded.installed.plugin.source, 'installed');
  check('manifest permissions granted through Host', [...seeded.granted.permissions].sort(), [...manifest.permissions].sort());
  let cdpPort = await launch(env);
  check('installed plugin enabled in actual Desktop', (await invoke('pi-desktop/plugin/list')).plugins.find(item => item.id === manifest.id)?.enabled, true);
  stage('native connection settings and preload IPC');
  await renderer.run(() => document.querySelector('[data-nav="plugins"]').click());
  await renderer.until(() => {
    const row = [...document.querySelectorAll('article')].find(node => node.textContent?.includes('ai-memory'));
    const button = row?.querySelector('button[aria-label="Plugin settings"]'); if (!button) return false; button.click(); return true;
  }, null, 'plugin settings action');
  await renderer.until(() => [...document.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Add connection'), null, 'native connection settings visible');
  check('native connection settings opened', true);
  try { await invoke('pi-desktop/plugins/connections/list', { pluginId: manifest.id }); check('native UI list envelope accepted', true); }
  catch (error) { check('native UI list envelope accepted', false); evidence.limitations.push(error.message); }
  const { connection } = await invoke('pi-desktop/plugins/connections/save', { pluginId: manifest.id, label: 'Synthetic local memory', baseUrl: upstream.baseUrl,
    token: upstream.token, allowHttp: false, routes: [{ path: '/mcp', methods: ['POST'] }, { path: '/hook', methods: ['POST'] }] });
  check('native connection credential metadata', connection.hasCredential, true);
  check('native response excludes bearer', !JSON.stringify(connection).includes(upstream.token));
  check('native routes restricted', connection.routes.map(route => route.path).sort(), ['/hook', '/mcp']);
  await renderer.run(() => { const close = [...document.querySelectorAll('[role="dialog"] button')].find(node => node.getAttribute('aria-label')?.toLowerCase().includes('close')); if (close) close.click(); });
  stage('real plugin panel binding');
  evidence.openedProject = await invoke('pi-desktop/project/set', project);
  await invoke('pi-desktop/plugin/openPanel', manifest.id); panel = await connectPanel(cdpPort, cleanup);
  await eventually(() => panel.run(() => ({ path: document.getElementById('project-path')?.textContent, options: document.querySelectorAll('#connection option').length })), data => data.path?.replaceAll('\\', '/') === project && data.options === 1, 'panel workspace and connection');
  await panel.run(({ scope }) => {
    document.getElementById('workspace').value = scope.workspace; document.getElementById('project').value = scope.project;
    document.getElementById('mode').value = 'coexist'; document.getElementById('capture').checked = true;
    document.getElementById('prompts').checked = true; document.getElementById('toolArguments').checked = false;
    document.getElementById('toolResults').checked = true; document.getElementById('assistant').checked = false;
    document.getElementById('save').click();
  }, { scope });
  const status = await eventually(() => panel.run(() => window.pluginBridge.invoke('memory.status')), data => data.settings?.bindings?.some(item => item.workspace === scope.workspace && item.project === scope.project), 'confirmed panel settings');
  check('real panel confirmation received', panel.confirms.some(item => item.type === 'confirm')); check('coexist configured through panel', status.settings.mode, 'coexist'); evidence.initialStatus = status;
  await panel.run(() => window.pluginBridge.invoke('memory.probe'));
  evidence.probedStatus = await panel.run(() => window.pluginBridge.invoke('memory.status'));
  stage('actual model request and persisted transcript');
  const created = await control.tool('pi_session_create', { title: 'Synthetic memory Desktop E2E', projectPath: project, mode: 'agent' });
  const sessionId = created.session?.id ?? created.id; assert.ok(sessionId); evidence.session = created;
  const first = await promptTurn(sessionId, 'Recall transaction boundaries from project memory.');
  evidence.afterPromptStatus = await panel.run(() => window.pluginBridge.invoke('memory.status'));
  evidence.pluginRows = await invoke('pi-desktop/plugin/list');
  const recalled = JSON.stringify(first).includes('Transaction boundaries preserve ownership.');
  check('model receives real upstream page', recalled);
  check('sourced packet appears once', (JSON.stringify(first[0]).match(/ai-memory historical context v1:/g) ?? []).length, 1);
  check('packet excluded from transcript', !JSON.stringify(await control.messages(sessionId)).includes('ai-memory historical context v1:'));
  check('bearer excluded from model', !JSON.stringify(first).includes(upstream.token));
  check('no external memory tools imported', !JSON.stringify(first).includes('mcp_mem_'));
  const readState = async () => JSON.parse(await readFile(join(root, 'data', 'plugins', 'data', manifest.id, 'memory-v1', 'state-v1.json'), 'utf8'));
  let capture = false;
  try {
    const state = await eventually(readState, state => state.sessions?.some(item => item.desktopId === sessionId) && state.events?.length > 0, 'capture locally admitted', 10000);
    const remoteSession = state.sessions.find(item => item.desktopId === sessionId).id;
    const observations = await eventually(async () => { try { return await upstream.tool('memory_read_session_observations', { ...scope, session_id: remoteSession, limit: 200 }); } catch { return null; } }, value => JSON.stringify(value).includes('Recall transaction boundaries'), 'capture persisted upstream', 30000);
    capture = true; evidence.capture = { remoteSession, total: observations.total };
  } catch (error) { evidence.limitations.push(`Capture not verified: ${error.message}`); }
  check('capture persists through real owner connection', capture);
  stage('Desktop and upstream restart');
  panel.close(); renderer.close(); await app.stop(); await upstream.stop(); await upstream.start(); cdpPort = await launch(env);
  check('connection restored', (await invoke('pi-desktop/plugins/connections/list', { pluginId: manifest.id })).connections[0]?.id, connection.id);
  await invoke('pi-desktop/project/set', project);
  const restored = await promptTurn(sessionId, 'Resume transaction boundaries from durable memory.');
  check('restored model receives upstream memory', JSON.stringify(restored).includes('Transaction boundaries preserve ownership.'));
  check('restored request has one packet', (JSON.stringify(restored[0]).match(/ai-memory historical context v1:/g) ?? []).length, 1);
  stage('disable and uninstall');
  await invoke('pi-desktop/plugin/disable', manifest.id);
  const countBefore = (await upstream.tool('memory_status', scope)).counts.observations;
  const disabled = await promptTurn(sessionId, 'Synthetic disabled plugin sentinel.');
  check('disabled plugin omits recall', !JSON.stringify(disabled).includes('ai-memory historical context v1:'));
  check('disabled plugin stops observations', (await upstream.tool('memory_status', scope)).counts.observations, countBefore);
  await invoke('pi-desktop/plugin/uninstall', manifest.id);
  check('uninstalled plugin removed', !(await invoke('pi-desktop/plugin/list')).plugins.some(item => item.id === manifest.id));
  check('uninstall preserves upstream', (await upstream.tool('memory_read_page', { ...scope, path: 'notes/transactions.md' })).body.includes('Transaction boundaries preserve ownership.'));
  evidence.completed = true; evidence.captureVerified = capture;
} catch (error) {
  evidence.failure = error.stack ?? String(error); console.error(error);
  if (renderer) { try { evidence.rendererText = await renderer.run(() => document.body.innerText.slice(0, 12000)); } catch {} }
} finally {
  evidence.modelRequests = model?.requests ?? []; evidence.electronLog = app?.output() ?? '';
  for (const dispose of cleanup.reverse()) { try { await dispose(); } catch (error) { evidence.limitations.push(`Cleanup: ${error.message}`); } }
  await saveEvidence(root, evidence, [upstream?.token, 'synthetic-model-token']);
  process.exitCode = evidence.failure || evidence.checks.some(item => !item.passed) ? 1 : evidence.limitations.length ? 2 : 0;
  console.log(JSON.stringify({ root, passed: evidence.checks.filter(item => item.passed).length, total: evidence.checks.length, completed: evidence.completed ?? false, captureVerified: evidence.captureVerified ?? false, failure: evidence.failure?.split('\n')[0] }));
}
