# AI command center: acceptance index and handoff status

- Status: Living index for the command-center refactor. It records what is
  **accepted**, what is **internally verified**, and what is **blocked**, with the
  evidence or dependency for each. Internal tests are never presented as product
  acceptance.
- Branch: `feat/command-center-continuation-20261110`.
- Base: `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`, containing fetched main
  `e977efc96b6b735aeef5066a0b66c6565ad5691f`. No dependency commit has arrived
  since this base in later rounds.
- Consolidated handoff: [branch state and remaining wiring](ai-command-center-final-handoff.md).\n- Evidence for this branch's own work:
  [continuation record](ai-command-center-continuation.md) and
  [source/configuration evidence](ai-command-center-foundations-evidence.json).
- Plan and acceptance sources: [parallel work packages](ai-command-center-parallel-work.md),
  [requirements](ai-command-center-requirements.md),
  [control contracts](ai-command-center-control-contracts.md),
  [monitor integration contract](ai-command-center-monitor-integration-contract.md).

## Verification snapshot (2026-11-11)

- Dependency head unchanged at `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`; this
  working tree is deliberately **uncommitted** (no commit, push or PR was made).
- Integrated foundation tests: **363 passed across 30 files**; complete Agent Host
  package **151/12**; shared source **808/72**; client package **259/15**; RACP
  consumer **33/4**.
- Repository consumer checks: **12/12** in both current-source and emitted-artifact
  modes, including the composed 1,025-page Host generation, live changes, health,
  session composition and cross-module limit composition.
- Taken-over modules: Rust `command_center` **59** (56 module + 3 versioned
  migration), H3 `owner_handoff::target` **16**, host-runtime
  `OwnerHandoffAttachment` + Rust adapter **36**, Desktop command-center/attachment
  **25**, Q0 qualification harness **24**. The combined baseline script
  (`node --test scripts/e2e/command-center/*.test.mjs scripts/e2e-command-center-curve.test.mjs`)
  passes **48/48** when `PI_SCRATCH_DIR` names an isolated scratch directory.
- Schema v31: C2 persistence is wired with a v30 backup, atomic upgrade and
  fail-closed validation. No commit, push or PR was made.
- Type checks, official TypeScript projects, lint (62 files), architecture and
  agent-policy gates pass. Documentation: **645 pages**, **88** English/Chinese
  pairs.
- Machine-readable evidence: observation foundations 58 files, digest
  `af583e9a4bc685c027b73d0b3f2e88af980d65af824c7b21d76683d3d44dfa98`
  ([JSON](ai-command-center-foundations-evidence.json)); authorized takeover
  58 files + 9 supplementary files
  ([JSON](ai-command-center-takeover-evidence.json)). Exact reproduction commands
  are in the [continuation record](ai-command-center-continuation.md#reproduce-this-verification).
- Environment limitations: `host-runtime`/`agent-runtime` cannot build in this
  worktree because the provisioned Pi dependency copy lacks the branch patches;
  this remains recorded, not passing. OS-temp directory creation is denied to the
  test process, so affected suites use repository scratch space.
- Production wiring remains incomplete: H3 `--owner-target` entry and supervisor
  adoption, C3 RACP/IPC registration, C4 dispatch claims, U1 route mount and
  H5 cross-process acceptance are not wired. Details:
  [takeover provenance](ai-command-center-takeover-provenance.md) and
  [takeover evidence](ai-command-center-takeover-evidence.json).

## Work-package status

| Package | Status | Evidence or blocking dependency |
|---|---|---|
| H0 handoff contracts | Accepted in source history (`bf5c042b7`) | Project H0 record; not re-run in this branch |
| H1 Desktop coordinator/adapters | R01-R09 accepted (`a360fc505`, base `e977efc96`) | [H1 acceptance record](ai-command-center-p0-evidence/h1-adapters-verification.md); ten fixed native gaps remain |
| H2 Rust source prepare/cancel/fence/release | Scoped candidate accepted (`011a7dd59`) | [H2 acceptance record](ai-command-center-p0-evidence/h2-source-verification.md); full transfer still H5 |
| H3 restricted successor bootstrap | Code + module wiring; CLI integration **pending** | The previously ignored `owner_handoff/target` module is now tracked and declared; **16 Rust tests pass** (readiness CAS/receipts, recovery, strict envelope). The `--owner-target` process entry point is not wired and no cross-process launch has been exercised |
| H4 epoch-aware client reattachment | Code taken over; wiring **pending** | `OwnerHandoffAttachment` and its transport ports are in this branch and typecheck in isolation; real reconnect composition is unverified |
| H5 integrated idle transfer | **Blocked** | Needs H1-H4 acceptance and the real authorization path |
| C1 versioned control contracts | Accepted (`decb07c4c`) | 47 contract tests in this branch |
| C2 workspaces/membership/reservations/goals/receipts | Code + migration wired; RACP registration **pending** | 59 command-center tests pass (56 module + 3 versioned-migration tests); `SCHEMA_VERSION` is 31 with a v30 backup and atomic upgrade validated on a populated file |
| C3 authorized control/receipt APIs | Code taken over; registration **pending** | Control service, Rust repository adapter and RACP dispatcher are present and compile; no RACP/IPC catalog registration or capability advertisement |
| C4 all-entry quota and main/child control | **Blocked** | Depends on C3 |
| M1 bounded monitor projection | Foundations done; producer **blocked** | Store, barrier contract test, reader, live summary, health and session composition pass here; real authorized producer needs C2/C3 ([contract](ai-command-center-monitor-integration-contract.md)) |
| U1 V3 Desktop surfaces | Code taken over; mounting **pending** | Components, view model and locales are in this branch; 25 desktop tests pass; not mounted in the app route and no i18n namespace registration |
| N1 native application association | **Blocked by design** | Window-generation identity, privilege and detach policy are not settled; nominated programs/versions absent |
| W1 browser HTTPS edge | **Blocked** | Requires deployment/security decisions, enrollment/revocation workflow and environment |
| W2 Web/PWA client | Foundations done; product **blocked** | Portal receipt model and monitor session are browser-safe and tested; real device/network acceptance needs W1, M1, C4, H5, E4 |
| Q0 qualification preparation | Code taken over | Manifest/validation harness is in this branch; 24 tests pass; no Q1-Q3 run exists |
| Q1/Q2/Q3 measurement and devices | **Blocked** | Requires integrated candidate plus nominated two-core/8 GB runner, programs and phones |
| R1 release readiness | **Blocked** | Depends on Q1-Q3 |
| X1 macOS/Linux native lane | **Blocked** | Requires nominated native runners |

## What this branch verifies today

- Shared C1 contracts and a strict observation-owner parser; 59 shared tests.
- Host bounded snapshot store and projection-barrier contract; 45 Host monitor
  tests, including seeded pagination and the subscribe-cut-capture-replay
  sequence.
- Browser-safe client models: intervention attempt/receipt, all-pages reader,
  live change application, connection health and session composition; 259 client
  tests across fifteen files.
- Repository consumer checks: twelve browser-boundary checks against current
  source **and** emitted package artifacts, including a real 1,025-page Host
  generation, live changes and a composed session.
- A dependent consumer (`racp`) builds against this branch and passes 30 tests.
- C3 authorization/transport boundary tests added in this branch: **15** control
  service tests (roles, scope, owner fencing, mutation closure, receipt
  replay/conflict, capability gate, response budget) and **7** Rust repository
  adapter tests (private stdio payload, error-family mapping, no retry, owner
  change, malformed result, receipt binding). The RACP dispatcher factory is
  exported and covered by **3** seam tests (prefix list, namespace stripping,
  principal forwarding, unknown-operation refusal). Catalog registration in
  RACP/IPC remains pending, and capability flags stay unavailable.
- Taken-over C2/C3/H3/H4/U1/Q0 code: Rust `command_center` module compiles and its
  **56 tests pass**; taken-over Desktop command-center/attachment tests **25 pass**;
  Q0 harness **24 pass**; isolated typechecks pass for the Host-runtime attachment/
  repository files and the Desktop surface. All are uncommitted and not wired into
  production paths.
- Documentation: 642 pages and 88 English/Chinese pairs.
- Known environment limitation: `host-runtime`/`agent-runtime` cannot build here
  because the provisioned Pi dependency copy lacks the branch's patches; this is
  recorded, not a passing gate. Existing repo tests that create OS temp
  directories also fail on this host for the same environmental reason.

## Required to unblock

1. Register the C3 control service in the RACP/IPC catalog with authenticated
   principals, roles and explicit connection cleanup; keep capability flags
   unavailable until the complete producer/consumer path passes
   ([integration contract](ai-command-center-monitor-integration-contract.md)).
2. Compose the H3/H4 successor bootstrap and attachment helpers with the real
   supervisor/transport, then complete H5 full transfer acceptance.
3. Mount the U1 surface in the Desktop route, register its i18n namespace and pass
   a real Electron journey; run the monitor integration acceptance against the real
   repository/transport.
4. Provide the nominated target machines, programs, devices and deployment scope
   for Q1-Q3/W1-W2/N1; otherwise record them as open qualification limits.
5. Voice/LiveVoice remains the final planned stage.

No item above is satisfied by copied-but-unwired code, an internal fixture, or this
index itself.













