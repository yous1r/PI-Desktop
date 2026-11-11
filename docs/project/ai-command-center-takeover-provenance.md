# AI command center: authorized takeover provenance

- Date: 2026-11-11.
- Authorization: the user explicitly selected "authorize takeover and integration of the 24 uncommitted changes" in this session. Without that decision the repository's isolation rules forbade consuming them.
- Source worktree: `D:/Packages/PI-Desktop/worktrees/owner-local-control`.
- Source branch: `feat/owner-idle-handoff`, at `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f` (identical to this branch's base).
- Target worktree: `D:/Packages/PI-Desktop/.worktrees/command-center-continuation-20261110`, branch `feat/command-center-continuation-20261110`.
- Mechanism: a verified copy (`sha256` per file) of the source worktree's modified and untracked files into the same repository-relative paths. The source worktree was only read; it remains unmodified with the same 24 status entries.
- Manifest: `.pi/command-center-continuation/takeover-manifest.json` (ignored local file) records every copied file with size and SHA-256, the source head, and the exact authorization statement.
- Machine-readable record: [takeover evidence](ai-command-center-takeover-evidence.json) —
  58 files with current and source SHA-256, digest
  `db6aca78e4c230df352bc753fe549d26ed52c174b399f3170fa1891fc08de852`. Five files
  differ from the source copy because of the test corrections and the migration
  wiring below; they are flagged `modifiedAfterTakeover`.
- Files: 58 files across the C2 Rust command-center module and migration, C3 control/repository adapters, H3/H4 owner-target and attachment helpers, U1 Desktop command-center surface and its tests, Q0 qualification harness, and the qualification-inputs document.
- **Ignored-path follow-up.** The H3 module lives under
  `crates/host-core/src/owner_handoff/target/`, which the global `.gitignore`
  `target/` build-output rule hid from `git status`, so the first copy missed its
  nine source files. They were copied separately with SHA-256 verification, the
  ignore rule was negated for that source path, and `owner_handoff/mod.rs` now
  declares the module. Two of the nine were adjusted for this host/schema:
  `target/tests.rs` uses the repository target scratch directory (the host denies
  OS-temp directory creation) and `target/tests/bootstrap_tests.rs` pins the
  envelope build to the current `SCHEMA_VERSION` because the shared H2 fixture
  records schema 31 after the coordinated schema bump: the shared
  `OwnerHandoffBuildSchema` TS literal, the shared owner-handoff fixtures, the
  host-runtime attachment test and the owner-handoff e2e scripts moved from 30 to
  31 together. Verified after the bump by Rust
  `cargo test -p host-core owner_handoff --locked --offline` **146/0** and the
  shared package suite **1616/1616**.
- Integration edits made here (not in the source): `packages/agent-host/src/index.ts` now exports the command-center control module so consumers (RACP dispatcher, Rust repository adapter) can import the shared control service and contracts.

## Verification performed after the copy

- `tsc -b packages/shared packages/agent-host`: pass; `tsc -b packages/racp`: pass; `racp` suite 30 tests pass.
- Agent Host suite: 151 tests pass, including the 15 C3 control-service tests added in this branch.
- Isolated typecheck of the taken-over Host-runtime files (`attachment/**`, `owner-handoff-attachment.ts`, `command-center-repository.ts`) against this branch's shared/agent-host: pass.
- Isolated typecheck of taken-over Desktop command-center components and the Electron handoff-attachment module: pass. This is a compile check, not a rendered UI or Electron journey.
- `cargo check -p host-core --locked --offline` with the provisioned target cache: pass (warnings only).
- `cargo test -p host-core --locked --offline command_center`: **59 passed, 0 failed**
  after three taken-over test corrections (below). This includes the three new
  versioned-migration tests that wire the C2 module into schema v31.
- `cargo test -p host-core --locked --offline owner_handoff::target`: **16 passed**
  after wiring the previously ignored module (restricted successor bootstrap,
  readiness CAS/receipts, recovery, strict envelope parsing).
- Host-runtime `OwnerHandoffAttachment` tests: **29 passed** under the takeover
  vitest config, alongside the 7 repository-adapter tests (36 total).
- RACP dispatch seam: the factory is exported from the package and **3 tests**
  cover the prefixed method list, namespace stripping with principal forwarding,
  and refusal of unknown operations. The shared RACP catalog and capability flags
  are untouched.
- Taken-over Desktop command-center and attachment tests:
  `node --test apps/desktop/test/command-center-*.test.mjs apps/desktop/test/handoff-attachment.test.mjs`
  → **25 passed**.
- Taken-over Q0 harness tests:
  `node --test scripts/e2e/command-center/qualification-*.test.mjs` → **24 passed**.
- Foundations regression after the export integration: integrated 363/30, Agent Host
  151/12, shared source 808/72, client 259/15, RACP 33/4, consumer checks 12/12 in
  both modes. Machine-readable takeover record (58 files, hashes):
  [takeover evidence](ai-command-center-takeover-evidence.json).
- `cargo fmt --check -p host-core`: pass.
- Not run/blocked: full `host-runtime` and `agent-runtime` package builds and Desktop
  typecheck via their own projects, because the provisioned Pi dependency copy lacks
  this branch's patches (pre-existing environment limitation); real
  Electron/browser/device journeys; the complete `cargo test -p host-core` suite
  (many existing tests require OS temp directories this host denies to the test
  process); `cargo clippy -p host-core --all-targets`, whose rebuild of `ring`
  fails in this host's MSVC environment (`cl` D8050) before any project code is
  linted.

## Test corrections made during integration

The copied code was not green on this host. Three taken-over tests contradicted the
frozen C1 contract or the environment; each was corrected rather than weakening the
production rule:

| Test | Problem | Change |
|---|---|---|
| `receipt_tests::receipt_lifecycle_moves_are_fenced` | Expected `accepted → conflicted`, which the frozen shared transition table forbids | Expects `CC_TRANSITION_INVALID`; ledger-retention assertion kept |
| `reservation_tests::host_capacity_is_thirty_six_across_three_workspaces` | Created a fourth enabled workspace, impossible under the three-workspace quota, so setup failed before testing the Host cap | Exercises the Host cap through a 37th admission into an existing workspace (Host check runs first) and asserts the fourth enabled workspace is refused |
| `tests::migration_adds_tables_without_touching_existing_data` | `temp_dir()` creation is denied to the test process on this managed host (existing repo tempdir tests fail identically) | Uses `tempdir_in` on the repository target scratch directory; still proves additive migration and idempotence |

Integration also bumped `SCHEMA_VERSION` from 30 to 31, wired
`db::command_center_migration::migrate_v30_to_v31` into `Database::open` (fresh
creation and upgrade share `command_center::SCHEMA_DDL`, every open validates),
and added three tests: a fresh v31 file, an atomic v30 upgrade that preserves an
existing row and keeps a readable backup, and refusal of a non-v30 source. The
storage spec now records schema v31.

## Boundary

This record does not claim product acceptance. The copied code remains uncommitted work in this request branch, authored in another request; this branch preserves its content with provenance instead of rewriting it. The C2 persistence migration is now wired (schema v31); capability advertisement, RACP catalog registration and UI mounting still require the plan's integration gates and must not be inferred from these files existing.

> Batch 1 update (2026-11-11): C3 later added thirteen `commandCenter/*` entries
> to the shared RACP catalog in this worktree. They remain capability-gated
> unavailable (`CAPABILITY_UNAVAILABLE`), so the statement above still describes
> the copied baseline and no product acceptance follows. See the
> [acceptance index](ai-command-center-acceptance-index.md#batch-1-worktree-2026-11-11).
