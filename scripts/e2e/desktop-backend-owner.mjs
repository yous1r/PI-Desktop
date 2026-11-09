import assert from 'node:assert/strict';
import { join } from 'node:path';
import { database, until } from './owner-handoff-fixture.mjs';

const program = `
const { spawn } = require('node:child_process');
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (!request.id) return;
  if (request.method === 'fixture.spawn') {
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  }
  reply(request.id, { ok: true });
  if (request.method === 'fixture.exit') setImmediate(() => process.exit(7));
});`;

/** Native generation/recovery proof with real Rust, runner, Node and descendants.
 * Full production configuration wiring is covered by the Desktop behavior test. */
export async function verifyDesktopBackendOwner({ DesktopBackendOwner, DesktopSidecar, DesktopHandoffAdmission }, makeHost, binary, env, directory) {
  const profile = join(directory, 'backend-profile');
  const hosts = [], sidecars = [];
  const state = { host: null, sidecar: null, handoffAdmission: new DesktopHandoffAdmission() };
  const owner = new DesktopBackendOwner({ runtimeState: state, fenced: true, isQuitting: () => false,
    host: { prepare: async () => undefined,
      create: () => {
        const h = makeHost(profile, true); hosts.push(h);
        h.onExit(() => { if (state.host === h) state.host = null; }); return h;
      },
      configure: async (h, _prepared, check) => { await h.handshake(); check();
        assert.ok(database(profile, db => db.prepare('SELECT count(*) AS n FROM execution_owners').get()).n > 0); },
    },
    sidecar: {
      create: async (h, check) => {
        const s = await DesktopSidecar.createFenced({ host: h, binaryPath: binary, assertLaunch: check, onStderr() {},
          launch: { command: process.execPath, args: ['-e', program], cwd: directory, env: { ...env, PI_DESKTOP_DATA_DIR: profile } } });
        sidecars.push(s); s.onExit(() => { if (state.sidecar === s) state.sidecar = null; }); return s;
      },
      configure: async (s, _h, check) => { await s.call('sidecar.configure', {}, 10000); check(); },
    },
  });
  try {
    await Promise.all([owner.startHost(), owner.startSidecar(), owner.startSidecar()]);
    assert.equal(hosts.length, 1); assert.equal(sidecars.length, 1);
    const first = state.sidecar;
    await first.call('fixture.spawn');
    await until(async () => (await first.executionStatus()).activeProcesses >= 2, 'owned descendant registration');
    const generation = (await first.executionStatus()).generation;
    const exited = new Promise(resolve => first.onExit(resolve));
    await first.call('fixture.exit'); await exited;
    assert.equal(await first.confirmExit(), true);
    await owner.startSidecar();
    assert.equal(hosts.length, 1); assert.equal(sidecars.length, 2);
    const stopped = database(profile, db => db.prepare('SELECT closed FROM execution_generations WHERE id=?').get(generation));
    assert.equal(stopped.closed, 1);
    assert.notEqual(state.sidecar, first);

    const second = state.sidecar;
    await second.call('fixture.spawn');
    await until(async () => (await second.executionStatus()).activeProcesses >= 2, 'replacement descendant registration');
    const oldGeneration = (await second.executionStatus()).generation;
    const originalHost = hosts[0];
    // Dispose the exact original transport, never select a PID or a live app.
    await originalHost.dispose(); assert.equal(await originalHost.confirmExit(), true);
    await Promise.all([owner.startSidecar(), owner.startHost(), owner.startSidecar()]);
    assert.equal(hosts.length, 2); assert.equal(sidecars.length, 3);
    assert.equal(await second.confirmExit(), true);
    assert.equal(state.sidecar.captureHostBinding(hosts[1])(), true);
    const retired = database(profile, db => db.prepare('SELECT o.retired FROM execution_generations g JOIN execution_owners o ON o.epoch=g.owner_epoch WHERE g.id=?').get(oldGeneration));
    assert.equal(retired.retired, 1);
    assert.equal(owner.retainedSidecars().includes(second), false);
    await state.sidecar.call('fixture.ready');
    await owner.closeSidecar();
    assert.equal(hosts[1].isAvailable(), true, 'persistence retains a live Host after Sidecar closure');
    await owner.closeHost();
    assert.equal(await hosts[1].confirmExit(), true);
    assert.equal(owner.getHandoffActivity().operations, 0);
    assert.equal(owner.getHandoffActivity().uncontainedResources, 0);
  } finally {
    state.handoffAdmission.dispose();
    const errors = [];
    for (const s of sidecars) {
      try { await s.dispose(); assert.equal(await s.confirmExit(), true); } catch (error) { errors.push(error); }
    }
    for (const h of hosts) {
      try { await h.dispose(); assert.equal(await h.confirmExit(), true); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'isolated backend cleanup unconfirmed');
  }
}
