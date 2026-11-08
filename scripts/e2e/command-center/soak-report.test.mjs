import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSoak, distribution } from './soak-report.mjs';
import { parseOptions } from './report.mjs';
function fixture() {
  const config = { sessions: 1, ticks: 2, intervalMs: 100, contextKind: 'ascii', contextBytes: 1048576,
    durationSeconds: 1, targetBytes: 400, budgetBytes: 600, sampleMs: 100 };
  const inventory = ['coordinator', 'host', 'sidecar'].map((role, i) => ({ role, pid: i+1 }));
  const samples = Array.from({ length: 13 }, (_, i) => ({ timestampMs: i*100, collectionMs: 1,
    processes: inventory.map(p => ({ ...p, startTime: 'same', privateBytes: 150, cpuSeconds: i/10, handles: 50, threads: 4 })) }));
  const rounds = [1,2].map(index => ({ index, completed: 1, verified: 1, inputVerified: 1, verifiedBeforeDispose: true,
    unexpectedEvents: 0, outputBytes: 10, pendingWritesPeak: 1, durationMs: 500, settlementLagMs: [10],
    fixture: { requests: 1, contextVerified: 1, maxConcurrent: 1, finished: 1, aborted: 0,
      startedAt: index*400, endedAt: index*400+100, overlapMs: 100 } }));
  return { config, inventory, samples, rounds, outcome: { ...rounds[1], elapsedMs: 1000, rounds },
    telemetry: [{ eventLoopP99Ms: 20, eventLoopMaxMs: 30, pendingWrites: 1 }] };
}
test('soak distinguishes hard limit from target and sums all verified turns', () => {
  const report = assessSoak(fixture());
  assert.equal(report.status, 'PASS'); assert.equal(report.memory.targetMet, false);
  assert.equal(report.memory.peakConcurrentBytes, 450); assert.equal(report.soak.verifiedTurns, 2);
  assert.equal(report.soak.cpuSeconds.host, 1.2);
});
test('short duration, early round failure, memory breach and missing evidence fail', () => {
  for (const mutate of [e => { e.outcome.elapsedMs = 999; }, e => { e.rounds[0].verified = 0; },
    e => { e.samples[5].processes[0].privateBytes = 400; }, e => { e.rounds[0].index = 2; },
    e => { e.telemetry = []; }, e => { delete e.samples[0].processes[0].cpuSeconds; }]) {
    const e = fixture(); mutate(e); assert.equal(assessSoak(e).status, 'FAIL');
  }
});
test('duration/sample options are bounded and percentiles use actual samples', () => {
  assert.equal(parseOptions(['--duration-seconds','3600']).durationSeconds, 3600);
  assert.throws(() => parseOptions(['--duration-seconds','3601']));
  assert.throws(() => parseOptions(['--sample-ms','0']));
  assert.deepEqual(distribution([3,1,2]), { count: 3, min: 1, mean: 2, p50: 2, p95: 3, p99: 3, max: 3 });
});
