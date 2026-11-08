import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPostOutcomeSample, assessSamplingCoverage } from './sampling-coverage.mjs';

test('the exit barrier requires a fresh sample after final outcome receipt', () => {
  const outcome = { fixture: { endedAt: 500 }, loadEndedAt: 722, measurementEndedAt: 800 };
  for (const timestampMs of [500, 722, 799, 800]) assert.equal(hasPostOutcomeSample({ timestampMs, collectionMs: 0 }, outcome), false);
  assert.equal(hasPostOutcomeSample({ timestampMs: 801, collectionMs: 0 }, outcome), true);
  for (const boundary of [undefined, null, NaN, Infinity]) {
    assert.equal(hasPostOutcomeSample({ timestampMs: 801, collectionMs: 0 }, { measurementEndedAt: boundary }), false);
  }
  assert.equal(hasPostOutcomeSample(undefined, outcome), false);
  assert.equal(hasPostOutcomeSample({ timestampMs: 820, collectionMs: 30 }, outcome), false);
  assert.equal(hasPostOutcomeSample({ timestampMs: 820, collectionMs: 10 }, outcome), true);
  for (const collectionMs of [undefined, NaN, -1]) assert.equal(hasPostOutcomeSample({ timestampMs: 820, collectionMs }, outcome), false);
});

test('coverage exposes the observed 222ms verification tail instead of a pass', () => {
  const result = assessSamplingCoverage([{ timestampMs: 0 }, { timestampMs: 1000 }],
    { loadStartedAt: 100, loadEndedAt: 1222, measurementEndedAt: 1250 });
  assert.equal(result.coverage.unsampledVerificationTailMs, 222);
  assert.equal(result.coverage.sampledLoadMs, 900);
  assert.equal(result.coverage.verificationCovered, false);
  assert.equal(result.coverage.finalOutcomeCovered, false);
  assert.ok(result.failures.includes('verification_not_covered_by_samples'));
});
