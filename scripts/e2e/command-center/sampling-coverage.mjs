/** Outcome receipt follows worker verification/disposal; a later sample must exist. */
export function hasPostOutcomeSample(sample, outcome) {
  return Number.isFinite(outcome?.measurementEndedAt) &&
    Number.isFinite(sample?.timestampMs) && Number.isFinite(sample.collectionMs) && sample.collectionMs >= 0 &&
    sample.timestampMs - sample.collectionMs > outcome.measurementEndedAt;
}

/** Coverage of the measured workload, not startup/teardown or between-sample peaks. */
export function assessSamplingCoverage(samples, outcome) {
  const firstSampleAt = samples[0]?.timestampMs;
  const lastSampleAt = samples.at(-1)?.timestampMs;
  const loadStartedAt = outcome?.loadStartedAt;
  const loadEndedAt = outcome?.loadEndedAt;
  const measurementEndedAt = outcome?.measurementEndedAt;
  const failures = [];
  const validLoad = Number.isFinite(loadStartedAt) && Number.isFinite(loadEndedAt) && loadEndedAt > loadStartedAt;
  const validEnd = Number.isFinite(measurementEndedAt) && validLoad && measurementEndedAt >= loadEndedAt;
  const validSamples = Number.isFinite(firstSampleAt) && Number.isFinite(lastSampleAt);
  if (!validLoad || !validEnd) failures.push('invalid_measurement_window');
  const startCovered = validLoad && validSamples && firstSampleAt <= loadStartedAt;
  const verificationCovered = validLoad && validSamples && lastSampleAt >= loadEndedAt;
  const finalOutcomeCovered = validEnd && hasPostOutcomeSample(samples.at(-1), outcome);
  if (!startCovered) failures.push('load_start_not_covered_by_samples');
  if (!verificationCovered) failures.push('verification_not_covered_by_samples');
  if (!finalOutcomeCovered) failures.push('final_outcome_not_covered_by_samples');
  return {
    failures,
    coverage: {
      loadStartedAt: Number.isFinite(loadStartedAt) ? loadStartedAt : null,
      loadEndedAt: Number.isFinite(loadEndedAt) ? loadEndedAt : null,
      measurementEndedAt: Number.isFinite(measurementEndedAt) ? measurementEndedAt : null,
      firstSampleAt: Number.isFinite(firstSampleAt) ? firstSampleAt : null,
      lastSampleAt: Number.isFinite(lastSampleAt) ? lastSampleAt : null,
      startCovered, verificationCovered, finalOutcomeCovered,
      unsampledVerificationTailMs: validLoad && validSamples ? Math.max(0, loadEndedAt - lastSampleAt) : null,
      sampledLoadMs: validLoad && validSamples ? Math.max(0, Math.min(loadEndedAt, lastSampleAt) - Math.max(loadStartedAt, firstSampleAt)) : 0,
      loadSampleCount: validLoad ? samples.filter(s => s.timestampMs >= loadStartedAt && s.timestampMs <= loadEndedAt).length : 0,
    },
  };
}
