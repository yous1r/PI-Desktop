import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

export function database(profile, action, readOnly = true) {
  const db = new DatabaseSync(join(profile, 'pi.sqlite'), { readOnly });
  try { db.exec('PRAGMA busy_timeout=5000;'); return action(db); } finally { db.close(); }
}
export function durableState(profile) {
  return database(profile, db => Object.fromEntries([
    'execution_owners', 'execution_generations', 'owner_handoffs', 'owner_handoff_receipts', 'turns',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
export async function until(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error(`timeout: ${description}`);
}
export async function bounded(promise, description, timeout = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${description}`)), timeout);
  })]); } finally { clearTimeout(timer); }
}

export async function harness(directory, binary, root) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const name of ['home', 'temp', 'appdata', 'agents']) await mkdir(join(directory, name));
  Object.assign(env, { USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home'),
    TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), APPDATA: join(directory, 'appdata'),
    LOCALAPPDATA: join(directory, 'appdata'), PI_DESKTOP_AGENTS_DIR: join(directory, 'agents'), RUST_LOG: 'error' });
  const children = [];
  function launch(command, args, profile, extra = {}) {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, PI_DESKTOP_DATA_DIR: profile, ...extra } });
    child.stderrText = ''; child.stdoutText = '';
    child.stderr.on('data', bytes => { child.stderrText = (child.stderrText + bytes).slice(-65536); });
    child.stdout.on('data', bytes => { child.stdoutText = (child.stdoutText + bytes).slice(-65536); });
    child.stdin.on('error', () => {}); // Exit/response promises report the same transport failure.
    child.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.failed = new Promise((_, reject) => child.once('error', reject));
    child.failed.catch(() => {});
    children.push(child);
    return child;
  }
  async function closed(child, timeout = 10000) {
    return bounded(Promise.race([child.closed, child.failed]), `close ${child.pid}: ${child.stderrText}`, timeout);
  }
  async function stop(child, crash = false) {
    if (child.exitCode === null && child.signalCode === null) {
      if (crash) child.kill('SIGKILL'); else child.stdin.end();
    }
    return closed(child);
  }
  async function host(profile, enabled = true) {
    const child = launch(binary, enabled ? ['--execution-fence'] : [], profile);
    const pending = new Map();
    createInterface({ input: child.stdout }).on('line', line => {
      const response = JSON.parse(line);
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      response.error ? entry.reject(new Error(JSON.stringify(response.error))) : entry.resolve(response.result);
    });
    child.once('exit', () => { for (const entry of pending.values()) entry.reject(new Error(`Host exited: ${child.stderrText}`)); pending.clear(); });
    const call = async (method, params = {}) => {
      const id = randomUUID();
      const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      try { return await bounded(promise, method, method === 'app.handshake' ? 45000 : 10000); }
      finally { pending.delete(id); }
    };
    await call('app.handshake', { protocolVersion: 11 });
    return { child, call };
  }
  function restricted(profile) {
    const child = launch(binary, ['--owner-handoff'], profile);
    let buffer = Buffer.alloc(0);
    let pending;
    child.stdout.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE();
      assert.ok(length > 0 && length <= 16384);
      if (buffer.length < length + 4) return;
      assert.equal(buffer.length, length + 4, 'one response per serialized request');
      const reply = JSON.parse(buffer.subarray(4).toString('utf8'));
      buffer = Buffer.alloc(0);
      assert.ok(pending, 'response belongs to an outstanding request');
      pending.resolve(reply); pending = undefined;
    });
    child.once('exit', () => { pending?.reject(new Error(`restricted process exited: ${child.stderrText}`)); pending = undefined; });
    return { child, async call(command) {
      assert.equal(pending, undefined);
      const bytes = Buffer.from(JSON.stringify(command));
      const frame = Buffer.alloc(4 + bytes.length); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4);
      const promise = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      child.stdin.write(frame);
      try { return await bounded(promise, `restricted ${command.operation}`, 15000); }
      finally { pending = undefined; }
    } };
  }
  async function observe(pids, profile) {
    const child = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(root, 'scripts/e2e/execution-fence-observer.ps1'), '-ProcessIds', pids.join(',')], profile);
    await until(() => child.stdoutText.includes('captured'), 'original handle capture', 15000);
    return async () => { assert.equal((await closed(child, 20000)).code, 0, child.stderrText); assert.match(child.stdoutText, /exited/); };
  }
  return { launch, host, restricted, stop, closed, observe, children, async cleanup() {
    let confirmed = true;
    for (const child of children) {
      try { await stop(child, true); } catch { confirmed = false; }
    }
    return confirmed;
  } };
}
