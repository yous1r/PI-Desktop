import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopHandoffAdmission } from '../../apps/desktop/electron/main/runtime/handoff-admission.ts';
import { inspectDesktopHandoff, DESKTOP_HANDOFF_UNQUALIFIED_SOURCES } from '../../apps/desktop/electron/main/runtime/handoff-inventory.ts';
import { PersistenceOutbox } from '../../apps/desktop/electron/main/persistence-outbox.ts';
import { InflightCheckpointer } from '../../packages/host-runtime/src/inflight-checkpoint.ts';

/** Actual Rust/persistence/gate composition. Other Desktop owners are explicit
 * idle fixtures; this does not qualify full Desktop startup or native closure. */
export async function verifyDesktopInventory(host, binding, directory) {
  const reporter = value => ({ getHandoffActivity: () => ({ ...value }) });
  const external = () => reporter({ operations: 0, resources: 0, uncontainedResources: 0 });
  const sidecar = {
    captureHostBinding: owner => () => owner === host && host.isAvailable(),
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
  } finally { saveRelease.resolve(); await saving; checkpointer.dispose(); admission.dispose(); }
}
