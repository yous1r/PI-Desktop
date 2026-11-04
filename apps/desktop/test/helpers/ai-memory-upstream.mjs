import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const upstreamHashes = {
  '3.3.2': 'a20f08b9efef1f5e8635373eca44b9d59eb36d899097e3634e409c109c59414b',
  '3.3.3': '0fcf2490d707041a503b2c92876640b7706ef464156e2135a84b719688a541ff',
};

/** Poll an observable condition; every attempt performs the actual read. */
export async function eventually(read, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(last).slice(0, 2000)}`);
}

/** Official binaries only, isolated data/config, no model credentials or watchers. */
export async function upstreamFixture(t, root, version, binaryRoot, stateful = false) {
  const binary = join(binaryRoot, `bin-v${version}`, 'ai-memory.exe');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), upstreamHashes[version]);
  const directory = join(root, `upstream-${version}`);
  await mkdir(directory, { recursive: true });
  const token = 'synthetic-ai-memory-integration-only';
  const config = join(directory, 'config.toml');
  await writeFile(config, `embedding_provider = "none"\nlog_level = "warn"\n[auth]\nbearer_token = "${token}"\n[maintenance]\nenabled = false\n[auto_improve.scheduler]\nenabled = false\n`);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['systemroot', 'windir', 'path', 'pathext', 'comspec', 'systemdrive', 'processor_architecture'].includes(name.toLowerCase())));
  const home = join(directory, 'profile'); await mkdir(home, { recursive: true });
  Object.assign(env, { USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
    XDG_CONFIG_HOME: home, NO_PROXY: '127.0.0.1,localhost' });
  let child; let logs = ''; let session; let id = 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const requests = [];
  async function start() {
    session = undefined;
    child = spawn(binary, ['--config', config, '--data-dir', join(directory, 'data'), 'serve', '--transport', 'http',
      '--bind', `127.0.0.1:${port}`, '--workspace', 'forbidden-fallback', '--project', 'forbidden-fallback', '--no-watcher',
      ...(stateful ? ['--http-stateful'] : [])], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', value => { logs = (logs + value).slice(-100000); });
    child.stderr.on('data', value => { logs = (logs + value).slice(-100000); });
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`Upstream exited: ${logs.replaceAll(token, '<redacted>')}`);
      try { await fetch(`${baseUrl}/mcp`, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
    }, Boolean, 'upstream listening');
    const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-integration', version: '1.0.0' } });
    assert.equal(initialized.serverInfo.version, version);
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    await writeFile(join(directory, 'server.log'), logs.replaceAll(token, '<redacted>'));
  }
  async function send(body) {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) });
    if (response.headers.has('mcp-session-id')) session = response.headers.get('mcp-session-id');
    const text = await response.text(); assert.ok(text.length < 1000000);
    assert.ok(response.ok, `MCP HTTP ${response.status}`);
    if (!text.trim()) return undefined;
    const values = text.startsWith('{') ? [JSON.parse(text)] : text.split('\n').flatMap(line => {
      if (!line.startsWith('data:')) return [];
      try { return [JSON.parse(line.slice(5))]; } catch { return []; }
    });
    const message = values.find(value => value.id === body.id);
    requests.push({ method: body.method, params: body.params, result: message });
    assert.ok(message, 'matching JSON-RPC response');
    if (message.error) throw Object.assign(new Error(message.error.message), message.error);
    return message.result;
  }
  const rpc = (method, params) => send({ jsonrpc: '2.0', id: ++id, method, params });
  async function tool(name, args) {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    if (result.structuredContent) return result.structuredContent;
    return JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  }
  t.after(stop); await start();
  return { baseUrl, token, tool, start, stop, requests, directory };
}
