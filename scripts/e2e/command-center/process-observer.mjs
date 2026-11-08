// Test-only preload observing the OS spawn boundary without replacing child behavior.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

const originalSpawn = childProcess.spawn;
const live = new Set();
const send = message => { if (process.connected) process.send(message, () => {}); };
childProcess.spawn = function observedSpawn(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  const role = resolve(String(command)).toLowerCase() === resolve(process.env.P0_HOST_BINARY).toLowerCase()
    ? 'host' : Array.isArray(args) && args.includes(process.env.P0_SIDECAR_ENTRY) ? 'sidecar' : 'unexpected-child';
  child.once('spawn', () => {
    live.add(child);
    send({ kind: 'owned-process', role, pid: child.pid });
  });
  child.once('close', (code, signal) => {
    live.delete(child);
    send({ kind: 'owned-process-exit', role, pid: child.pid, code, signal });
  });
  return child;
};
// A worker-level failure must not leave its directly owned processes running.
process.once('exit', () => { for (const child of live) child.kill(); });
syncBuiltinESMExports();
