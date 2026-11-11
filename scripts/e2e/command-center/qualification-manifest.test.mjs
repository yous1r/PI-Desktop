import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ISOLATED_ENV_KEYS,
  QUALIFICATION_METRICS,
  QUALIFICATION_QUOTA,
  QUALIFICATION_TARGET,
  QUOTA_SOURCES,
  ROLE_PLAN_PER_WORKSPACE,
  TOKENIZER_DISCOVERY,
  TOKEN_EVIDENCE_RULES,
  WORKSPACE_IDS,
  buildCorpusDocument,
  buildIsolatedEnvironment,
  buildWorkloadManifest,
  manifestDigest,
  serializeCanonical,
  validateIsolatedEnvironment,
} from './qualification-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A plausible candidate identity; tests never read the real repository state. */
const CANDIDATE = Object.freeze({
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  hostBinarySha256: 'c'.repeat(64),
  nodeVersion: 'v24.12.0',
  sourceWorktree: 'D:/Packages/PI-Desktop/worktrees/owner-local-control',
  baseAncestryVerified: true,
});

const manifest = buildWorkloadManifest({ candidate: CANDIDATE });

function tokenFields(value, path = '') {
  const found = [];
  if (!value || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (['tokens', 'tokenCount', 'estimatedTokens', 'counts'].includes(key)) found.push({ path: next, entry });
    if (entry && typeof entry === 'object') found.push(...tokenFields(entry, next));
  }
  return found;
}

test('recipe identity is deterministic and excludes the volatile timestamp', () => {
  const again = buildWorkloadManifest({ candidate: CANDIDATE });
  const stamped = buildWorkloadManifest({ candidate: CANDIDATE, generatedAt: '2026-11-08T00:00:00.000Z' });
  assert.equal(manifest.manifestSha256, again.manifestSha256);
  assert.equal(manifest.manifestSha256, stamped.manifestSha256);
  assert.equal(manifest.manifestSha256, manifestDigest(manifest));
  assert.equal(stamped.generatedAt, '2026-11-08T00:00:00.000Z');
  const changed = buildWorkloadManifest({ candidate: { ...CANDIDATE, head: 'd'.repeat(40) } });
  assert.notEqual(changed.manifestSha256, manifest.manifestSha256);
  assert.deepEqual(manifest.executions.map((execution) => execution.executionId), again.executions.map((execution) => execution.executionId));
  assert.equal(manifest.executionSetSha256.length, 64);
});

test('mixed topology keeps 2 main / 6 native child / 4 worker per workspace', () => {
  assert.equal(manifest.executions.length, QUALIFICATION_QUOTA.agentsPerHost);
  for (const workspaceId of WORKSPACE_IDS) {
    const scoped = manifest.executions.filter((execution) => execution.workspaceId === workspaceId);
    assert.equal(scoped.length, QUALIFICATION_QUOTA.agentsPerWorkspace);
    for (const role of Object.keys(ROLE_PLAN_PER_WORKSPACE)) {
      assert.equal(scoped.filter((execution) => execution.role === role).length, ROLE_PLAN_PER_WORKSPACE[role], `${workspaceId}/${role}`);
    }
  }
  for (const main of manifest.executions.filter((execution) => execution.role === 'main')) {
    const children = manifest.executions.filter((execution) => execution.parentExecutionId === main.executionId);
    assert.ok(children.length <= QUALIFICATION_QUOTA.nativeChildrenPerSession, 'ten-child per-session cap preserved');
    assert.ok(children.every((child) => child.workspaceId === main.workspaceId));
  }
  assert.equal(new Set(manifest.executions.map((execution) => execution.executionId)).size, 36);
  assert.equal(QUALIFICATION_QUOTA.rpcInFlightLimit, 32);
});

test('quota echo follows current product source instead of an invented limit', () => {
  for (const [key, source] of Object.entries(QUOTA_SOURCES)) {
    const text = readFileSync(join(root, source.file), 'utf8');
    const match = new RegExp(source.pattern).exec(text);
    assert.ok(match, `${source.file} must still declare ${key}`);
    assert.equal(Number(match[1]), QUALIFICATION_QUOTA[key], `${key} drifted from ${source.file}`);
  }
});

test('corpus is mixed, deterministic and bound by its hash', () => {
  const corpus = buildCorpusDocument();
  assert.deepEqual(corpus.kinds.toSorted(), ['code', 'prose', 'status', 'tool-result']);
  assert.ok(corpus.bytes > 1000);
  assert.match(corpus.sha256, /^[0-9a-f]{64}$/);
  assert.equal(buildCorpusDocument().sha256, corpus.sha256);
  assert.equal(manifest.corpus.sha256, corpus.sha256);
  assert.deepEqual(manifest.corpus.sections.map((section) => section.id), ['prose-en', 'code-ts', 'tool-result-json', 'prose-zh', 'emoji-status']);
  assert.ok(manifest.corpus.sections.some((section) => section.language === 'zh'));
  assert.ok(manifest.corpus.sections.every((section) => section.bytes > 0 && /^[0-9a-f]{64}$/.test(section.sha256)));
  for (const execution of manifest.executions) {
    assert.equal(execution.corpusSha256, corpus.sha256);
    assert.match(execution.inputShape.inputSha256, /^[0-9a-f]{64}$/);
    assert.ok(execution.inputShape.inputBytes > corpus.bytes);
  }
  assert.notEqual(manifest.executions[0].inputShape.inputSha256, manifest.executions[1].inputShape.inputSha256);
  assert.equal(manifest.inputShape.repeats >= 1, true);
  assert.equal('tokens' in manifest.inputShape, false);
});

test('byte sizing is labelled provisional and never presented as tokens', () => {
  assert.equal(manifest.inputShape.provisionalBytes, true);
  assert.equal(manifest.inputTokens.target, 32_000);
  assert.equal(manifest.inputTokens.evidence.state, 'MISSING');
  assert.equal(manifest.inputTokens.evidence.method, 'not-measured');
  assert.deepEqual(tokenFields(manifest), []);
  assert.deepEqual(TOKEN_EVIDENCE_RULES.acceptedMethods, ['tokenizer-count']);
  assert.ok(TOKEN_EVIDENCE_RULES.rejectedMethods.includes('bytes-divided-by-4'));
  assert.ok(TOKEN_EVIDENCE_RULES.rejectedMethods.includes('character-ratio'));
  assert.ok(TOKEN_EVIDENCE_RULES.rejectedSources.includes('fixture contextBytes'));
  const derived = buildWorkloadManifest({ candidate: CANDIDATE, tokenizer: { ...TOKENIZER_DISCOVERY, consequence: 'free text' } });
  assert.equal(derived.inputTokens.evidence.state, 'MISSING');
});

test('tokenizer absence is recorded with probes and an explicit consequence', () => {
  assert.equal(TOKENIZER_DISCOVERY.status, 'unavailable');
  assert.ok(TOKENIZER_DISCOVERY.probed.length >= 3);
  assert.ok(TOKENIZER_DISCOVERY.probed.some((probe) => probe.includes('tiktoken')));
  assert.match(TOKENIZER_DISCOVERY.consequence, /must not be converted/);
  assert.deepEqual(manifest.tokenizer, {
    status: 'unavailable',
    probed: [...TOKENIZER_DISCOVERY.probed],
    result: TOKENIZER_DISCOVERY.result,
    consequence: TOKENIZER_DISCOVERY.consequence,
  });
  const available = buildWorkloadManifest({
    candidate: CANDIDATE,
    tokenizer: { status: 'available', id: 'q0-tokenizer', version: '1', sha256: 'e'.repeat(64) },
  });
  assert.equal(available.tokenizer.status, 'available');
  assert.equal(available.inputTokens.evidence.state, 'MEASUREMENT_REQUIRED');
  assert.deepEqual(tokenFields(available), []);
});

test('candidate provenance rejects truncated or missing identities', () => {
  const mutations = [
    { ...CANDIDATE, head: 'a'.repeat(39) },
    { ...CANDIDATE, base: 'b'.repeat(41) },
    { ...CANDIDATE, hostBinarySha256: 'c'.repeat(63) },
    { ...CANDIDATE, nodeVersion: '24.12.0' },
    { ...CANDIDATE, sourceWorktree: ' ' },
    { ...CANDIDATE, baseAncestryVerified: false },
    {},
  ];
  for (const candidate of mutations) {
    assert.throws(() => buildWorkloadManifest({ candidate }), /Invalid candidate provenance/);
  }
  assert.throws(() => buildWorkloadManifest({}), /Invalid candidate provenance/);
  assert.throws(() => buildWorkloadManifest({ candidate: CANDIDATE, generatedAt: '08/11/2026' }), /generatedAt/);
  assert.throws(() => buildWorkloadManifest({ candidate: CANDIDATE, bodyTargetBytes: 0 }), /bodyTargetBytes/);
});

test('declared target and metric gate match the requirement thresholds', () => {
  assert.equal(QUALIFICATION_TARGET.cpuCores, 2);
  assert.equal(QUALIFICATION_TARGET.memoryBytes, 8_000_000_000);
  assert.equal(QUALIFICATION_TARGET.storage, 'ssd');
  assert.equal(QUALIFICATION_METRICS.memory.privateBytesMax, 4_000_000_000);
  assert.equal(QUALIFICATION_METRICS.memory.sampleIntervalMaxMs, 100);
  assert.equal(QUALIFICATION_METRICS.latencyMinSamples, 1000);
  assert.deepEqual(QUALIFICATION_METRICS.latency.map((metric) => [metric.id, metric.maxP95Ms]), [
    ['local-input-to-paint', 100],
    ['warm-workspace-switch', 250],
    ['host-stop-admission', 500],
  ]);
  assert.equal(QUALIFICATION_METRICS.lifecycle.soakDurationMs, 7_200_000);
  assert.equal(QUALIFICATION_METRICS.lifecycle.minCycles, 100);
  assert.equal(QUALIFICATION_METRICS.lifecycle.residualGrowthMaxRatio, 0.1);
  assert.equal(manifest.metrics.memory.privateBytesMax, 4_000_000_000);
  assert.deepEqual(manifest.disclosure.required, ['processCoverage', 'samplingLimits', 'excludedRoles', 'sequencing']);
});

test('canonical serialization is order independent and refuses non-finite numbers', () => {
  assert.equal(serializeCanonical({ b: 1, a: [1, 'x'] }), serializeCanonical({ a: [1, 'x'], b: 1 }));
  assert.throws(() => serializeCanonical({ value: Number.POSITIVE_INFINITY }), /non-finite/);
  assert.equal(serializeCanonical({ value: undefined, other: 1 }).includes('value'), false);
});

test('isolated environment exposes only explicit scratch paths', () => {
  const scratch = process.platform === 'win32' ? 'C:/q0-scratch/run-1' : '/tmp/q0-scratch/run-1';
  const built = buildIsolatedEnvironment({ scratchDir: scratch });
  assert.deepEqual(Object.keys(built.env).toSorted(), [...ISOLATED_ENV_KEYS].toSorted());
  for (const key of ISOLATED_ENV_KEYS) assert.ok(built.env[key].includes('q0-scratch'), `${key} stays under the scratch root`);
  assert.equal(built.env.TEMP, built.env.TMP);
  assert.notEqual(built.env.PI_DESKTOP_DATA_DIR, built.env.PI_DESKTOP_AGENTS_DIR);
  assert.deepEqual(validateIsolatedEnvironment(built.env), { ok: true, failures: [] });
  assert.throws(() => buildIsolatedEnvironment({ scratchDir: 'relative/scratch' }), /absolute/);
  assert.throws(() => buildIsolatedEnvironment({}), /scratchDir/);
  assert.deepEqual(validateIsolatedEnvironment({}), { ok: false, failures: ISOLATED_ENV_KEYS.map((key) => `environment_value_missing:${key}`) });
  assert.equal(validateIsolatedEnvironment({ ...built.env, TEMP: 'temp' }).failures.includes('environment_path_not_absolute:TEMP'), true);
  assert.equal(validateIsolatedEnvironment({ ...built.env, TMP: built.env.TEMP }).ok, true);
  assert.equal(validateIsolatedEnvironment({ ...built.env, TMP: `${built.env.TEMP}-other` }).failures.includes('temp_and_tmp_differ'), true);
  assert.equal(validateIsolatedEnvironment({ ...built.env, PI_DESKTOP_DATA_DIR: built.env.TEMP }).failures.includes('data_and_temp_share_path'), true);
  assert.equal(validateIsolatedEnvironment({ ...built.env, PI_DESKTOP_AGENTS_DIR: '../agents' }).failures.length > 0, true);
  assert.equal(validateIsolatedEnvironment(null).failures[0], 'environment_missing');
});
