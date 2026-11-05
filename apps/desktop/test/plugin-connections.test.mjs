import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { createServer } from 'node:http';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { PluginConnectionService } = await import('../electron/main/plugin-connections.ts');
const { normalizeConnectionBase, connectionRequestUrl } = await import('../electron/main/plugin-connection-policy.ts');

const TOKEN = 'synthetic-credential-27e950';
const definition = { pluginId: 'local.fixture', label: 'Fixture', baseUrl: 'https://memory.invalid/base', allowHttp: false, token: TOKEN, routes: [{ path: '/mcp', methods: ['POST'] }, { path: '/hook', methods: ['POST'] }] };
function fixture(transport) {
  const records = new Map(), audits = [];
  let granted = true;
  const service = new PluginConnectionService({
    store: { read: async key => records.get(key) ?? null, write: async (key, value) => { records.set(key, value); }, delete: async key => { records.delete(key); } },
    transport, assertGranted: () => { if (!granted) throw Object.assign(new Error('Permission revoked'), { code: 'PERMISSION_DENIED' }); },
    audit: value => audits.push(value),
  });
  return { service, records, audits, revoke: () => { granted = false; service.releasePlugin('local.fixture'); } };
}
const request = (connection, patch = {}) => ({ connectionId: connection.id, expectedRevision: connection.revision, requestId: 'request-1', path: '/mcp', method: 'POST', body: '{}', ...patch });

test('native save, plugin metadata, authenticated request, redaction, rotation and removal user path', async () => {
  const calls = [];
  const { service, audits } = fixture(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ echo: init.headers.authorization }), { headers: { 'mcp-session-id': 'transport-session', 'set-cookie': TOKEN, 'x-echo': TOKEN } });
  });
  const connection = await service.save(definition);
  assert.equal(connection.revision, 1);
  assert.equal(connection.hasCredential, true);
  assert.equal(JSON.stringify(await service.list(definition.pluginId)).includes(TOKEN), false);
  const result = await service.request(definition.pluginId, request(connection));
  assert.equal(calls[0].url, 'https://memory.invalid/base/mcp');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(result.headers['mcp-session-id'], 'transport-session');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.bodyText.includes(TOKEN), false);
  const rotated = await service.save({ ...definition, id: connection.id, expectedRevision: 1, token: 'new-synthetic-credential' });
  assert.equal(rotated.revision, 2);
  await assert.rejects(service.request(definition.pluginId, request(connection)), { code: 'CONNECTION_CHANGED' });
  await service.remove(definition.pluginId, connection.id);
  assert.deepEqual(await service.list(definition.pluginId), []);
  assert.equal(JSON.stringify(audits).includes(TOKEN), false);
});

test('scope, method, credential override and relative path boundaries are enforced before HTTP', async () => {
  let calls = 0;
  const { service } = fixture(async () => { calls++; return new Response('{}'); });
  const c = await service.save(definition);
  await assert.rejects(service.request('local.other', request(c)), { code: 'NOT_FOUND' });
  for (const path of ['/../mcp', '/%2e%2e/mcp', '/mcp%2f..', '//other/mcp', 'https://other/mcp', '/mcp\\x', '/mcp#fragment']) {
    await assert.rejects(service.request(definition.pluginId, request(c, { path })), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(service.request(definition.pluginId, request(c, { path: '/handoff' })), { code: 'PERMISSION_DENIED' });
  await assert.rejects(service.request(definition.pluginId, request(c, { method: 'GET' })), { code: 'PERMISSION_DENIED' });
  for (const header of ['Authorization', 'Host', 'Cookie', 'X-Forwarded-Host', 'Proxy-Authorization']) {
    await assert.rejects(service.request(definition.pluginId, request(c, { headers: { [header]: 'malicious' } })), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls, 0);
});

test('endpoint change needs re-entry; stale settings do not overwrite newer revision', async () => {
  const { service } = fixture();
  const c = await service.save(definition);
  await assert.rejects(service.save({ ...definition, id: c.id, baseUrl: 'https://other.invalid', token: undefined }), { code: 'CREDENTIAL_REQUIRED' });
  const same = await service.save({ ...definition, id: c.id, token: undefined });
  assert.equal(same.hasCredential, true);
  await assert.rejects(service.save({ ...definition, id: c.id, expectedRevision: 1 }), { code: 'CONFLICT' });
  assert.throws(() => normalizeConnectionBase('http://10.0.0.112:49374', false), { code: 'HTTP_CONSENT_REQUIRED' });
  assert.equal(normalizeConnectionBase('http://10.0.0.112:49374', true), 'http://10.0.0.112:49374');
  for (const host of ['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]']) {
    assert.throws(() => normalizeConnectionBase(`http://${host}`, true), { code: 'PERMISSION_DENIED' });
  }
  assert.throws(() => normalizeConnectionBase('https://user:pass@example.test', true));
  assert.equal(connectionRequestUrl('https://example.test/sub', '/mcp?project=a%2Fb').href, 'https://example.test/sub/mcp?project=a%2Fb');
});

test('redirect and oversized responses fail without exposing upstream error data', async () => {
  const a = fixture(async () => new Response('', { status: 307, headers: { location: 'https://evil.invalid' } }));
  const c = await a.service.save(definition);
  await assert.rejects(a.service.request(definition.pluginId, request(c)), { code: 'REDIRECT_DISALLOWED' });
  const b = fixture(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  const d = await b.service.save(definition);
  await assert.rejects(b.service.request(definition.pluginId, request(d)), { code: 'LIMIT_EXCEEDED' });
  const fail = fixture(async () => { throw new Error(`Bad request Bearer ${TOKEN}`); });
  const e = await fail.service.save(definition);
  await assert.rejects(fail.service.request(definition.pluginId, request(e)), error => error.code === 'CONNECTION_FAILED' && !error.message.includes(TOKEN));
});

test('cancel before admission, caller abort and unload abort pending requests', async () => {
  for (const action of ['cancel-first', 'caller', 'unload', 'rotate']) {
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = fixture(async (_url, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        if (init.signal.aborted) reject(init.signal.reason);
      });
    });
    const c = await f.service.save(definition);
    const abort = new AbortController();
    if (action === 'cancel-first') f.service.cancel(definition.pluginId, 'request-1');
    const pending = f.service.request(definition.pluginId, request(c), abort.signal);
    const rejected = assert.rejects(pending, { code: 'ABORTED' });
    if (action !== 'cancel-first') await ready;
    if (action === 'caller') abort.abort();
    if (action === 'unload') f.revoke();
    if (action === 'rotate') await f.service.save({ ...definition, id: c.id, token: 'rotated-token' });
    await rejected;
  }
});

test('unknown stored schema and corrupt state fail closed without overwriting', async () => {
  const f = fixture();
  f.records.set('secret:plugin-connections:local.fixture', '{"version":99,"connections":[]}');
  await assert.rejects(f.service.list(definition.pluginId), { code: 'STORAGE_INVALID' });
  await assert.rejects(f.service.save(definition), { code: 'STORAGE_INVALID' });
  assert.match(f.records.values().next().value, /99/);
});

test('actual local HTTP transport receives credential and base path, and response is bounded', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const f = fixture();
    const c = await f.service.save({ ...definition, baseUrl: `http://127.0.0.1:${server.address().port}/base` });
    const response = await f.service.request(definition.pluginId, request(c));
    assert.equal(response.status, 200);
    assert.deepEqual(received, [{ url: '/base/mcp', auth: `Bearer ${TOKEN}`, body: '{}' }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('unload preserves connections but uninstall revokes stored credentials before reinstall', async () => {
  const f = fixture(async () => new Response('{}'));
  const c = await f.service.save(definition);
  f.service.releasePlugin(definition.pluginId);
  assert.equal((await f.service.list(definition.pluginId)).length, 1);
  f.revoke();
  await f.service.uninstall(definition.pluginId);
  assert.equal(f.records.has('secret:plugin-connections:local.fixture'), false);
  const reinstalled = new PluginConnectionService({
    store: { read: async key => f.records.get(key) ?? null, write: async () => {}, delete: async () => {} },
    assertGranted() {},
  });
  assert.deepEqual(await reinstalled.list(definition.pluginId), []);
  await assert.rejects(reinstalled.request(definition.pluginId, request(c)), { code: 'NOT_FOUND' });
});
