# AI command center: branch handoff

- Branch: `feat/command-center-continuation-20261110` in its request worktree.
- Base: `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`, containing fetched `main`
  `e977efc96b6b735aeef5066a0b66c6565ad5691f`.
- State: **uncommitted, unpushed** (no commit, push, PR or deployment was made).
- Authorized takeover: the user approved copying the other request worktree's
  uncommitted work into this branch. The source worktree was only read and remains
  unchanged; provenance and per-file hashes are in the
  [takeover record](ai-command-center-takeover-provenance.md) and
  [takeover evidence](ai-command-center-takeover-evidence.json).

## What is implemented here

| Area | State |
|---|---|
| H0/H1/H2 contracts and source operations | Accepted in earlier commits; not re-run here except the H3 consumer below |
| C1 control contracts | Committed `decb07c4c`; strict schemas and fixtures reused |
| C2 persistence | Code taken over **and wired**: schema v31 migration with v30 backup, atomic upgrade, fail-closed validation; 59 command-center tests |
| C3 control service | Code taken over; authorization, owner fencing, replay and row filtering covered by tests; private Rust adapter and RACP dispatcher exported |
| H3 successor bootstrap | Module taken over, tracked (previously hidden by the `target/` ignore rule), declared and tested; 16 tests |
| H4 client reattachment | `OwnerHandoffAttachment` with 29 tests (snapshot before events, replay freeze, reconnect, permissions) |
| M1 monitor foundations | Snapshot store, projection barrier, browser reader, summary, health and session composition; 363 integrated tests |
| U1 Desktop surface | Components, view model, locales and tests taken over; 25 tests. Not mounted in the app route |
| Q0 qualification harness | Manifest/validation harness taken over; 24 tests; part of the existing baseline script |

## Verification snapshot (2026-11-11)

| Suite | Result |
|---|---|
| Integrated observation foundations | 363 / 30 files |
| Agent Host package | 151 / 12 |
| Shared source | 808 / 72 |
| Command-center client | 259 / 15 |
| RACP package | 33 / 4 |
| Rust `command_center` (incl. 3 migration tests) | 59 |
| Rust `owner_handoff::target` | 16 |
| Host-runtime attachment + repository adapter | 36 |
| Desktop command-center/attachment | 25 |
| Q0 harness | 24 |
| Command-center baseline script (needs `PI_SCRATCH_DIR`) | 48 / 48 |
| Repository consumer checks | 12 / 12 source and artifacts |
| Rust `cargo check` and `cargo fmt --check` | pass |
| TypeScript source and official builds | pass |
| Biome lint (configured set) | pass |
| Architecture and agent-policy gates | pass |
| Documentation | 645 pages, 88 pairs |

Evidence: [foundations JSON](ai-command-center-foundations-evidence.json) (58 files,
digest `af583e9a4bc685c027b73d0b3f2e88af980d65af824c7b21d76683d3d44dfa98`) and
[takeover JSON](ai-command-center-takeover-evidence.json) (58 files + 9 ignored-path
supplements + explicit boundary-test hashes). Exact commands are in the
[continuation record](ai-command-center-continuation.md#reproduce-this-verification).

## Not wired — required before claiming product acceptance

1. **H3 process entry**: `--owner-target` is not dispatched from `main.rs` and no
   supervisor adopts the captured owner/coordinator; no cross-process successor
   launch exists. The module refuses work until this is designed against the
   registry, and admission must stay closed until the Ready proof.
2. **C3 registration**: the RACP/IPC catalog has no command-center methods, roles
   or capability negotiation. The dispatcher factory is exported for that wiring.
   Capability flags remain unavailable on purpose.
3. **C4**: dispatch claims, uncertainty reconciliation and ACK persistence are not
   implemented; the control service only gates on the runtime handoff predicate.
4. **U1 mount**: the surface is not mounted in the Desktop route and its i18n
   namespace is not registered; no real Electron journey was run.
5. **H5/W/N/Q/R/X1/Voice**: cross-process transfer acceptance, browser edge,
   native association, device/soak qualification, release readiness, native lanes
   and Voice remain blocked on the items above plus nominated hardware and
   deployment scope.

## Environment limitations

- `host-runtime` and `agent-runtime` package builds fail because the provisioned
  Pi dependency copy lacks this branch's patches (pre-existing, recorded).
- This managed host denies OS-temp directory creation to test processes; affected
  suites use repository scratch space, and the pre-existing curve test requires
  `PI_SCRATCH_DIR`.
- `cargo clippy` cannot run here: compiling `ring` in the MSVC environment fails
  before project code is linted.
- No real user profile, provider, paid service, browser/device deployment or running
  Desktop instance was used.

## Suggested next request

Either (a) commit this branch after review and open a PR for the observable parts
(C2 migration, H3 module tests, C3 boundary tests, docs), or (b) continue with one
of the unwired items above under a new explicit scope, ideally H3 entry plus C3
registration together so the private path becomes exercisable end to end.
