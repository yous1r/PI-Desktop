import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Deterministic local clock; never waits for real time or starts a connection. */
function scheduler() {
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

export async function checkConnectionHealthConsumer(client, owner, page) {
  const context = client.createCommandCenterObservationContext();
  client.bindCommandCenterObservationOwner(context, owner);
  const time = scheduler();
  const replies = [];
  const notices = [];
  const observations = [];
  const nextState = (predicate) => {
    const result = deferred();
    observations.push({ predicate, resolve: result.resolve });
    return result.promise;
  };
  const health = client.createCommandCenterConnectionHealth(context, {
    ...time,
    onState(state) {
      notices.push(state);
      for (let index = observations.length - 1; index >= 0; index -= 1) {
        if (observations[index].predicate(state)) observations.splice(index, 1)[0].resolve(state);
      }
    },
    ping(signal) {
      const reply = deferred();
      replies.push({ ...reply, signal });
      return reply.promise;
    },
  });
  const completePage = { version: page.version, cursor: page.cursor, generatedAt: page.generatedAt, rows: page.rows };
  const reader = client.createCommandCenterMonitorReader(context, async () => completePage);
  const firstCycle = health.connect();
  assert.equal(health.getState().freshness, "stale");
  assert.equal((await reader.refresh()).kind, "published");
  assert.equal(health.completeResync(firstCycle), true);
  assert.equal(health.getState().freshness, "stale", "A snapshot alone is not a health reply");
  const firstFresh = nextState((state) => state.freshness === "fresh");
  replies[0].resolve({ ok: true, serverTime: "2026-01-01T00:00:00.000Z" });
  await firstFresh;
  assert.equal(health.getState().freshness, "fresh");
  time.advance(6000);
  assert.equal(notices.at(-1).freshness, "stale", "Deadline changes notify the consumer without polling");
  assert.equal(health.getState().freshness, "stale");
  assert.equal(replies.length, 3, "Only two unsettled original pings may accumulate");
  health.suspend();
  assert.equal(time.pending(), 0);
  assert.equal(replies[1].signal.aborted, true);
  assert.equal(replies[2].signal.aborted, true);
  replies[1].resolve({ ok: true, serverTime: "2026-01-01T00:00:01.000Z" });
  replies[2].resolve({ ok: true, serverTime: "2026-01-01T00:00:02.000Z" });
  await replies[1].promise;
  await replies[2].promise;
  assert.equal(health.getState().freshness, "stale");
  const resumed = health.resume();
  assert.equal(health.completeResync(firstCycle), false, "An old snapshot cannot complete the resumed cycle");
  assert.equal((await reader.refresh()).kind, "published");
  // Original cross-realm ping promises may still occupy the budget at resume;
  // the next scheduled foreground probe runs after their settlement.
  time.advance(8000);
  const resumedReply = nextState((state) => state.lastReplyAtMs !== null);
  replies[3].resolve({ ok: true, serverTime: "2026-01-01T00:00:03.000Z" });
  await resumedReply;
  assert.equal(health.getState().freshness, "stale", "Resume requires fresh synchronization as well as liveness");
  assert.equal(health.completeResync(resumed), true);
  assert.equal(health.getState().freshness, "fresh");
  client.invalidateCommandCenterObservationContext(context);
  assert.equal(health.getState().status, "invalidated");
  assert.equal(health.getState().freshness, "stale");
  assert.equal(reader.getState().projection, null);
  assert.equal(time.pending(), 0);
  reader.dispose();
  health.dispose();
  const closedNotices = notices.length;
  time.advance(18_000);
  assert.equal(notices.length, closedNotices, "Closed controllers retain no timer notification work");
}
