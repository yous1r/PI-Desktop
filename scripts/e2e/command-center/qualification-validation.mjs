/**
 * Q0 qualification validation: binds candidate evidence to the frozen workload
 * manifest and reports whether the Q1 measurement contract is satisfiable.
 *
 * This module is a checker, not a runner. It starts no process, contacts no
 * provider and never turns a bounded fixture into product acceptance: even a
 * complete evidence bundle produces `productAcceptance: 'NOT_ACCEPTED'` because
 * accepting capacity, native interaction or mobile behavior belongs to the
 * owning Q1/Q2/Q3 lanes on a nominated environment.
 *
 * Failure codes are stable strings; the qualification-inputs document lists them.
 */
import { assessSamplingCoverage } from './sampling-coverage.mjs';
import {
  DISCLOSURE_FIELDS,
  QUALIFICATION_EVIDENCE_SCHEMA,
  QUALIFICATION_MANIFEST_VERSION,
  QUALIFICATION_METRICS,
  QUALIFICATION_QUOTA,
  QUALIFICATION_SCOPE,
  QUALIFICATION_TARGET,
  ROLE_PLAN_PER_WORKSPACE,
  TOTAL_EXECUTIONS,
  TOKEN_EVIDENCE_RULES,
  WORKSPACE_IDS,
  buildCorpusDocument,
  buildIsolatedEnvironment,
  manifestDigest,
  validateIsolatedEnvironment,
} from './qualification-manifest.mjs';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTION_ID = /^q0-ws[1-3]-(main|native-child|worker)-0[1-6]$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Process roles that must be present and application-owned for a Q1 run. */
export const REQUIRED_PROCESS_ROLES = Object.freeze(['electron-main', 'renderer', 'rust-host', 'agent-sidecar']);

/** Observers that prove closure through an original handle rather than a PID guess. */
export const CLEANUP_OBSERVERS = Object.freeze(['owned-spawn-preload', 'handle-snapshot']);

export const PROVIDER_KINDS = Object.freeze(['deterministic-fixture', 'real-provider']);

function unique(failures) {
  return [...new Set(failures)];
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Nearest-rank percentile matched to the repository soak report convention. */
export function percentile(values, fraction) {
  const sorted = values.filter(isFiniteNumber).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/**
 * Validate the frozen manifest itself. A mutated quota, a relaxed gate, a
 * substituted corpus or a synthetic main-only execution set cannot pass.
 */
export function validateManifest(manifest, { corpusDocument = buildCorpusDocument() } = {}) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, failures: ['manifest_missing'], identity: null };
  if (manifest.manifestVersion !== QUALIFICATION_MANIFEST_VERSION) failures.push('manifest_version_invalid');
  if (manifest.scope !== QUALIFICATION_SCOPE) failures.push('manifest_scope_invalid');
  if (manifest.generatedAt !== null && manifest.generatedAt !== undefined && !ISO_UTC.test(String(manifest.generatedAt))) {
    failures.push('manifest_timestamp_invalid');
  }
  let recomputed = null;
  try {
    recomputed = manifestDigest(manifest);
    if (manifest.manifestSha256 !== recomputed) failures.push('manifest_digest_mismatch');
  } catch {
    failures.push('manifest_not_serializable');
  }

  for (const key of Object.keys(QUALIFICATION_TARGET)) {
    if (manifest.target?.[key] === undefined || JSON.stringify(manifest.target[key]) !== JSON.stringify(QUALIFICATION_TARGET[key])) {
      failures.push(`minimum_hardware_target_changed:${key}`);
    }
  }
  for (const key of Object.keys(QUALIFICATION_QUOTA)) {
    if (manifest.quota?.[key] !== QUALIFICATION_QUOTA[key]) failures.push(`quota_contract_changed:${key}`);
  }
  for (const key of Object.keys(QUALIFICATION_METRICS)) {
    if (JSON.stringify(manifest.metrics?.[key]) !== JSON.stringify(QUALIFICATION_METRICS[key])) failures.push(`metric_gate_changed:${key}`);
  }
  if (JSON.stringify(manifest.disclosure?.required) !== JSON.stringify(DISCLOSURE_FIELDS)) failures.push('disclosure_contract_changed');
  if (JSON.stringify(manifest.tokenEvidenceRules) !== JSON.stringify(TOKEN_EVIDENCE_RULES)) failures.push('token_rules_changed');

  // Corpus identity is recomputed from source, so editing corpus text or the
  // recorded digest cannot pass as the frozen recipe.
  if (manifest.corpus?.id !== corpusDocument.id) failures.push('corpus_identity_mismatch');
  if (manifest.corpus?.sha256 !== corpusDocument.sha256) failures.push('corpus_digest_mismatch');
  if (manifest.corpus?.bytes !== corpusDocument.bytes) failures.push('corpus_size_mismatch');
  if (JSON.stringify(manifest.corpus?.sections) !== JSON.stringify(corpusDocument.sections)) failures.push('corpus_section_identity_mismatch');
  const kinds = new Set(Array.isArray(manifest.corpus?.kinds) ? manifest.corpus.kinds : []);
  for (const required of ['prose', 'code', 'tool-result']) if (!kinds.has(required)) failures.push(`corpus_not_mixed:${required}`);
  if (kinds.size < 3) failures.push('corpus_not_mixed:kinds');

  const inputShape = manifest.inputShape ?? {};
  if (!isPositiveInteger(inputShape.repeats)) failures.push('input_shape_invalid:repeats');
  if (!isPositiveInteger(inputShape.bodyBytes)) failures.push('input_shape_invalid:bodyBytes');
  if (!SHA256.test(String(inputShape.bodySha256 ?? ''))) failures.push('input_shape_invalid:bodySha256');
  for (const forbidden of ['tokens', 'tokenCount', 'inputTokens', 'estimatedTokens']) {
    if (inputShape[forbidden] !== undefined) failures.push(`tokens_inferred_from_bytes:${forbidden}`);
  }

  const tokenizer = manifest.tokenizer ?? {};
  if (!['available', 'unavailable'].includes(tokenizer.status)) failures.push('tokenizer_status_invalid');
  if (tokenizer.status === 'available') {
    if (!isNonEmptyString(tokenizer.id) || !isNonEmptyString(tokenizer.version) || !SHA256.test(String(tokenizer.sha256 ?? ''))) {
      failures.push('tokenizer_identity_missing');
    }
  } else if (tokenizer.status === 'unavailable') {
    if (!isNonEmptyString(tokenizer.consequence)) failures.push('tokenizer_unavailable_without_consequence');
    if (!Array.isArray(tokenizer.probed) || !tokenizer.probed.length) failures.push('tokenizer_discovery_unrecorded');
    if (manifest.inputTokens?.evidence?.state !== 'MEASUREMENT_REQUIRED') {
      if (manifest.inputTokens?.evidence?.state !== 'MISSING') failures.push('token_evidence_state_invalid');
    }
  }
  if (manifest.inputTokens?.target !== QUALIFICATION_METRICS.inputTokens.target) failures.push('token_target_changed');

  const candidate = manifest.candidate ?? {};
  if (!GIT_SHA.test(String(candidate.head ?? '')) || !GIT_SHA.test(String(candidate.base ?? ''))) failures.push('candidate_commit_invalid');
  if (!SHA256.test(String(candidate.hostBinarySha256 ?? ''))) failures.push('candidate_host_binary_invalid');
  if (!NODE_VERSION.test(String(candidate.nodeVersion ?? ''))) failures.push('candidate_node_version_invalid');
  if (!isNonEmptyString(candidate.sourceWorktree)) failures.push('candidate_source_worktree_missing');
  if (candidate.baseAncestryVerified !== true) failures.push('candidate_base_ancestry_unverified');

  const executions = Array.isArray(manifest.executions) ? manifest.executions : [];
  if (executions.length !== TOTAL_EXECUTIONS) failures.push('execution_set_incomplete');
  const seen = new Set();
  const ids = [];
  for (const execution of executions) {
    if (!execution || typeof execution !== 'object') { failures.push('execution_observation_invalid'); continue; }
    if (!EXECUTION_ID.test(String(execution.executionId ?? ''))) failures.push('execution_identity_invalid');
    if (seen.has(execution.executionId)) failures.push('execution_identity_duplicate');
    seen.add(execution.executionId);
    ids.push(execution.executionId);
    if (!WORKSPACE_IDS.includes(execution.workspaceId)) failures.push('workspace_set_changed');
    if (!Object.hasOwn(ROLE_PLAN_PER_WORKSPACE, execution.role)) failures.push('execution_role_invalid');
    if (!isNonEmptyString(execution.taskTemplateId)) failures.push(`execution_recipe_incomplete:${execution.executionId}`);
    if (execution.corpusId !== manifest.corpus?.id || execution.corpusSha256 !== manifest.corpus?.sha256) failures.push('execution_corpus_mismatch');
    if (!SHA256.test(String(execution.inputShape?.inputSha256 ?? ''))) failures.push('execution_input_identity_missing');
    if (execution.inputShape?.repeats !== inputShape.repeats) failures.push('execution_input_shape_mismatch');
    for (const field of ['tokens', 'tokenCount', 'inputTokens', 'estimatedTokens']) {
      if (execution[field] !== undefined) failures.push(`tokens_inferred_from_bytes:${field}`);
    }
  }
  for (const workspaceId of WORKSPACE_IDS) {
    const scoped = executions.filter((execution) => execution?.workspaceId === workspaceId);
    for (const role of Object.keys(ROLE_PLAN_PER_WORKSPACE)) {
      const actual = scoped.filter((execution) => execution.role === role).length;
      if (actual !== ROLE_PLAN_PER_WORKSPACE[role]) failures.push(`workspace_topology_changed:${workspaceId}:${role}`);
    }
  }
  for (const execution of executions) {
    if (execution?.role === 'main') {
      if (execution.parentExecutionId !== null) failures.push('execution_parent_invalid');
      continue;
    }
    const parent = executions.find((candidateExecution) => candidateExecution?.executionId === execution?.parentExecutionId);
    if (!parent || parent.role !== 'main' || parent.workspaceId !== execution.workspaceId) failures.push('execution_parent_invalid');
  }
  for (const main of executions.filter((execution) => execution?.role === 'main')) {
    const children = executions.filter((execution) => execution?.parentExecutionId === main.executionId).length;
    if (children > QUALIFICATION_QUOTA.nativeChildrenPerSession) failures.push('native_child_limit_exceeded');
  }
  if (manifest.executionSetSha256 !== undefined && new Set(ids).size !== TOTAL_EXECUTIONS) failures.push('execution_identity_duplicate');

  const uniqueFailures = unique(failures);
  return {
    ok: uniqueFailures.length === 0,
    failures: uniqueFailures,
    identity: { manifestSha256: manifest.manifestSha256 ?? null, recomputedManifestSha256: recomputed,
      corpusSha256: manifest.corpus?.sha256 ?? null, executions: executions.length, workspaces: WORKSPACE_IDS.length },
  };
}

function environmentEntry(status, fields) {
  return { status, ok: status === 'KNOWN', ...fields };
}

/**
 * Environment readiness matrix for E1-E5. A larger development machine is not a
 * substitute for the nominated two-core/8-GB target, and missing devices stay
 * missing instead of becoming a local proxy result.
 */
export function assessEnvironmentReadiness(environment = {}, manifest = null) {
  const host = environment.host ?? {};
  const e1Missing = [];
  if (host.isNominatedTarget !== true) e1Missing.push('nominated_minimum_target_host');
  if (host.platform !== QUALIFICATION_TARGET.platform) e1Missing.push('platform');
  if (!isPositiveInteger(host.logicalCpus) || host.logicalCpus < QUALIFICATION_TARGET.cpuCores) e1Missing.push('cpu_cores');
  if (!isPositiveInteger(host.memoryBytes) || host.memoryBytes < QUALIFICATION_TARGET.memoryBytes) e1Missing.push('memory_bytes');
  if (host.storage !== QUALIFICATION_TARGET.storage) e1Missing.push('storage');
  if (!isNonEmptyString(host.cpuModel)) e1Missing.push('cpu_model');
  if (!isNonEmptyString(host.osVersion)) e1Missing.push('os_version');
  const exceedsMinimumTarget = host.logicalCpus > QUALIFICATION_TARGET.cpuCores || host.memoryBytes > QUALIFICATION_TARGET.memoryBytes;
  const E1 = environmentEntry(e1Missing.length ? 'MISSING' : 'KNOWN', {
    missing: e1Missing,
    observed: { platform: host.platform ?? null, logicalCpus: host.logicalCpus ?? null, memoryBytes: host.memoryBytes ?? null, storage: host.storage ?? null },
    comparisonOnly: e1Missing.length > 0 && exceedsMinimumTarget,
    note: 'CPU affinity or a larger development host is preflight only and does not reproduce 8-GB paging pressure.',
  });

  const e2Missing = [];
  const tokenizerStatus = environment.tokenizer?.status ?? manifest?.tokenizer?.status;
  if (tokenizerStatus !== 'available') e2Missing.push('installed_tokenizer');
  if (!isNonEmptyString(environment.fixtures?.corpusId ?? manifest?.corpus?.id)) e2Missing.push('frozen_corpus');
  if (!Array.isArray(environment.fixtures?.pluginVersions) || !environment.fixtures.pluginVersions.length) e2Missing.push('plugin_versions');
  if (!Array.isArray(environment.fixtures?.toolVersions) || !environment.fixtures.toolVersions.length) e2Missing.push('tool_versions');
  if (environment.fixtures?.providerQuotaRecorded !== true) e2Missing.push('provider_quota_record');
  const E2 = environmentEntry(e2Missing.length ? 'MISSING' : 'KNOWN', {
    missing: e2Missing,
    note: 'Token counts must be measured with the installed tokenizer over the frozen corpus hash.',
  });

  const programs = Array.isArray(environment.nativePrograms) ? environment.nativePrograms : [];
  const e3Missing = [];
  if (!programs.length) e3Missing.push('nominated_native_programs');
  if (programs.some((program) => !isNonEmptyString(program?.id) || !isNonEmptyString(program?.version) || program?.verified !== true)) {
    e3Missing.push('program_identity_or_verification');
  }
  for (const key of ['rdp', 'dpi', 'ime', 'dialogs']) {
    if (environment.interactive?.[key] !== true) e3Missing.push(`interactive_${key}`);
  }
  if (!Array.isArray(environment.interactive?.dpiScales) || !environment.interactive.dpiScales.length) e3Missing.push('interactive_dpi_scales');
  const E3 = environmentEntry(e3Missing.length ? 'MISSING' : 'KNOWN', { missing: e3Missing, programs: programs.map((program) => program?.id ?? null) });

  const devices = environment.devices ?? {};
  const e4Missing = [];
  for (const platform of ['android', 'ios']) {
    const entries = Array.isArray(devices[platform]) ? devices[platform] : [];
    if (!entries.length) e4Missing.push(`${platform}_device`);
    if (entries.some((device) => !isNonEmptyString(device?.osVersion) || !isNonEmptyString(device?.browser) || !isNonEmptyString(device?.browserVersion))) {
      e4Missing.push(`${platform}_device_identity`);
    }
  }
  for (const key of ['httpsEdge', 'enrollment', 'revocation', 'networkFaults']) {
    if (environment.crossClient?.[key] !== true) e4Missing.push(`cross_client_${key}`);
  }
  const E4 = environmentEntry(e4Missing.length ? 'MISSING' : 'KNOWN', { missing: e4Missing });

  const runners = Array.isArray(environment.nativePlatformRunners) ? environment.nativePlatformRunners : [];
  const e5Missing = [];
  for (const platform of ['macos', 'linux']) {
    if (!runners.some((runner) => runner?.platform === platform && isNonEmptyString(runner?.displayServer))) e5Missing.push(`${platform}_runner`);
  }
  const E5 = environmentEntry(e5Missing.length ? 'MISSING' : 'KNOWN', { missing: e5Missing });

  const environments = { E1, E2, E3, E4, E5 };
  const blockedBy = Object.entries(environments).filter(([, entry]) => entry.status !== 'KNOWN').map(([key]) => key);
  return {
    status: blockedBy.length ? 'BLOCKED' : 'READY',
    environments,
    blockedBy,
    programs: {
      Q1: E1.ok && E2.ok ? ['E1', 'E2'] : [],
      Q2: E3.ok ? ['E3'] : [],
      Q3: E4.ok ? ['E4'] : [],
    },
    providerQualification: environment.providerAuthorization === 'granted' ? 'REQUIRES_AUTHORIZED_RUN' : 'NOT_RUN',
    note: 'Environment readiness is preparation evidence only; no Q1-Q3 result exists until the owning lane runs it.',
  };
}

function analyseOverlap(executions) {
  if (!executions.length) return { simultaneous: 0, commonStart: null, commonEnd: null, durationMs: 0, rolesAtOverlap: null };
  const commonStart = Math.max(...executions.map((execution) => execution.startedAt));
  const commonEnd = Math.min(...executions.map((execution) => execution.endedAt));
  const active = executions.filter((execution) => execution.startedAt <= commonStart && execution.endedAt >= commonStart);
  const rolesAtOverlap = {};
  for (const execution of active) {
    const key = `${execution.workspaceId}:${execution.role}`;
    rolesAtOverlap[key] = (rolesAtOverlap[key] ?? 0) + 1;
  }
  return { simultaneous: active.length, commonStart, commonEnd,
    durationMs: Number.isFinite(commonStart) && Number.isFinite(commonEnd) ? Math.max(0, commonEnd - commonStart) : 0, rolesAtOverlap };
}

/**
 * Assess one candidate evidence bundle against the manifest and the Q1 gate.
 * Returns FAIL with explicit codes for missing, invalid or unproven observations.
 */
export function assessQualificationEvidence({ manifest, evidence, corpusDocument = buildCorpusDocument() } = {}) {
  const manifestCheck = validateManifest(manifest, { corpusDocument });
  if (!manifestCheck.ok) {
    return { status: 'INVALID_MANIFEST', failures: manifestCheck.failures, scope: QUALIFICATION_SCOPE,
      productAcceptance: 'NOT_ACCEPTED', acceptanceNote: 'The workload manifest is invalid, so no evidence can be assessed against it.' };
  }
  const failures = [];
  if (!evidence || typeof evidence !== 'object') {
    return { status: 'FAIL', failures: ['evidence_missing'], scope: QUALIFICATION_SCOPE, productAcceptance: 'NOT_ACCEPTED',
      acceptanceNote: 'No evidence bundle was supplied.' };
  }
  if (evidence.schema !== QUALIFICATION_EVIDENCE_SCHEMA) failures.push('evidence_schema_mismatch');
  if (evidence.manifestSha256 !== manifest.manifestSha256) failures.push('evidence_not_bound_to_manifest');
  for (const key of ['head', 'base', 'hostBinarySha256', 'nodeVersion']) {
    if (evidence.candidate?.[key] !== manifest.candidate[key]) failures.push(`candidate_provenance_mismatch:${key}`);
  }

  if (!PROVIDER_KINDS.includes(evidence.provider?.kind)) failures.push('provider_provenance_missing');
  if (evidence.provider?.kind === 'real-provider' && !isNonEmptyString(evidence.provider?.authorizationRef)) {
    failures.push('provider_authorization_missing');
  }

  // Synthetic workload substitution: the historical P0 shape is a single main
  // role with byte-sized ASCII context and must not be reported as the mixed load.
  if (evidence.workloadKind !== undefined && evidence.workloadKind !== 'mixed-2-6-4') failures.push('synthetic_workload_not_equivalent:workloadKind');
  for (const forbidden of ['contextBytes', 'contextKind']) {
    if (evidence[forbidden] !== undefined || evidence.workload?.[forbidden] !== undefined) failures.push(`synthetic_workload_not_equivalent:${forbidden}`);
  }
  if (evidence.workload?.topology === 'independent main sessions') failures.push('synthetic_workload_not_equivalent:topology');

  const executions = Array.isArray(evidence.executions) ? evidence.executions : [];
  const expected = new Map(manifest.executions.map((execution) => [execution.executionId, execution]));
  if (executions.length !== TOTAL_EXECUTIONS) failures.push('execution_observation_incomplete');
  const seen = new Set();
  for (const execution of executions) {
    const planned = expected.get(execution?.executionId);
    if (!planned) { failures.push('execution_identity_unknown'); continue; }
    if (seen.has(execution.executionId)) failures.push('execution_identity_duplicate');
    seen.add(execution.executionId);
    if (execution.workspaceId !== planned.workspaceId || execution.role !== planned.role) failures.push(`execution_attribution_mismatch:${execution.executionId}`);
    if (!isFiniteNumber(execution.startedAt) || !isFiniteNumber(execution.endedAt) || execution.endedAt <= execution.startedAt) {
      failures.push(`execution_interval_invalid:${execution.executionId}`);
    }
    if (execution.inputSha256 !== planned.inputShape.inputSha256) failures.push(`execution_input_mismatch:${execution.executionId}`);
    if (execution.settlement?.verified !== true || !SHA256.test(String(execution.settlement?.outputSha256 ?? ''))) {
      failures.push(`execution_output_unverified:${execution.executionId}`);
    }
  }
  if (seen.size !== expected.size) failures.push('execution_observation_incomplete');
  const roleSet = new Set(executions.map((execution) => execution?.role));
  if (roleSet.size === 1) failures.push('synthetic_workload_not_equivalent:roles');

  const overlap = analyseOverlap(executions.filter((execution) => isFiniteNumber(execution?.startedAt) && isFiniteNumber(execution?.endedAt)));
  if (overlap.simultaneous !== QUALIFICATION_METRICS.overlap.executions) failures.push('no_mixed_36_overlap:simultaneous');
  for (const workspaceId of WORKSPACE_IDS) {
    for (const role of Object.keys(ROLE_PLAN_PER_WORKSPACE)) {
      const key = `${workspaceId}:${role}`;
      if ((overlap.rolesAtOverlap?.[key] ?? 0) !== ROLE_PLAN_PER_WORKSPACE[role]) failures.push(`no_mixed_36_overlap:${workspaceId}:${role}`);
    }
  }
  if (overlap.durationMs < QUALIFICATION_METRICS.overlap.minimumOverlapMs) failures.push('overlap_too_short');

  // Token evidence: only a real tokenizer count over the frozen corpus is accepted.
  const tokenMeasurement = evidence.tokenMeasurement;
  if (!tokenMeasurement || typeof tokenMeasurement !== 'object') failures.push('token_measurement_missing');
  else {
    if (!TOKEN_EVIDENCE_RULES.acceptedMethods.includes(tokenMeasurement.method)) failures.push('token_measurement_not_counted');
    if (!isNonEmptyString(tokenMeasurement.tokenizer?.id) || !isNonEmptyString(tokenMeasurement.tokenizer?.version)
      || !SHA256.test(String(tokenMeasurement.tokenizer?.sha256 ?? ''))) failures.push('tokenizer_identity_missing');
    if (!Array.isArray(tokenMeasurement.counts) || !tokenMeasurement.counts.length) failures.push('token_measurement_empty');
    const { target, toleranceRatio } = QUALIFICATION_METRICS.inputTokens;
    const low = Math.floor(target * (1 - toleranceRatio));
    const high = Math.ceil(target * (1 + toleranceRatio));
    const counted = new Set();
    for (const count of Array.isArray(tokenMeasurement.counts) ? tokenMeasurement.counts : []) {
      if (!expected.has(count?.executionId)) { failures.push('token_measurement_unknown_execution'); continue; }
      if (counted.has(count.executionId)) failures.push('token_measurement_duplicate_execution');
      counted.add(count.executionId);
      if (!isPositiveInteger(count.inputTokens)) failures.push(`token_measurement_invalid:${count.executionId}`);
      else if (count.inputTokens < low || count.inputTokens > high) failures.push(`token_count_out_of_band:${count.executionId}`);
    }
    if (counted.size !== expected.size) failures.push('token_measurement_coverage_incomplete');
  }

  const processes = Array.isArray(evidence.processes) ? evidence.processes : [];
  const applicationOwned = processes.filter((entry) => entry?.scope === 'application-owned');
  if (!processes.length) failures.push('process_inventory_missing');
  if (processes.some((entry) => !Number.isSafeInteger(entry?.pid) || entry.pid <= 0 || !isNonEmptyString(entry?.startTime) || !isNonEmptyString(entry?.role))) {
    failures.push('process_identity_invalid');
  }
  for (const role of REQUIRED_PROCESS_ROLES) {
    if (!applicationOwned.some((entry) => entry.role === role)) failures.push(`process_coverage_incomplete:${role}`);
  }
  const identities = new Set();
  for (const entry of applicationOwned) {
    const identity = `${entry.role}:${entry.pid}:${entry.startTime}`;
    if (identities.has(identity)) failures.push('process_identity_duplicate');
    identities.add(identity);
    if (!isFiniteNumber(entry?.startedAt)) failures.push(`process_identity_invalid:startedAt:${entry.role}`);
    if (!isFiniteNumber(entry?.exitObservedAt)) failures.push(`process_exit_unobserved:${entry.role}:${entry.pid}`);
  }

  const samples = Array.isArray(evidence.memorySamples) ? evidence.memorySamples : [];
  if (samples.length < 2) failures.push('memory_observation_missing');
  const maxInterval = QUALIFICATION_METRICS.memory.sampleIntervalMaxMs;
  let peakBytes = 0;
  let maxGapMs = 0;
  let maxCollectionMs = 0;
  let lastTimestamp;
  for (const sample of samples) {
    if (!isFiniteNumber(sample?.timestampMs)) { failures.push('memory_sample_invalid:timestamp'); continue; }
    if (lastTimestamp !== undefined) {
      if (sample.timestampMs <= lastTimestamp) failures.push('memory_sample_invalid:monotonic');
      else maxGapMs = Math.max(maxGapMs, sample.timestampMs - lastTimestamp);
    }
    lastTimestamp = sample.timestampMs;
    if (!isFiniteNumber(sample.collectionMs) || sample.collectionMs < 0 || sample.collectionMs > maxInterval) {
      failures.push('collection_exceeded_interval');
      continue;
    }
    maxCollectionMs = Math.max(maxCollectionMs, sample.collectionMs);
    const rows = Array.isArray(sample.processes) ? sample.processes : [];
    if (!rows.length) { failures.push('memory_observation_missing:processes'); continue; }
    const observed = new Map();
    for (const row of rows) {
      if (!isNonEmptyString(row?.role) || !Number.isSafeInteger(row?.pid) || row.pid <= 0) { failures.push('memory_sample_invalid:identity'); continue; }
      if (!isNonEmptyString(row?.startTime) || !isFiniteNumber(row?.privateBytes) || row.privateBytes < 0) {
        failures.push('memory_sample_invalid:value');
        continue;
      }
      if (observed.has(`${row.role}:${row.pid}`)) failures.push('memory_sample_invalid:duplicate');
      observed.set(`${row.role}:${row.pid}`, row);
    }
    let total = 0;
    for (const entry of applicationOwned) {
      if (!isFiniteNumber(entry.startedAt)) continue;
      const liveDuringSample = entry.startedAt <= sample.timestampMs
        && (!isFiniteNumber(entry.exitObservedAt) || sample.timestampMs <= entry.exitObservedAt);
      if (!liveDuringSample) continue;
      const row = observed.get(`${entry.role}:${entry.pid}`);
      if (row?.startTime !== entry.startTime) { failures.push(`unobserved_process_gap:${entry.role}:${entry.pid}`); continue; }
      total += row.privateBytes;
    }
    for (const key of observed.keys()) {
      if (!applicationOwned.some((entry) => `${entry.role}:${entry.pid}` === key)) failures.push('unexpected_process_identity');
    }
    peakBytes = Math.max(peakBytes, total);
  }
  if (maxGapMs > maxInterval) failures.push('sampling_interval_exceeded');
  if (peakBytes > QUALIFICATION_METRICS.memory.privateBytesMax) failures.push('memory_budget_exceeded');

  const coverage = assessSamplingCoverage(samples, evidence.window ?? {});
  for (const failure of coverage.failures) failures.push(`sampling_coverage:${failure}`);

  const latency = evidence.latency ?? {};
  for (const metric of QUALIFICATION_METRICS.latency) {
    const values = latency[metric.id];
    if (!Array.isArray(values) || !values.length) { failures.push(`latency_metric_missing:${metric.id}`); continue; }
    if (values.some((value) => !isFiniteNumber(value) || value < 0)) failures.push(`latency_sample_invalid:${metric.id}`);
    if (values.length < QUALIFICATION_METRICS.latencyMinSamples) failures.push(`latency_samples_insufficient:${metric.id}`);
    const p95 = percentile(values, 0.95);
    if (p95 !== null && p95 > metric.maxP95Ms) failures.push(`latency_p95_exceeded:${metric.id}`);
  }

  const lifecycle = evidence.lifecycle ?? {};
  const cycles = Array.isArray(lifecycle.cycles) ? lifecycle.cycles : [];
  if (!isFiniteNumber(lifecycle.durationMs) || lifecycle.durationMs < QUALIFICATION_METRICS.lifecycle.soakDurationMs) failures.push('soak_duration_not_met');
  if (cycles.length < QUALIFICATION_METRICS.lifecycle.minCycles) failures.push('soak_cycles_not_met');
  if (cycles.some((cycle, index) => cycle?.index !== index + 1 || !isFiniteNumber(cycle?.attachAt) || !isFiniteNumber(cycle?.detachAt))) {
    failures.push('soak_cycle_invalid');
  }
  const baseline = lifecycle.postWarmupBaselineBytes;
  const steady = lifecycle.finalSteadyBytes;
  if (!isFiniteNumber(baseline) || baseline <= 0) failures.push('baseline_missing');
  else if (!isFiniteNumber(steady)) failures.push('steady_state_missing');
  else if ((steady - baseline) / baseline > QUALIFICATION_METRICS.lifecycle.residualGrowthMaxRatio) failures.push('residual_growth_exceeded');

  const cleanup = evidence.cleanup ?? {};
  if (cleanup.proven !== true) failures.push('cleanup_unproven');
  if (cleanup.orphaned !== 0) failures.push('cleanup_orphan_detected');
  if (!CLEANUP_OBSERVERS.includes(cleanup.observer)) failures.push('cleanup_observer_unknown');
  if (processes.length && cleanup.observedProcesses !== processes.length) failures.push('cleanup_coverage_incomplete');
  if (processes.length && cleanup.exitedProcesses !== processes.length) failures.push('cleanup_coverage_incomplete');
  if (isPositiveInteger(cleanup.unobservedGaps)) failures.push('cleanup_gap_unobserved');

  for (const field of DISCLOSURE_FIELDS) {
    if (!Array.isArray(evidence.disclosure?.[field]) || !evidence.disclosure[field].length) failures.push(`disclosure_missing:${field}`);
  }

  const uniqueFailures = unique(failures);
  return {
    status: uniqueFailures.length ? 'FAIL' : 'PASS_WITH_STATED_LIMITS',
    failures: uniqueFailures,
    scope: QUALIFICATION_SCOPE,
    measurements: {
      peakConcurrentPrivateBytes: peakBytes,
      sampleCount: samples.length,
      maxSampleGapMs: maxGapMs,
      maxCollectionMs,
      overlap: { simultaneous: overlap.simultaneous, durationMs: overlap.durationMs, rolesAtOverlap: overlap.rolesAtOverlap },
      latency: Object.fromEntries(QUALIFICATION_METRICS.latency.map((metric) => [metric.id,
        { samples: Array.isArray(latency[metric.id]) ? latency[metric.id].length : 0,
          p95: percentile(Array.isArray(latency[metric.id]) ? latency[metric.id] : [], 0.95), limitMs: metric.maxP95Ms }])),
      lifecycle: { durationMs: lifecycle.durationMs ?? null, cycles: cycles.length,
        residualGrowthRatio: isFiniteNumber(baseline) && baseline > 0 && isFiniteNumber(steady) ? (steady - baseline) / baseline : null },
    },
    providerQualification: evidence.provider?.kind === 'real-provider' ? 'REQUIRES_AUTHORIZED_RUN' : 'NOT_RUN',
    productAcceptance: 'NOT_ACCEPTED',
    acceptanceNote: 'A Q0 checker cannot accept product behavior. Capacity, native interaction and mobile gates belong to Q1/Q2/Q3 on a nominated environment; this result is at most a contract-complete evidence bundle.',
  };
}

/** Combined Q0 report: manifest integrity, environment matrix and optional evidence. */
export function assessQualificationReadiness({ manifest, environment = {}, evidence = null } = {}) {
  const manifestCheck = validateManifest(manifest);
  const environments = assessEnvironmentReadiness(environment, manifest);
  const q1 = evidence ? assessQualificationEvidence({ manifest, evidence }) : null;
  return {
    status: manifestCheck.ok ? (environments.status === 'READY' ? 'READY_FOR_Q1' : 'BLOCKED') : 'INVALID_MANIFEST',
    scope: QUALIFICATION_SCOPE,
    manifest: manifestCheck,
    environments,
    evidence: q1,
    productAcceptance: 'NOT_ACCEPTED',
    nextAction: environments.blockedBy.length
      ? `Resolve or explicitly leave missing inputs for ${environments.blockedBy.join(', ')}; blocked environments produce no qualification result.`
      : 'Run Q1 alone on the nominated target, then re-run this assessment on that evidence bundle.',
  };
}

export { buildIsolatedEnvironment, validateIsolatedEnvironment };
