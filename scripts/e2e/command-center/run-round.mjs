import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { expectedText } from './provider.mjs';
import { promptText } from './context.mjs';

/** One public AgentHost journey. The same services/processes survive every round. */
export async function runRound({ config, sessions, runtime, agent, host, provider }) {
  const outcome = { completed: 0, verified: 0, inputVerified: 0, verifiedBeforeDispose: false,
    unexpectedEvents: 0, outputBytes: 0, startedAt: Date.now(), pendingWritesPeak: 0, settlementLagMs: [] };
  let failure, signalCompletion;
  const completed = new Set();
  const completion = new Promise(resolve => { signalCompletion = resolve; });
  const started = performance.now();
  const observe = setInterval(() => { outcome.pendingWritesPeak = Math.max(outcome.pendingWritesPeak, runtime.pendingWrites()); }, 20);
  const offEvent = runtime.onEvent(envelope => {
    try {
      agent.ingest(envelope);
      if (['tool_start', 'tool_permission_request', 'asktool_request', 'error'].includes(envelope.event.type)) {
        outcome.unexpectedEvents++; failure ??= new Error(`Unexpected runtime event: ${envelope.event.type}`); signalCompletion();
      }
    } catch (error) { failure ??= error; signalCompletion(); }
  });
  const offEnd = runtime.onTurnEnded(info => {
    agent.endTurn(info.sessionId, info.turnId, info.reason === 'completed' ? 'completed' : 'failed');
    if (!info.settled || info.reason !== 'completed') failure ??= new Error('Turn did not settle successfully');
    if (completed.has(info.sessionId)) failure ??= new Error('Duplicate turn settlement');
    completed.add(info.sessionId); outcome.completed = completed.size;
    outcome.settlementLagMs.push(Math.max(0, Date.now() - provider.stats.endedAt));
    if (failure || completed.size === config.sessions) signalCompletion();
  });
  const timer = setTimeout(() => { failure ??= new Error('Round deadline exceeded'); signalCompletion(); }, config.ticks * config.intervalMs + 90000);
  try {
    const principal = { subject: 'p0-local-fixture', roles: ['owner'], pairedDevice: true };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
      while (next < sessions.length) {
        const current = sessions[next++];
        await agent.startTurn(principal, { sessionId: current.id,
          input: { text: promptText(current.key, config.contextBytes, config.contextKind) },
          context: { requestId: randomUUID() }, admission: 'reject_if_busy' });
      }
    }));
    await completion;
    if (failure) throw failure;
    provider.assertHealthy();
    assert.equal(runtime.pendingWrites(), 0, 'turn completion drains messages before disposal');
    for (const session of sessions) {
      const detail = (await host.call('session.get', { id: session.id, messageLimit: 10 })).session;
      const users = detail.messages.filter(m => m.role === 'user');
      const replies = detail.messages.filter(m => m.role === 'assistant' && !m.parentToolCallId);
      assert.equal(users.length, 1, `One input for ${session.key}`);
      assert.equal(users[0].content, promptText(session.key, config.contextBytes, config.contextKind), `Lossless input for ${session.key}`);
      outcome.inputVerified++;
      assert.equal(replies.length, 1, `One assistant result for ${session.key}`);
      assert.equal(replies[0].content, expectedText(session.key, config.ticks), `Lossless result for ${session.key}`);
      outcome.verified++; outcome.outputBytes += Buffer.byteLength(replies[0].content);
    }
    outcome.verifiedBeforeDispose = true;
  } catch (error) { outcome.error = String(error.message ?? error); }
  finally {
    clearInterval(observe); clearTimeout(timer); offEvent(); offEnd();
    outcome.endedAt = Date.now(); outcome.durationMs = performance.now() - started;
    outcome.fixture = { ...provider.stats };
  }
  return outcome;
}
