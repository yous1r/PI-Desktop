# Upstream changes after v0.22.0: fork migration

## Scope and provenance

- Requested source: `vastsa/PI-Desktop`, fetched on 2026-11-09.
- Source tag: `v0.22.0` = `589b6703fcfdfd257ebd7fc0551321f0049a3a67`.
- Source cutoff: `3169c219d0220b77557a178a6bef395d95ff1e09`.
- Destination base: `yous1r/PI-Desktop` `origin/main` =
  `fd28eb89866ac513912ed109716e7120cf60f18c`.
- Request branch: `chore/migrate-upstream-post-v0220`.
- Executable candidate: `87c7ca49984d94adf770a7445594b76594eef654`.
- Strategy: `git cherry-pick -x -m 1` of the 11 first-parent PR merges,
  in upstream order, followed by one fork integration correction commit.

The source range contains 47 historical commits, including 17 non-merge
commits. A direct merge of source `main` would additionally import 499 commits
already reachable from the upstream tag but absent from this fork. Those
older features and their dependency upgrades are outside this request.
The migration therefore transfers each PR's mainline delta and records its
source SHA rather than claiming the upstream head is an ancestor of the fork.
Fork release manifests, Cargo versions, changelog surfaces, bundled model
catalog and the locked Pi 1.4.0 dependency group are preserved at the destination
baseline. This is a source migration, not a new release.

## PR-to-commit mapping

| Upstream PR | Upstream merge | Local port | Change |
| --- | --- | --- | --- |
| #2190 | `f69299570` | `652b4df00` | Explain unpublished macOS SSH Host bundles |
| #2196 | `345f6f0e1` | `499f17a07` | Settle file-manager Git deadlines without waiting for inherited pipes |
| #2201 | `fc28d5d9b` | `456f9e330` | Retry transient macOS stapler validation failures |
| #2199 | `c97711fb1` | `6e1bc2efb` | Screenshot paste regression coverage, adapted to the existing fork fast path |
| #2194 | `181d11e0c` | `e3dc4e0b2` | User-defined modes, stage artifacts, gates, claims and persistence |
| #2192 | `6c81b7f29` | `09206b9fc` | Put session scratch identity after the shared system-prompt prefix |
| #2198 | `7ce62ea03` | `08621cd06` | Give steering recovery replies a fresh message identity |
| #2210 | `b9028c3c7` | `8e27cd16e` | Goal budgets, pause/edit/remove controls and closeout notices |
| #2211 | `6acb877db` | `4686afe4e` | Mode catalog file ownership and refresh |
| #2212 | `5592555d3` | `98b5840db` | Resolve a closed run's return mode against the current catalog |
| #2195 | `3169c219d` | `43abd3ba8` | Resolve native Pi file requests through their source session |

Fork compatibility corrections are in `87c7ca499`. Original upstream
merge authors and `cherry picked from commit` trailers are retained.

The 17 non-merge commits included in the source range are:

```text
1131ce966  user-defined staged mode workflows
 eb5850d53  unpublished macOS Host explanation
 d06c4436e  scratch prompt placement
 990442fb8  integrated mode and approval fixtures
 233022a49  Plan coverage and legacy Goal activation refusal
 a5e3b3626  native Pi file source routing
 9ebe54860  file-routing validation documentation
 7f058a9d9  immediate Git deadline settlement
 71cee3a78  steering recovery message identity
 0271ec35d  screenshot directory-scan bypass
 b87d68049  native image paste compatibility coverage
 2bbab2524  stapler validation retry
 5a5c63ee4  literal workflow placeholders in VitePress
 a209a2ca8  Goal run controls
 16a2cd6bb  native-routing Host replacement fixture correction
 226be74a8  mode catalog file ownership
 39384a7cc  return-mode catalog settlement
```

## Conflict decisions

1. **Remote Host errors.** The fork separates complete-error handling from
   bare-code translation. The unpublished Darwin target check stays in the
   complete-error entry point; existing Host preparation/recovery codes remain.
   The upstream error regression file was restored with compatible mappings.
2. **Bundled file manager.** Keep the fork's `0.9.1-pi.2` workspace execution
   entry, manifest and view. Merge only the Git deadline repair into `main.js`,
   then recompute its actual byte count and SHA-256 in `UPSTREAM.md`.
3. **Clipboard.** This fork never introduced the earlier native directory-card
   scanning path, so screenshots already bypass that wait. Preserve production
   paste behavior and port screenshot/native-image byte regressions. Do not
   import pre-tag directory cards, their editor state, or their fixture claims.
4. **Modes and settings.** Wire mode catalog/run services into the existing
   Main, renderer and Agent Host structure. Keep the fork's settings layout,
   personal todos, remote Host deployment and plugin owner lifecycle. Add Goal
   budget controls to its existing defaults card. Keep original delegation
   controls; do not introduce pre-tag computer-use/background-job APIs.
5. **Database.** The fork starts at schema 27; upstream modes assume schema 28.
   Back up the actual source version and add mode tables transactionally from
   either 27 or 28 to 29. Do not import the pre-tag project-path reconciliation
   migration. Preserve sessions, approvals, queue records and existing tables.
   Update old current-version and future-version test assertions accordingly.
6. **Plugin contracts.** Shared and SDK owner contexts now accept custom mode
   IDs. Main matches them to durable Host identity and outbound launch facts.
   Only builtin Agent retains mutating owner operations; custom mode/stage
   permission does not silently widen the fork's plugin security boundary.
7. **Documentation and fixtures.** Preserve fork-specific sections and append
   only each PR's actual new spec content. Drop changes targeting absent
   pre-tag files. Reuse the existing raw-source esbuild plugin in native file
   E2E; provide the actual terminal channel module to the renderer API fixture;
   update the Composer fixture's renamed transform-invalidation callback.

## Validation environment and results

Windows x64, Node 24.12.0, Rust 1.97.1, Electron 43.6.0. Cargo uses the existing
host target cache. Workspace package outputs are built from the candidate.
Electron binaries are referenced from the existing host installation. All
executed model/process tests use offline fixtures and temporary profiles.

The initial `pnpm build:js` unexpectedly triggered pnpm 12 dependency setup;
its Desktop postinstall failed because MSVC Spectre libraries are unavailable.
The build then used direct installed compiler/build executables and reused the
host Electron binary. No source manifest or lockfile was changed to bypass it.

### Passed

- TypeScript builds: shared, i18n, plugin-sdk, plugin-devkit, agent-runtime,
  agent-host, host-runtime, racp, voice-runtime and pi-host.
- Desktop `tsc -p tsconfig.json --noEmit` and `electron-vite build`.
- VitePress production build; documentation locale/link checks.
- Biome (repository-configured scope), style tokens, architecture budgets,
  release version consistency, agent-policy synchronization and Pi pins.
- Latest-base ancestry via `node scripts/check-pr-base-main.mjs`.
- Runtime/mode/owner suites: 466 tests, no skips, including all 375 runtime tests.
- Shared package default suite: 1,394 executions, including both source and
  emitted test copies; this is not a count of distinct behavior scenarios.
- Agent Host: 75 tests. Host Runtime: 175 passed, 3 existing platform skips.
  The latter passed with `--maxWorkers=2 --testTimeout=30000 --hookTimeout=30000`
  after the default parallel run timed out while creating large file trees.
- Mode Main and production plugin owner tests: 36 passed. Renderer mode
  tests: 14 passed. Targeted remote bootstrap, file-manager, native-file,
  screenshot and owner-broker regressions passed.
- Isolated Electron mode user path: picker, status controls and settings editor.
- `node scripts/e2e-native-workspace-files.mjs`: real Main IPC and file access.
- `node scripts/e2e-composer-paste.mjs --screenshot-only`: exact image bytes,
  screenshot scan bypass and native image compatibility.
- Stapler shim: retry, retry exhaustion and argument-preserving pass-through,
  3 tests passed with `--test-name-pattern='stapler shim'`.
- Rust targeted filters: `mode_runs` 32, `tool_image_storage_migration` 4,
  `plugins::providers` 24 and `turn_queue` 13 tests passed.
  Worktree tests: 67 passed; worktree RPC: 6 passed. The controlled rerun used
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false`
  plus `GIT_CONFIG_SYSTEM=NUL` in the process environment only; the latter
  survives the production GitRunner's config-argument scrub.
- `cargo check -p host-core --locked`; `cargo fmt --check` after corrections;
  `cargo clippy -p host-core --all-targets --locked` (warnings reported).
- `cargo build -p host-core --locked`, followed by real Host E2E on executable
  candidate `87c7ca499`: `e2e-mode-definitions.mjs` passed the complete
  artifact/approval/command-gate/return-mode sequence; `e2e-plan.mjs` reported
  14 passed, 0 failed, 3 skips (clock-control, unavailable-shell simulation,
  and opt-in 60-second timeout leg).
- Candidate Host SHA-256:
  `9660491b87381c2a4206c808f71937926fbb69113b574e4fe81cdf5e3ae67f43`.

### Full-suite limitations

The first complete Rust run reported 1,107 passed, 25 failed and 1 ignored.
Five failures were stale schema assertions caused by this migration and were
fixed and retested. CRLF-dependent worktree failures were reproduced and
removed by isolated Git configuration; no global Git setting was modified.
The full suite was not rerun after those targeted corrections.

Seven remaining failures reproduce with identical panic messages after
compiling a clean `git archive origin/main` baseline with the same toolchain:

- Three `data_relocation` tests compare Windows path spellings or collisions.
- Two `rpc::remote_tools` tests receive `permissions.request` where the fixture
  expects `tools.remoteExecute`.
- `background_tasks::windows_tests::stop_terminates_the_command_the_runner_launched`
  fails its child cleanup assertion.
- `tools::windows_process_tree::tests::children_are_terminated_before_their_parents`
  fails on a missing expected descendant.

All affected production/test files are byte-identical to the destination
baseline. These are pre-existing failures, but they still prevent claiming a
fully green Windows suite. Baseline compilation was completed before running
the seven exact tests; none timed out. The candidate Host was rebuilt last so
E2E did not accidentally execute the baseline binary.

The complete macOS release fixture suite does not pass on this Windows host:
its POSIX URL path handling produces `/D:/...`, and the process-group timeout
assertion does not hold under Windows. Real macOS signing/notarization was not
performed. The new portable stapler shim behavior was verified separately.

Paid-provider Goal live acceptance, actual SSH/Linux release deployment,
marketplace authorization, `verify:ui:*`, and installed-user-profile tests were
not run. No PR integration candidate has been tested or merged.

## Delivery state

Local migration is committed on the request branch. Remote main integration
is **not complete**: no PR was created, no PR integration candidate was
validated, and no merge or direct push to main was performed. The source
candidate contains the destination base and preserves release version 0.22.3.
Remaining landing work is authenticated PR creation, required remote checks
and review, resolution of any applicable platform gates, then gated merge.
The executable source candidate and these instructions provide a resumable,
reviewable handoff; later report-only commits do not change the tested code.

Remote `main` must not be advanced until repository landing gates pass.
The available GitHub CLI has no authenticated account, and Git credential
lookup did not return an API credential. SSH Git access does not authorize
bypassing the repository's PR-only integration rule. Keep the request branch
and worktree until remote integration is complete; preserve the user's primary
checkout and all unrelated worktrees.
