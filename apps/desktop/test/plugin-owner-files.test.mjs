import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { createOwnerFileReader } = await import('../electron/main/plugin-owner-files.ts');
const { PluginExtensionLaunchBindings } = await import('../electron/main/plugin-extension-launch-bindings.ts');

const input = (sessionId, signal = new AbortController().signal) => ({
  invocation: { id: 'invocation', pluginId: 'local.fixture', sessionId, toolName: 'extension:recall', signal },
  path: '.ai-memory.toml', rule: { root: 'workspace', scope: ['.ai-memory.toml'] }, isProtected: () => false,
});
test('owner preview follows each persistent session and its worktree instead of the visible cwd', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-owner-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree'), other = join(root, 'other');
  await Promise.all([mkdir(worktree), mkdir(other)]);
  await Promise.all([writeFile(join(root, '.ai-memory.toml'), 'project="primary"'),
    writeFile(join(worktree, '.ai-memory.toml'), 'project="worktree"'), writeFile(join(other, '.ai-memory.toml'), 'project="other"')]);
  const host = { call: async (method, params) => method === 'worktree.location' ? { path: worktree }
    : { session: params.id === 'first' ? { projectPath: root, worktree: {} } : { projectPath: other } } };
  const reader = createOwnerFileReader({ getHost: () => host, getRemote: () => null, isPluginActive: () => true });
  const [first, second] = await Promise.all([reader({ ...input('first'), workspacePath: root }), reader(input('second'))]);
  assert.equal(first.content, 'project="worktree"'); assert.equal(second.content, 'project="other"');
  await assert.rejects(reader({ ...input('first'), workspacePath: other }), { code: 'WORKSPACE_CHANGED' });
  for (const path of ['../.ai-memory.toml', '/absolute', '.env', '.git/config']) {
    await assert.rejects(reader({ ...input('first'), path }), /INVALID_ARGUMENT|PERMISSION_DENIED/);
  }
  await assert.rejects(reader({ ...input('first'), isProtected: () => true }), { code: 'PERMISSION_DENIED' });
});

test('remote owner preview uses the host binding and rejects cancellation, replacement and malformed responses', async () => {
  let project = 'remote-project:one'; let valid = true; let onRead = () => {};
  const host = { call: async () => ({ session: { projectPath: project, remoteWorkspace: { hostKey: 'ssh-one', path: '/srv/repo' } } }) };
  const remote = { workspacePluginFiles: async (hostKey, request) => {
    assert.equal(hostKey, 'ssh-one'); assert.equal(request.path, '/srv/repo');
    assert.deepEqual(request.scope, ['.ai-memory.toml']); onRead();
    return valid ? { kind: 'text', content: 'project="remote"', size: 16, mtimeMs: 0 } : { kind: 'text' };
  } };
  const reader = createOwnerFileReader({ getHost: () => host, getRemote: () => remote, isPluginActive: () => true });
  assert.equal((await reader(input('remote'))).content, 'project="remote"');
  valid = false; await assert.rejects(reader(input('remote')), { code: 'INVALID_RESPONSE' }); valid = true;
  onRead = () => { project = 'remote-project:two'; };
  await assert.rejects(reader(input('remote')), { code: 'WORKSPACE_CHANGED' });
  const abort = new AbortController(); onRead = () => abort.abort();
  await assert.rejects(reader(input('remote', abort.signal)), { name: 'AbortError' });
});

test('owner generation registration requires the exact Main launch and a retired predecessor', () => {
  const launches = new PluginExtensionLaunchBindings();
  const registration = { sessionId: 's', runtimeId: 'one', mode: 'agent', projectPath: '/repo', workspaceRoot: '/worktree', extensionIds: ['extension'] };
  assert.equal(launches.accept(registration), false);
  launches.observe('agent.prompt', { sessionId: 's', turnId: 't', mode: 'agent', projectPath: '/repo', workspaceRoot: '/worktree',
    provider: { apiKey: 'synthetic-private' }, trustedExtensions: [{ id: 'extension', ownerPluginId: 'local.fixture', ownerOperations: [{ name: 'recall', readOnly: true }] }] });
  assert.equal(JSON.stringify(launches.get('s')).includes('synthetic-private'), false);
  assert.equal(launches.accept({ ...registration, workspaceRoot: '/wrong' }), false);
  assert.equal(launches.accept(registration), true);
  assert.equal(launches.accept({ ...registration, runtimeId: 'two' }), false);
  launches.retire('s', 'one'); assert.equal(launches.accept({ ...registration, runtimeId: 'two' }), true);
  launches.close('s'); assert.equal(launches.accept(registration), false);
});
