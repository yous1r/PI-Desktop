# AI command center: Batch 1 worktree baseline (Q0)

- Status: Qualification baseline for the reconstructed Batch 1 request worktree.
  Internal engineering evidence only; it does not change product acceptance,
  capability advertisement, or any blocked work-package status.
- Recorded: 2026-11-11 (Asia/Singapore), worktree `command-center-wiring-20261111`.
- Branch: `feat/command-center-wiring-20261111`, HEAD
  `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`, containing fetched `main`
  `e977efc96b6b735aeef5066a0b66c6565ad5691f`.
- Worktree: `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111`.
  The primary checkout `D:\Packages\PI-Desktop` was used only as a build-cache and
  toolchain source; no source file there was modified.
- Machine-readable evidence:
  [.artifacts/batch1-baseline-evidence.json](../../.artifacts/batch1-baseline-evidence.json).

## Reconstructed-tree caveat (read first)

This is a **reconstructed working tree**, not a committed candidate and not a
pristine branch checkout. The command-center baseline is **uncommitted** work copied
from the original request worktree
`D:\Packages\PI-Desktop\.worktrees\command-center-continuation-20261110`
(read-only during the copy and untouched afterwards). Git records only the base
commit `1cdb4ce1d`; file contents on disk include that copied baseline plus edits
made by the concurrent Batch 1 lanes (H3 Rust entry, C3 RACP registration, U1
Desktop mount).

`.artifacts/batch1-baseline-manifest.json` snapshots the 160 baseline files
(byte SHA-256) present at reconstruction. It is the comparison point for
"what changed since this worktree was created". Baseline results below describe
the tree state named by the timestamps in each suite row; they do not certify any
commit or PR candidate, because no commit was created.

## Environment

| Item | Actual value |
|---|---|
| OS | Windows 10 Pro, `10.0.19045`, x64 |
| CPU / RAM | 6 logical CPUs / 24 GiB |
| Node | `v24.12.0` |
| Rust | `cargo 1.97.1`, `rustc 1.97.1` |
| Source HEAD / base main | `1cdb4ce1d` / `e977efc96` |
| Git worktree state | uncommitted baseline + concurrent lane edits (see caveat) |
| Rust build cache | reused `D:\Packages\PI-Desktop\target` via `CARGO_TARGET_DIR` |
| Scratch directory | `<worktree>\.artifacts\scratch\q0` via `PI_SCRATCH_DIR` |
| Test runner launchers | `node --test`; package `vitest` invoked directly as `node node_modules/vitest/vitest.mjs run` |

Launcher limitation: the `pnpm` shim on `PATH` (`D:\mise_data\shims\pnpm.exe`) is
broken in this host — it resolves to
`...\.tools\pnpm\12.8.1\node_modules\pnpm\pnpm`, which does not exist, so every
`pnpm ...` invocation exits 1 before running a script. The installed tool entry
points were invoked directly instead (the package `test` script is exactly
`vitest run`). No dependency install, link, or rebuild was performed. This is the
same launcher issue already recorded in the P0 baseline.

## Suite results

All commands run from the worktree root unless a `cd` is shown. `PASS` means the
command was actually executed here and its runner reported the stated counts.
Nothing below is inferred from the earlier handoff.

| # | Suite | Command | Result | Counts / duration |
|---|---|---|---|---|
| 1 | Desktop command-center + attachment (`node --test`) | `node --test apps/desktop/test/command-center-*.test.mjs apps/desktop/test/handoff-attachment.test.mjs` | **PASS** | 25 tests, 25 pass, 0 fail; 4 input files; 73.8 s |
| 2 | `packages/command-center-client` (full) | `cd packages/command-center-client && node node_modules/vitest/vitest.mjs run` | **PASS** | 259 tests, 15 files, 0 fail; 14.4 s |
| 3 | `packages/racp` (full) | `cd packages/racp && node node_modules/vitest/vitest.mjs run` | **PASS** | 33 tests, 4 files, 0 fail; 5.0 s |
| 4 | `packages/shared` command-center filter | `cd packages/shared && node node_modules/vitest/vitest.mjs run src/command-center` | **PASS** | 59 tests, 10 files, 0 fail; 3.4 s |
| 5 | `packages/agent-host` command-center filter | `cd packages/agent-host && node node_modules/vitest/vitest.mjs run command-center` | **PASS** | 15 tests, 1 file, 0 fail; 3.6 s |
| 6 | `packages/shared` full source suite (extended baseline) | `cd packages/shared && node node_modules/vitest/vitest.mjs run src` | **PASS** | 808 tests, 72 files, 0 fail; 17.4 s |
| 7 | `packages/agent-host` full source suite (extended baseline) | `cd packages/agent-host && node node_modules/vitest/vitest.mjs run src` | **PASS** | 151 tests, 12 files, 0 fail; 10.5 s |
| 8 | `crates/host-core` `command_center` tests | `$env:CARGO_TARGET_DIR='D:\Packages\PI-Desktop\target'; cargo test -p host-core command_center --locked --offline` | **PASS** | 59 passed, 0 failed, 1,323 filtered out; 0.76 s (final tree state 12:04; first run at 11:42: 1,316 filtered, 0.89 s) |
| 9 | Command-center baseline harness | `$env:PI_SCRATCH_DIR='<worktree>\.artifacts\scratch\q0'; node --test scripts/e2e/command-center/*.test.mjs scripts/e2e-command-center-curve.test.mjs` | **PASS** | 48 tests, 48 pass, 0 fail; 0.84 s |
| 10 | Public-package consumer check (source mode) | `node scripts/check-command-center-foundations.mjs` | **PASS** | 12/12 checks; `{"status":"PASS","inputs":"current-source",...}`; 3.2 s |
| 11 | Host-runtime attachment + repository adapter | `cd packages/host-runtime && node node_modules/vitest/vitest.mjs run src/owner-handoff-attachment.test.ts src/command-center-repository.test.ts` | **PASS** | 36 tests, 2 files, 0 fail; 5.4 s |
| 12 | Rust formatting | `cargo fmt --check` | **PASS** | exit 0, no diff; informational |
| 13 | Consumer check, emitted-artifact mode | `node scripts/check-command-center-foundations.mjs --built` | **NOT RUN** | `packages/command-center-client/dist` is absent in this reconstructed worktree; rebuilding package output is outside the Q0 write scope |
| 14 | `cargo clippy -p host-core --all-targets` | — | **NOT RUN** | Known host limitation: `ring` does not compile in this MSVC environment before project code is linted |
| 15 | `host-runtime` typecheck | `cd packages/host-runtime && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **FAIL (environment)** | 4 pre-existing errors from the provisioned Pi dependency copy: `Promise.withResolvers` lib target + `PluginManifest.execution` / `main` missing (`src/workspace-plugin-mcp.ts`) |
| 16 | `agent-runtime` typecheck | `cd packages/agent-runtime && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **PASS** | exit 0; full package build/test still not exercised (see limitations) |
| 17 | `verify:ui:*` / real Electron journey | — | **NOT RUN** | Not requested and forbidden for this task; no Desktop instance or profile was used |

Notes:

- Suite 1 uses Node's own test-file glob support; the four inputs are the three
  `command-center-*.test.mjs` files plus `handoff-attachment.test.mjs`.
- Suite 4 deliberately runs `src/command-center` instead of a bare `command-center`
  filter: the bare filter also matches the stale `dist/command-center/*.js`
  duplicates produced by an earlier build (20 files / 118 duplicated tests).
  The source-only run is the meaningful 59-test figure.
- Suite 8 was run twice. The 11:42 run compiled the tree as copied; a 11:58
  re-run hit the H3 lane's in-flight `owner_handoff/target.rs` edit (compile error,
  not a test failure); the final 12:04 run with `--offline` against the host Cargo
  cache compiled and passed 59/59. The filtered-out count grew from 1,316 to 1,323
  because the H3 lane added seven tests outside the `command_center` filter.
- Post-lane observation (same worktree, after C3 edits, 12:05): `packages/racp`
  **42 tests / 5 files pass** (was 33/4; the C3 lane added
  `command-center-registration.test.ts`), `shared` command-center **59/10** and
  `agent-host` command-center **15/1** still pass. This is not part of the copied
  baseline; it shows the tree remained green after those lane edits at that time.

## Failures and environmental limitations

1. **No Q0 suite failed.** The only FAIL recorded above (suite 15) is a
   pre-existing dependency-copy/environment failure in `host-runtime` typecheck,
   not a command-center test.
2. **`host-runtime` / `agent-runtime` full package builds cannot be claimed.**
   The provisioned Pi dependency copy lacks this branch's patched
   `PluginManifest` members. Isolated command-center tests in `host-runtime`
   (suite 11) do pass, but they do not constitute a package build gate.
3. **OS-temp directory creation is denied to test processes** on this managed
   host. The command-center curve test therefore requires `PI_SCRATCH_DIR`; it was
   set to worktree scratch and the suite passed. No OS-temp reliance was added.
4. **`cargo clippy`** remains unavailable (MSVC `ring` build failure). Rust static
   confidence here is limited to `cargo test` + `cargo fmt --check`.
5. **Broken `pnpm` launcher** on `PATH` (see Environment). All package suites were
   run through the already-installed vitest entry point; no installs.
6. **No production-path evidence**: no real Desktop route mount, RACP catalog
   registration, provider, profile, paid service, or device was exercised. The
   unwired/blocked items recorded in the acceptance index are unchanged.

## Concurrency and manifest comparison

Other lanes were editing this worktree while Q0 ran. The comparison against
`.artifacts/batch1-baseline-manifest.json` (160 files) at the time of writing is
recorded in `.artifacts/batch1-baseline-evidence.json`; each changed/added source
file in it is attributed to a concurrent lane or to Q0's own docs/evidence (the
JSON records the attribution per path).

At the 11:53 comparison the only differences were H3-lane Rust files:

| File | Change |
|---|---|
| `crates/host-core/src/main.rs` | modified |
| `crates/host-core/src/owner_handoff/mod.rs` | modified |
| `crates/host-core/src/owner_handoff/target.rs` | modified |
| `crates/host-core/src/owner_handoff/target/tests.rs` | modified |
| `crates/host-core/src/owner_handoff/target/tests/argv_tests.rs` | added |
| `crates/host-core/src/owner_handoff/target/tests/entry_tests.rs` | added |

At the 12:03 comparison (160-file baseline manifest):

| Class | Count | Files |
|---|---:|---|
| Changed in baseline, H3 lane | 4 | `crates/host-core/src/main.rs`, `crates/host-core/src/owner_handoff/mod.rs`, `crates/host-core/src/owner_handoff/target.rs`, `crates/host-core/src/owner_handoff/target/tests.rs` |
| Changed in baseline, C3 lane | 2 | `packages/racp/src/command-center-dispatch.ts`, `packages/racp/src/command-center-dispatch.test.ts` |
| Changed in baseline, Q0 lane | 1 | `docs/project/ai-command-center-acceptance-index.md` (this task's section) |
| Tracked file modified after baseline | 6 | `crates/host-core/src/owner_handoff/tests.rs` (H3); `packages/racp/src/{host-operations,operations,server,test-harness}.ts` and `packages/shared/src/racp.ts` (C3) |
| New file after baseline | 9 | H3: `target/tests/{argv_tests,entry_tests}.rs`; C3: `packages/racp/src/command-center-registration.test.ts`; Q0: this doc, the baseline manifest and `.artifacts` scratch files |

The machine-readable evidence re-ran this comparison later (12:12–12:30); by then
the U1 lane had also added `apps/desktop/src/features/command-center/`
(`CommandCenterPage.tsx`, `command-center-fixtures.ts`), added
`apps/desktop/src/styles/command-center.css`, edited the copied command-center
locale files, and modified its own tracked Desktop/i18n files, while the lanes'
`.artifacts` scratch files grew (excluded from the source list). The Q0-owned
change remains only this doc and the acceptance-index section; see the evidence
JSON for the final snapshot and per-path attribution.

Because the H3 lane was still editing `owner_handoff/target.rs`, the 11:58
`cargo test` re-run did **not compile** (`target.rs:62`, `dispatch(directory,
windows::receive)` lifetime error — an in-flight H3 edit). H3 then fixed it; the
12:04 `--offline` re-run compiled and passed 59/59. That transient failure is a
concurrency observation, not a Q0 suite result. The H3 lane must still run its own
Rust gates for the entry work, and the final candidate must re-run suite 8; Q0
does not certify the mid-flight tree as a candidate.

H3 later completed the entry and the coordinated schema-30→31 bump; the H3 lane's
logs record `owner_handoff::target` **22/22** and the full `owner_handoff` suite
**146/0** (see the acceptance index Batch 1 section). Q0 did not re-run those
suites; its baseline Rust count above remains the `command_center` filter only.

## C3 registration digest refresh

C3 added the thirteen `commandCenter/*` catalog entries and their registration
tests after the Q0 baseline snapshot. The C3-related digests in
`.artifacts/batch1-baseline-evidence.json` were recomputed from the current files
on 2026-11-11:

| Path | SHA-256 |
|---|---|
| `packages/racp/src/command-center-dispatch.ts` | `57dbb8da60db8636e86f8f3b84036ee79d380e7a06e54a7ab9da05daf4a9f7ac` |
| `packages/racp/src/command-center-dispatch.test.ts` | `d84c1f778b1dd6d499a8d543af10a185a00fca0335056a302b68f0fcc74cd821` |
| `packages/racp/src/operations.ts` | `6dd73762f009757f8e5be9766ff9c0ef34c987664dfb7dab255e41c8a86d9766` |
| `packages/racp/src/server.ts` | `62f766d24c23b07e3668677c046f3dbd72a71ef97b4da301e235cfceda909324` |
| `packages/racp/src/host-operations.ts` | `ff3e93c137794ba15d43b65226a9697f42994386df14963a115c33cde47b63ca` |
| `packages/racp/src/test-harness.ts` | `80c0214785a3c37505f51b21b7e5640a9df3875abe824f60222175d50624d795` |
| `packages/racp/src/command-center-registration.test.ts` | `a8abdfc03d4fa5a384b7291fc45d21b4b9ba31b1e1b98938d0ad66784d29e6f8` |
| `packages/shared/src/racp.ts` | `d09987bad8b1e6aa9d5807bc82fbdba10f9140f98fee28ec2ef967c9caec51e3` |

The original [takeover evidence](ai-command-center-takeover-evidence.json) is a
record of the earlier tree and is intentionally **not rewritten**. Its digests for
these eight paths are superseded only by this refresh; the other hashes still
describe the copied baseline. C3's recorded test evidence (RACP **42/5**, shared
package **1,616/144**) is cited by the acceptance index; Q0 did not re-run those
suites.

## What this baseline proves and does not prove

Proves: the copied command-center baseline is present and functional in the
reconstructed worktree across the desktop, client, RACP, shared, agent-host,
host-runtime attachment, Rust `command_center` and Q0 harness layers, with the
counts above reproduced independently of the earlier handoff.

Does not prove: any committed/PR candidate, any end-to-end owner handoff, RACP/IPC
registration, Desktop route mount, browser/device qualification, capacity or soak
targets, or release readiness. Those remain blocked exactly as recorded in the
[acceptance index](ai-command-center-acceptance-index.md).

## Reproduction

```powershell
$w = 'D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111'
cd $w
node --test apps/desktop/test/command-center-*.test.mjs apps/desktop/test/handoff-attachment.test.mjs

cd "$w\packages\command-center-client"; node node_modules/vitest/vitest.mjs run
cd "$w\packages\racp";                 node node_modules/vitest/vitest.mjs run
cd "$w\packages\shared";               node node_modules/vitest/vitest.mjs run src/command-center
cd "$w\packages\agent-host";           node node_modules/vitest/vitest.mjs run command-center
cd "$w\packages\shared";               node node_modules/vitest/vitest.mjs run src
cd "$w\packages\agent-host";           node node_modules/vitest/vitest.mjs run src
cd "$w\packages\host-runtime";         node node_modules/vitest/vitest.mjs run src/owner-handoff-attachment.test.ts src/command-center-repository.test.ts

cd $w
$env:CARGO_TARGET_DIR = 'D:\Packages\PI-Desktop\target'
cargo test -p host-core command_center --locked --offline
cargo fmt --check

$env:PI_SCRATCH_DIR = "$w\.artifacts\scratch\q0"
node --test scripts/e2e/command-center/*.test.mjs scripts/e2e-command-center-curve.test.mjs
node scripts/check-command-center-foundations.mjs
```
