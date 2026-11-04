import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ConnectionRequest, Connections } from '../../src/contracts.js';

export const hashes: Record<string, string> = {
  '3.3.2': 'a20f08b9efef1f5e8635373eca44b9d59eb36d899097e3634e409c109c59414b',
  '3.3.3': '0fcf2490d707041a503b2c92876640b7706ef464156e2135a84b719688a541ff',
};
export async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do { last = await read(); if (predicate(last)) return last; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(last).slice(0, 2000)}`);
}
/** Real external boundary only. Explicit executable hashes, synthetic token, isolated profile,
 * no inherited provider credentials, no watcher, no model configuration or paid calls. */
export async function fixture(t: TestContext, root: string, version: string, stateful = false) {
  const binary = join(process.env.AI_MEMORY_TEST_BINARIES!, `bin-v${version}`, 'ai-memory.exe');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), hashes[version]);
  const directory = join(root, 's'); await mkdir(directory, { recursive: true });
  const token = 'synthetic-plugin-contract-only';
  const config = join(directory, 'config.toml');
  await writeFile(config, `embedding_provider = "none"\nlog_level = "warn"\n[auth]\nbearer_token = "${token}"\n[maintenance]\nenabled = false\n[auto_improve.scheduler]\nenabled = false\n`);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert.ok(address && typeof address === 'object'); const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'path', 'pathext', 'comspec', 'systemdrive', 'processor_architecture'].includes(key.toLowerCase())));
  const home = join(directory, 'profile'); await mkdir(home, { recursive: true });
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, XDG_CONFIG_HOME: home, NO_PROXY: '127.0.0.1,localhost' });
  let child: ChildProcess | undefined; let logs = '';
  const baseUrl = `http://127.0.0.1:${port}`;
  const requests: ConnectionRequest[] = []; const pending = new Map<string, AbortController>();
  const controls = { loseHookResponse: false, hideObservations: false, loseToolResponse: '' };
  async function start() {
    child = spawn(binary, ['--config', config, '--data-dir', join(directory, 'data'), 'serve', '--transport', 'http', '--bind', `127.0.0.1:${port}`, '--workspace', 'forbidden-fallback', '--project', 'forbidden-fallback', '--no-watcher', ...(stateful ? ['--http-stateful'] : [])], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout!.on('data', value => { logs = (logs + value).slice(-100000); }); child.stderr!.on('data', value => { logs = (logs + value).slice(-100000); });
    await eventually(async () => {
      if (child!.exitCode !== null) throw new Error(`Server exited: ${logs.replaceAll(token, '<redacted>')}`);
      try { await fetch(`${baseUrl}/mcp`, { signal: AbortSignal.timeout(300) }); return true; } catch { return false; }
    }, Boolean, 'upstream listening');
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    await writeFile(join(directory, 'server.log'), logs.replaceAll(token, '<redacted>'));
  }
  const request: Connections['request'] = async input => {
    requests.push(structuredClone(input));
    const controller = new AbortController(); pending.set(input.requestId, controller);
    try {
      const response = await fetch(`${baseUrl}${input.path}`, { method: input.method, redirect: 'error', headers: { ...input.headers, authorization: `Bearer ${token}` }, body: input.body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(input.timeoutMs ?? 8000)]) });
      let bodyText = await response.text();
      const rpc = JSON.parse(input.body ?? '{}');
      if (bodyText.startsWith('{')) {
        const result = JSON.parse(bodyText);
        if (result.error) t.diagnostic(`Synthetic server ${rpc.params?.name ?? rpc.method}: ${JSON.stringify(result.error)}`);
      }
      if (controls.loseHookResponse && input.path.startsWith('/hook?')) { controls.loseHookResponse = false; throw new Error('synthetic response loss after admission'); }
      if (controls.loseToolResponse && rpc.params?.name === controls.loseToolResponse) { controls.loseToolResponse = ''; throw new Error('synthetic mutation response loss after commit'); }
      if (controls.hideObservations && rpc.params?.name === 'memory_read_session_observations') bodyText = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"observations":[]}' }] } });
      return { status: response.status, headers: Object.fromEntries(response.headers), bodyText, connectionRevision: 1 };
    } finally { pending.delete(input.requestId); }
  };
  t.after(stop); await start();
  return { request, cancel: async (id: string) => { pending.get(id)?.abort(); }, start, stop, requests, controls, baseUrl };
}
