import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRun, parseOptions } from './report.mjs';

function evidence() {
  const config = { sessions: 3, ticks: 3, intervalMs: 100, contextBytes: 131072, budgetBytes: 1000 };
  const inventory = ['coordinator', 'host', 'sidecar'].map((role, i) => ({ role, pid: i + 10 }));
  const samples = [0, 100, 200, 300, 400].map(timestampMs => ({ timestampMs, collectionMs: 2,
    processes: inventory.map(p => ({ ...p, startTime: 'origin', privateBytes: 100, workingSetBytes: 50 })) }));
  const outcome = { completed: 3, verified: 3, unexpectedEvents: 0,
    fixture: { requests: 3, maxConcurrent: 3, aborted: 0, finished: 3, overlapMs: 200, startedAt: 100, endedAt: 300 } };
  return { config, inventory, samples, outcome };
}

test('reports concurrent process sums, not the sum of separate per-process peaks', () => {
  const e = evidence();
  e.samples[1].processes[0].privateBytes = 600;
  e.samples[2].processes[1].privateBytes = 650;
  const report = assessRun(e);
  assert.equal(report.status, 'PASS');
  assert.equal(report.memory.peakConcurrentBytes, 850);
  assert.equal(report.fullWorkbenchAcceptance, 'NOT_RUN');
  assert.equal(report.workload.contextTokens, 'NOT_MEASURED');
});

test('cannot pass from RSS alone, missing samples, or a reused PID', () => {
  for (const mutate of [
    e => { delete e.samples[2].processes[1].privateBytes; },
    e => { e.samples[2].processes.pop(); },
    e => { e.samples[2].processes[1].startTime = 'replacement'; },
    e => { e.samples = []; },
    e => { e.inventory[1].pid = e.inventory[0].pid; },
  ]) {
    const e = evidence(); mutate(e); assert.equal(assessRun(e).status, 'FAIL');
  }
});

test('queued/serial work, truncated transcripts and incomplete streams fail', () => {
  for (const mutate of [
    e => { e.outcome.fixture.maxConcurrent = 1; },
    e => { e.outcome.verified = 2; },
    e => { e.outcome.fixture.aborted = 1; },
    e => { e.outcome.fixture.overlapMs = 50; },
    e => { e.outcome.fixture.requests = 4; },
    e => { e.samples = e.samples.slice(2); },
    e => { e.outcome.unexpectedEvents = 1; },
  ]) {
    const e = evidence(); mutate(e); assert.equal(assessRun(e).status, 'FAIL');
  }
});

test('budget breach fails, and slow collection is reported rather than hidden', () => {
  const e = evidence(); e.config.budgetBytes = 299;
  assert.ok(assessRun(e).failures.includes('memory_budget_exceeded'));
  e.config.budgetBytes = 1000; e.samples.splice(2, 1);
  assert.equal(assessRun(e).memory.samplingTargetMet, false);
  assert.equal(assessRun(e).memory.maxGapMs, 200);
});

test('CLI rejects unbounded/ambiguous inputs and unknown options', () => {
  assert.equal(parseOptions([]).sessions, 12);
  assert.equal(parseOptions(['--sessions', '36']).sessions, 36);
  assert.equal(parseOptions(['--context-bytes', '1048576', '--context-kind', 'utf8']).contextBytes, 1048576);
  assert.throws(() => parseOptions(['--context-bytes', '1048577']));
  assert.throws(() => parseOptions(['--context-kind', 'unknown']));
  for (const args of [['--sessions','37'],['--sessions','1.5'],['--ticks','0'],['--context-bytes','99999999'],['--budget-bytes','NaN'],['--api-key','secret']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('duplicate inventory and inconsistent timing cannot produce a passing report', () => {
  for (const mutate of [
    e => { e.inventory.push(e.inventory[0]); },
    e => { e.outcome.fixture.startedAt = null; },
    e => { e.outcome.fixture.overlapMs = 500; },
    e => { delete e.samples[2].collectionMs; },
  ]) {
    const e = evidence(); mutate(e); assert.equal(assessRun(e).status, 'FAIL');
  }
});

test('new context evidence requires full provider ingress and durable verification before disposal', () => {
  const e = evidence(); e.config.contextKind = 'utf8';
  assert.ok(assessRun(e).failures.includes('context_or_durability_not_proven'));
  e.outcome.fixture.contextVerified = 3; e.outcome.inputVerified = 3; e.outcome.verifiedBeforeDispose = true;
  assert.equal(assessRun(e).status, 'PASS');
  e.outcome.inputVerified = 2;
  assert.equal(assessRun(e).status, 'FAIL');
});
