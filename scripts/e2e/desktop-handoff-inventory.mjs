import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopHandoffAdmission } from '../../apps/desktop/electron/main/runtime/handoff-admission.ts';
import { inspectDesktopHandoff, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES } from '../../apps/desktop/electron/main/runtime/handoff-inventory.ts';
import { bindDesktopHandoffOwner, DesktopHandoffCoordinator } from '../../apps/desktop/electron/main/runtime/handoff-coordinator.ts';
import { PersistenceOutbox } from '../../apps/desktop/electron/main/persistence-outbox.ts';
import { InflightCheckpointer } from '../../packages/host-runtime/src/inflight-checkpoint.ts';

/** Actual Rust/persistence/gate composition. Other Desktop owners are explicit
 * idle fixtures; this does not qualify full Desktop startup or native closure.
 * `inspectRust` is the production `ownerHandoff.inspect` read for the same
 * binding, used to check the durable linked-Worker count before Desktop maps it. */
export async function verifyDesktopInventory(host, binding, directory, inspectRust) {
  const reporter = value => ({ getHandoffActivity: () => ({ ...value }) });
  const external = () => reporter({ operations: 0, resources: 0, uncontainedResources: 0 });
  const sidecar = {
    captureHostBinding: owner => () => owner === host && host.isAvailable(),
    executionStatus: () => host.call('executionFence.status', { generation: binding.generation }),
    call: async () => assert.fail('unqualified coordinator must not acquire a Sidecar hold'),
    getExtensionOwnerActivity: () => ({ operations: 0, runtimes: 0, uncontainedResources: 0 }),
    getExtensionWorkspaceProcessActivity: () => ({ operations: 0, processes: 0, uncontainedResources: 0 }),
    getExtensionServiceActivity: () => ({ operations: 0, inputs: 0, uncontainedResources: 0 }),
  };
  const admission = new DesktopHandoffAdmission();
  const outbox = new PersistenceOutbox(directory, () => undefined);
  const saveEntered = Promise.withResolvers(), saveRelease = Promise.withResolvers();
  const checkpointer = new InflightCheckpointer(async checkpoint => {
    saveEntered.resolve(); await saveRelease.promise;
    await host.call('session.saveInflightMessage', checkpoint);
  });
  const sources = {
    binding: { ...binding, sidecar }, admission,
    backends: { retainedSidecars: () => [sidecar], getHandoffActivity: () => ({ operations: 0, retiredSidecars: 0, uncontainedResources: 0 }) },
    agentHost: { handoffBusyCounts: () => ({ turns: 0, queuedTurns: 0, admissions: 0, approvals: 0, inputs: 0 }) },
    plans: { inFlightCount: () => 0 }, modes: reporter({ operations: 0, turns: 0, queuedTurns: 0, uncontainedResources: 0 }),
    coordination: reporter({ admissions: 0, finalizations: 0, writes: 0, uncontainedResources: 0 }),
    events: reporter({ finalizations: 0, writes: 0, uncontainedResources: 0 }), outbox, checkpointer,
    scheduler: { inFlightCount: () => 0 }, scheduledRuns: new Map(), activeTurns: new Map(), activeTools: new Map(),
    plugins: reporter({ operations: 0, plugins: 0, schedules: 0, uncontainedResources: 0 }), remote: external(),
    browser: reporter({ operations: 0, pages: 0, uncontainedResources: 0 }),
    terminals: reporter({ terminals: 0, uncontainedResources: 0 }), userMcp: reporter({ mcp: 0, uncontainedResources: 0 }),
    mcpOAuth: external(), speech: external(),
    modelCatalog: external(), updater: external(), mcpControl: external(),
    vendorOAuth: external(), personalTodos: external(), collaboration: external(),
    surfaces: external(),
  };
  const inspect = () => inspectDesktopHandoff(() => sources);
  const { session } = await host.call('session.create', { title: 'Isolated Desktop inventory fixture' });
  const { turnId } = await host.call('session.beginTurn', { sessionId: session.id });
  const message = { id: randomUUID(), role: 'assistant', content: 'original inventory write',
    createdAt: '2026-11-09T00:00:00.000Z', status: 'streaming' };
  let saving;
  try {
    checkpointer.observe({ sessionId: session.id, turnId, message });
    saving = checkpointer.flush(session.id);
    await saveEntered.promise;
    await outbox.enqueue({ key: `message:${message.id}`, sessionId: session.id,
      message: { ...message, id: randomUUID(), content: 'queued inventory reply', status: 'complete' } }, () => null);
    await outbox.flush(() => null);
    checkpointer.dispose();
    const busy = await inspect();
    assert.ok(busy.turns > 0); assert.ok(busy.writes >= 2);
    await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), /HOST_BUSY/);
    assert.equal(admission.isClosed(), false);
    saveRelease.resolve(); await saving;
    await host.call('session.endTurn', { turnId, status: 'aborted', createNotification: false, recoverInflight: true });
    await outbox.flush(() => host);
    assert.equal(outbox.size(), 0);
    const settled = await inspect();
    assert.equal(settled.turns, 0); assert.equal(settled.writes, 0);
    assert.equal(settled.uncontainedResources, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES.length);
    await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), /HOST_BUSY/);
    const detail = await host.call('session.get', { id: session.id });
    assert.ok(detail.session.messages.some(value => value.content === message.content));
    assert.ok(detail.session.messages.some(value => value.content === 'queued inventory reply'));
    const current = () => ({ ...sources, host, sidecar });
    const original = await bindDesktopHandoffOwner(current);
    assert.equal(original.current().binding.sourceEpoch, binding.sourceEpoch);
    assert.equal(original.current().binding.profileId, binding.profileId);
    assert.equal(original.current().binding.generation, binding.generation);
    assert.equal((await original.inspect()).uncontainedResources, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES.length);

    // Durable linked-Worker obligation through the real public Host API. A
    // spawned Worker task is queued in Rust before any Desktop/AgentHost turn
    // exists, so this count cannot come from Sidecar children or native sessions.
    assert.equal(typeof inspectRust, 'function', 'the Worker scenario needs original Rust inspection');
    const { session: workerParent } = await host.call('session.create', { title: 'Worker inventory parent', mode: 'agent' });
    const spawnWorker = async title => {
      const spawned = await host.call('session.collaboration.spawn', { sourceSessionId: workerParent.id,
        pluginId: 'pi.session-orchestrator', content: 'Queued-only Worker inventory fixture',
        idempotencyKey: randomUUID(), notifyOnCompletion: false, title });
      assert.equal(spawned.message.status, 'queued', 'a spawned Worker task is queued before Desktop dispatches it');
      return spawned;
    };
    const queuedWorker = await spawnWorker('Queued-only Worker');
    const rustQueued = await inspectRust();
    assert.equal(rustQueued.durable.workers, 1, 'Rust counts the linked Worker before Desktop dispatch');
    assert.equal(rustQueued.durable.turns, false, 'the queued Worker owns no Host turn yet');
    const observedQueued = await inspect();
    assert.equal(Object.keys(observedQueued).length, 19, 'the public inventory keeps all nineteen families');
    assert.equal(observedQueued.workers, 1, 'Desktop maps the original durable Worker count');
    assert.equal(observedQueued.turns, 0, 'a queued-only Worker adds no turn obligation');
    assert.equal(observedQueued.children, 0, 'subagent delegations are not Worker sessions');
    assert.equal(observedQueued.nativeSessions, 0, 'native Pi sessions are not Worker sessions');
    assert.equal(observedQueued.uncontainedResources, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES.length);

    // An unrelated ordinary session with a real running turn is not a Worker.
    const { session: unlinked } = await host.call('session.create', { title: 'Unlinked inventory session', mode: 'agent' });
    const { turnId: unlinkedTurn } = await host.call('session.beginTurn', { sessionId: unlinked.id });
    const withUnlinkedTurn = await inspect();
    assert.ok(withUnlinkedTurn.turns > 0, 'the unlinked session really has a running turn');
    assert.equal(withUnlinkedTurn.workers, 1, 'an unlinked running session never becomes a Worker');
    await host.call('session.endTurn', { turnId: unlinkedTurn, status: 'aborted', createNotification: false, recoverInflight: true });
    assert.equal((await inspect()).turns, 0);

    // Claiming the queued task keeps one Worker counted once, then settles it.
    const { turnId: workerTurn } = await host.call('session.beginTurn', { sessionId: queuedWorker.sessionId,
      sessionMessageId: queuedWorker.message.id });
    assert.equal((await inspectRust()).durable.workers, 1, 'a queued and running Worker is one session, not two');
    await host.call('session.endTurn', { turnId: workerTurn, status: 'completed', createNotification: false });
    await host.call('session.collaboration.settle', { turnId: workerTurn });
    assert.equal((await inspectRust()).durable.workers, 0, 'settling the delivery releases the Worker');
    assert.equal((await inspect()).workers, 0);

    // Cancelling a still-queued delivery through the public API releases it too.
    const cancelledWorker = await spawnWorker('Cancelled Worker');
    assert.equal((await inspectRust()).durable.workers, 1);
    const released = await host.call('session.collaboration.cancel', { sessionId: cancelledWorker.sessionId,
      pluginId: 'pi.session-orchestrator', sourceSessionId: workerParent.id });
    assert.deepEqual(released.messageIds, [cancelledWorker.message.id]);
    assert.deepEqual(released.runningTurnIds, []);
    assert.equal((await inspectRust()).durable.workers, 0, 'a cancelled queued delivery is not an active Worker');
    const releasedInventory = await inspect();
    assert.equal(releasedInventory.workers, 0);
    assert.equal(releasedInventory.uncontainedResources, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES.length,
      'all fixed qualification gaps, including Worker classification, are retained');

    const coordinator = new DesktopHandoffCoordinator(admission, current);
    try {
      await assert.rejects(coordinator.exchange({ version: 1, operation: 'hold', exchangeId: randomUUID(),
        transferId: randomUUID(), sourceEpoch: binding.sourceEpoch, revision: 1 }), error => error.code === 'HOST_BUSY');
      assert.equal(admission.isClosed(), false);
    } finally { coordinator.dispose(); }
  } finally { saveRelease.resolve(); await saving; checkpointer.dispose(); admission.dispose(); }
}
