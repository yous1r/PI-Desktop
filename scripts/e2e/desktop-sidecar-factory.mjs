import assert from 'node:assert/strict';

const program = `
let held;
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method === 'fixture.hold') { held = request.id; return; }
  if (request.method === 'fixture.release') { reply(held, { completed: true }); held = undefined; }
  reply(request.id, { ok: true, held: held !== undefined });
});`;

/** Real Rust/runner/Node processes and the Desktop subclass; no Electron instance. */
export async function verifyDesktopSidecarFactory(AgentSidecar, host, binaryPath, launchEnv, directory) {
  const options = { host, binaryPath, onStderr() {},
    launch: { command: process.execPath, args: ['-e', program], env: launchEnv, cwd: directory } };
  const sidecar = await AgentSidecar.createFenced(options);
  try {
    assert.ok(sidecar instanceof AgentSidecar);
    const binding = sidecar.captureHostBinding(host);
    assert.equal(binding(), true);
    assert.deepEqual(await sidecar.call('fixture.ready', {}, 10000), { ok: true, held: false });
    const status = await sidecar.executionStatus();
    assert.equal(status.state, 'running');
    assert.equal(status.confirmed, false);
    assert.ok(status.activeProcesses >= 1);
    const holding = sidecar.call('fixture.hold', {}, 10000);
    const settled = holding.then(value => ({ value }), error => ({ error }));
    assert.equal((await sidecar.call('fixture.poll')).held, true);
    assert.equal(sidecar.getExtensionOwnerActivity().operations, 1);
    await sidecar.call('fixture.release');
    assert.deepEqual(await settled, { value: { completed: true } });
    assert.equal(sidecar.getExtensionOwnerActivity().operations, 0);
    assert.deepEqual(sidecar.getExtensionServiceActivity(), { operations: 0, inputs: 0, uncontainedResources: 0 });
    assert.deepEqual(sidecar.getExtensionWorkspaceProcessActivity(), { operations: 0, processes: 0, uncontainedResources: 0 });
    assert.equal(await sidecar.fenceExecution(), true);
    assert.equal(await sidecar.confirmExit(), true);
    assert.equal(binding(), false);
  } finally {
    assert.equal(await sidecar.fenceExecution(), true);
    await sidecar.dispose();
    assert.equal(await sidecar.confirmExit(), true);
  }

  for (const failureAt of ['binding', 'constructor']) {
    const original = new Error(`isolated ${failureAt} failure`);
    let generation;
    const originalHost = {
      async call(method, params) {
        const result = await host.call(method, params);
        if (method === 'executionFence.prepare') generation = result.generation;
        return result;
      },
      onExit: handler => host.onExit(handler),
      onNotification: () => { throw original; },
    };
    class BrokenSidecar extends AgentSidecar {
      constructor(prepared) { super(prepared.onStderr, prepared.launch); throw original; }
      static create(prepared) { return this.createFencedWith(prepared, launch => new BrokenSidecar(launch)); }
    }
    await assert.rejects(failureAt === 'binding'
      ? AgentSidecar.createFenced({ ...options, host: originalHost })
      : BrokenSidecar.create({ ...options, host: originalHost }), error => error === original);
    assert.ok(generation);
    const status = await host.call('executionFence.status', { generation });
    assert.equal(status.confirmed, true);
    assert.equal(status.activeProcesses, 0);
  }
}
