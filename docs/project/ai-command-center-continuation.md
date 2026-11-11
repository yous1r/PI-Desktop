# AI command center: independent observation foundations

- Request branch: `feat/command-center-continuation-20261110`.
- Starting implementation: `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`.
- Fetched main: `e977efc96b6b735aeef5066a0b66c6565ad5691f`, included in the starting implementation.
- Status: observation foundations are implemented and scoped source/artifact checks pass on the uncommitted request tree. Production integration is waiting for committed C2/C3/H3/H4 dependencies. No full M1/W2 or release acceptance is implied.

## Scope and coordination

The source-owner H2 candidate is accepted in the existing
[H2 evidence](ai-command-center-p0-evidence/h2-source-verification.md). Its ten
native qualification gaps and H5 full transfer remain open. Concurrent work in
another request owns H3/H4, C2/C3, U1 and Q0. This continuation consumes only its
committed baseline and does not copy, modify or depend on that request's pending
source. The request uses a separate worktree and reuses provisioned JS dependencies
by links; it installs no second dependency environment.

Two independent consumers of committed C1 contracts are implemented here:

1. `packages/agent-host/src/monitor/` provides bounded stable snapshot pagination.
   It accepts an already-authorized projection cut, validates C1 rows and retains
   immutable serialized pages. It does not infer membership/goal facts, read
   transcripts, authorize requests, or create a snapshot/event barrier.
2. `packages/command-center-client/` provides an immutable browser-safe intervention
   attempt and authoritative receipt observation model. It never submits or
   retries a control. The trusted adapter owns authentication and its local
   context lifetime; request hashes and context identity prevent accidental
   retargeting and stale observations. Its multi-page monitor reader now joins
   the Host store through an injected authorized read port, publishes only complete
   generations and bounds unsettled original I/O after local cancellation. Its
   connection-health controller separately tracks foreground liveness and resumed
   snapshot synchronization; it opens no connection or execution path.
3. `createCommandCenterMonitorSummary` keeps a published projection current from
   ordered `upsert`/`remove`/`resync` adapter envelopes with duplicate detection,
   gap/epoch resync, bounded rows/bytes and revocation cleanup. The envelope is a
   local adapter port shape, not a registered wire message or capability.

Both modules have public-model user-path tests. The repository consumer check
bundles their public package entries from current source, exercises Host paging,
and evaluates the client in a separate JavaScript realm containing Web APIs but
no Node globals or transport. This tests portability and contract behavior, not
an actual browser, mobile device or full application flow.

## Authorized takeover of the pending dependency work

After the user explicitly authorized taking over the other request's uncommitted
work, 58 files were copied into this branch from `worktrees/owner-local-control`
(identical base `1cdb4ce1d`) with a SHA-256 manifest; the source worktree was only
read. Provenance, file hashes and the three test corrections are recorded in the
[takeover provenance](ai-command-center-takeover-provenance.md) and
[takeover evidence](ai-command-center-takeover-evidence.json).

Verification of the copied code on this host:

- `cargo check -p host-core --locked --offline`: pass. `cargo test -p host-core
  --locked --offline command_center`: **59 passed** after correcting three tests
  that contradicted the frozen C1 table or this host's temp-dir policy; three of
  the 59 are the new versioned-migration tests.
- C2 persistence is now wired: `SCHEMA_VERSION` moves 30 → 31,
  `db::command_center_migration::migrate_v30_to_v31` runs inside
  `Database::open` with a readable v30 backup, fresh creation and upgrade share
  `command_center::SCHEMA_DDL`, and every open validates the live `cc_*` objects.
  Tests cover a fresh v31 database, an atomic v30 upgrade that keeps an existing
  `kv` row and its backup, and refusal of a non-v30 source.
- Taken-over Desktop command-center and attachment tests: **25 passed**; Q0
  manifest/validation harness tests: **24 passed**.
- Isolated typechecks: Host-runtime attachment/repository files and the Desktop
  command-center surface + Electron handoff attachment: pass.
- One integration edit: `packages/agent-host/src/index.ts` now exports the
  command-center control module so RACP and the Rust repository adapter can
  consume it.
- H3 restricted successor bootstrap: the previously ignored
  `crates/host-core/src/owner_handoff/target/` module (nine files) is now tracked,
  compiled and declared; **16 Rust tests pass** (strict envelope, readiness CAS and
  receipts, recovery, retained-generation proof). Its `--owner-target` process
  entry point is not wired, so no cross-process successor launch exists yet.
- Host-runtime `OwnerHandoffAttachment`: **29 tests pass** under the takeover
  vitest config (epoch checks, snapshot-before-events, replay freeze, reconnect,
  permission changes).
- C3 registration seam: the RACP dispatcher factory is exported from `@pi-desktop/racp` and covered by **3** seam tests (prefix list, namespace stripping, principal forwarding, unknown-operation refusal). No catalog entry or capability flag is added.\n- C3 boundary tests added in this branch: **14** control-service tests
  (authorization, roles, owner fencing, mutation closure, receipt
  replay/conflict, capability gate, response budget) and **7** Rust repository
  adapter tests (stdio payload shape, error mapping, no retry, owner change,
  malformed result, receipt binding). They run without host-runtime composition;
  RACP/IPC registration is still pending.
- Foundations regressions after the copy: integrated 363/30, Agent Host 151/12,
  shared 808/72, client 259/15, RACP 33/4, consumer checks 12/12.

The storage migration is wired (schema v31, v30 backup, upgrade tests). The code
is otherwise still **unwired**: no RACP/IPC catalog registration, no capability
advertisement, no Desktop route mount or i18n registration, and no H3/H4/H5
composition with the real supervisor. Those are the remaining integration steps;
none may be inferred from the files existing.

> Batch 1 update (2026-11-11): C3 later registered thirteen `commandCenter/*`
> operations in the shared RACP catalog; the roles, capability gate and exact test
> counts are recorded in the
> [acceptance index](ai-command-center-acceptance-index.md#batch-1-worktree-2026-11-11).
> No capability is advertised, so every call still returns
> `CAPABILITY_UNAVAILABLE`. The "no RACP/IPC catalog registration" statements above
> describe the earlier continuation snapshot and are kept as history; they do not
> describe the current tree.

## Preserved invariants

- Rust remains the only database owner. No migration, second task store,
  transcript store, executor or network listener is introduced.
- C1 capabilities remain unavailable until C3/C4/M1 have authorized producers and
  consumers. Internal exports do not change RACP or Electron IPC negotiation.
- Snapshot pages use one cursor/timestamp, at most 100 rows and 256 KiB including
  continuation tokens. Trusted authorization/filter generations and Host epochs
  bind page access. Expired/evicted generations require explicit resync.
- Retained snapshot data has independent row, encoded-byte, generation, token and
  lifetime bounds. Encoded-byte budgets do not claim a process-memory bound.
- Receipt identity, fingerprint, revision and legal progression are checked before
  publication. Local disconnect uncertainty never overwrites authoritative state.
  `accepted` and `consumed` do not prove settlement. Authoritative
  `outcome_unknown` has no invented reconciliation transition under current C1.
- Invalidating the authenticated observation context clears its attempts and
  rejects late receipts; it does not stop any Host-owned work.

## Validation commands

The host's `pnpm` executable currently attempts to resolve a missing managed
`pnpm@12.8.1` executable. Validation therefore uses the already-provisioned Node,
Vitest, TypeScript and Biome entry points directly. No dependency installation or
successful pnpm execution is claimed. Current-source aliases avoid stale shared
package build output in linked worktrees.

- C1 baseline: 47 tests in nine files passed before implementation.
- Latest integrated run: **363 tests across 30 files passed** — 59 shared
  C1/owner-validator, 45 Host monitor (snapshot store 6, failures 20, retention 9,
  projection barrier 5, seeded pagination 5) and 259 client (intervention 64,
  context binding 5, multi-page reader 47, connection health 59 including five
  seeded timing cases, live summary 59 including four seeded summary-sequence
  cases, session composition 25). Earlier 140/199/253/258/313/322-test results are
  superseded, not added.
- Regression breadth on this branch: the complete Agent Host package suite passed
  **151 tests across 12 files**; shared source-only (excluding prior build output)
  passed **808 tests across 72 files**; the client package passed **259 tests
  across fifteen files**.
  The new owner-validator baseline failed all 12 cases because the parser was
  absent, then passed after implementing strict copied owner validation.
- `node scripts/check-command-center-foundations.mjs`: twelve consumer checks pass,
  including the health/reader suspend-resync, live-change-application and\n  documented cross-module limit composition paths.
  The actual Host store and browser-target reader exchange 205 rows in three pages;
  expiry during a refresh retains only the previous complete projection with an
  error state and does not trigger retry. Revocation clears the projection.
  The first harness run omitted the browser `URL` global required by TypeBox and
  failed before receipt evaluation; adding standard `URL`/`URLSearchParams` globals
  corrected the harness. No product dependency was changed to hide that failure.
- Workspace lockfile YAML parses and the new importer exactly matches the new
  package's dependency specifications. All versions reuse existing lock entries.

The latest current-source TypeScript check passed with no emit. Biome passed all
62 selected source/test/check files. Agent-policy synchronization and main ancestry
passed in the preceding foundation slice and have no changed policy/base inputs;
whitespace and documentation checks passed again after health integration. The
architecture checker passed against `1cdb4ce1d`; because its new-file comparison
does not inspect untracked additions, a separate updated check verified all 45
added TS/MJS files against the 800-line ceiling (maximum 368 lines), trailing
whitespace and blank final lines. Earlier checkpoint digests are superseded. The
current [source/configuration evidence](ai-command-center-foundations-evidence.json)
records 58 observation-foundation source/configuration files and digest
`af583e9a4bc685c027b73d0b3f2e88af980d65af824c7b21d76683d3d44dfa98`.
This record contains repository-relative paths and hashes, not source bodies.

Documentation validation passed 642 pages and 88 English/Chinese pairs. The first
locale check failed on existing mirror omissions: one `HOST_DATA_DIR_IN_USE` row
and four handoff/runtime traceability rows. Comparison with `1cdb4ce1d` confirmed
those missing rows predated this request. Their English facts and scenario links
are now mirrored, alongside this request's new scenario. The first whitespace
check also found two extra EOF blank lines in the appended specs; both were fixed.
Existing non-failing notes about missing consequences sections remain unchanged.

The scoped command entry points are the direct Vitest executable with
`.pi/command-center-continuation/vitest.config.mjs`, TypeScript with
`.pi/command-center-continuation/tsconfig.json`,
`node scripts/check-command-center-foundations.mjs`, the configured Biome lint,
`node scripts/check-architecture.mjs --base 1cdb4ce1d`,
`node scripts/check-agent-policy-sync.mjs`, `node scripts/check-pr-base-main.mjs`,
and the documentation package's `check-docs.mjs` / `check-locales.mjs`.
The ignored configs select current shared source in this linked development tree;
normal installed workspace package scripts remain available on a provisioned host.

The official TypeScript project build also passed:
`node node_modules/typescript/bin/tsc -b packages/shared packages/agent-host packages/command-center-client`.
The task-owned agent-host/client dependency junctions were replaced with small
local link directories so `@pi-desktop/shared` resolves this request's emitted
shared package. External dependencies still link to the provisioned tree; no
installation or changes to its shared outputs occurred. Both
`node scripts/check-command-center-foundations.mjs` and its `--built` mode passed
the same twelve checks. Built mode uses emitted package entries and normal package
resolution without shared source aliases. Direct ESM imports of the emitted Host
and client packages also executed successfully.

No full repository build, Rust suite, Electron journey, live profile, paid provider,
browser network endpoint or native process qualification is claimed for this
internal JS-only scope. No commit, push, PR, deployment or service installation
was performed. These checks describe the working source, not a clean committed
release candidate.

## Live summary application

The client summary model applies validated ordered envelopes to a published
projection: `upsert` replaces or inserts by stable task key, `remove` drops a
known key (and is an idempotent no-op for an unknown one), and `resync` demands a
new snapshot. A sequence at or below the cursor is a duplicate no-op; a gap,
epoch change, bound violation or explicit request makes `resync_required`
absorbing while the last consistent rows remain available for stale display. The
initial cut timestamp never advances, inputs are copied and frozen, and context
revocation clears rows. Envelopes are a local adapter port shape; the future C3
transport must map real events to it and own authorization, ordering and
backpressure.

The browser consumer check now drives this path after the real Host page join:
replace and insert rows in order, remove one, reject a duplicate, detect a
sequence gap without bridging it, retain the prior rows, and clear everything on
context revocation. Cross-realm object comparison uses field checks rather than
`deepEqual`, because the browser realm's frozen objects have different prototypes;
that is a harness detail, not a product behaviour.

## Reproduce this verification

Run from this request worktree after linking the provisioned dependencies (the
ignored `.pi/command-center-continuation/` configs select current shared source and
the affected test files). No install, Desktop, profile, provider or network is used.

```text
node packages/agent-host/node_modules/vitest/vitest.mjs run --config .pi/command-center-continuation/vitest.config.mjs
node packages/agent-host/node_modules/vitest/vitest.mjs run --root packages/agent-host
node packages/agent-host/node_modules/vitest/vitest.mjs run --root packages/shared src/
node packages/agent-host/node_modules/vitest/vitest.mjs run --root packages/command-center-client
node packages/agent-host/node_modules/vitest/vitest.mjs run --root packages/racp
node node_modules/typescript/bin/tsc -p .pi/command-center-continuation/tsconfig.json
node node_modules/typescript/bin/tsc -b packages/shared packages/agent-host packages/command-center-client
node scripts/check-command-center-foundations.mjs
node scripts/check-command-center-foundations.mjs --built
node node_modules/@biomejs/biome/bin/biome lint packages/agent-host/src/monitor packages/command-center-client/src packages/shared/src/command-center/identity.ts packages/shared/src/command-center/identity.test.ts packages/shared/src/command-center/observation-owner.test.ts scripts/check-command-center-foundations.mjs scripts/e2e/command-center/connection-health-consumer.mjs scripts/e2e/command-center/monitor-session-consumer.mjs
node scripts/check-architecture.mjs --base 1cdb4ce1d
node scripts/check-agent-policy-sync.mjs
node scripts/check-pr-base-main.mjs
node docs/scripts/check-docs.mjs
node docs/scripts/check-locales.mjs
node .pi/command-center-continuation/source-manifest.mjs
node .pi/command-center-continuation/takeover-evidence.mjs
```

Takeover-specific commands (after the authorized copy):

```text
node node_modules/typescript/bin/tsc -p .pi/command-center-continuation/tsconfig.host-runtime-takeover.json
node node_modules/typescript/bin/tsc -p .pi/command-center-continuation/tsconfig.desktop-takeover.json
$env:CARGO_TARGET_DIR='D:\Packages\PI-Desktop\target'
cargo check -p host-core --locked --offline
cargo test -p host-core --locked --offline command_center
cargo test -p host-core --locked --offline owner_handoff::target
cargo fmt --check -p host-core
node --test apps/desktop/test/command-center-*.test.mjs apps/desktop/test/handoff-attachment.test.mjs
node --test scripts/e2e/command-center/qualification-*.test.mjs
node packages/agent-host/node_modules/vitest/vitest.mjs run --config .pi/command-center-continuation/vitest.host-runtime-takeover.config.mjs
$env:PI_SCRATCH_DIR="$PWD/.pi/command-center-continuation/scratch"
node --test scripts/e2e/command-center/*.test.mjs scripts/e2e-command-center-curve.test.mjs
```

Observed on 2026-11-11 with the dependency head unchanged at `1cdb4ce1d`:
integrated 363/30, Agent Host 151/12, shared source 808/72, client 259/15, RACP
33/4, consumer checks 12/12 in both modes, documentation 645 pages / 88 pairs.
Taken-over modules: Rust `command_center` 59/59, `owner_handoff::target` 16/16,
host-runtime attachment + adapter 36/36, Desktop command-center/attachment 25/25,
Q0 harness 24/24. The combined baseline script passes 48/48 when
`PI_SCRATCH_DIR` points at an isolated scratch directory; without it the
pre-existing curve test refuses to run.

## Audit corrections

An independent read-only audit of these foundations against their documentation
raised four discrepancies; all were resolved and re-verified:

1. **Paging ceilings did not compose.** The Host allowed 1,024 continuation
   tokens plus the initial page (up to 1,025 pages), while the client ceiling was
   1,024 pages, so a legal Host generation could be rejected. The client default
   is now 1,025 pages with the composition rule documented, and the browser
   consumer check reads a real 1,025-page generation (1,024 continuations).
2. **Change sequence wording was ambiguous.** The contract said "strictly
   increasing" while the client correctly requires contiguous
   `cursor + 1`; the contract now requires contiguous delivery and an explicit
   `resync` instead of any filtered gap.
3. **Test-total arithmetic was inconsistent.** The headline was from the actual
   run; the component list is now given per file group and sums to the same 322.
   The client full-package figure was corrected to 243 tests across twelve files.
4. **Consumer-check counts disagreed.** One paragraph still said "same eight
   checks"; both modes now state the same current count.

## Dependent consumer verification

The `racp` package (a real consumer of the changed shared and Agent Host public
entries) was linked to this branch's workspace packages by reference and compiled
with its own TypeScript project: it built successfully and its suite passed
**30 tests across three files** against the branch outputs. This is additive-export
compatibility evidence for an existing transport consumer.

`host-runtime` and `agent-runtime` could not be built in this worktree because the
provisioned dependency tree does not match this branch's pinned Pi patches: the
installed `@earendil-works/pi-ai@1.4.0` copy is a plain directory that lacks
patched exports such as `LocalRequestError` and `getLastAssistantUsageInfo`, and
`host-runtime` then reports the same missing APIs plus an ES2024 `withResolvers`
lib mismatch. The same failures concern files this request never changed. Fixing
them would require reinstalling dependencies, which the workflow forbids for E2E
and which the broken host `pnpm` cannot do. The attempt is recorded as a
dependency-provenance limitation, not as a passing gate or a product regression.

A `git fetch` in this worktree produced a stray `NUL` file containing only the
`github.com` host-key line, an artifact of the host SSH configuration writing
`UserKnownHostsFile=NUL` as a real file. It was verified to contain no credential
and removed; no other checkout was modified.

## Model-based coverage

Two seeded, deterministic model-based suites now check invariants over generated
inputs rather than hand-picked cases:

- Host store pagination: for random row counts (0-250) and page sizes (1-100),
  following every continuation reproduces exactly the captured rows in order at a
  single cursor, with unique tokens, per-page row bounds and stable timestamps;
  post-capture mutation of source rows or a previously returned page cannot change
  a retained page.
- Client summary changes: for three seeds and 120 generated steps each, applied
  upserts/removals (including unknown removals) keep the projection exactly equal
  to an independent reference map, with the cursor advancing once per change and
  the cut timestamp unchanged; replayed/lower sequences stay duplicates.
- All-pages reader: three seeds split 20-250 rows into arbitrary legal page sizes
  (1-100 rows), and following every continuation reconstructs exactly the input
  rows at one cursor/timestamp; changed generation, duplicate task, token cycle
  and loader failure fail explicitly while the prior complete projection is kept.
- Receipt chains: four seeds build legal receipt sequences from the committed C1
  transition table, apply each step and compare against the expected revision,
  content, settlement flag and terminal absorption; stale, duplicate,
  inconsistent, mismatched and malformed receipts never change state. Authoritative
  `outcome_unknown` remains absorbing under the current contract.
- Connection health timing: three seeds advance a controlled clock in random
  increments and resolve/reject/leave probes at random, asserting the invariant
  `fresh == synchronized && last valid reply < 6s old` after every step, the
  two-unsettled-call probe budget, and that no valid reply can never become
  fresh. This targets the timing-sensitive freshness contract without wall-clock
  waits.

These complement, and do not replace, the real C3 repository authorization and
transport acceptance that remains open. Seeded streams are reproducible without
clock, network or Host execution.

## Monitor session composition

`createCommandCenterMonitorSession` composes the reader, live summary and
connection health for one authenticated connection. A published refresh rebuilds
the summary from the new projection and completes health resynchronization only
for the cycle captured before that read; a read started before connect/resume
cannot satisfy a later cycle. `fresh` requires a ready projection, a summary built
from exactly that cut, and a recent valid ping. Reader failure/resync makes the
summary resync-required, suspension/disconnection retain rows as stale, and
context revocation/disposal clears rows and timers. Independently lower summary
limits reject an otherwise valid projection explicitly. No stream, transport,
capability or execution is added.

The browser consumer check now drives this composition with a controlled clock and
held ping replies: a pre-connect snapshot stays stale; connect plus refresh plus a
valid reply becomes fresh; live changes apply; a gap forces summary resync;
advancing two seconds sends exactly one probe, which suspension aborts while
clearing the timer; resume requires a further published refresh before freshness;
revocation clears both children. Two harness corrections were needed: the probe
assertion assumed a ping was in flight before advancing the clock, and closed
summary state is exposed as an invalidated child model with a null projection
rather than `null`. Both were test-fixture facts, not product changes.

## Connection-health continuation

The foreground health controller implements the existing two-second probe and
six-second stale contract through injected clock/scheduler/authenticated-ping
ports. It separates connection liveness from Agent progress and from completed
snapshot synchronization. Connect/resume produce opaque cycle tokens; a matching
completed snapshot and a valid recent reply are both necessary for freshness.
Suspension, disconnection, invalidation and disposal cancel observation without
stopping Host work. At most two original unsettled ping calls remain counted,
even after cancellation; bounded capacity never produces an automatic retry queue.

A single state observer receives actual changes without polling. Reentrant
observer/abort/scheduler callbacks preserve the newest cycle and timer; throwing
observers detach with an explicit sticky diagnostic. Invalid/backward clocks and
scheduler failure halt stale, and stale cycle replies/tokens cannot revive it.

The added consumer check composes the browser-target reader and health controller
with held ping replies and a deterministic scheduler. It verifies freshness after
both synchronization and liveness, six-second stale notification, suspend/resume,
original pending-I/O bounds, old-token refusal and revocation cleanup. Initial
harness attempts exposed a fixture with a continuation it did not serve and an
incorrect assumption that awaiting the original cross-realm ping promise meant
its consumer had published. The final harness supplies a complete page, waits on
explicit state notifications and advances the controlled next probe after old
promises settle; it uses no real-time sleep or network.

## Projection-barrier contract and C3 join

The required integration sequence is specified in the
[monitor integration contract](ai-command-center-monitor-integration-contract.md):
subscribe first, take one consistent cut with its watermark, capture at that
watermark under the trusted scope, replay only strictly later changes, and rotate
scope/snapshot on access or epoch change. It is a dependency contract, not a wire
protocol or capability.

A new executable test encodes that order against the real snapshot store with an
in-memory reference change source: mid-read updates/inserts/removals stay out of
the frozen cut, post-cut changes replay in order to exactly the authoritative
rows, complete multi-page generations are read consistently, buffer overflow
requires a fresh snapshot without partial publication, and a scope change discards
old pages while the replacement scope rejects them. This is contract evidence;
CC-M-01/02 with the real C3 repository, authorization and transport remain open.

## Remaining joins

A read-only joining review reconfirmed that existing session metadata has no
command-workspace membership, desired/effective goal heads, authoritative
reservations or child execution generations. Existing session snapshots await
history before taking state/cursor, and controller/owner attach can resume queued
execution; neither provides the monitor's cross-source cut. No adapter substitutes
project IDs, status-derived goals or a collection of session cursors for that cut.

The next production join requires committed C2/C3 query/change/authorization ports:

1. Resolve authenticated viewer access and a trusted filter/access generation.
2. Read authoritative rows with a matching change watermark; buffer committed
   changes across the read, then freeze the projection and register bounded
   delivery at sequence S in one serialized operation.
3. Capture pages through the existing store, complete the client projection, and
   only then apply changes after S. Define upsert/remove/resync and scope-local
   sequence or filtered-watermark semantics before implementing that live stream.
4. Recheck authorization after awaits, discard scopes on access/filter changes,
   and close subscriptions on epoch changes or disconnect. Bound opening/replay/
   outstanding buffers, including transport envelope bytes. Overflow requires resync.
5. Add RACP/IPC catalog/role/connection wiring and negotiation tests. The current
   capability implementation list is empty and its parser rejects true flags;
   both must change only with a passing complete producer/consumer path.

M1 still needs C3's authorized source projection, ordering across database reads
and events, subscription backpressure, cursor recovery and production composition.
W2 still needs the actual application, authorized transport, W1 browser security
binding, C4/H5 integration and nominated Android/iOS/browser environments. The
portable model cannot enable those features on its own.

Native application association remains behind its identity/observation design and
program-specific qualification. A new UUID attached to an HWND is not proof
against same-process handle reuse. No unqualified native capability is advertised.
Voice remains the final planned stage. Two-core/8-GB capacity, mixed workloads,
two-hour/100-cycle recovery and actual device/platform qualification remain open.
The earlier default-profile isolation incident remains unresolved; these isolated
checks do not establish the integrity of the data affected by that earlier event.

## Integration handoff condition

Across three automatic continuation rounds, the dependency branch remained at
`1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`. Git status continued to show C2/C3,
H3/H4, U1 and Q0 source as modified/untracked work in the other request's tree.
This request cannot consume those drafts under the repository's isolation rule,
and it has no authorization to commit or rewrite that other request's work.
The independent paging, receipt, reader and health slices above are complete
within their stated boundaries; another disconnected adapter would not close the
missing authoritative producer path.

To resume production integration, provide committed C2/C3 repository/query/change/
authorization contracts and H3/H4 successor/attachment contracts from their owning
request, with the corresponding validation evidence. Import those commits into
this dedicated branch, resolve overlaps here, then implement and test the monitor
producer/event barrier and the H5/control/UI joins. User-device/hardware-dependent
qualification still requires its nominated environments. No unsafe takeover,
uncommitted dependency import, capability enablement, publish or deployment is
substituted for those conditions.
