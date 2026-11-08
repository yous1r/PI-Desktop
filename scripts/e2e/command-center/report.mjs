import { parseArgs } from 'node:util';

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    sessions: { type: 'string', default: '12' },
    ticks: { type: 'string', default: '50' },
    'interval-ms': { type: 'string', default: '100' },
    'context-bytes': { type: 'string', default: '131072' },
    'context-kind': { type: 'string', default: 'ascii' },
    'budget-bytes': { type: 'string', default: '4000000000' },
    'duration-seconds': { type: 'string', default: '0' },
    'target-bytes': { type: 'string', default: '4000000000' },
    'sample-ms': { type: 'string', default: '100' },
    'host-bin': { type: 'string' },
    'scratch-dir': { type: 'string' },
    help: { type: 'boolean', default: false },
  }, allowPositionals: false, strict: true });
  function integer(key, min, max) {
    const raw = values[key];
    if (!/^\d+$/.test(raw ?? '')) throw new Error(`--${key} must be an integer`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`--${key} must be ${min}..${max}`);
    return n;
  }
  if (!['ascii', 'utf8'].includes(values['context-kind'])) throw new Error('--context-kind must be ascii or utf8');
  return {
    sessions: integer('sessions', 1, 36), ticks: integer('ticks', 2, 600),
    intervalMs: integer('interval-ms', 20, 1000), contextBytes: integer('context-bytes', 0, 1048576),
    contextKind: values['context-kind'],
    budgetBytes: integer('budget-bytes', 1, 16_000_000_000),
    durationSeconds: integer('duration-seconds', 0, 3600), targetBytes: integer('target-bytes', 1, 16_000_000_000),
    sampleMs: integer('sample-ms', 100, 1000),
    hostBin: values['host-bin'], scratchDir: values['scratch-dir'], help: values.help,
  };
}

export function assessRun({ config, inventory, samples, outcome }) {
  const failures = [];
  const expected = new Map(inventory.map(p => [p.role, p.pid]));
  if (inventory.length !== 3 || expected.size !== 3 || !['coordinator', 'host', 'sidecar'].every(role => expected.has(role))) {
    failures.push('incomplete_process_inventory');
  }
  if (new Set(inventory.map(p => p.pid)).size !== 3 || inventory.some(p => !Number.isInteger(p.pid) || p.pid <= 0)) failures.push('invalid_process_identity');
  const identities = new Map();
  let peakBytes = 0, maxGapMs = 0, maxCollectionMs = 0, lastTimestamp;
  if (samples.length < 2) failures.push('insufficient_memory_samples');
  for (const sample of samples) {
    const seen = new Set(); let total = 0;
    if (!Number.isFinite(sample.timestampMs)) { failures.push('invalid_timestamp'); continue; }
    if (!Number.isFinite(sample.collectionMs) || sample.collectionMs < 0) failures.push('invalid_collection_duration');
    else maxCollectionMs = Math.max(maxCollectionMs, sample.collectionMs);
    if (lastTimestamp !== undefined) {
      if (sample.timestampMs <= lastTimestamp) failures.push('non_monotonic_samples');
      maxGapMs = Math.max(maxGapMs, sample.timestampMs - lastTimestamp);
    }
    lastTimestamp = sample.timestampMs;
    for (const p of sample.processes ?? []) {
      if (!expected.has(p.role) || expected.get(p.role) !== p.pid || seen.has(p.role)) failures.push('unexpected_process_identity');
      seen.add(p.role);
      if (!p.startTime || p.missing || !Number.isFinite(p.privateBytes) || p.privateBytes < 0) {
        failures.push('incomplete_memory_sample'); continue;
      }
      const before = identities.get(p.role);
      if (before && before !== p.startTime) failures.push('process_replaced_during_measurement');
      identities.set(p.role, p.startTime);
      total += p.privateBytes;
    }
    if (seen.size !== 3 || [...expected.keys()].some(role => !seen.has(role))) failures.push('incomplete_memory_sample');
    peakBytes = Math.max(peakBytes, total);
  }
  if (peakBytes > config.budgetBytes) failures.push('memory_budget_exceeded');
  if (!outcome || outcome.error || outcome.unexpectedEvents > 0) failures.push('runtime_failure');
  if (outcome?.diagnostics?.length) failures.push('runtime_diagnostics');
  if (outcome?.completed !== config.sessions || outcome?.verified !== config.sessions) failures.push('incomplete_transcripts');
  if (config.contextKind && (outcome?.fixture?.contextVerified !== config.sessions || outcome?.inputVerified !== config.sessions || outcome?.verifiedBeforeDispose !== true)) failures.push('context_or_durability_not_proven');
  if (outcome?.fixture?.maxConcurrent !== config.sessions || outcome?.fixture?.requests !== config.sessions) failures.push('concurrency_not_proven');
  if (outcome?.fixture?.aborted !== 0 || outcome?.fixture?.finished !== config.sessions) failures.push('stream_did_not_finish');
  if (!(outcome?.fixture?.overlapMs >= (config.ticks - 1) * config.intervalMs)) failures.push('overlap_too_short');
  const start = outcome?.fixture?.startedAt, end = outcome?.fixture?.endedAt;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start !== outcome?.fixture?.overlapMs) failures.push('invalid_overlap_timing');
  const during = samples.filter(s => s.timestampMs >= start && s.timestampMs <= end);
  if (!during.length || samples[0]?.timestampMs > start || samples.at(-1)?.timestampMs < end) failures.push('load_not_covered_by_samples');
  const uniqueFailures = [...new Set(failures)];
  return {
    status: uniqueFailures.length ? 'FAIL' : 'PASS', failures: uniqueFailures,
    scope: 'headless-session-runtime-baseline', fullWorkbenchAcceptance: 'NOT_RUN',
    memory: { metric: 'Windows Private Bytes', peakConcurrentBytes: peakBytes, budgetBytes: config.budgetBytes,
      sampleCount: samples.length, loadSampleCount: during.length, maxGapMs, maxCollectionMs,
      samplingTargetMs: config.sampleMs ?? 100, samplingTargetMet: samples.length >= 2 && maxGapMs <= (config.sampleMs ?? 100) && maxCollectionMs <= (config.sampleMs ?? 100),
      limitation: 'Sampled maximum only; process readings within each sample are sequential. No OS allocation trace. Includes test coordinator/provider overhead; excludes outer test driver, sampler, desktop renderer/plugins/native resources.' },
    workload: { sessions: config.sessions, topology: 'independent main sessions', contextBytes: config.contextBytes,
      contextKind: config.contextKind ?? 'ascii', contextTokens: 'NOT_MEASURED', ticks: config.ticks, intervalMs: config.intervalMs },
    exclusions: ['native subagents', 'RACP/browser transport', 'headless launch resolver', 'desktop renderer', 'native programs', 'tools/mixed workload', 'real providers', 'long-history/soak qualification'],
  };
}
