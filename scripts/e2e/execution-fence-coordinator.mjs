// Isolated coordinator fixture; invokes the production transports bundled by the harness.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [directory, binary, profile, runtime, marker] = process.argv.slice(2);
const children = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  children.push(child);
  return child;
};
syncBuiltinESMExports();
const { HostProcess } = await import(pathToFileURL(join(directory, 'host-process.mjs')));
const { AgentSidecar } = await import(pathToFileURL(join(directory, 'agent-sidecar.mjs')));
const host = new HostProcess({ binaryPath: binary, dataDir: profile, executionFence: true,
  onStderr: text => process.stderr.write(text) });
await host.handshake();
const sidecar = await AgentSidecar.createFenced({ host, binaryPath: binary,
  launch: { command: process.execPath, args: [runtime, marker] }, onStderr: text => process.stderr.write(text) });
const ping = await sidecar.call('fixture.ping', {}, 10000);
if (!ping.ok) throw new Error('sidecar RPC unavailable');
process.stdout.write(`${JSON.stringify({ host: children[0].pid, launcher: children[1].pid, ready: true })}\n`);
createInterface({ input: process.stdin }).on('line', async line => {
  if (line !== 'stop') return;
  try {
    if (!await sidecar.fenceExecution()) throw new Error('containment unconfirmed');
    if (!await sidecar.confirmExit()) throw new Error('launcher exit unconfirmed');
    await sidecar.dispose();
    await host.dispose();
    if (!await host.confirmExit()) throw new Error('host exit unconfirmed');
    process.stdout.write('stopped\n');
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});
