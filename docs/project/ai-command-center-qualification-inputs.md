# AI command center: Q0 qualification inputs, workload manifest and measurement protocol

- Status: **Q0 preparation only.** No Q1/Q2/Q3 run exists, no environment is
  substituted and no product behavior is accepted by this document or its code.
- Harness checkpoint: new `scripts/e2e/command-center/qualification-manifest.mjs`,
  `qualification-validation.mjs` and their tests in worktree `owner-local-control`;
  source HEAD `9ff740d168b21b54a882b649f23ce8e1eeaaaa48` (branch
  `feat/owner-idle-handoff`), local `origin/main`
  `e977efc96b6b735aeef5066a0b66c6565ad5691f` verified as an ancestor with
  `git merge-base --is-ancestor`. `origin/main` was not re-fetched in this slice.
- Basis: [parallel work](ai-command-center-parallel-work.md) Q0/Q1/Q2/Q3
  rows and E1-E5, [requirements](ai-command-center-requirements.md) resource
  contract and AC-07/AC-08/AC-09, existing
  [P0 baseline](ai-command-center-p0-baseline.md),
  [1 MiB validation](ai-command-center-1mib-validation.md) and
  [soak report](ai-command-center-soak-report.md).
- Code is the source of truth. Quotas are read back from product source by
  `qualification-manifest.test.mjs`; this document describes the frozen inputs,
  not a replacement for the implementation.

## What Q0 provides

| Path | Exports used by Q1-Q3 | Purpose |
|---|---|---|
| `scripts/e2e/command-center/qualification-manifest.mjs` | `buildWorkloadManifest`, `buildCorpusDocument`, `manifestDigest`, `serializeCanonical`, `QUALIFICATION_TARGET`, `QUALIFICATION_QUOTA`, `QUOTA_SOURCES`, `ROLE_PLAN_PER_WORKSPACE`, `QUALIFICATION_METRICS`, `TOKEN_EVIDENCE_RULES`, `TOKENIZER_DISCOVERY`, `buildIsolatedEnvironment`, `validateIsolatedEnvironment` | Frozen workload recipe, corpus identity, quota echo, gate thresholds, token rules and isolated-run environment |
| `scripts/e2e/command-center/qualification-validation.mjs` | `validateManifest`, `assessEnvironmentReadiness`, `assessQualificationEvidence`, `assessQualificationReadiness`, `percentile`, `REQUIRED_PROCESS_ROLES`, `CLEANUP_OBSERVERS` | Manifest integrity, E1-E5 matrix and Q1 evidence assessment with stable failure codes |
| `scripts/e2e/command-center/qualification-manifest.test.mjs` | 10 tests | Recipe determinism, topology, quota echo, corpus identity, token rules, provenance, isolated environment |
| `scripts/e2e/command-center/qualification-validation.test.mjs` | 14 tests | Missing/invalid identity, provenance, empty observations, unproven cleanup, synthetic-vs-real workload, gates |

Q0 does **not** start the Host, Electron, a sidecar, a browser or a provider. It
contains no runner, no sampler, no quota store and no report generator beyond the
evidence checker, so it cannot invent execution results.

## Frozen workload manifest

Topology matches the requirements mixed phase: three admitted workspaces with two
main sessions, six native children (three per main) and four Worker executions,
twelve per workspace and thirty-six in total. Queued work never substitutes for a
simultaneous execution.

| Field | Frozen value |
|---|---|
| Workspaces | `ws1`, `ws2`, `ws3` |
| Roles per workspace | `main` 2, `native-child` 6, `worker` 4 |
| Execution id scheme | `q0-<workspaceId>-<role>-<NN>`, e.g. `q0-ws2-main-01` |
| Parent mapping | children 01-03 and Workers 01-02 under main 01; children 04-06 and Workers 03-04 under main 02 |
| Task templates | `q0-task/main@1`, `q0-task/native-child@1`, `q0-task/worker@1` |
| Stream plan | 1 burst of 100 deltas, 1 KiB per delta, 100 ms interval (ten-second burst per execution) |
| Main probes | 2 tool calls, 1 approval request, 1 cancellation probe, 1 retry probe per main execution |
| Child/Worker probes | 1 tool call, 1 approval request, no cancellation/retry probe |
| History fixture | 10,000 messages per main session, one 1 MiB tool result, 2 image references |
| Model fixture | `q0-local-fixture` / `q0-fixture-model` version `1`, `openai-chat` streaming on loopback |
| Plugin fixture | `q0-fixture-plugins` version `1` |
| Tools | `q0-tool-read@1`, `q0-tool-edit@1`, `q0-tool-bash@1` |

Per-execution `turnPlan` and `inputShape` carry the streaming plan, tool/approval
probes and the exact input hash, so an execution cannot be re-attributed to
another role, workspace or parent after the fact.

### Quota echo (no new limits)

| Name | Value | Read from |
|---|---:|---|
| Enabled workspaces | 3 | `packages/shared/src/command-center/primitives.ts` |
| Agents per workspace | 12 | same file |
| Agents per host | 36 | same file |
| Native children per session | 10 | `packages/shared/src/subagent-definition.ts` (`MAX_SUBAGENT_CONCURRENCY`) |
| In-flight RPC limit | 32 | `crates/host-core/src/rpc/mod.rs` (`MAX_IN_FLIGHT_RPC`) |

The manifest test executes each `QUOTA_SOURCES` pattern against the current source
file and fails if the number or declaration disappears, so a product change breaks
the fixture instead of silently diverging. Native-child limits are not raised: three
children per main stay inside the unchanged ten-child per-session ceiling.

### Corpus (measured, deterministic)

Single mixed corpus document: ordinary English prose, TypeScript code, JSON tool
results, Chinese prose and emoji/status lines. It replaces the ASCII-only P0
payload, which cannot represent a mixed text/code/tool-result workload.

| Section | Kind | Language | Bytes | SHA-256 |
|---|---|---|---:|---|
| `prose-en` | prose | en | 830 | `9439bec2f9f105b371091dc89465cfd394f66d9878392ac430c35bfb84c28a67` |
| `code-ts` | code | ts | 1077 | `74c22e44320cc2d989a3d1b8e2d22f56eed0f25a9db536848b4df18532fb95d3` |
| `tool-result-json` | tool-result | json | 672 | `fd28cb1a310a77ba4800e19f5bdbcb201a7c1f3233a2171e2281fe979231a126` |
| `prose-zh` | prose | zh | 742 | `0c557d7ffc922261206369422a39306df2ed7daa1d454a3e1382afe1ac611ea5` |
| `emoji-status` | status | mixed | 218 | `399898dde31657c997f6940d24200f3838189a77f1aaa855ff93a1bbd8df9152` |
| **`q0-mixed-corpus` v1** | — | — | **3539** | **`4cce124b87316748d1d1f0c3d4fcadfb8ebf7f32ccd4710ef49e93da60075dd1`** |

### Provisional input assembly (bytes, not tokens)

| Field | Value |
|---|---|
| Body target | 131,072 bytes |
| Repeats of the corpus document | 38 |
| Assembled body | 135,537 bytes, SHA-256 `f9a109eef25f19a2c22496176c039fc371315fee473835ad9f4844b7ae96788c` (`inputShape.bodySha256`) |
| Routing prefix | `q0-execution-prefix:<executionId>` (35 bytes for the first execution) |
| First execution input | 135,572 bytes, distinct `inputSha256` per execution |
| Execution-set digest | `ace6cab46ee11ae3128dcdf423b6fd977c1b9dcc250cc2bb26590f30d43a53d4` |

`inputShape.provisionalBytes: true` is deliberate. The repeat count is a starting
assembly chosen from text size only; it is **not** a token count and must not be
reported as one. After the token measurement below, the operator rebuilds the
manifest with an adjusted `bodyTargetBytes` repeat count, re-measures the counted
tokens and records the new manifest digest. Evidence for the old digest never
carries over, because `manifestSha256` covers the whole body.

### Candidate provenance

`buildWorkloadManifest` refuses a candidate without: 40-hex `head`, 40-hex `base`,
64-hex `hostBinarySha256`, `vX.Y.Z` `nodeVersion`, non-empty `sourceWorktree` and
`baseAncestryVerified: true`. The recorded ancestry assertion is the caller's
verified fact, not re-checked offline. The digest excludes only `generatedAt` and
the digest field itself, so re-running the same recipe keeps one identity while a
changed head, binary, corpus, quota or gate produces a different digest.

## Token evidence: tokenizer unavailable

Local discovery before any run (`TOKENIZER_DISCOVERY`), read-only:

| Probe | Result |
|---|---|
| `node_modules` and `node_modules/.pnpm` package names | No tokenizer package (only `js-tokens`, `comma-separated-tokens`, `micromark-util-subtokenize`) |
| `@earendil-works/pi-ai` exports | No token-count utility |
| `python -c "import tiktoken"` | `ModuleNotFoundError: No module named 'tiktoken'` |
| Repository references to `@dqbd/tiktoken`, `js-tiktoken`, `gpt-tokenizer` | None |

Consequence: `manifest.inputTokens.evidence.state` is `MISSING` with method
`not-measured`. Q0 does not install or download a tokenizer, and it never converts
bytes or characters into tokens. The historical "128 KiB synthetic context read as
32k tokens" reading is explicitly refused.

Q1 must supply a counted measurement:

```json
"tokenMeasurement": {
  "method": "tokenizer-count",
  "tokenizer": { "id": "<installed tokenizer id>", "version": "<version>", "sha256": "<64-hex of tokenizer data>" },
  "counts": [{ "executionId": "q0-ws2-main-01", "inputTokens": 32104 }],
  "measuredAt": "<ISO-8601 UTC>",
  "toolCommand": "<exact command used over the frozen corpus>"
}
```

Rejected methods: `byte-ratio`, `character-ratio`, `bytes-divided-by-4`,
`chunk-count`, `estimated`, `inherited-from-fixture-config`. Every one of the 36
executions needs a count, inside the target band, from one identified tokenizer.

**Q0 interpretation requiring review:** "approximately 32,000 tokens" is frozen as
30,400-33,600 (32,000 +/- 5 percent). A different band requires a recorded decision
before the run, not after a failure.

## Acceptance gate frozen by Q0

| Gate | Value | Requirement source | Q0 note |
|---|---|---|---|
| Application memory | sum of contemporaneous application-owned Private Bytes <= 4,000,000,000 at sample intervals <= 100 ms, with a post-outcome sample | requirements measurement boundary, AC-07 | Sequential reads inside one sample are a stated limit; sampler and outer driver excluded |
| No unobserved process gaps | every application-owned process present in every sample that covers its lifetime | AC-07, process coverage | A missing row, a PID reuse or a changed process-start identity fails |
| Local input to paint | P95 <= 100 ms | AC-08 | Must be measured by production renderer instrumentation under load |
| Warm workspace switch | P95 <= 250 ms | AC-08 | — |
| Host stop-request admission | P95 <= 500 ms | AC-08 | Stop admission, not turn cancellation |
| Latency samples | >= 1,000 per metric | AC-08 | Stricter reading than "1,000 total"; documented above |
| Mixed overlap | 36 simultaneous (12 per workspace as 2 main / 6 child / 4 Worker) for >= 5,000 ms | requirements reproducible load suite | 5 s floor approximates the ten-second synchronized burst |
| Lifecycle soak | 2 h (7,200,000 ms), >= 100 attach/detach/maximize cycles, <= 10 percent residual growth after cleanup | requirements lifecycle soak, AC-09 | Baseline is post-warmup with equivalent live workload and cache state |
| Disclosure | `processCoverage`, `samplingLimits`, `excludedRoles`, `sequencing` non-empty | requirements disclosure rule | Missing disclosure fails the bundle |

The minimum target stays two CPU cores, 8 GB RAM (decimal `8,000,000,000` bytes),
SSD, software rendering, no required discrete GPU. A larger development machine or
CPU affinity is preflight only and is reported as `comparisonOnly`.

**Q0 interpretation requiring review:** the requirements say "8 GB RAM" without a
decimal/GiB qualifier. Q0 reads it as decimal `8,000,000,000` bytes (7.45 GiB), the
same convention as the decimal 4 GB budget. Reading it as 8 GiB (`8,589,934,592`)
would raise the E1 threshold; that decision needs an explicit choice before a target
host is nominated.

## Q1 evidence contract

`assessQualificationEvidence({ manifest, evidence })` consumes one bundle:

| Field | Content |
|---|---|
| `schema` | `q0-qualification-evidence@1` |
| `manifestSha256` | digest of the exact manifest used |
| `candidate` | `head`, `base`, `hostBinarySha256`, `nodeVersion` identical to the manifest |
| `provider` | `{ kind: 'deterministic-fixture' \| 'real-provider', id, version, authorizationRef? }` |
| `workloadKind` | `mixed-2-6-4` |
| `tokenMeasurement` | counted tokens as above |
| `executions` | 36 entries: `executionId`, `workspaceId`, `role`, `startedAt`, `endedAt`, `inputSha256`, `settlement.verified`, `settlement.outputSha256` |
| `processes` | application-owned inventory: `role`, `pid`, `startTime`, `startedAt`, `exitObservedAt`, `scope` |
| `memorySamples` | `timestampMs`, `collectionMs`, `processes[]` with `startTime` and `privateBytes` |
| `window` | `loadStartedAt`, `loadEndedAt`, `measurementEndedAt`, `soakStartedAt`, `soakEndedAt` |
| `latency` | `local-input-to-paint`, `warm-workspace-switch`, `host-stop-admission` sample arrays |
| `lifecycle` | `durationMs`, `cycles[]`, `postWarmupBaselineBytes`, `finalSteadyBytes` |
| `cleanup` | `observer`, `observedProcesses`, `exitedProcesses`, `orphaned`, `proven`, `unobservedGaps` |
| `disclosure` | the four required arrays |

Cleanup must be proven through an original handle (`owned-spawn-preload` or
`handle-snapshot`), not a name scan or a missing PID. A real-provider bundle without
`authorizationRef` fails; fixture-provider bundles report
`providerQualification: 'NOT_RUN'` because fixture capacity never proves provider
rate limits or model behavior.

Stable failure codes emitted by the modules; the tests assert concrete instances
across every family below. The list is representative, not exhaustive - every code
is a stable lower-case string: `manifest_version_invalid`,
`manifest_digest_mismatch`, `quota_contract_changed:<key>`,
`minimum_hardware_target_changed:<key>`, `metric_gate_changed:<key>`,
`corpus_digest_mismatch`, `corpus_not_mixed:<kind>`,
`candidate_commit_invalid`, `candidate_host_binary_invalid`,
`candidate_base_ancestry_unverified`, `execution_set_incomplete`,
`workspace_topology_changed:<ws>:<role>`, `execution_identity_duplicate`,
`execution_parent_invalid`, `tokens_inferred_from_bytes:<field>`,
`token_measurement_not_counted`, `token_measurement_empty`,
`token_measurement_coverage_incomplete`, `token_count_out_of_band:<id>`,
`tokenizer_identity_missing`, `evidence_not_bound_to_manifest`,
`candidate_provenance_mismatch:<field>`, `synthetic_workload_not_equivalent:<what>`,
`execution_identity_unknown`, `execution_attribution_mismatch:<id>`,
`execution_input_mismatch:<id>`, `execution_output_unverified:<id>`,
`no_mixed_36_overlap:<ws>:<role>`, `overlap_too_short`,
`process_inventory_missing`, `process_coverage_incomplete:<role>`,
`process_identity_invalid`, `process_identity_duplicate`,
`process_exit_unobserved:<role>:<pid>`, `unobserved_process_gap:<role>:<pid>`,
`unexpected_process_identity`, `memory_sample_invalid:<what>`,
`memory_observation_missing`, `memory_budget_exceeded`,
`sampling_interval_exceeded`, `collection_exceeded_interval`,
`sampling_coverage:<reason>`, `latency_metric_missing:<id>`,
`latency_samples_insufficient:<id>`, `latency_sample_invalid:<id>`,
`latency_p95_exceeded:<id>`, `soak_duration_not_met`, `soak_cycles_not_met`,
`soak_cycle_invalid`, `baseline_missing`, `steady_state_missing`,
`residual_growth_exceeded`, `cleanup_unproven`, `cleanup_orphan_detected`,
`cleanup_observer_unknown`, `cleanup_coverage_incomplete`,
`cleanup_gap_unobserved`, `provider_provenance_missing`,
`provider_authorization_missing`, `disclosure_missing:<field>`,
`evidence_schema_mismatch`, `evidence_missing`.

Even a complete bundle returns `PASS_WITH_STATED_LIMITS` with
`productAcceptance: 'NOT_ACCEPTED'`; accepting capacity, native interaction or
mobile behavior belongs to the owning lane on a nominated environment.

## Synthetic 1 MiB main-only fixture is not equivalent

The retained P0/1 MiB runs are real Host/runtime runs but the wrong workload shape:

1. payload is one ASCII repetition sized in **bytes**, with `contextTokens:
   'NOT_MEASURED'`, so it cannot evidence ~32k tokens;
2. it is 36 independent main sessions - no native children, no Workers, no three
   workspaces, no 12-per-workspace admission;
3. it has no per-role tool/approval/cancel/retry probes and no mixed corpus;
4. it reports `scope: 'headless-session-runtime-baseline'` and excluded renderer,
   plugins, native programs and browser edge, so it cannot evidence the 4 GB
   application-owned process set or the interaction gates.

The checker therefore rejects bundles that carry `contextBytes`/`contextKind`, the
`independent main sessions` topology marker, a non-`mixed-2-6-4` workload kind or a
single-role execution set, and it requires counted tokens, mixed overlap and the
full process/disclosure evidence.

## Environment matrix: known vs missing on this machine

Read-only local facts: Windows 10 Pro `10.0.19045` x64, `Genuine Intel(R) 0000`
with 6 cores / 6 logical processors, 25,765,265,408 bytes RAM, Node `v24.12.0`,
pnpm `12.8.1`, Electron `43.6.0`.

| Env | Status | Known | Missing / unresolved input |
|---|---|---|---|
| E1 minimum-target runner | **MISSING** | Local host identity only, flagged `comparisonOnly` | Nominated 2-core/8-GB Windows target, exact CPU model/OS build, SSD, access |
| E2 tokenizer/corpus/fixtures | **MISSING** | In-repo mixed corpus frozen by hash; plugin/tool fixture ids declared | Installed tokenizer + version/data hash, plugin/tool artifacts with hashes, representative provider quota record |
| E3 native programs / interactive | **MISSING** | Contract shape only | Named programs with versions/privileges, RDP session, DPI 100/125/150/200 percent, Chinese IME, dialog access |
| E4 Android/iOS/HTTPS | **MISSING** | Contract shape only | Real Android and iOS/iPadOS devices with browser versions, HTTPS edge, enrollment/revocation, controlled network faults |
| E5 macOS/Linux runners | **MISSING** | Contract shape only | Native macOS and Linux runners with display server scope |

No environment can be substituted: a 6-core/24 GB development host is not
minimum-target evidence, a VM is a documented candidate rather than automatic
equivalence, and fixture capacity does not prove provider rate limits.

## Integration into Q1, Q2 and Q3

Q0 work becomes usable at these exact joins. Nothing below has been run.

### Q1 - Windows capacity and lifecycle (after H5, C4, M1, U1, Q0)

1. Build the candidate Rust Host in the task worktree with the shared Cargo target;
   record `git rev-parse HEAD`, the verified `origin/main` ancestor, the Host binary
   SHA-256 and `node -v`.
2. Generate the manifest for that candidate and persist it:
   `node -e "import('./scripts/e2e/command-center/qualification-manifest.mjs').then(m => console.log(JSON.stringify(m.buildWorkloadManifest({candidate:{head,base,hostBinarySha256,nodeVersion,sourceWorktree,baseAncestryVerified:true}, generatedAt: new Date().toISOString()}), null, 2)))"`
   with the six candidate fields substituted; store the printed digest.
3. Measure counted tokens over `corpus.sha256` with the installed tokenizer, adjust
   `bodyTargetBytes` if the count is outside 30,400-33,600, regenerate the manifest
   and re-measure. The digest changes; discard counts taken against the old digest.
4. Run the load alone on the nominated target with the isolated environment:
   `PI_DESKTOP_DATA_DIR`, `TEMP`, `TMP`, `PI_DESKTOP_AGENTS_DIR` all under one scratch
   root, produced by `buildIsolatedEnvironment` and checked by
   `validateIsolatedEnvironment`. Reuse the existing harness composition
   (`HostProcess`, `AgentSidecar`, `RuntimeService`, `AgentHost`, loopback
   `startProvider` with `ticks: 100`, `intervalMs: 100`) rather than a new runner.
5. Map the recipe onto that harness: 36 executions across three admitted
   workspaces, 2 main / 6 native child / 4 Worker per workspace, per-execution
   corpus input hash, tool/approval/cancel/retry probes. Admission must use the
   existing 12/36/10/32 limits; the manifest does not introduce a quota store.
6. Collect memory samples at <= 100 ms with a post-outcome sample, production
   renderer latency samples (>= 1,000 per metric), the two-hour/100-cycle lifecycle
   record and handle-based cleanup proof.
7. Assemble the evidence bundle and run
   `assessQualificationEvidence({ manifest, evidence })`. Report `failures`,
   `measurements`, `providerQualification`, disclosure text and the residual
   `productAcceptance: 'NOT_ACCEPTED'` statement; a `PASS_WITH_STATED_LIMITS` result
   is not Q1 acceptance by itself - Q1 acceptance additionally needs the owning
   lane's report on the nominated target.

### Q2 - Native interaction (after N1, U1, Q0)

Populate `environment.nativePrograms` (id, version, privilege, `verified: true`) and
`environment.interactive` (`rdp`, `dpi`, `ime`, `dialogs`, `dpiScales`).
`assessEnvironmentReadiness` reports `E3` and only then lists `Q2: ['E3']`. Q0
supplies no program list, no RDP session and no DPI/IME measurement.

### Q3 - Mobile and cross-client (after W1, W2, M1, C4, H5, Q0)

Populate `environment.devices.android` and `.ios` (osVersion, browser,
browserVersion) and `environment.crossClient` (`httpsEdge`, `enrollment`,
`revocation`, `networkFaults`). `E4` gates `Q3`. Desktop-as-mobile and simulated
reconnect fixtures do not substitute for real devices.

Integration rules that stay in force: no live Desktop/profile, no stored SSH or real
accounts, no paid provider, no `verify:ui:*` without an explicit request, and no
merge into local `main` to manufacture an integration candidate.

## Checks actually run

Isolated scratch root used for every command:
`C:/Users/Administrator/.pi-desktop/scratch/233744ff-b9c5-46dd-9a91-5169100d5569/q0test`.

```sh
# explicit isolated environment for both runs
PI_DESKTOP_DATA_DIR=.../q0test/data TEMP=.../q0test/temp TMP=.../q0test/temp \
  PI_DESKTOP_AGENTS_DIR=.../q0test/agents \
  node --test scripts/e2e/command-center/qualification-manifest.test.mjs \
            scripts/e2e/command-center/qualification-validation.test.mjs
# 24 tests, 24 pass, 0 fail
PI_DESKTOP_DATA_DIR=... TEMP=... TMP=... PI_DESKTOP_AGENTS_DIR=... \
  node --test scripts/e2e/command-center/*.test.mjs
# 47 tests, 47 pass, 0 fail (24 new, 23 pre-existing)
```

Also executed: `node --check` on both modules, a build/print of the corpus and
manifest values quoted above, and read-only local discovery (CPU/RAM/OS, Node/pnpm/
Electron versions, tokenizer probes, `git merge-base --is-ancestor`).

Not run and not claimed: Rust build, Cargo/pnpm commands, dependency install,
Electron/Desktop launch, browser/mic/RDP, load or soak, any real provider,
`verify:ui:*`, typecheck/lint. No process outside this task's own environment was
inspected.

## Limits

1. **Preparation, not evidence.** No Q1/Q2/Q3 measurement, no minimum-target run and
   no product acceptance exist. Every environment gate stays missing.
2. **Bytes are not tokens.** The corpus and body sizes are byte identities. Counts
   are `MISSING` until a real tokenizer measurement is supplied; the 5 percent band
   and the 5 s overlap floor are Q0 interpretations that need review.
3. **Corpus ownership.** The mixed corpus is an in-repo deterministic fixture, not an
   externally frozen corpus. Changing its text changes `corpus.sha256` and every
   input hash, so evidence from the previous corpus cannot be reused.
4. **Sampling limits stay disclosed.** Sampled maxima and sequential reads inside a
   sample do not prove an absolute allocation bound between samples; correlated OS
   traces remain optional and any demonstrated breach still fails the gate.
5. **The checker cannot accept.** `assessQualificationEvidence` validates contract
   completeness and always reports `productAcceptance: 'NOT_ACCEPTED'`; provider,
   native and mobile qualification belong to the owning lanes.
