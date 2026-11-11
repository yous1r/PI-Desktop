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

## Batch 1 worktree (2026-11-11)

- Batch 1 request branch `feat/command-center-wiring-20261111` runs in
  `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111` at base
  `1cdb4ce1d` (containing fetched `main` `e977efc96`). Its uncommitted
  command-center baseline was copied from the original request worktree
  `command-center-continuation-20261110` (read-only, untouched), so it is a
  **reconstructed working tree**, not a committed candidate.
- Q0 baseline qualification of that reconstructed tree: [Batch 1 worktree
  baseline](ai-command-center-batch1-baseline.md) and
  [.artifacts/batch1-baseline-evidence.json](../../.artifacts/batch1-baseline-evidence.json)
  record the executed commands, real counts, environmental limitations and the
  manifest comparison against the copied baseline. That baseline changes no
  accepted/verified/blocked status below.
- Final lane results (2026-11-11, from lane logs; not re-run by Q0):
  - **C3 registered, capability-gated**: thirteen `commandCenter/*` operations are
    in `RACP_OPERATIONS` (profile `remote-host`; viewer for workspace/membership
    reads and receipts, owner for workspace writes, controller for
    membership/intervention mutations).
    `RacpServerCapabilitiesSchema` has no command-center field, so every one
    returns `CAPABILITY_UNAVAILABLE` before dispatch. Evidence: RACP **42/5**
    (was 33/4; +9 registration/dispatch tests), shared package `test` **1,616/144**
    (includes built `dist` copies; source-only 808/72).
  - **H3 target entry implemented, fail-closed**: `--owner-target` validates the
    exclusive argv/private-stdin channel and commits the claim; it then stops with
    `HANDOFF_TARGET_ADOPTION_UNAVAILABLE` because no supervisor adopts the captured
    owner/coordinator and no Ready publication exists. `owner_handoff::target`
    **22/22**; full `cargo test -p host-core owner_handoff --locked --offline`
    **146/0** after the coordinated schema-30→31 bump (shared TS literal, fixtures,
    host-runtime test, e2e scripts; shared package **1,616/1,616**). Supervisor
    adoption, Ready publication and same-process serving remain open.
  - **U1 mounted (fixture preview)**: page `command-center` is full-screen in
    `AppShell` (chat shell hidden/inert, no global left sidebar), entered from the
    Sidebar footer icon and the global-search Pages entry; the work panel is
    hidden and the page stays mounted to retain draft/focus/history. The
    `commandCenter` i18n namespace is registered for en and zh-CN (other locales
    fall back to en) in the main.tsx initial resources, the renderer-catalogs
    loader and `renderer-language` `addResourceBundle`; the renderer-keys scan is
    namespace-aware with en/zh key-parity checks. Fixtures are deterministic and
    the Host is explicitly offline; overview lower areas stay noninteractive.
    Verification: route/components/user-path/view **27/27**, i18n **33/33**
    (catalogs 13/13, renderer-keys 11/11), shell/nav/i18n **105/105**,
    sidebar **115/115**, renderer-only `tsc` exit 0, desktop lint OK. The desktop
    package typecheck still fails only with 89 pre-existing `electron/main` errors
    (workspace dist/Pi dependency environment), zero in `apps/desktop/src`.
    **Remaining gap**: fixture preview only; no live Host producer and no Electron
    journey was run.
- Lead final verification on the current tree (independent): desktop
  command-center **27/27**, i18n **33/33**, RACP **42/42** (5 files),
  command-center-client **259/259** (15 files), Rust `command_center` **59/0**,
  Rust `owner_handoff` **146/0** (H3 schema fix).

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
- Production wiring remains incomplete: H3 supervisor adoption (the entry is
  implemented fail-closed and stops with `HANDOFF_TARGET_ADOPTION_UNAVAILABLE`),
  C3 capability advertisement (the catalog registration exists but stays
  unavailable), C4 dispatch claims, the U1 live Host producer/Electron journey
  (route mount is verified with deterministic fixtures only) and H5 cross-process
  acceptance are not wired. Details:
  [takeover provenance](ai-command-center-takeover-provenance.md) and
  [takeover evidence](ai-command-center-takeover-evidence.json).

## Work-package status

| Package | Status | Evidence or blocking dependency |
|---|---|---|
| H0 handoff contracts | Accepted in source history (`bf5c042b7`) | Project H0 record; not re-run in this branch |
| H1 Desktop coordinator/adapters | R01-R09 accepted (`a360fc505`, base `e977efc96`) | [H1 acceptance record](ai-command-center-p0-evidence/h1-adapters-verification.md); ten fixed native gaps remain |
| H2 Rust source prepare/cancel/fence/release | Scoped candidate accepted (`011a7dd59`) | [H2 acceptance record](ai-command-center-p0-evidence/h2-source-verification.md); full transfer still H5 |
| H3 restricted successor bootstrap | **Real native root + same-process serving implemented**; Windows-only, cross-process Desktop journey pending | Claim → restricted `AppState` → `Registry::adopt` → prepared Job/one-use pipe/ticket → Node `launch-sidecar`/`attach-epoch` → `wait_root` → real `ReadyTarget::commit` → bounded framed `target_serve`. The production unrooted-Ready exception is removed and the directory guard is retained outside the Tokio runtime. Target **41/0/1 ignored** (real OS child binds root), `owner_handoff` **165/0/1**, `state` **5/5**, `execution_fence` **10/10**. `target_serve` remains serial with no notification bridge |
| H4 epoch-aware client reattachment | Composition + startup root implemented; real target Ready source **pending** | `OwnerHandoffSuccessor` (claim-bound identity, strict `readStatus`), startup-owned handoff boot with its single registration entry, opt-in per-host reattachment bootstrap with a 5-session subscription budget, and shutdown ordering. Opted-in hosts without the real target Ready/event epoch fail closed with `HANDOFF_ATTACHMENT_READY_UNAVAILABLE`. Desktop handoff tests **74/74** |
| H5 integrated idle transfer | **Blocked** | Needs H1-H4 acceptance and the real authorization path |
| C1 versioned control contracts | Accepted (`decb07c4c`) | 47 contract tests in this branch |
| C2 workspaces/membership/reservations/goals/receipts | Code + migration wired; exposed through C3 | 59 command-center tests pass (56 module + 3 versioned-migration tests); `SCHEMA_VERSION` is 31 with a v30 backup and atomic upgrade validated on a populated file. RACP exposure is the C3 registration below |
| C3 authorized control/receipt APIs | **Registered, capability-advertised by pi-host, served over private Rust RPC** | Thirteen control operations plus `commandCenter/monitorPage`; optional `commandCenter` capability advertised only when a Host binds the service and opts in; `apps/pi-host --command-center` is the in-repo production binding. Private Rust RPC requires the live boot owner epoch. Evidence: RACP **53/6**, shared **812/72** source (**1,6xx/144** with built output), Rust RPC **7/7**, `command_center` **82/82**. `membership.remove` remains unavailable pending C2 tombstones |
| C4 all-entry quota and main/child control | **C2-authoritative admission served to clients**; entry-point wiring pending | `reservation.reserve/hold/release/state` run inside one immediate C2 transaction per call (12/workspace, 36/Host, idempotent duplicate, exactly-once release, capacity retained while stopping/outcome_unknown). Control service refuses while maintenance admission is closed and re-checks scope/owner after every await. Real Rust SQL tests **11/11**; `runtimeMode=required` needs a real dispatch consumer. Desktop/RACP/plugin/scheduler/Task/Worker entry points do not call it yet, and exact-generation Stop is still only the pi-host exact-turn abort |
| M1 bounded monitor projection | **Producer, Rust cut and authenticated page transport implemented**; live-change adapter pending | `CommandCenterMonitorProducer`/provider over `HostRpcPort`, Rust `commandCenter.monitor.cut` (bounded reservation/goal cut, real boot epoch watermark), `commandCenter/monitorPage` with connection/scope-bound continuation handles re-authorized on every page, and Desktop preload/IPC selection of the observation Host. Focused host-runtime **112/112**, Desktop end-to-end IPC path **74/74**. Live change envelopes need an authorized change source |
| U1 V3 Desktop surfaces | **Mounted with live-provider transport**; real Electron journey pending | Full-window route, sidebar/search entries, `commandCenter` i18n namespace (en/zh), fixed preload channels for capability/monitor page/ping/workspace/receipt, and an injected live provider that is created only for a connected capability-advertising Host. Fixture preview remains the default offline surface. i18n **33/33**; Electron end-to-end journey not run |
| N1 native application association | **Blocked by design** | Window-generation identity, privilege and detach policy are not settled; nominated programs/versions absent |
| W1 browser HTTPS edge | **Blocked** | Requires deployment/security decisions, enrollment/revocation workflow and environment |
| W2 Web/PWA client | Foundations done; product **blocked** | Portal receipt model and monitor session are browser-safe and tested; real device/network acceptance needs W1, M1, C4, H5, E4 |
| Q0 qualification preparation | Harness + new real end-to-end scripts | Existing Q0 manifest/validation harness (24 tests) plus `scripts/e2e-command-center-control.mjs` (18 checks) and `scripts/e2e-command-center-pi-host.mjs` (5 checks, both modes), all PASS with real Rust binary/SQLite/WebSocket. No Q1-Q3 capacity or device run exists |
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
- A dependent consumer (`racp`) builds against this branch and passes 42 tests
  across five files after the C3 registration tests were added.
- C3 authorization/transport boundary tests added in this branch: **15** control
  service tests (roles, scope, owner fencing, mutation closure, receipt
  replay/conflict, capability gate, response budget) and **7** Rust repository
  adapter tests (private stdio payload, error-family mapping, no retry, owner
  change, malformed result, receipt binding). The RACP dispatcher factory is
  exported and covered by **3** seam tests (prefix list, namespace stripping,
  principal forwarding, unknown-operation refusal). The shared `RACP_OPERATIONS`
  catalog now also carries the thirteen `commandCenter/*` entries and RACP passes
  **42 tests across 5 files**, but capability flags stay unavailable: every
  command-center call returns `CAPABILITY_UNAVAILABLE` before dispatch.
- Taken-over C2/C3/H3/H4/U1/Q0 code: Rust `command_center` module compiles and its
  **56 tests pass**; Desktop command-center/attachment tests **25 pass** and the U1
  route mount adds view/user-path/route tests for **27/27**; Q0 harness **24 pass**;
  isolated typechecks pass for the Host-runtime attachment/repository files and the
  renderer-only Desktop surface. All are uncommitted; the command-center UI remains
  a fixture preview and the production producer path is still unwired.
- Documentation: 642 pages and 88 English/Chinese pairs.
- Known environment limitation: `host-runtime`/`agent-runtime` cannot build here
  because the provisioned Pi dependency copy lacks the branch's patches; this is
  recorded, not a passing gate. Existing repo tests that create OS temp
  directories also fail on this host for the same environmental reason.

## Required to unblock

1. Advertise the `commandCenter/*` capability only after the authorized
   producer/consumer path, C4 claims and connection cleanup pass; until then keep
   all thirteen registered operations `CAPABILITY_UNAVAILABLE`
   ([integration contract](ai-command-center-monitor-integration-contract.md)).
2. Compose the H3/H4 successor bootstrap and attachment helpers with the real
   supervisor/transport, then complete H5 full transfer acceptance.
3. Connect the mounted U1 surface to a live Host producer and run a real Electron
   journey; it currently renders deterministic fixtures only. Run the monitor
   integration acceptance against the real repository/transport.
4. Provide the nominated target machines, programs, devices and deployment scope
   for Q1-Q3/W1-W2/N1; otherwise record them as open qualification limits.
5. Voice/LiveVoice remains the final planned stage.

No item above is satisfied by copied-but-unwired code, an internal fixture, or this
index itself.
