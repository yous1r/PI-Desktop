# AI command center: Batch 1 delivery record

- Status: Local engineering delivery; **uncommitted, unpushed**. No product
  acceptance or release gate is closed by this record.
- Branch/worktree: `feat/command-center-wiring-20261111` in
  `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111`.
- Base: `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f` (contains fetched main
  `e977efc96b6b735aeef5066a0b66c6565ad5691f`).
- Reconstructed tree: the uncommitted command-center baseline was copied
  byte-for-byte from the prior request worktree
  `command-center-continuation-20261110` (read-only; original left untouched).
  `.artifacts/batch1-baseline-manifest.json` records the 160 copied files.
- Task source: the prior handoff's "Required to unblock" items in
  `ai-command-center-final-handoff.md` / `ai-command-center-acceptance-index.md`,
  executed under the parallel decomposition of `ai-command-center-parallel-work.md`.

## Why the base is not origin/main

The entire command-center foundation (H0-H2 contracts and source operations) is
unmerged private-branch work; `origin/main` does not contain the prerequisite
commit chain. Starting from `origin/main` would make every package unwireable.
The request therefore stacks on the private branch tip, which is a normal
PR-stack integration state; no commit, push or merge was performed.

## Batches

| Batch | Lane | Scope | Write ownership | Result |
|---|---|---|---|---|
| 0 | Lead | Reconstruct request worktree, copy baseline, offline workspace install, manifest, integration checks | whole tree setup, no product code | Done |
| 1 | H3 (`h3-entry`) | `--owner-target` process entry in Rust host-core | `crates/host-core/src/main.rs`, `crates/host-core/src/owner_handoff/**` | Partial (fail-closed): entry + claim dispatch landed; supervisor adoption/Ready pending |
| 1 | C3 (`c3-registry`) | Register 13 `commandCenter/*` RACP operations, role gate, capability-gated unavailable, connection cleanup | `packages/racp/**`, `packages/shared/src/racp.ts`, `packages/shared/src/command-center/**` | Done |
| 1 | U1 (`u1-mount`) | Mount V3 command-center route, register i18n namespace, deterministic fixtures, tests | `apps/desktop/src/**`, `apps/desktop/test/**`, `packages/i18n/**` | Done (fixture preview; live producer/Electron journey pending) |
| 1 | Q0 (`q0-verify`) | Baseline qualification, evidence JSON, acceptance-index update | `docs/project/**`, `.artifacts/**` | Done |
| 2 | H3 | Coordinated schema 30→31 bump (shared TS literal, fixtures, host-runtime test, e2e scripts) | 10 listed files | Done |
| 2 | Q0 | RACP spec (EN+zh) and command-center docs synchronization, evidence rehash | `docs/spec/03-runtime/19-*`, `docs/zh-CN/.../19-*`, `docs/project/**`, `.artifacts/**` | Done |
| 3 (not started) | — | C4 dispatch claims, M1 producer, H4 real composition, H5 transfer, N1/W1/W2, Q1-Q3, R1, X1, Voice | — | Blocked on Batch 1/2 joins and external inputs |

## Concurrency

- One request worktree, four durable teammates with explicit, disjoint write
  scopes; the Lead owned shared files, integration and final verification.
- Shared-file rule: `packages/shared/src/racp.ts` was granted to C3 only;
  schema-30→31 coordinated files were granted to H3 only after C3/U1 had stopped
  touching them; docs stayed with Q0/Lead.
- Environment reuse: host Node/pnpm toolchain and store, offline workspace
  install (no downloads), host Cargo target cache
  (`CARGO_TARGET_DIR=D:\Packages\PI-Desktop\target`), per-lane scratch dirs under
  `.artifacts/scratch/`. No `pnpm install` beyond the offline link step, no
  Electron launch, no `verify:ui:*`.

## Verified results (Lead re-run on the final tree)

| Suite | Result |
|---|---|
| Desktop command-center (route/components/user-path/view) | 27/27 |
| Desktop i18n (`@pi-desktop/i18n`, vitest) | 33/33 |
| RACP (`@pi-desktop/racp`, vitest) | 42/42 (5 files; baseline 33) |
| Command-center client (vitest) | 259/259 (15 files) |
| Shared package (vitest, full) | 1,616/1,616 (144 files) |
| Host-runtime attachment test | 29/29 |
| Rust `owner_handoff` | 146 passed / 0 failed (was 140/6) |
| Rust `command_center` | 59 passed / 0 failed |
| Command-center baseline harness | 48/48 |
| `check-command-center-foundations.mjs` (source mode) | 12/12 PASS |

## Not verified / limitations

- `cargo clippy` NOT RUN (pre-existing ring/MSVC `cl D8050` environment limit).
- Desktop package typecheck still reports 89 pre-existing `electron/main`
  errors caused by stale/missing workspace package dists and the provisioned Pi
  dependency copy; zero errors in `apps/desktop/src` and in changed files.
- `host-runtime`/`agent-runtime` full package builds fail for the same
  pre-existing Pi-dependency reason (recorded in the prior branch handoff).
- No real Electron journey, no live Host producer for the command-center route,
  no cross-process `--owner-target` successor launch (no supervisor exists),
  no Android/iOS/browser/native-program qualification.
- E2E owner-handoff scripts were updated to schema 31 but NOT executed
  (real-process harness not part of this request).

## Remaining work (Batch 3 candidates)

1. H3 supervisor adoption: spawn `--owner-target`, consume the claim receipt,
   adopt owner/coordinator, restricted AppState/prepare/Ready, same-process
   service; closes H5's process entry.
2. C4 dispatch claims / uncertainty reconciliation / ACK persistence on top of
   the registered C3 path; then advertise the capability only with the complete
   producer/consumer path green.
3. M1 authorized producer and U1 real Host wiring (replace fixtures), then a real
   Electron journey.
4. H4 real reconnect composition and H5 integrated transfer acceptance.
5. External-input lanes remain blocked: N1 programs/privileges, W1/W2 devices and
   HTTPS deployment, Q1-Q3 nominated hardware, X1 macOS/Linux runners, Voice.

## Evidence

- `docs/project/ai-command-center-batch1-baseline.md` — environment and suite table.
- `.artifacts/batch1-baseline-evidence.json` — machine-readable suites, digests,
  lane results and Lead final verification.
- `.artifacts/batch1-baseline-manifest.json` — 160 baseline files (SHA-256).
- Per-lane records: `.artifacts/scratch/{h3,c3,u1,q0}/`.
