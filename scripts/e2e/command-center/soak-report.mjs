import { assessRun } from './report.mjs';

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
  return { count: sorted.length, min: sorted[0] ?? null, mean: sorted.length ? sorted.reduce((a,b) => a+b, 0) / sorted.length : null,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? null };
}

export function assessSoak({ config, inventory, samples, outcome, rounds, telemetry }) {
  const last = assessRun({ config, inventory, samples, outcome });
  const failures = new Set(last.failures);
  if (!(outcome?.elapsedMs >= config.durationSeconds * 1000)) failures.add('soak_duration_not_met');
  if (!rounds.length || outcome?.rounds?.length !== rounds.length) failures.add('missing_round_evidence');
  for (const [index, round] of rounds.entries()) {
    if (round.index !== index + 1) failures.add('round_sequence_invalid');
    if (!(round.durationMs > 0) || !round.settlementLagMs?.every(Number.isFinite) || round.settlementLagMs.length !== config.sessions) failures.add('round_metrics_invalid');
    for (const failure of assessRun({ config, inventory, samples, outcome: round }).failures) failures.add(`round_${index+1}:${failure}`);
  }
  if (!telemetry.length || telemetry.some(item => !Number.isFinite(item.eventLoopP99Ms))) failures.add('missing_runtime_telemetry');
  const sums = samples.map(sample => sample.processes.reduce((sum, p) => sum + (p.privateBytes ?? 0), 0));
  const cpuSeconds = {};
  for (const role of ['coordinator', 'host', 'sidecar']) {
    const rows = samples.map(sample => sample.processes.find(p => p.role === role));
    if (rows.some(row => !Number.isFinite(row?.cpuSeconds) || !Number.isFinite(row?.handles) || !Number.isFinite(row?.threads))) failures.add('missing_process_metrics');
    cpuSeconds[role] = rows.length ? rows.at(-1)?.cpuSeconds - rows[0]?.cpuSeconds : null;
  }
  const elapsedMs = outcome?.elapsedMs ?? 0;
  const verified = rounds.reduce((sum, round) => sum + round.verified, 0);
  return { ...last, status: failures.size ? 'FAIL' : 'PASS', failures: [...failures],
    scope: 'headless-session-runtime-soak',
    memory: { ...last.memory, targetBytes: config.targetBytes, targetMet: last.memory.peakConcurrentBytes <= config.targetBytes,
      distributionBytes: distribution(sums), samplesAboveTarget: sums.filter(bytes => bytes > config.targetBytes).length },
    workload: { ...last.workload, durationSeconds: config.durationSeconds, historyPolicy: 'verify then clear synthetic history between rounds; same services and processes' },
    soak: { elapsedMs, completedRounds: rounds.length, verifiedTurns: verified,
      inputBytes: verified * config.contextBytes, outputBytes: rounds.reduce((sum, round) => sum + round.outputBytes, 0),
      turnsPerMinute: elapsedMs ? verified / elapsedMs * 60000 : 0,
      allStreamOverlapMs: rounds.reduce((sum, round) => sum + round.fixture.overlapMs, 0),
      roundDurationMs: distribution(rounds.map(round => round.durationMs)),
      settlementLagMs: distribution(rounds.flatMap(round => round.settlementLagMs)),
      pendingWritesPeak: Math.max(0, ...rounds.map(round => round.pendingWritesPeak), ...telemetry.map(item => item.pendingWrites)),
      eventLoopWindowP99Ms: distribution(telemetry.map(item => item.eventLoopP99Ms)),
      eventLoopMaxMs: Math.max(0, ...telemetry.map(item => item.eventLoopMaxMs)), cpuSeconds },
    exclusions: last.exclusions.filter(item => item !== 'long-history/soak qualification').concat('unbounded history growth', 'other workload soak qualification'),
  };
}
