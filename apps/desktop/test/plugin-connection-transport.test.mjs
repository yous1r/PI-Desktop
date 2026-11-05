import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { register } from 'node:module';
import { connect as tcpConnect, Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { createConnectionTransport } = await import('../electron/main/plugin-connection-transport.ts');
const { PluginConnectionService } = await import('../electron/main/plugin-connections.ts');
const fixtures = new URL('../../../scripts/e2e/fixtures/certificates/', import.meta.url);
const cert = await readFile(new URL('localhost-cert.pem', fixtures), 'utf8');
const key = await readFile(new URL('localhost-key.pem', fixtures), 'utf8');
async function fixture(t, handler) {
  const sockets = new Set(), calls = [];
  const server = createServer({ cert, key }, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
    if (handler) handler(req, res); else res.end('{"ok":true}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); });
  const routes = [];
  const transport = createConnectionTransport(async (host, port, signal) => {
    routes.push({ host, port }); const socket = tcpConnect({ host: '127.0.0.1', port, signal });
    await once(socket, 'connect', { signal }); return socket;
  });
  return { transport, calls, routes, url: `https://localhost:${server.address().port}` };
}

test('managed private CA sends authenticated POST through its supplied route without global TLS changes', async t => {
  const f = await fixture(t); const stored = new Map();
  const service = new PluginConnectionService({ transport: f.transport, assertGranted() {},
    store: { read: async id => stored.get(id) ?? null, write: async (id, value) => stored.set(id, value) } });
  const connection = await service.save({ pluginId: 'local.fixture', label: 'CA', baseUrl: f.url,
    caPem: cert, token: 'synthetic-fixture', allowHttp: false, routes: [{ path: '/mcp', methods: ['POST'] }] });
  const response = await service.request('local.fixture', { connectionId: connection.id,
    expectedRevision: 1, requestId: 'ca-test', path: '/mcp', method: 'POST', body: '{"query":"memory"}' });
  assert.equal(response.bodyText, '{"ok":true}');
  assert.deepEqual(f.calls, [{ method: 'POST', path: '/mcp', body: '{"query":"memory"}', auth: 'Bearer synthetic-fixture' }]);
  assert.equal(f.routes[0].host, 'localhost');
  await assert.rejects(f.transport(f.url.replace('localhost', '127.0.0.1') + '/mcp', { method: 'POST' }, cert), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal(f.calls.length, 1);
});

test('private CA bounds decompressed bodies and never follows redirects', async t => {
  let large = false;
  const f = await fixture(t, (_req, res) => {
    if (!large) { res.writeHead(302, { location: 'https://other.invalid' }); res.end(); }
    else { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('x'.repeat(1024 * 1024 + 1))); }
  });
  const response = await f.transport(f.url, { method: 'GET' }, cert);
  assert.equal(response.status, 302); assert.equal(f.calls.length, 1);
  large = true; await assert.rejects(f.transport(f.url, { method: 'GET' }, cert), { code: 'LIMIT_EXCEEDED' });
});

test('cancelled private CA requests close a late proxy tunnel', async () => {
  const pending = Promise.withResolvers(), abort = new AbortController();
  const transport = createConnectionTransport(() => pending.promise);
  const work = transport('https://localhost/mcp', { signal: abort.signal }, cert);
  abort.abort(); await assert.rejects(work, { name: 'AbortError' });
  const socket = new Socket(); pending.resolve(socket); await once(socket, 'close');
  assert.equal(socket.destroyed, true);
});

test('cancellation while a private CA response is incomplete closes the operation', async t => {
  const abort = new AbortController();
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('partial'); abort.abort(); });
  await assert.rejects(f.transport(f.url, { signal: abort.signal }, cert), { name: 'AbortError' });
});
