import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Deterministic monotonic scheduler; never waits on real product timers. */
function controlledTime() {
  let now = 0;
  let serial = 0;
  const tasks = new Map();
  return {
    clock: { now: () => now },
    scheduler: {
      schedule(delay, callback) {
        const key = ++serial;
        tasks.set(key, { at: now + delay, callback });
        return () => tasks.delete(key);
      },
    },
    advance(target) {
      for (;;) {
        const due = [...tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    pending: () => tasks.size,
  };
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Browser-realm composition: installer session over the real Host store adapter.
 * No socket, provider or Agent execution is involved.
 */
export async function checkMonitorSessionConsumer(client, owner, projection, MonitorSnapshotStore) {
  const context = client.createCommandCenterObservationContext();
  client.bindCommandCenterObservationOwner(context, owner);
  const time = controlledTime();
  const replies = [];
  let tokenSerial = 0;
  const store = new MonitorSnapshotStore({
    epoch: projection.cursor.epoch, clock: { now: () => time.clock.now() },
    tokens: { next: () => `session-token-${++tokenSerial}` },
  });
  const first = store.capture({ scopeKey: "session-scope", sequence: projection.cursor.sequence, rows: projection.rows });
  const session = client.createCommandCenterMonitorSession(context, {
    ...time,
    ping(signal) {
      const reply = deferred();
      replies.push({ ...reply, signal });
      return reply.promise;
    },
    loadPage: async (token) => {
      if (token === undefined) return first;
      const result = store.page({ scopeKey: "session-scope", epoch: projection.cursor.epoch, token });
      if (result.status !== "page") throw new Error(`Page ${result.reason}`);
      return result.snapshot;
    },
  });

  // A snapshot without a connected cycle cannot become fresh.
  assert.equal((await session.refresh()).kind, "published");
  assert.equal(session.getState().snapshotReady, true);
  assert.equal(session.getState().fresh, false);

  const cycle = session.connect();
  assert.equal(typeof cycle, "object");
  assert.equal((await session.refresh()).kind, "published");
  replies[0].resolve({ ok: true, serverTime: "2026-11-11T00:00:00.000Z" });
  await until(() => session.getState().fresh, "freshness after snapshot + ping");
  assert.equal(session.getState().summaryReady, true);

  // Live changes apply through the composed summary.
  const { epoch } = projection.cursor;
  const liveRow = {
    ...projection.rows[0], target: { kind: "session", sessionId: "session-live" },
    execution: { kind: "session", sessionId: "session-live", turnId: "turn-live" },
  };
  assert.equal(session.apply({
    version: 1, epoch, sequence: projection.cursor.sequence + 1, type: "upsert", row: liveRow,
  }), "applied");
  const applied = session.getState();
  assert.ok(applied.summary.projection.rows.some((row) => row.target.sessionId === "session-live"));

  // A gap must force a fresh snapshot rather than silently bridging.
  const gap = session.apply({
    version: 1, epoch, sequence: projection.cursor.sequence + 5, type: "upsert", row: liveRow,
  });
  assert.equal(gap.resync, "sequence_gap");
  assert.equal(session.getState().summary.status, "resync_required");
  assert.equal(session.getState().fresh, false);

  // Suspend clears the foreground timer and aborts an in-flight probe.
  time.advance(2000);
  const beforeSuspend = replies.length;
  assert.equal(beforeSuspend, 2, "The two-second foreground probe was sent");
  assert.equal(replies[1].signal.aborted, false);
  session.suspend();
  assert.equal(session.getState().fresh, false);
  assert.equal(time.pending(), 0);
  assert.equal(replies[1].signal.aborted, true);
  session.resume();
  assert.equal(session.getState().fresh, false, "Resume alone cannot restore freshness");
  assert.equal((await session.refresh()).kind, "published");
  assert.equal(session.getState().summaryReady, true);
  replies.at(-1).resolve({ ok: true, serverTime: "2026-11-11T00:00:02.000Z" });
  await until(() => session.getState().fresh, "freshness after resumed snapshot + reply");

  // Revocation tears down children and exposes no rows.
  client.invalidateCommandCenterObservationContext(context);
  const closed = session.getState();
  assert.equal(closed.status, "invalidated");
  assert.equal(closed.summary.status, "invalidated");
  assert.equal(closed.summary.projection, null);
  assert.equal(closed.monitor.projection, null);
  assert.equal(closed.fresh, false);
  assert.equal(time.pending(), 0);
  session.dispose();
  store.dispose();
}
