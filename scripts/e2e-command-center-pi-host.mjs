#!/usr/bin/env node
// Production pi-host startup, real Rust host-core and real authenticated WS.
// Only the model sidecar is a deterministic external-edge double.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.PI_DESKTOP_HOST_BIN && process.env.PI_SCRATCH_DIR,
  'Explicit candidate binary and isolated scratch directory required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const scratch = resolve(process.env.PI_SCRATCH_DIR);
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(join(scratch, 'cc-pi-host-'));
for (const name of ['home', 'temp', 'off', 'on']) await mkdir(join(directory, name));
const sidecarEntry = join(directory, 'sidecar-edge.cjs');
await writeFile(sidecarEntry, `
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method !== 'sidecar.configure') {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:1000,message:'No model operation is allowed by this test'}})+'\\n');
    return;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{ok:true}})+'\\n');
});
rl.on('close', () => process.exit(0));
`);
const checks = [];
const digest = value => createHash('sha256').update(value).digest('hex');
// A verification clone may carry only the request branch; record the base when known.
function baseMainRef() {
  try { return execFileSync('git', ['rev-parse', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const result = {
  status: 'FAIL', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  baseMain: baseMainRef(),
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  hostBinarySha256: digest(await readFile(binary)), platform: process.platform,
  checks, cleanupConfirmed: false, scope: 'production startPiHost + Rust + WS; external model sidecar double',
};
const children = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  children.push(child);
  return child;
};
syncBuiltinESMExports();
const apps = [];
const clients = [];
const startupDiagnostics = [];
const quiet = Object.assign((level, message) => {
  startupDiagnostics.push(`${level}: ${message}`);
  if (startupDiagnostics.length > 20) startupDiagnostics.shift();
}, { child: (channel) => text => {
  // Only isolated children whose profile/environment this test just created.
  startupDiagnostics.push(`${channel}: ${String(text).trim().slice(-1200)}`);
  if (startupDiagnostics.length > 20) startupDiagnostics.shift();
} });
// Change only this isolated test process before importing the app composition.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|KEY|PROXY|PI_DESKTOP|ELECTRON/i.test(key)) delete process.env[key];
}
Object.assign(process.env, { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
  APPDATA: join(directory, 'home'), LOCALAPPDATA: join(directory, 'home'),
  TEMP: join(directory, 'temp'), TMP: join(directory, 'temp'), RUST_LOG: 'error' });
const deadline = setTimeout(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch {} } }, 60_000);
try {
  const { startPiHost } = await import('../apps/pi-host/dist/app.js');
  const { RacpClient, wsClientTransport, hashToken } = await import('../packages/racp/dist/index.js');
  const { RACP_WS_PATH } = await import('../packages/shared/dist/racp.js');
  async function start(commandCenter, name) {
    const app = await startPiHost({ commandCenter, dataDir: join(directory, name),
      host: '127.0.0.1', port: 0, hostCoreBinary: binary, sidecarEntry,
      nodeBinary: process.execPath, pair: false, pairingLifetimeMs: 60_000,
      browseRoot: directory, logLevel: 'error' }, { log: quiet });
    apps.push(app);
    const pairing = await app.issuePairingToken(60_000);
    const device = await app.authenticator.pair(hashToken(pairing.token), 'isolated command-center owner', ['owner']);
    const client = new RacpClient({
      transport: wsClientTransport({ url: `ws://${app.address.host}:${app.address.port}${RACP_WS_PATH}`, token: device.token }),
      client: { name: 'isolated startup test', version: '1' }, reconnect: { enabled: false }, requestTimeoutMs: 10_000,
    });
    clients.push(client);
    const initialized = await client.connect();
    return { app, client, initialized };
  }
  // One application composition per process, matching the real pi-host CLI.
  // Run the two modes as separate invocations rather than sharing singletons.
  const defaultMode = process.argv.includes('--default-mode');
  result.mode = defaultMode ? 'default' : 'command-center';
  if (defaultMode) {
    const off = await start(false, 'off');
    assert.notEqual(off.initialized.capabilities.commandCenter, true);
    await assert.rejects(off.client.request('commandCenter/workspace/list', { version: 1, hostId: off.app.hostId }), { code: 'CAPABILITY_UNAVAILABLE' });
    checks.push('default startup does not advertise command-center mode');
    await off.client.close(); await off.app.stop();
  } else {
  const on = await start(true, 'on');
  assert.equal(on.initialized.capabilities.commandCenter, true);
  assert.match(on.app.hostId, /^host_/);
  checks.push('real startup binds the command-center ports and installation identity');
  const workspaces = await on.client.request('commandCenter/workspace/list', { version: 1, hostId: on.app.hostId });
  assert.deepEqual(workspaces, { workspaces: [] });
  const page = await on.client.request('commandCenter/monitorPage', { version: 1, hostId: on.app.hostId });
  assert.deepEqual(page.rows, []);
  assert.match(page.cursor.epoch, /^[0-9a-f-]{36}$/);
  checks.push('production monitor reads an empty real Rust database without synthetic rows');
  const receipts = await on.client.request('commandCenter/receipt/list', { version: 1, hostId: on.app.hostId, afterSequence: 0, limit: 10 });
  assert.deepEqual(receipts.receipts, []);
  checks.push('production receipt reader uses the same Rust data owner');
  await assert.rejects(on.client.request('commandCenter/monitorPage', { version: 1, hostId: on.app.hostId, token: 'not-a-minted-page-handle' }), { code: 'NOT_FOUND' });
  checks.push('production page port refuses a foreign continuation handle');
  await on.client.close(); await on.app.stop();
  checks.push('stop disposes the monitor, WS server, runtime and original child processes');
  }
  result.status = 'PASS';
} catch (error) {
  result.error = String(error.stack ?? error);
  result.startupDiagnostics = startupDiagnostics;
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const client of clients) await client.close();
  for (const app of apps) {
    try { await app.stop(); } catch (error) { result.cleanupError = String(error); process.exitCode = 1; result.status = 'FAIL'; }
  }
  result.cleanupConfirmed = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (!result.cleanupConfirmed) {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} } }
    result.status = 'FAIL'; process.exitCode = 1;
  }
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, report: join(directory, 'report.json') }, null, 2));
}
