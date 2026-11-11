/**
 * Q0 qualification preparation: frozen workload recipe, corpus identity, quota
 * echo and isolated-run environment contract for the AI command center.
 *
 * Preparation only. Nothing here starts a process, calls a provider, measures
 * the product or attaches to a running Desktop, and no function returns a
 * product-acceptance result.
 *
 * Two rules are enforced by construction rather than prose:
 * - every number that already exists in product code is echoed from that code
 *   (see `QUOTA_SOURCES`, executed by the qualification manifest test);
 * - token counts are never derived from bytes or characters. The corpus is
 *   recorded in bytes; the only accepted token evidence is a real tokenizer
 *   measurement over the frozen corpus hash (`TOKEN_EVIDENCE_RULES`).
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join as joinPath, normalize } from 'node:path';

export const QUALIFICATION_MANIFEST_VERSION = 1;
export const QUALIFICATION_SCOPE = 'Q0-preparation';
export const QUALIFICATION_EVIDENCE_SCHEMA = 'q0-qualification-evidence@1';
export const QUALIFICATION_MANIFEST_ID = 'q0-workload-manifest';

/** Windows-first minimum target from the requirements resource contract. */
export const QUALIFICATION_TARGET = Object.freeze({
  platform: 'win32',
  cpuCores: 2,
  /** Decimal 8 GB interpretation, matching the decimal 4,000,000,000-byte budget. */
  memoryBytes: 8_000_000_000,
  storage: 'ssd',
  rendering: 'software',
  requiresDiscreteGpu: false,
  displayModes: Object.freeze([
    Object.freeze({ width: 1920, height: 1080 }),
    Object.freeze({ width: 2560, height: 1440 }),
  ]),
});

/**
 * Quotas borrowed from current product code. This module never defines its own
 * limits; `QUOTA_SOURCES` is read and re-parsed by the manifest test so a product
 * change breaks the qualification manifest instead of silently diverging.
 */
export const QUALIFICATION_QUOTA = Object.freeze({
  enabledWorkspaces: 3,
  agentsPerWorkspace: 12,
  agentsPerHost: 36,
  nativeChildrenPerSession: 10,
  rpcInFlightLimit: 32,
});

export const QUOTA_SOURCES = Object.freeze({
  enabledWorkspaces: Object.freeze({
    file: 'packages/shared/src/command-center/primitives.ts',
    pattern: 'export const COMMAND_CENTER_MAX_ENABLED_WORKSPACES = (\\d+);',
  }),
  agentsPerWorkspace: Object.freeze({
    file: 'packages/shared/src/command-center/primitives.ts',
    pattern: 'export const COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE = (\\d+);',
  }),
  agentsPerHost: Object.freeze({
    file: 'packages/shared/src/command-center/primitives.ts',
    pattern: 'export const COMMAND_CENTER_MAX_AGENTS_PER_HOST = (\\d+);',
  }),
  nativeChildrenPerSession: Object.freeze({
    file: 'packages/shared/src/subagent-definition.ts',
    pattern: 'export const MAX_SUBAGENT_CONCURRENCY = (\\d+);',
  }),
  rpcInFlightLimit: Object.freeze({
    file: 'crates/host-core/src/rpc/mod.rs',
    pattern: 'const MAX_IN_FLIGHT_RPC: usize = (\\d+);',
  }),
});

/** Mixed execution attribution required for one command workspace. */
export const ROLE_PLAN_PER_WORKSPACE = Object.freeze({ main: 2, 'native-child': 6, worker: 4 });
export const EXECUTION_ROLES = Object.freeze(['main', 'native-child', 'worker']);
export const WORKSPACE_IDS = Object.freeze(['ws1', 'ws2', 'ws3']);
export const TOTAL_EXECUTIONS = 36;
export const EXECUTIONS_PER_WORKSPACE = 12;

/**
 * Frozen acceptance gate. Values trace to the requirements resource/performance
 * contract and AC-07/AC-08/AC-09; Q0 contributions that are interpretations of
 * "approximately" are marked as such in the qualification-inputs document.
 */
export const QUALIFICATION_METRICS = Object.freeze({
  memory: Object.freeze({
    privateBytesMax: 4_000_000_000,
    sampleIntervalMaxMs: 100,
    requirePostOutcomeSample: true,
  }),
  latency: Object.freeze([
    Object.freeze({ id: 'local-input-to-paint', maxP95Ms: 100 }),
    Object.freeze({ id: 'warm-workspace-switch', maxP95Ms: 250 }),
    Object.freeze({ id: 'host-stop-admission', maxP95Ms: 500 }),
  ]),
  /** Per-metric floor; stricter than "at least 1,000 samples" read as a total. */
  latencyMinSamples: 1000,
  overlap: Object.freeze({
    executions: TOTAL_EXECUTIONS,
    perWorkspace: EXECUTIONS_PER_WORKSPACE,
    rolesPerWorkspace: ROLE_PLAN_PER_WORKSPACE,
    /** Sustained-overlap floor derived from the ten-second streaming burst. */
    minimumOverlapMs: 5_000,
  }),
  lifecycle: Object.freeze({
    soakDurationMs: 7_200_000,
    minCycles: 100,
    residualGrowthMaxRatio: 0.1,
  }),
  inputTokens: Object.freeze({
    target: 32_000,
    /** "approximately 32,000" read as plus/minus 5 percent. */
    toleranceRatio: 0.05,
    requiredMethod: 'tokenizer-count',
  }),
});

export const DISCLOSURE_FIELDS = Object.freeze([
  'processCoverage',
  'samplingLimits',
  'excludedRoles',
  'sequencing',
]);

/**
 * Token evidence boundary. Byte or character conversions are refused outright,
 * including the historical "128 KiB means 32k tokens" reading.
 */
export const TOKEN_EVIDENCE_RULES = Object.freeze({
  acceptedMethods: Object.freeze(['tokenizer-count']),
  rejectedMethods: Object.freeze([
    'byte-ratio',
    'character-ratio',
    'bytes-divided-by-4',
    'chunk-count',
    'estimated',
    'inherited-from-fixture-config',
  ]),
  rejectedSources: Object.freeze([
    'fixture contextBytes',
    'synthetic ASCII payload length',
    'prompt character count',
    'model contextWindow configuration',
  ]),
});

/**
 * Local discovery result recorded before any qualification run. No tokenizer
 * package, model tokenizer data file or Python `tiktoken` module is installed in
 * this checkout, so token counts are MISSING rather than inferred.
 */
export const TOKENIZER_DISCOVERY = Object.freeze({
  status: 'unavailable',
  probed: Object.freeze([
    'node_modules top level and node_modules/.pnpm package names (no tokenizer package)',
    'node_modules/@earendil-works/pi-ai exports (no token-count utility)',
    'python -c "import tiktoken" (ModuleNotFoundError)',
    'repository references to @dqbd/tiktoken, js-tiktoken and gpt-tokenizer (none)',
  ]),
  result: 'No installed tokenizer or tokenizer data file was found; token counts were not measured.',
  consequence:
    'Q1 must supply counted input tokens from a real tokenizer measurement over the frozen corpus hash. Bytes, characters and fixture contextWindow values must not be converted into tokens.',
});

const CORPUS_ID = 'q0-mixed-corpus';
const CORPUS_VERSION = 1;
const PREFIX_ID = 'q0-execution-prefix';
const BODY_TARGET_BYTES = 131_072;

/**
 * Deterministic mixed corpus sections: ordinary prose, code, a tool result and
 * non-ASCII text. The ASCII-only P0 payload is deliberately not reused because it
 * cannot represent the mixed text/code/tool-result workload.
 */
const CORPUS_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'prose-en',
    kind: 'prose',
    language: 'en',
    lines: Object.freeze([
      'The command center keeps one overview and at most three admitted workspaces.',
      'Queued work is not simultaneous execution, and a cancelled request is not exit proof.',
      'Reservations are released only after authoritative evidence permits release.',
      'Bounded summaries keep the monitor from subscribing to every full transcript.',
      'A handoff refuses unknown ownership, unresolved cleanup or unqualified containment.',
      'Detached processes are tracked by explicit ownership rather than current parent PID.',
      'Sampled memory is a maximum of contemporaneous sums, never a sum of lifetime peaks.',
      'Interaction latency is measured on the rendering surface that the user actually sees.',
      'History is paginated, and retained receipts survive session and task deletion.',
      'Every long-lived resource has one owner and one cleanup path.',
    ]),
  }),
  Object.freeze({
    id: 'code-ts',
    kind: 'code',
    language: 'ts',
    lines: Object.freeze([
      'export interface Reservation { readonly executionId: string; readonly workspaceId: string; }',
      'export function admit(reserved: readonly Reservation[], candidate: Reservation, limit: number) {',
      '  if (reserved.some((entry) => entry.executionId === candidate.executionId)) {',
      '    return { admitted: false, reason: "duplicate-execution" } as const;',
      '  }',
      '  if (reserved.length >= limit) return { admitted: false, reason: "capacity" } as const;',
      '  return { admitted: true, reason: "admitted" } as const;',
      '}',
      'export async function settle(write: () => Promise<boolean>): Promise<boolean> {',
      '  const acknowledged = await write();',
      '  return acknowledged === true;',
      '}',
      'const label = (id: string): string => `execution:${id}`;',
      'const bounded = (rows: readonly string[], max: number) => rows.slice(0, max);',
      'type Role = "main" | "native-child" | "worker";',
      'const roles: readonly Role[] = ["main", "main", "native-child", "worker"];',
      'export const describe = (role: Role): string => `role=${role}`;',
      'export const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];',
    ]),
  }),
  Object.freeze({
    id: 'tool-result-json',
    kind: 'tool-result',
    language: 'json',
    lines: Object.freeze([
      '{"tool":"read","path":"fixtures/scheduler.ts","lines":42,"truncated":false}',
      '{"tool":"edit","path":"fixtures/scheduler.ts","replacements":2,"ok":true}',
      '{"tool":"bash","command":"node --version","exitCode":0,"stdout":"v24.12.0"}',
      '{"tool":"read","path":"fixtures/queue.json","lines":18,"truncated":false}',
      '{"tool":"bash","command":"git rev-parse --short HEAD","exitCode":0,"stdout":"fixture"}',
      '{"tool":"edit","path":"fixtures/queue.json","replacements":1,"ok":true}',
      '{"tool":"read","path":"fixtures/transcript.md","lines":64,"truncated":true}',
      '{"tool":"bash","command":"echo bounded-fixture","exitCode":0,"stdout":"bounded-fixture"}',
    ]),
  }),
  Object.freeze({
    id: 'prose-zh',
    kind: 'prose',
    language: 'zh',
    lines: Object.freeze([
      '同一个工作区最多同时运行十二个执行实例，整个主机最多三十六个。',
      '排队中的任务不算作并发执行，取消成功也不等于进程已经退出。',
      '采样间隔不得超过一百毫秒，进程集合必须完整覆盖被测工作负载。',
      '两个主会话、六个原生子会话和四个后台执行共同组成混合阶段。',
      '记忆体预算为四十亿字节，采样峰值必须同时覆盖全部应用自有进程。',
      '输入到绘制的延迟、热切换延迟和停止请求准入延迟分别统计。',
      '两小时的生命周期测试需要至少一百次挂载、分离与最大化循环。',
      '未证明的清理、缺失的观测和估算的令牌数都不能通过验收。',
    ]),
  }),
  Object.freeze({
    id: 'emoji-status',
    kind: 'status',
    language: 'mixed',
    lines: Object.freeze([
      '[ok] workspace admission \u2705',
      '[wait] queue depth 3 \u23f3',
      '[ok] streaming burst 10 s \ud83d\ude80',
      '[warn] retry scheduled \u26a0\ufe0f',
      '[ok] stop admission accepted \ud83d\uded1',
      '[ok] transcript settled \ud83d\udcc4',
    ]),
  }),
]);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

/** Deterministic JSON with sorted keys; rejects values that cannot bind identity. */
export function serializeCanonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical serialization rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : serializeCanonical(item))).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`).join(',')}}`;
  }
  throw new Error(`Canonical serialization rejects ${typeof value}`);
}

/**
 * Manifest digest over the frozen body. Volatile fields (`generatedAt`) and the
 * digest itself are excluded so a rerun of the same recipe keeps one identity and
 * evidence bound to an older body cannot silently apply to a changed recipe.
 */
export function manifestDigest(manifest) {
  const { manifestSha256: _ignoredDigest, generatedAt: _ignoredTimestamp, ...body } = manifest ?? {};
  return sha256(serializeCanonical(body));
}

/** Deterministic corpus document plus per-section identity. */
export function buildCorpusDocument() {
  const sections = CORPUS_SECTIONS.map((section) => {
    const text = `### ${section.id} kind=${section.kind} lang=${section.language}\n${section.lines.join('\n')}\n`;
    return { id: section.id, kind: section.kind, language: section.language, lineCount: section.lines.length,
      bytes: byteLength(text), sha256: sha256(text), text };
  });
  const text = sections.map((section) => section.text).join('');
  return deepFreeze({
    id: CORPUS_ID,
    version: CORPUS_VERSION,
    sha256: sha256(text),
    bytes: byteLength(text),
    kinds: [...new Set(sections.map((section) => section.kind))],
    sections: sections.map(({ text: _ignoredText, ...rest }) => rest),
    text,
  });
}

function assertCandidateProvenance(candidate) {
  const problems = [];
  if (!candidate || typeof candidate !== 'object') problems.push('candidate provenance is required');
  else {
    if (!/^[0-9a-f]{40}$/.test(candidate.head ?? '')) problems.push('candidate.head must be a 40-character git commit');
    if (!/^[0-9a-f]{40}$/.test(candidate.base ?? '')) problems.push('candidate.base must be a 40-character git commit');
    if (!/^[0-9a-f]{64}$/.test(candidate.hostBinarySha256 ?? '')) problems.push('candidate.hostBinarySha256 must be a SHA-256 hex digest');
    if (!/^v\d+\.\d+\.\d+$/.test(candidate.nodeVersion ?? '')) problems.push('candidate.nodeVersion must look like v24.12.0');
    if (typeof candidate.sourceWorktree !== 'string' || !candidate.sourceWorktree.trim()) problems.push('candidate.sourceWorktree is required');
    if (candidate.baseAncestryVerified !== true) problems.push('candidate.baseAncestryVerified must be true (verified base ancestry)');
  }
  if (problems.length) throw new Error(`Invalid candidate provenance: ${problems.join('; ')}`);
}

function assertTokenizerRecord(tokenizer) {
  if (!tokenizer || typeof tokenizer !== 'object') throw new Error('Tokenizer record is required');
  if (!['available', 'unavailable'].includes(tokenizer.status)) throw new Error('Tokenizer status must be available or unavailable');
  if (tokenizer.status === 'available') {
    if (!tokenizer.id || !tokenizer.version) throw new Error('Available tokenizer requires id and version');
    if (!/^[0-9a-f]{64}$/.test(tokenizer.sha256 ?? '')) throw new Error('Available tokenizer requires a SHA-256 digest of its data');
  } else if (typeof tokenizer.consequence !== 'string' || !tokenizer.consequence.trim()) {
    throw new Error('Unavailable tokenizer requires an explicit consequence');
  }
}

function buildExecutions(corpus, repeats) {
  const body = Array.from({ length: repeats }, (_, index) => `${corpus.text}--- q0-corpus-repeat ${index + 1} ---\n`).join('');
  const bodySha256 = sha256(body);
  const bodyBytes = byteLength(body);
  const executions = [];
  for (const workspaceId of WORKSPACE_IDS) {
    for (const role of EXECUTION_ROLES) {
      const count = ROLE_PLAN_PER_WORKSPACE[role];
      for (let index = 1; index <= count; index += 1) {
        const suffix = String(index).padStart(2, '0');
        const parentMainIndex = role === 'main' ? null : index <= Math.ceil(count / 2) ? 1 : 2;
        const executionId = `q0-${workspaceId}-${role}-${suffix}`;
        const prefix = `${PREFIX_ID}:${executionId}\n`;
        executions.push(deepFreeze({
          executionId,
          workspaceId,
          role,
          parentExecutionId: parentMainIndex === null ? null : `q0-${workspaceId}-main-0${parentMainIndex}`,
          taskTemplateId: `q0-task/${role}@1`,
          turnPlan: role === 'main'
            ? { streamingBursts: 1, deltasPerBurst: 100, deltaBytes: 1024, deltaIntervalMs: 100, toolCalls: 2, approvalRequests: 1, cancellationProbes: 1, retryProbes: 1 }
            : { streamingBursts: 1, deltasPerBurst: 100, deltaBytes: 1024, deltaIntervalMs: 100, toolCalls: 1, approvalRequests: 1, cancellationProbes: 0, retryProbes: 0 },
          corpusId: corpus.id,
          corpusSha256: corpus.sha256,
          inputShape: { prefixId: PREFIX_ID, repeats, inputBytes: byteLength(prefix) + bodyBytes, inputSha256: sha256(prefix + body) },
        }));
      }
    }
  }
  return { executions, body, bodySha256, bodyBytes };
}

/**
 * Build the frozen workload manifest. Same arguments produce the same digest, so
 * evidence can be bound to one exact recipe; `generatedAt` never changes identity.
 */
export function buildWorkloadManifest({ candidate, tokenizer = TOKENIZER_DISCOVERY, generatedAt = null,
  bodyTargetBytes = BODY_TARGET_BYTES } = {}) {
  assertCandidateProvenance(candidate);
  if (!Number.isSafeInteger(bodyTargetBytes) || bodyTargetBytes < 1 || bodyTargetBytes > 4 * 1024 * 1024) {
    throw new Error('bodyTargetBytes must be an integer between 1 and 4 MiB');
  }
  assertTokenizerRecord(tokenizer);
  if (generatedAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(generatedAt)) {
    throw new Error('generatedAt must be an ISO-8601 UTC timestamp or null');
  }
  const corpus = buildCorpusDocument();
  const repeats = Math.max(1, Math.ceil(bodyTargetBytes / corpus.bytes));
  const { executions, bodySha256, bodyBytes } = buildExecutions(corpus, repeats);
  const manifest = deepFreeze({
    manifestVersion: QUALIFICATION_MANIFEST_VERSION,
    scope: QUALIFICATION_SCOPE,
    id: QUALIFICATION_MANIFEST_ID,
    generatedAt,
    target: QUALIFICATION_TARGET,
    quota: QUALIFICATION_QUOTA,
    corpus: {
      id: corpus.id,
      version: corpus.version,
      sha256: corpus.sha256,
      bytes: corpus.bytes,
      kinds: corpus.kinds,
      sections: corpus.sections,
    },
    inputShape: {
      prefixId: PREFIX_ID,
      bodyTargetBytes,
      repeats,
      bodyBytes,
      bodySha256,
      provisionalBytes: true,
      tokenNote: 'Body size is a starting assembly, not a token count. Repeats are re-derived from a counted token measurement before Q1, which produces a new manifest digest.',
    },
    tokenizer: tokenizer.status === 'available'
      ? { status: 'available', id: tokenizer.id, version: tokenizer.version, sha256: tokenizer.sha256, probed: tokenizer.probed ?? [] }
      : { status: 'unavailable', probed: tokenizer.probed ?? [], result: tokenizer.result ?? null, consequence: tokenizer.consequence },
    inputTokens: {
      target: QUALIFICATION_METRICS.inputTokens.target,
      toleranceRatio: QUALIFICATION_METRICS.inputTokens.toleranceRatio,
      evidence: tokenizer.status === 'available'
        ? { state: 'MEASUREMENT_REQUIRED', method: 'not-measured', note: 'A tokenizer exists; Q1 must record counts over corpus.sha256 before running.' }
        : { state: 'MISSING', method: 'not-measured', note: 'No tokenizer available. Counted tokens must come from a real measurement; byte conversion is refused.' },
    },
    tokenEvidenceRules: TOKEN_EVIDENCE_RULES,
    model: { provider: 'loopback-openai-chat', fixtureId: 'q0-local-fixture', modelId: 'q0-fixture-model', modelVersion: '1', apiStyle: 'openai-chat', stream: true },
    plugin: { id: 'q0-fixture-plugins', version: '1' },
    tools: [
      { id: 'q0-tool-read', version: '1' },
      { id: 'q0-tool-edit', version: '1' },
      { id: 'q0-tool-bash', version: '1' },
    ],
    fixtures: { historyMessagesPerMain: 10_000, toolResultBytes: 1_048_576, imageReferences: 2 },
    metrics: QUALIFICATION_METRICS,
    disclosure: { required: DISCLOSURE_FIELDS },
    candidate: {
      head: candidate.head,
      base: candidate.base,
      hostBinarySha256: candidate.hostBinarySha256,
      nodeVersion: candidate.nodeVersion,
      sourceWorktree: candidate.sourceWorktree,
      baseAncestryVerified: candidate.baseAncestryVerified,
    },
    executions: [...executions],
    executionSetSha256: sha256(serializeCanonical(executions.map((execution) => execution.executionId))),
  });
  return deepFreeze({ ...manifest, manifestSha256: manifestDigest(manifest) });
}

/**
 * Isolated run environment. Every mutable path lives under one scratch root and
 * the four required keys are explicit; a shared or relative path is refused.
 */
export const ISOLATED_ENV_KEYS = Object.freeze(['PI_DESKTOP_DATA_DIR', 'TEMP', 'TMP', 'PI_DESKTOP_AGENTS_DIR']);

export function buildIsolatedEnvironment({ scratchDir } = {}) {
  if (typeof scratchDir !== 'string' || !scratchDir.trim()) throw new Error('scratchDir is required');
  const normalized = normalize(scratchDir);
  if (!isAbsolute(normalized)) throw new Error('scratchDir must be an absolute path');
  const directories = {
    data: joinPath(normalized, 'data'),
    temp: joinPath(normalized, 'temp'),
    agents: joinPath(normalized, 'agents'),
  };
  const env = {
    PI_DESKTOP_DATA_DIR: directories.data,
    TEMP: directories.temp,
    TMP: directories.temp,
    PI_DESKTOP_AGENTS_DIR: directories.agents,
  };
  return deepFreeze({ env, directories, scratchDir: normalized });
}

/** Structural checks only: nothing is created or deleted here. */
export function validateIsolatedEnvironment(env) {
  const failures = [];
  if (!env || typeof env !== 'object') return { ok: false, failures: ['environment_missing'] };
  for (const key of ISOLATED_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== 'string' || !value.trim()) { failures.push(`environment_value_missing:${key}`); continue; }
    if (!isAbsolute(normalize(value))) failures.push(`environment_path_not_absolute:${key}`);
    if (normalize(value).split(/[\\/]/).includes('..')) failures.push(`environment_path_traverses:${key}`);
  }
  if (typeof env.TEMP === 'string' && typeof env.TMP === 'string' && env.TEMP !== env.TMP) failures.push('temp_and_tmp_differ');
  if (typeof env.PI_DESKTOP_DATA_DIR === 'string' && env.PI_DESKTOP_DATA_DIR === env.TEMP) failures.push('data_and_temp_share_path');
  if (typeof env.PI_DESKTOP_AGENTS_DIR === 'string' && env.PI_DESKTOP_AGENTS_DIR === env.PI_DESKTOP_DATA_DIR) failures.push('agents_and_data_share_path');
  return { ok: failures.length === 0, failures };
}
