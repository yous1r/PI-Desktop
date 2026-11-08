import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
register(new URL('./helpers/current-source-import-hooks.mjs', import.meta.url));
const { WorkspaceTerminalRouter } = await import('../electron/main/terminal/workspace-terminal-router.ts');
const { DesktopHandoffAdmission } = await import('../electron/main/runtime/handoff-admission.ts');
const { WorkspaceTerminalRegistry } = await import('../electron/main/terminal/workspace-terminal-registry.ts');

const deferred = () => Promise.withResolvers();
const closed = { errorCode: 'HOST_BUSY' };
const offline = { errorCode: 'TERMINAL_HOST_OFFLINE' };
const target = { sessionId: 'remote:host-a:session-a', tabId: 'tab' };
const create = router => router.create({ target, shellId: 'default', cols: 80, rows: 24 });
function fixture(t, request = async () => ({ ok: true }), registry) {
  const admission = new DesktopHandoffAdmission();
  const calls = [], clients = [];
  const makeClient = () => {
    const client = { state: () => 'connected', generation: () => 1,
      subscribe: () => () => {}, handleServerRequest: () => () => {},
      async request(method, input) {
        calls.push({ client, method, input });
        if (method === 'terminal/open') return { terminalId: 'backend', cols: 80, rows: 24, replay: '' };
        return request(method, input);
      } };
    clients.push(client);return client;
  };
  let client = makeClient();
  let loads = 0;
  const makeRouter = options => registry ? registry.create(options) : new WorkspaceTerminalRouter(options);
  const router = makeRouter({
    isAdmissionClosed: () => admission.isClosed(), getHost: () => null,
    currentWorkspacePath: () => null, remoteClient: () => client, emit() {},
    loadPty() { loads++;throw Error('Unexpected local terminal'); },
  });
  t.after(async () => { admission.dispose();await router.dispose(); });
  return { router, admission, calls, clients, loads: () => loads,
    replace: () => { client = makeClient();return client; } };
}

test('terminal public entries refuse a closed gate before lookup or initialization', async t => {
  const f = fixture(t);
  f.admission.dispose();
  for (const operation of [() => f.router.listShells(target), () => create(f.router),
    ...['write', 'resize', 'replay', 'buffer', 'close'].map(action => () => f.router.action(action, 'missing'))]) {
    await assert.rejects(operation(), closed);
  }
  assert.equal(f.calls.length, 0);assert.equal(f.loads(), 0);
  assert.deepEqual(f.router.getHandoffActivity(), { terminals: 0, uncontainedResources: 0 });
});

test('pending binding remains owned through disposal and cannot resurrect a catalog', async t => {
  const reply = deferred(), entered = deferred();
  const f = fixture(t, method => { assert.equal(method, 'session/get');entered.resolve();return reply.promise; });
  const pending = f.router.listShells(target);
  const rejected = assert.rejects(pending, offline);
  await entered.promise;
  let disposed = false;
  const disposal = f.router.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.ok(f.router.getHandoffActivity().terminals > 0);
  reply.resolve({ session: {} });await rejected;await disposal;
  assert.deepEqual(f.router.getHandoffActivity(), { terminals: 0, uncontainedResources: 0 });
  assert.equal(f.loads(), 0);
});

test('gate closure during session binding prevents terminal creation', async t => {
  const reply = deferred(), entered = deferred();
  const f = fixture(t, method => { assert.equal(method, 'session/get');entered.resolve();return reply.promise; });
  const pending = create(f.router);const rejected = assert.rejects(pending, closed);
  await entered.promise;f.admission.dispose();reply.resolve({ session: {} });await rejected;
  assert.equal(f.calls.filter(call => call.method === 'terminal/open').length, 0);
});

test('late create cleanup stays on the original remote connection after replacement', async t => {
  const reply = deferred(), entered = deferred();
  const f = fixture(t);
  const original = f.clients[0];
  original.request = async (method, input) => {
    f.calls.push({ client: original, method, input });
    if (method === 'terminal/open') { entered.resolve();return reply.promise; }
    return { ok: true };
  };
  const pending = create(f.router);const rejected = assert.rejects(pending, { errorCode: 'WORKSPACE_CHANGED' });
  await entered.promise;const replacement = f.replace();
  reply.resolve({ terminalId: 'late', cols: 80, rows: 24 });await rejected;
  assert.deepEqual(f.calls.filter(call => call.method === 'terminal/close').map(call => call.client), [original]);
  assert.equal(f.calls.filter(call => call.client === replacement).length, 0);
  assert.deepEqual(f.router.getHandoffActivity(), { terminals: 0, uncontainedResources: 1 });
});

test('a retired terminal cannot write through a replacement client', async t => {
  const f = fixture(t);const opened = await create(f.router);
  f.replace();
  await assert.rejects(f.router.action('write', opened.terminalId, { data: 'must-not-run' }), { errorCode: 'WORKSPACE_CHANGED' });
  assert.equal(f.calls.filter(call => call.method === 'terminal/input').length, 0);
});

test('disposal retains a late create and its original cleanup until both settle', async t => {
  const reply = deferred(), entered = deferred(), closeReply = deferred(), closing = deferred();
  const f = fixture(t), original = f.clients[0];
  original.request = async (method, input) => {
    f.calls.push({ client: original, method, input });
    if (method === 'terminal/open') { entered.resolve();return reply.promise; }
    if (method === 'terminal/close') { closing.resolve();return closeReply.promise; }
    return { ok: true };
  };
  const pending = create(f.router);const rejected = assert.rejects(pending, offline);
  await entered.promise;const disposal = f.router.dispose();
  reply.resolve({ terminalId: 'late', cols: 80, rows: 24 });await closing.promise;
  assert.ok(f.router.getHandoffActivity().terminals > 0);
  closeReply.resolve({ ok: true });await rejected;await disposal;
  assert.deepEqual(f.router.getHandoffActivity(), { terminals: 0, uncontainedResources: 1 });
});

for (const action of ['write', 'resize', 'replay', 'buffer']) test(`delayed ${action} binding cannot dispatch after admission closes`, async t => {
  const reply = deferred(), entered = deferred();let waiting = false;
  const f = fixture(t, method => {
    if (method === 'session/get' && waiting) { entered.resolve();return reply.promise; }
    return { ok: true };
  });
  const opened = await create(f.router);waiting = true;
  const pending = f.router.action(action, opened.terminalId, { data: 'must-not-run', cols: 90, rows: 30 });
  const rejected = assert.rejects(pending, closed);
  await entered.promise;f.admission.dispose();reply.resolve({ session: {} });await rejected;
  assert.equal(f.calls.filter(call => call.method === 'terminal/open').length, 1);
  assert.equal(f.calls.filter(call => ['terminal/input', 'terminal/resize'].includes(call.method)).length, 0);
});

test('window retirement keeps pending ownership and compacts only settled refusal evidence', async t => {
  const registry = new WorkspaceTerminalRegistry();
  const reply = deferred(), entered = deferred();
  const f = fixture(t, async () => ({ ok: true }), registry), original = f.clients[0];
  original.request = async (method, input) => {
    f.calls.push({ client: original, method, input });
    if (method === 'terminal/open') { entered.resolve();return reply.promise; }
    return { ok: true };
  };
  const pending = create(f.router), rejected = assert.rejects(pending, offline);
  await entered.promise;
  const retiring = registry.retire(f.router);
  assert.equal(registry.retire(f.router), retiring);
  assert.ok(registry.getHandoffActivity().terminals > 0);
  assert.equal(registry.getHandoffActivity().uncontainedResources, 1);
  reply.resolve({ terminalId: 'late', cols: 80, rows: 24 });await rejected;await retiring;
  await registry.retire(f.router);
  assert.deepEqual(registry.getHandoffActivity(), { terminals: 0, uncontainedResources: 1 });
  const next = fixture(t, undefined, registry);await next.router.listShells(target);
  await registry.dispose();
  assert.deepEqual(registry.getHandoffActivity(), { terminals: 0, uncontainedResources: 1 });
  assert.throws(() => registry.create({}), offline);
});

test('unacknowledged creation retains refusal evidence after window retirement', async t => {
  const registry = new WorkspaceTerminalRegistry(), f = fixture(t, undefined, registry);
  f.clients[0].request = async method => {
    if (method === 'terminal/open') throw Object.assign(Error('lost reply'), { code: 'HOST_DISCONNECTED' });
    return { ok: true };
  };
  await assert.rejects(create(f.router), offline);
  await registry.retire(f.router);
  assert.deepEqual(registry.getHandoffActivity(), { terminals: 0, uncontainedResources: 1 });
});

test('failed close is observed and cannot turn retired resources into idle', async t => {
  const registry = new WorkspaceTerminalRegistry(), f = fixture(t, undefined, registry);
  const original = f.clients[0], messages = [];
  // The logger is the external diagnostic boundary; lifecycle owners stay real.
  t.mock.method(console, 'warn', message => messages.push(message));
  const opened = await create(f.router);
  original.request = async () => ({ ok: false });
  await assert.rejects(f.router.action('close', opened.terminalId), { errorCode: 'INVALID_RESPONSE' });
  assert.ok(f.router.getHandoffActivity().terminals > 0);
  await registry.retire(f.router);
  assert.equal(registry.getHandoffActivity().terminals, 0);
  assert.ok(registry.getHandoffActivity().uncontainedResources > 0);
  assert.ok(messages.some(message => message.includes('cleanup could not be confirmed')));
});

test('same-object connection restart is never used for late create cleanup', async t => {
  const reply = deferred(), entered = deferred(), f = fixture(t), original = f.clients[0];
  let generation = 1;
  original.generation = () => generation;
  t.mock.method(console, 'warn', () => {});
  original.request = async (method, input) => {
    f.calls.push({ client: original, method, input });
    if (method === 'terminal/open') { entered.resolve();return reply.promise; }
    return { ok: true };
  };
  const pending = create(f.router), rejected = assert.rejects(pending, { errorCode: 'WORKSPACE_CHANGED' });
  await entered.promise;generation++;
  reply.resolve({ terminalId: 'late', cols: 80, rows: 24 });await rejected;
  assert.equal(f.calls.filter(call => call.method === 'terminal/close').length, 0);
  assert.ok(f.router.getHandoffActivity().uncontainedResources > 0);
});

for (const change of ['gate', 'Host object', 'Host generation']) test(`local binding refuses a changed ${change} before loading PTY`, async t => {
  const reply = deferred(), entered = deferred(), admission = new DesktopHandoffAdmission();
  let loads = 0;
  let host = { generation: 'original', call: () => { entered.resolve();return reply.promise; } };
  const router = new WorkspaceTerminalRouter({ isAdmissionClosed: () => admission.isClosed(),
    getHost: () => host, currentWorkspacePath: () => process.cwd(), emit() {},
    remoteClient() { throw Error('Unexpected remote lookup'); }, loadPty() { loads++;throw Error('Unexpected PTY load'); } });
  t.after(async () => { admission.dispose();reply.resolve({ groups: [] });await router.dispose(); });
  const pending = router.listShells({ tabId: 'tab' });
  const rejected = assert.rejects(pending, { errorCode: change === 'gate' ? 'HOST_BUSY' : 'HOST_UNAVAILABLE' });
  await entered.promise;
  if (change === 'gate') admission.dispose();
  else if (change === 'Host object') host = { ...host };
  else host.generation = 'replacement';
  reply.resolve({ groups: [] });await rejected;
  assert.equal(loads, 0);
  assert.deepEqual(router.getHandoffActivity(), { terminals: 0, uncontainedResources: 0 });
});

test('workspace binding captures the exact connection across later Host reads', async t => {
  const reply = deferred(), entered = deferred(), f = fixture(t);
  const groups = [{ id: 'p', name: 'Remote', primaryPath: 'remote-project:p',
    roots: [{ path: 'remote-project:p', name: 'Remote', position: 0 }], remote: { hostKey: 'host-a', path: '/repo' } }];
  let reads = 0, client = f.clients[0];
  const host = { generation: 'original', async call() { if (++reads === 2) { entered.resolve();return reply.promise; }return { groups }; } };
  const router = new WorkspaceTerminalRouter({ isAdmissionClosed: () => false, getHost: () => host,
    currentWorkspacePath: () => 'remote-project:p', remoteClient: () => client, emit() {},
    loadPty() { throw Error('Unexpected local PTY'); } });
  t.after(async () => { reply.resolve({ groups });await router.dispose(); });
  const pending = router.create({ target: { tabId: 'tab' }, shellId: 'bash', cols: 80, rows: 24 });
  const rejected = assert.rejects(pending, { errorCode: 'WORKSPACE_CHANGED' });
  await entered.promise;client = f.replace();reply.resolve({ groups });await rejected;
  assert.equal(f.calls.length, 0);
});

test('concurrent replay results on the same owner do not close each other', async t => {
  const f = fixture(t), opened = await create(f.router), reply = deferred(), entered = deferred();
  let replays = 0;
  const original = f.clients[0];
  original.request = async (method, input) => {
    f.calls.push({ client: original, method, input });
    if (method === 'terminal/open') {
      if (++replays === 1) { entered.resolve();return reply.promise; }
      return { replay: 'c2Vjb25k' };
    }
    return { ok: true };
  };
  const first = f.router.action('replay', opened.terminalId);
  await entered.promise;
  assert.deepEqual(await f.router.action('replay', opened.terminalId), { data: 'c2Vjb25k' });
  reply.resolve({ replay: 'Zmlyc3Q=' });
  assert.deepEqual(await first, { data: 'Zmlyc3Q=' });
  assert.equal(f.calls.filter(call => call.method === 'terminal/close').length, 0);
});
