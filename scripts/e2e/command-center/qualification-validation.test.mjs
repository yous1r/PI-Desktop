import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUALIFICATION_METRICS,
  buildWorkloadManifest,
  manifestDigest,
} from './qualification-manifest.mjs';
import {
  assessEnvironmentReadiness,
  assessQualificationEvidence,
  assessQualificationReadiness,
  percentile,
  validateManifest,
} from './qualification-validation.mjs';

const CANDIDATE = Object.freeze({
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  hostBinarySha256: 'c'.repeat(64),
  nodeVersion: 'v24.12.0',
  sourceWorktree: 'D:/Packages/PI-Desktop/worktrees/owner-local-control',
  baseAncestryVerified: true,
});

const MANIFEST = buildWorkloadManifest({ candidate: CANDIDATE });
const BASE = 1_700_000_000_000;
const HIGH = 'd'.repeat(64);

/** One fully populated evidence bundle shape; mutations below make it fail. */
function validEvidence() {
  const processes = [['electron-main', 4100], ['renderer', 4104], ['rust-host', 4108], ['agent-sidecar', 4112], ['plugin-worker', 4116]]
    .map(([role, pid]) => ({ role, pid, startTime: `ft-${pid}`, startedAt: BASE - 60_000,
      exitObservedAt: BASE + 7_230_000, scope: 'application-owned', owner: 'q0-fixture' }));
  const executions = MANIFEST.executions.map((planned, index) => ({
    executionId: planned.executionId,
    workspaceId: planned.workspaceId,
    role: planned.role,
    startedAt: BASE + index * 5,
    endedAt: BASE + 12_000,
    inputSha256: planned.inputShape.inputSha256,
    settlement: { verified: true, outputSha256: HIGH },
  }));
  const memorySamples = [];
  for (let timestampMs = BASE - 200; timestampMs <= BASE + 13_200; timestampMs += 100) {
    memorySamples.push({ timestampMs, collectionMs: 4, processes: processes.map((entry) => ({
      role: entry.role, pid: entry.pid, startTime: entry.startTime, privateBytes: 120_000_000 })) });
  }
  return {
    schema: 'q0-qualification-evidence@1',
    manifestSha256: MANIFEST.manifestSha256,
    candidate: { head: MANIFEST.candidate.head, base: MANIFEST.candidate.base,
      hostBinarySha256: MANIFEST.candidate.hostBinarySha256, nodeVersion: MANIFEST.candidate.nodeVersion },
    provider: { kind: 'deterministic-fixture', id: 'q0-local-fixture', version: '0' },
    workloadKind: 'mixed-2-6-4',
    tokenMeasurement: {
      method: 'tokenizer-count',
      tokenizer: { id: 'q0-tokenizer', version: '1', sha256: 'e'.repeat(64) },
      counts: MANIFEST.executions.map((execution) => ({ executionId: execution.executionId, inputTokens: 32_000 })),
      measuredAt: '2026-11-08T00:00:00.000Z',
      toolCommand: 'node scripts/q0/count-tokens.mjs --corpus <sha256>',
    },
    executions,
    processes,
    memorySamples,
    window: { loadStartedAt: BASE, loadEndedAt: BASE + 12_000, measurementEndedAt: BASE + 13_000,
      soakStartedAt: BASE, soakEndedAt: BASE + 7_200_000 },
    latency: {
      'local-input-to-paint': Array.from({ length: 1200 }, (_, index) => (index % 12 === 0 ? 90 : 60)),
      'warm-workspace-switch': Array.from({ length: 1200 }, (_, index) => (index % 12 === 0 ? 230 : 120)),
      'host-stop-admission': Array.from({ length: 1200 }, (_, index) => (index % 12 === 0 ? 470 : 250)),
    },
    lifecycle: {
      durationMs: 7_200_000,
      cycles: Array.from({ length: 100 }, (_, index) => ({ index: index + 1, attachAt: BASE + index * 60_000,
        detachAt: BASE + index * 60_000 + 30_000, maximizeAt: BASE + index * 60_000 + 10_000 })),
      postWarmupBaselineBytes: 900_000_000,
      finalSteadyBytes: 950_000_000,
    },
    cleanup: { observer: 'owned-spawn-preload', observedProcesses: processes.length,
      exitedProcesses: processes.length, orphaned: 0, proven: true, unobservedGaps: 0 },
    disclosure: {
      processCoverage: ['application-owned only; outer test driver excluded'],
      samplingLimits: ['sequential reads within one sample; no OS allocation trace'],
      excludedRoles: ['outer driver', 'sampler'],
      sequencing: ['load, verification and teardown windows recorded'],
    },
  };
}

function mutateManifest(mutate) {
  const clone = structuredClone(MANIFEST);
  mutate(clone);
  clone.manifestSha256 = manifestDigest(clone);
  return clone;
}

function mutatingEvidence(mutate) {
  const evidence = validEvidence();
  mutate(evidence);
  return evidence;
}

test('a complete bundle passes the contract but never accepts the product', () => {
  const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: validEvidence() });
  assert.deepEqual(result.failures, []);
  assert.equal(result.status, 'PASS_WITH_STATED_LIMITS');
  assert.equal(result.productAcceptance, 'NOT_ACCEPTED');
  assert.equal(result.providerQualification, 'NOT_RUN');
  assert.equal(result.measurements.peakConcurrentPrivateBytes, 600_000_000);
  assert.equal(result.measurements.overlap.simultaneous, 36);
  assert.equal(result.measurements.overlap.durationMs, 11_825);
  assert.deepEqual(result.measurements.overlap.rolesAtOverlap, {
    'ws1:main': 2, 'ws1:native-child': 6, 'ws1:worker': 4,
    'ws2:main': 2, 'ws2:native-child': 6, 'ws2:worker': 4,
    'ws3:main': 2, 'ws3:native-child': 6, 'ws3:worker': 4,
  });
  assert.equal(result.measurements.lifecycle.residualGrowthRatio.toFixed(3), '0.056');
  assert.equal(result.measurements.latency['local-input-to-paint'].p95, 90);
  assert.match(result.acceptanceNote, /cannot accept product behavior/);
});

test('valid manifest identity is recomputed, not trusted', () => {
  const check = validateManifest(MANIFEST);
  assert.equal(check.ok, true);
  assert.equal(check.identity.manifestSha256, MANIFEST.manifestSha256);
  assert.equal(check.identity.executions, 36);
  assert.equal(validateManifest(mutateManifest(() => {})).ok, true);
  const stale = structuredClone(MANIFEST);
  stale.corpus.sha256 = '0'.repeat(64);
  assert.ok(validateManifest(stale).failures.includes('manifest_digest_mismatch'));
});

test('mutated manifests cannot hide a substituted quota, gate, corpus or synthetic roles', () => {
  const cases = [
    [mutateManifest((manifest) => { manifest.quota.agentsPerWorkspace = 13; }), 'quota_contract_changed:agentsPerWorkspace'],
    [mutateManifest((manifest) => { manifest.quota.rpcInFlightLimit = 64; }), 'quota_contract_changed:rpcInFlightLimit'],
    [mutateManifest((manifest) => { manifest.quota.nativeChildrenPerSession = 12; }), 'quota_contract_changed:nativeChildrenPerSession'],
    [mutateManifest((manifest) => { manifest.target.cpuCores = 4; }), 'minimum_hardware_target_changed:cpuCores'],
    [mutateManifest((manifest) => { manifest.metrics.latency[0].maxP95Ms = 500; }), 'metric_gate_changed:latency'],
    [mutateManifest((manifest) => { manifest.metrics.memory.privateBytesMax = 6_000_000_000; }), 'metric_gate_changed:memory'],
    [mutateManifest((manifest) => { manifest.executions.pop(); }), 'execution_set_incomplete'],
    [mutateManifest((manifest) => { manifest.executions[1].executionId = manifest.executions[0].executionId; }), 'execution_identity_duplicate'],
    [mutateManifest((manifest) => { for (const execution of manifest.executions) { execution.role = 'main'; execution.parentExecutionId = null; } }), 'workspace_topology_changed:ws1:native-child'],
    [mutateManifest((manifest) => { manifest.executions[0].workspaceId = 'ws4'; }), 'workspace_set_changed'],
    [mutateManifest((manifest) => { manifest.corpus.sha256 = '0'.repeat(64); }), 'corpus_digest_mismatch'],
    [mutateManifest((manifest) => { manifest.corpus.kinds = ['ascii']; }), 'corpus_not_mixed:prose'],
    [mutateManifest((manifest) => { manifest.candidate.head = 'abc'; }), 'candidate_commit_invalid'],
    [mutateManifest((manifest) => { manifest.candidate.baseAncestryVerified = false; }), 'candidate_base_ancestry_unverified'],
    [mutateManifest((manifest) => { manifest.tokenizer.status = 'unavailable'; manifest.tokenizer.consequence = ''; }), 'tokenizer_unavailable_without_consequence'],
    [mutateManifest((manifest) => { manifest.inputTokens.target = 16_000; }), 'token_target_changed'],
    [mutateManifest((manifest) => { manifest.inputShape.tokens = 32_000; }), 'tokens_inferred_from_bytes:tokens'],
    [mutateManifest((manifest) => { manifest.executions[0].inputTokens = 32_000; }), 'tokens_inferred_from_bytes:inputTokens'],
    [mutateManifest((manifest) => { manifest.disclosure.required = ['processCoverage']; }), 'disclosure_contract_changed'],
  ];
  for (const [manifest, failure] of cases) {
    const check = validateManifest(manifest);
    assert.equal(check.ok, false, failure);
    assert.ok(check.failures.includes(failure), `${failure} not reported: ${check.failures.join(', ')}`);
  }
});

test('environment matrix keeps missing hardware and devices missing', () => {
  const developmentHost = {
    host: { platform: 'win32', osVersion: '10.0.19045', logicalCpus: 6, memoryBytes: 25_161_392_000, storage: 'ssd',
      cpuModel: 'Genuine Intel(R) 0000', isNominatedTarget: false },
    tokenizer: { status: 'unavailable' },
    fixtures: {},
    nativePrograms: [],
    interactive: {},
    devices: {},
    crossClient: {},
    nativePlatformRunners: [],
  };
  const blocked = assessEnvironmentReadiness(developmentHost, MANIFEST);
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(blocked.blockedBy, ['E1', 'E2', 'E3', 'E4', 'E5']);
  assert.equal(blocked.environments.E1.status, 'MISSING');
  assert.equal(blocked.environments.E1.comparisonOnly, true);
  assert.ok(blocked.environments.E1.missing.includes('nominated_minimum_target_host'));
  assert.ok(blocked.environments.E2.missing.includes('installed_tokenizer'));
  assert.deepEqual(blocked.programs, { Q1: [], Q2: [], Q3: [] });
  assert.equal(blocked.providerQualification, 'NOT_RUN');

  const nominated = {
    host: { platform: 'win32', osVersion: '10.0.20348', logicalCpus: 2, memoryBytes: 8_000_000_000, storage: 'ssd',
      cpuModel: 'nominated-vcpu', isNominatedTarget: true },
    tokenizer: { status: 'available' },
    fixtures: { pluginVersions: ['q0-fixture-plugins@1'], toolVersions: ['q0-tool-read@1'], providerQuotaRecorded: true },
    nativePrograms: [{ id: 'notepad', version: '10.0.19041', privilege: 'standard', verified: true }],
    interactive: { rdp: true, dpi: true, ime: true, dialogs: true, dpiScales: [100, 125, 150, 200] },
    devices: { android: [{ osVersion: '14', browser: 'Chrome', browserVersion: '120' }],
      ios: [{ osVersion: '17.2', browser: 'Safari', browserVersion: '17.2' }] },
    crossClient: { httpsEdge: true, enrollment: true, revocation: true, networkFaults: true },
    nativePlatformRunners: [{ platform: 'macos', displayServer: 'aqua' }, { platform: 'linux', displayServer: 'wayland' }],
  };
  const ready = assessEnvironmentReadiness(nominated, MANIFEST);
  assert.equal(ready.status, 'READY');
  assert.deepEqual(ready.programs, { Q1: ['E1', 'E2'], Q2: ['E3'], Q3: ['E4'] });

  const vm = assessEnvironmentReadiness({ ...nominated, host: { ...nominated.host, logicalCpus: 2, memoryBytes: 8_000_000_000, isNominatedTarget: false } }, MANIFEST);
  assert.equal(vm.environments.E1.status, 'MISSING');
  assert.deepEqual(vm.programs.Q1, []);

  const partial = assessEnvironmentReadiness({ ...nominated, interactive: {}, devices: {} }, MANIFEST);
  assert.equal(partial.environments.E3.status, 'MISSING');
  assert.equal(partial.environments.E4.status, 'MISSING');
  assert.deepEqual(partial.programs.Q2, []);
  assert.deepEqual(partial.programs.Q3, []);
});

test('empty observations fail with explicit codes instead of passing silently', () => {
  const empty = {
    schema: 'q0-qualification-evidence@1',
    manifestSha256: MANIFEST.manifestSha256,
    candidate: validEvidence().candidate,
    provider: { kind: 'deterministic-fixture', id: 'q0-local-fixture', version: '0' },
    workloadKind: 'mixed-2-6-4',
    executions: [],
    processes: [],
    memorySamples: [],
    window: {},
    latency: {},
    lifecycle: {},
    cleanup: {},
    disclosure: {},
  };
  const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: empty });
  assert.equal(result.status, 'FAIL');
  for (const failure of ['execution_observation_incomplete', 'process_inventory_missing', 'memory_observation_missing',
    'latency_metric_missing:local-input-to-paint', 'soak_duration_not_met', 'soak_cycles_not_met',
    'cleanup_unproven', 'cleanup_observer_unknown', 'token_measurement_missing',
    'disclosure_missing:samplingLimits', 'baseline_missing']) {
    assert.ok(result.failures.includes(failure), `${failure} missing from ${result.failures.join(', ')}`);
  }
  assert.equal(result.productAcceptance, 'NOT_ACCEPTED');
  assert.equal(assessQualificationEvidence({ manifest: MANIFEST }).failures[0], 'evidence_missing');
});

test('evidence must stay bound to the candidate and manifest identities', () => {
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST,
    evidence: mutatingEvidence((evidence) => { evidence.manifestSha256 = 'f'.repeat(64); }) }).failures.includes('evidence_not_bound_to_manifest'));
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST,
    evidence: mutatingEvidence((evidence) => { evidence.candidate.head = 'f'.repeat(40); }) }).failures.includes('candidate_provenance_mismatch:head'));
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST,
    evidence: mutatingEvidence((evidence) => { evidence.candidate.hostBinarySha256 = 'f'.repeat(64); }) }).failures.includes('candidate_provenance_mismatch:hostBinarySha256'));
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST,
    evidence: mutatingEvidence((evidence) => { evidence.executions[0].inputSha256 = HIGH; }) }).failures.includes(`execution_input_mismatch:${MANIFEST.executions[0].executionId}`));
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST,
    evidence: mutatingEvidence((evidence) => { evidence.executions[3].executionId = 'q0-ws9-main-01'; }) }).failures.includes('execution_identity_unknown'));
  const invalid = assessQualificationEvidence({ manifest: mutateManifest((manifest) => { manifest.quota.agentsPerHost = 37; }), evidence: validEvidence() });
  assert.equal(invalid.status, 'INVALID_MANIFEST');
  assert.equal(invalid.productAcceptance, 'NOT_ACCEPTED');
});

test('the synthetic main-only P0 workload is not accepted as the mixed load', () => {
  const synthetic = mutatingEvidence((evidence) => {
    evidence.contextBytes = 1_048_576;
    evidence.contextKind = 'ascii';
    evidence.workload = { topology: 'independent main sessions' };
    evidence.workloadKind = 'p0-1mib-main-only';
    evidence.executions = evidence.executions.map((execution) => ({ ...execution, role: 'main' }));
  });
  const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: synthetic });
  for (const failure of ['synthetic_workload_not_equivalent:contextBytes', 'synthetic_workload_not_equivalent:contextKind',
    'synthetic_workload_not_equivalent:topology', 'synthetic_workload_not_equivalent:workloadKind',
    'synthetic_workload_not_equivalent:roles']) {
    assert.ok(result.failures.includes(failure), failure);
  }
  assert.equal(result.status, 'FAIL');
});

test('tokens must be counted, in band, complete and from an identified tokenizer', () => {
  for (const [mutate, failure] of [
    [(evidence) => { evidence.tokenMeasurement.method = 'byte-ratio'; }, 'token_measurement_not_counted'],
    [(evidence) => { evidence.tokenMeasurement.method = 'estimated'; }, 'token_measurement_not_counted'],
    [(evidence) => { evidence.tokenMeasurement.counts = []; }, 'token_measurement_empty'],
    [(evidence) => { delete evidence.tokenMeasurement.tokenizer.sha256; }, 'tokenizer_identity_missing'],
    [(evidence) => { evidence.tokenMeasurement.counts = evidence.tokenMeasurement.counts.map((count) => ({ ...count, inputTokens: 40_000 })); }, `token_count_out_of_band:${MANIFEST.executions[0].executionId}`],
    [(evidence) => { evidence.tokenMeasurement.counts = evidence.tokenMeasurement.counts.slice(1); }, 'token_measurement_coverage_incomplete'],
    [(evidence) => { delete evidence.tokenMeasurement; }, 'token_measurement_missing'],
  ]) {
    const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: mutatingEvidence(mutate) });
    assert.ok(result.failures.includes(failure), `${failure} not reported`);
    assert.equal(result.status, 'FAIL');
  }
  const inferred = buildWorkloadManifest({ candidate: CANDIDATE, tokenizer: { ...MANIFEST.tokenizer } });
  assert.ok(validateManifest({ ...structuredClone(inferred), manifestSha256: 'f'.repeat(64) }).failures.includes('manifest_digest_mismatch'));
});

test('sequential execution cannot pass as thirty-six overlapping executions', () => {
  const sequential = mutatingEvidence((evidence) => {
    evidence.executions = evidence.executions.map((execution, index) => ({ ...execution,
      startedAt: BASE + index * 20_000, endedAt: BASE + index * 20_000 + 5_000 }));
  });
  const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: sequential });
  assert.ok(result.failures.includes('no_mixed_36_overlap:simultaneous'));
  assert.ok(result.failures.includes('no_mixed_36_overlap:ws1:native-child'));
  assert.ok(result.failures.includes('overlap_too_short'));
  assert.equal(result.measurements.overlap.simultaneous, 1);
  const shortOverlap = mutatingEvidence((evidence) => {
    evidence.executions = evidence.executions.map((execution) => ({ ...execution, endedAt: BASE + 2_000 }));
  });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: shortOverlap }).failures.includes('overlap_too_short'));
});

test('sampling gaps, missing processes and slow collection are refused', () => {
  const gap = mutatingEvidence((evidence) => { evidence.memorySamples.splice(40, 3); });
  const gapResult = assessQualificationEvidence({ manifest: MANIFEST, evidence: gap });
  assert.ok(gapResult.failures.includes('sampling_interval_exceeded'));

  const missing = mutatingEvidence((evidence) => { evidence.memorySamples[50].processes.pop(); });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: missing }).failures.includes('unobserved_process_gap:plugin-worker:4116'));

  const slow = mutatingEvidence((evidence) => { evidence.memorySamples[10].collectionMs = 150; });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: slow }).failures.includes('collection_exceeded_interval'));

  const unstarted = mutatingEvidence((evidence) => { delete evidence.processes[1].startedAt; });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: unstarted }).failures.some((failure) => failure.startsWith('process_identity_invalid')));

  const uncovered = mutatingEvidence((evidence) => { evidence.window.measurementEndedAt = BASE + 20_000; });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: uncovered }).failures.some((failure) => failure.startsWith('sampling_coverage:')));
});

test('budget, latency and lifecycle gates are enforced from observations', () => {
  const overBudget = mutatingEvidence((evidence) => {
    evidence.memorySamples = evidence.memorySamples.map((sample) => ({ ...sample,
      processes: sample.processes.map((process) => ({ ...process, privateBytes: 900_000_000 })) }));
  });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: overBudget }).failures.includes('memory_budget_exceeded'));

  const fewSamples = mutatingEvidence((evidence) => { evidence.latency['warm-workspace-switch'] = evidence.latency['warm-workspace-switch'].slice(0, 999); });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: fewSamples }).failures.includes('latency_samples_insufficient:warm-workspace-switch'));

  const slowInput = mutatingEvidence((evidence) => { evidence.latency['local-input-to-paint'] = evidence.latency['local-input-to-paint'].map(() => 120); });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: slowInput }).failures.includes('latency_p95_exceeded:local-input-to-paint'));

  const missingMetric = mutatingEvidence((evidence) => { delete evidence.latency['host-stop-admission']; });
  assert.ok(assessQualificationEvidence({ manifest: MANIFEST, evidence: missingMetric }).failures.includes('latency_metric_missing:host-stop-admission'));

  const shortSoak = mutatingEvidence((evidence) => {
    evidence.lifecycle.durationMs = 6_000_000;
    evidence.lifecycle.cycles = evidence.lifecycle.cycles.slice(0, 99);
    evidence.lifecycle.finalSteadyBytes = 1_100_000_000;
  });
  const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: shortSoak });
  for (const failure of ['soak_duration_not_met', 'soak_cycles_not_met', 'residual_growth_exceeded']) {
    assert.ok(result.failures.includes(failure), failure);
  }
  assert.equal(QUALIFICATION_METRICS.lifecycle.minCycles, 100);
});

test('unproven cleanup, unknown observers and missing disclosure are refused', () => {
  for (const [mutate, failure] of [
    [(evidence) => { evidence.cleanup.proven = false; }, 'cleanup_unproven'],
    [(evidence) => { evidence.cleanup.orphaned = 1; }, 'cleanup_orphan_detected'],
    [(evidence) => { evidence.cleanup.observer = 'tasklist-scan'; }, 'cleanup_observer_unknown'],
    [(evidence) => { evidence.cleanup.exitedProcesses = 4; }, 'cleanup_coverage_incomplete'],
    [(evidence) => { evidence.cleanup.unobservedGaps = 2; }, 'cleanup_gap_unobserved'],
    [(evidence) => { evidence.processes[2].exitObservedAt = null; }, 'process_exit_unobserved:rust-host:4108'],
    [(evidence) => { evidence.disclosure.samplingLimits = []; }, 'disclosure_missing:samplingLimits'],
    [(evidence) => { evidence.disclosure.excludedRoles = []; }, 'disclosure_missing:excludedRoles'],
    [(evidence) => { evidence.provider = { kind: 'real-provider', id: 'paid', version: '1' }; }, 'provider_authorization_missing'],
    [(evidence) => { delete evidence.provider; }, 'provider_provenance_missing'],
    [(evidence) => { evidence.executions[0].settlement.verified = false; }, `execution_output_unverified:${MANIFEST.executions[0].executionId}`],
  ]) {
    const result = assessQualificationEvidence({ manifest: MANIFEST, evidence: mutatingEvidence(mutate) });
    assert.ok(result.failures.includes(failure), `${failure} not reported: ${result.failures.join(', ')}`);
  }
});

test('readiness never reports acceptance, even with a ready environment and complete evidence', () => {
  const environment = {
    host: { platform: 'win32', osVersion: '10.0.20348', logicalCpus: 2, memoryBytes: 8_000_000_000, storage: 'ssd',
      cpuModel: 'nominated-vcpu', isNominatedTarget: true },
    tokenizer: { status: 'available' },
    fixtures: { pluginVersions: ['q0-fixture-plugins@1'], toolVersions: ['q0-tool-read@1'], providerQuotaRecorded: true },
    nativePrograms: [{ id: 'notepad', version: '10.0.19041', privilege: 'standard', verified: true }],
    interactive: { rdp: true, dpi: true, ime: true, dialogs: true, dpiScales: [100, 125, 150, 200] },
    devices: { android: [{ osVersion: '14', browser: 'Chrome', browserVersion: '120' }],
      ios: [{ osVersion: '17.2', browser: 'Safari', browserVersion: '17.2' }] },
    crossClient: { httpsEdge: true, enrollment: true, revocation: true, networkFaults: true },
    nativePlatformRunners: [{ platform: 'macos', displayServer: 'aqua' }, { platform: 'linux', displayServer: 'wayland' }],
    providerAuthorization: 'not-requested',
  };
  const readiness = assessQualificationReadiness({ manifest: MANIFEST, environment, evidence: validEvidence() });
  assert.equal(readiness.status, 'READY_FOR_Q1');
  assert.equal(readiness.productAcceptance, 'NOT_ACCEPTED');
  assert.equal(readiness.evidence.status, 'PASS_WITH_STATED_LIMITS');
  assert.match(readiness.nextAction, /Run Q1 alone/);

  const blocked = assessQualificationReadiness({ manifest: MANIFEST, environment: {} });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.evidence, null);
  assert.match(blocked.nextAction, /E1/);
  assert.equal(assessQualificationReadiness({ manifest: mutateManifest((manifest) => { manifest.quota.agentsPerHost = 37; }) }).status, 'INVALID_MANIFEST');
});

test('percentile helper matches nearest-rank behaviour used by soak reports', () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([1, 'x', 3], 0.95), 3);
});
