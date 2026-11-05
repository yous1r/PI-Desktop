import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventually } from './ai-memory-upstream.mjs';

export async function isolatedEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['systemroot', 'windir', 'path', 'pathext', 'comspec', 'systemdrive', 'processor_architecture', 'number_of_processors'].includes(key.toLowerCase())));
  for (const directory of ['home', 'tmp', 'appdata', 'localappdata', 'data', 'agents']) await mkdir(join(root, directory), { recursive: true });
  return { ...env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'), XDG_CACHE_HOME: join(root, 'home', '.cache'),
    PI_DESKTOP_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'home', '.pi', 'agent'),
    // Rust uses the Windows Known Folder API for home, independently of USERPROFILE.
    PI_DESKTOP_AGENTS_DIR: join(root, 'agents'),
    PI_DESKTOP_PLUGIN_MARKET_URL: pathToFileURL(join(root, 'offline-catalog.json')).href,
    NO_PROXY: '127.0.0.1,localhost', ELECTRON_RENDERER_URL: '', PI_DESKTOP_START_MAXIMIZED: '0' };
}

export async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

export function processFixture(command, args, options, cleanup) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output = (output + value).slice(-100000); });
  child.stderr.on('data', value => { output = (output + value).slice(-100000); });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      await once(killer, 'exit');
    } else child.kill('SIGTERM');
    await done;
  }
  cleanup.push(stop);
  return { child, stop, output: () => output };
}

export async function seedHost({ root, hostBinary, env, packagePath, permissions, modelUrl, cleanup }) {
  const host = processFixture(hostBinary, [], { env, cwd: root }, cleanup);
  const pending = new Map(); let sequence = 0; let buffer = '';
  host.child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf('\n'); if (at < 0) break;
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id); if (!waiter) continue;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host ${method} timeout: ${host.output()}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    host.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await call('app.handshake', { protocolVersion: 11 });
    const installed = await call('plugins.installFromPackage', { path: packagePath, enable: true });
    assert.equal(installed.result.plugin.id, 'local.ai-memory');
    const granted = await call('plugins.grantPermissions', { id: 'local.ai-memory', permissions });
    assert.deepEqual([...granted.plugin.permissions].sort(), [...permissions].sort());
    await call('plugins.enable', { id: 'local.ai-memory' });
    const created = await call('providers.create', { name: 'Synthetic Desktop memory E2E', type: 'openai_compatible',
      baseUrl: `${modelUrl}/v1`, apiStyle: 'chat_completions', authKind: 'api_key', secretValue: 'synthetic-model-token',
      models: [{ id: 'memory-fixture', contextWindow: 128000, maxTokens: 4096, thinkingLevels: ['off'] }], defaultModelId: 'memory-fixture' });
    const providerId = created.provider?.id ?? created.id;
    await call('settings.set', { language: 'en', defaultProviderId: providerId, defaultModelId: 'memory-fixture', defaultMode: 'agent' });
    return { installed: installed.result, granted: granted.plugin, providerId };
  } finally { await host.stop(); }
}

export async function modelFixture(cleanup) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 2000000); }
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `synthetic-${requests.length}`;
    res.end([
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic Desktop answer.' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
      'data: [DONE]', '', '',
    ].join('\n\n'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** CDP for an actual plugin WebContentsView, including native confirm acceptance. */
export async function connectPanel(port, cleanup) {
  const target = await eventually(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(item => item.type === 'page' && /local.ai-memory|\/ui\/index.html/.test(item.url));
  }, Boolean, 'plugin panel CDP target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  cleanup.push(async () => socket.close());
  const pending = new Map(); let sequence = 0; const confirms = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Page.javascriptDialogOpening') {
      confirms.push({ type: message.params.type, message: message.params.message });
      void call('Page.handleJavaScriptDialog', { accept: message.params.type === 'confirm' }); return;
    }
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await call('Page.enable', {});
  async function run(fn, arg) {
    const result = await call('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  return { run, confirms, close: () => socket.close() };
}

export async function saveEvidence(root, evidence, secrets) {
  let text = JSON.stringify(evidence, null, 2);
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '<redacted>');
  await writeFile(join(root, 'evidence.json'), text + '\n');
}
export async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
