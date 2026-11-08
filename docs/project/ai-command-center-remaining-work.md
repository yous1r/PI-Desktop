# AI command center: remaining implementation and acceptance

- Basis: [schedule](ai-command-center-schedule.md), [requirements](ai-command-center-requirements.md), [control contracts](ai-command-center-control-contracts.md).
- Status: Incremental execution; no milestone is closed by planning documents alone.
- Current branch starts from the committed runtime/soak/sampling corrections.
- Execution map: [value/risk priorities, parallel dependencies, delivery gates and acceptance](ai-command-center-parallel-work.md).

## Current correctness status

All 20 originally reported Rust baseline failures are addressed across the
committed fixes. The historical Windows full suite passed **1,103 tests, zero
failures, one existing live-marketplace ignore, zero filtered tests**. The cmd
quoted-path defect and four Clippy warnings are also closed. See the
[full validation record](ai-command-center-p0-evidence/windows-validation.json).
Historical failure counts below remain unchanged evidence, not current blockers.
Full S03b implementation, two-core / 8-GB performance, native/mobile and release
qualification remain separate open product milestones.

## Completed baseline

- Runtime persistence backpressure and durable terminal ordering, byte-bounded
  replay, 1-MiB and one-hour fixed-context measurements.
- Sampling-tail correction: final result must precede the entire last sample;
  all-round counts, explicit coverage checks and a 108-turn short regression.
- P0 control contract draft (19 race scenarios), capability matrix (25 surfaces)
  and owner-handoff fault cases. These drafts do not implement new APIs.

## Missing inputs before dependent acceptance

1. Named native programs and privilege/dialog behavior; Windows RDP/DPI/IME
   test access. These block native and complete interactive acceptance, not a
   local Rust ownership primitive.
2. Android/iOS devices, browser versions and self-hosted HTTPS deployment model.
   These block mobile/browser qualification, not backend preparation.
3. Minimum hardware is now user-confirmed: two CPU cores and 8 GB RAM. Exact
   CPU/OS, target-machine access, tokenizer/corpus and tool/plugin versions still
   need qualification. Current six-thread / 24-GB measurements are comparison
   evidence; the synthetic 1-MiB main-only soak cannot certify the target.
4. Receipt policy is resolved: no automatic control-receipt or transfer-journal
   deletion in the first release. Implement bounded caches and paginated durable
   reads; a future explicit purge/deletion contract is separate.
5. Full Host handoff now has a [concrete protocol design](ai-command-center-idle-handoff.md)
   for local identity, durable phases and old-sidecar fencing. Native fencing,
   journal migration and restricted recovery are accepted on this Windows host;
   complete idle inventory, source orchestration and client attachment remain.
   Current-user background execution and idle-only transfer remain the first slice.

## Ordered work and acceptance

| Priority | Step | Implementation status | Required acceptance before completion |
|---|---|---|---|
| 1 | S03a: Rust data-directory ownership | Implemented candidate in this slice | Same-directory and alias contenders fail before recovery; independent directories run; normal/crash exit releases ownership; relocation refuses live destination before mutation; existing history remains readable |
| 2 | S03b: Exclusive execution handoff | Windows discovery, native fencing and durable restricted recovery accepted; full idle transfer pending | Existing admission gate blocks new work; busy handoff rejects; old sidecar proven stopped/fenced; one successor; crash at every phase leaves recoverable journal; no turn/tool replay |
| 3 | S02/S04: Finalize versioned metadata contract | Retention decided; schemas/implementation pending | Stable task vs concrete execution identity; strict request schema; desired/effective goal CAS; durable no-auto-delete receipts; golden producer/consumer fixtures |
| 4 | S04: Rust repositories and migrations | Pending | Workspaces/membership/reservations/goals/receipts preserve existing data; transactional 12/36 checks; unique release; migration/restart/partial-commit tests; no second transcript store |
| 5 | S05: Portable authorized control interfaces | Pending | Negotiated operations only; authenticated principal/role; idempotency and lost-reply reconciliation; unsupported capabilities explicit; old clients remain compatible |
| 6 | S06/S07: Monitoring and four-surface Desktop | Pending | Bounded summary snapshot/subscription; no gaps/stale repaint; existing history/live attach without new execution; overview + three workspaces; draft/focus/reading state preserved |
| 7 | S08/S09: All-entry quota and main/child control | Pending | Desktop/plugin/schedule/Task/Worker starts cannot bypass quotas; waits/stopping count; child consumes exact goal revision; parent rejects stale result; Stop targets exact generation |
| 8 | S10: Native program association | Pending, program matrix missing | Association/detach does not kill external apps; identity and privilege checks; RDP/DPI/IME/dialog behavior; unsupported embedding explicit |
| 9 | S11/S12: Browser edge and mobile clients | Pending, environment inputs missing | Same-origin authenticated HTTPS, revocation/origin/CSRF boundaries; cross-client receipts consistent; background/resume and phone journeys verified |
| Continuous | S13/S14: Capacity, lifecycle and recovery | Partial | Token-counted mixed load with all application processes; <=4 GB product target; <=100-ms sampling with disclosed trace limits; two-hour/100-cycle residual-growth and no-orphan checks |
| Final | S15: Release evidence and operating docs | Pending | Relevant platform integration candidate gates pass; migrations/recovery and compatibility documented; no release/deployment inferred from local test results |

## S03a implementation boundary

[Data-directory ownership ADR](../adr/host-data-directory-ownership.md) uses an
OS-held file lock before Rust AppState opening and recovery. The same primitive
protects offline relocation destination writes. Shared HostProcess emits a stable
boot refusal, without changing post-handshake failures or bounded supervisor
policy. Existing schema and transcript semantics stay unchanged.

This protects cooperating updated Host binaries only. It does not prevent an old
binary ignoring the lock, protect against a privileged actor replacing the lock
path, prove network-filesystem semantics, or fence an orphan sidecar that can
still execute effects. S03b and full M0/M1 remain pending.

The next slice must build on these checks rather than claiming S03 complete from
one lock. Run one coherent implementation and its meaningful regressions at a
time; report actual evidence and any remaining gate after each slice.

## S03a verification and unresolved integration gate

The old binary accepted two same-directory handshakes; retain the
[failing baseline](ai-command-center-p0-evidence/host-owner-before.json).
The implementation candidate passes the seven real-process scenarios before
final commit validation. Windows Rust ownership tests pass 3/3 and the occupied
relocation regression passes 1/1. Host-runtime tests pass 190 with three existing
platform skips; error-code registry tests pass 2/2. Shared build, affected-source
typecheck, formatting, lint and Clippy pass. Clippy reports four warnings in
unchanged modules.

The complete Rust suite is **not green**: 1,079 passed, 20 failed and one ignored.
All 20 failing test names reproduce on the unmodified baseline
`9a37c82c06a6ef362c9c52af313cb6dd3b64dccb` when selected independently; see
[baseline comparison](ai-command-center-p0-evidence/host-owner-baseline-comparison.json).
They involve Windows process trees, relocation path/capability keys, remote-tool
permission expectations and Git worktree operations. They remain unresolved;
this evidence distinguishes the ownership change from existing failures but
does not waive the integration gate. Unix-specific lock tests, macOS/Linux and
network-filesystem qualification are not run on this Windows machine.

Before progressing to S03b acceptance, resolve the applicable baseline failures
and prove the complete execution-owner lifecycle. No user data migration,
service installation, force takeover or automatic replay is performed by S03a.
The raw process report for the committed candidate is recorded separately.

Committed-candidate verification: `60bbb5ddc774af6e1695f7583d44c93d653802f6`
contains remote base `fd28eb89866ac513912ed109716e7120cf60f18c`. The production
HostProcess/Rust test completed all seven scenarios from a clean worktree, with
nine observed process exits and confirmed cleanup. Retain the exact
[candidate report](ai-command-center-p0-evidence/host-owner-after.json).
Host binary SHA-256:
`b892cb1e584a8cea0a5189bc622ad9a9173b1bc5ed17fda0bcaf771880769203`.
The final ownership/relocation tests were rebuilt and explicitly ran four tests;
a stale shared-target invocation that selected zero tests was discarded. The
final candidate build, `cargo fmt --check` and Clippy completed successfully.

S03a is implemented and its focused Windows checks pass. Full Rust integration,
S03b and all subsequent product milestones remain open. Next priority is the
baseline compatibility failures relevant to safe ownership handoff, then the
idle-only transfer journal/sidecar fencing and recovery flow. Receipt retention
and real native/mobile workload inputs remain required before their dependent
steps are accepted.

## Windows relocation prerequisite

The three previously failing relocation tests now pass in the focused group
(9/9), together with 20/20 capability-state tests. Native Windows path output
must be normalized before serializing a project capability identity; otherwise
the destination lookup loses a disabled override and misses key collisions.
The legacy-schema test now compares database paths using the existing canonical
database spelling rather than native separators. No schema or casing rule changes.

The old ownership-candidate binary fails the real offline CLI regression at the
destination disabled-key assertion; retain the
[failing report](ai-command-center-p0-evidence/relocation-capability-before.json).
The rebuilt candidate passes all four CLI checks: canonical project identity,
global/external/source preservation, repeated-run byte idempotence, and collision
refusal without capability-file rewrite. Exact committed-candidate evidence is
recorded after commit. Formatting, capability/relocation tests, Host build,
Clippy, script lint and documentation checks pass; Clippy retains four existing
warnings. No UI, real profile or provider is used.

This resolves the three selected relocation failures, not the remaining 17
baseline failures or the full-suite integration gate. The next applicable
prerequisite is Windows background-process termination, before full S03b handoff.
The earlier full Rust result remains historical; it has not been rerun or
retroactively changed.

Clean committed CLI verification: `cad0a6402e65ee792ad31b6acbc472eaa1be3e82`,
base `fd28eb89866ac513912ed109716e7120cf60f18c`, Windows, four checks passed,
`dirty:false`. The
[candidate report](ai-command-center-p0-evidence/relocation-capability-after.json)
records binary SHA-256
`2b413a296e708113537ad39d4effc49c630c7ebc3feaf9b3eda64b6744fe3e24`.
An earlier post-commit run had an untracked task-generated `NUL` SSH artifact;
that report was not used as clean-candidate evidence.

## Windows Stop prerequisite and S03b sequencing

The process-tree ordering test had a duplicate `HashMap` key that discarded two
descendants; the background Stop test blocked its single-threaded Tokio runtime
while waiting for the supervisor. Correcting those fixtures makes the two
original baseline cases pass without a production change. The test build starts
the shell directly, despite its former hidden-runner comment.

A new real-process fallback regression exposed a separate production defect:
`ProcessTimes::now()` returned Host creation time, so normal later-born command
processes were skipped. Before the fix, the focused group is 5 passed / 1 failed
(target still alive after cleanup); after using Windows wall-clock FILETIME
before snapshot collection it is 6/6. The background-task group is 8/8. The
newer-handle guard and unrelated-process preservation remain covered. These
checks supplement, not replace, real Host RPC / hidden-runner Stop acceptance.

Five names from the original 20-failure baseline have now been addressed in
focused runs (three relocation cases and two test-fixture defects). The other
15 remain unqualified; no new full-suite pass count is inferred. An additional
cmd command containing quoted executable paths failed at startup with literal
backslash-quote characters. The Stop fixture uses the established relative
`node tree.mjs root` command; quoted-path execution remains a separate observed
compatibility defect, not a successful Stop test or a change in this slice.

Source inspection fixes the next S03b order and acceptance:

1. **Local control transport and identity.** `apps/pi-host/src/app.ts` skips its
   admin channel on Windows, and `admin-socket.ts` only accepts Unix ownership.
   Add a versioned current-user local channel; reject other identities, stale
   generations and malformed/oversized requests before any ownership mutation.
2. **Durable transfer admission.** Reuse existing admission wiring, but do not
   treat the 120-second auto-reopening `MaintenanceAdmission` lease as a durable
   handoff. Busy work refuses an idle-only request; after transfer starts, timeout
   or requester disconnect must not silently resume source execution.
3. **Rust-owned journal and process fencing.** Persist source/target generations
   and phases before effects. Prove old sidecar and tool ownership has ended
   before releasing the data-directory owner. A process snapshot fallback alone
   does not establish a generation fence or safe orphan takeover.
4. **Successor recovery and client reattachment.** One successor claims the
   directory, reconciles the journal, publishes readiness and new epochs, and
   lets clients attach without replaying model or tool work. Inject failure at
   each transition, including lost replies and source/successor crashes.

S03b remains unimplemented. Receipt retention/deletion policy is still needed
before finalizing the dependent S02/S04 contract; native/mobile/reference-load
inputs continue to block their own qualification, not these local fixes.

Stop evidence retained for review:

- [Fallback failing baseline](ai-command-center-p0-evidence/process-stop-fallback-before.txt)
  and [async test-only baseline](ai-command-center-p0-evidence/process-stop-async-baseline.txt).
- [Old-binary RPC baseline](ai-command-center-p0-evidence/process-stop-rpc-baseline.json)
  passes the ordinary Job Object route; it does not reproduce the fallback defect.
- [Quoted-cmd limitation](ai-command-center-p0-evidence/process-stop-cmd-limitation.json)
  fails before command readiness and retains its diagnostic output and cleanup.

The rebuilt candidate passes the same four real RPC Stop checks with confirmed
cleanup. Host build, formatting, Clippy (four unchanged warnings), script lint,
documentation check and current-main ancestry check pass. A clean-commit RPC
report is recorded separately after committing this fix. No full Rust rerun,
Desktop UI, service installation, live profile or paid provider is involved.

Clean committed Stop verification: `c33392f566f70ccc817e4a0ffa48113d377b6f65`,
base `fd28eb89866ac513912ed109716e7120cf60f18c`, Windows, `dirty:false`.
All four RPC checks pass and process cleanup is confirmed; retain the
[candidate report](ai-command-center-p0-evidence/process-stop-after.json).
Host binary SHA-256:
`f8b25e417a3f5253f9c5e15aea13a7c82c8ab14027ee4a8a1c967efcee53b887`.
The two lower V3 overview regions remain intentionally unassigned and
non-interactive; later UI work must not invent functions for them.

## S03b design checkpoint

The [idle handoff protocol](ai-command-center-idle-handoff.md) now specifies a
Windows current-user native channel, 16-KiB strict frames, source/target epochs,
seven durable phases, explicit recovery and fifteen fault scenarios. It records
why an expiring maintenance lease and ordinary disposal completion cannot prove
exclusive execution transfer. Four implementation slices have separate evidence
gates. No new protocol, migration, process adoption or handoff is advertised by
the current binaries; full M0 prerequisites and later product gates remain open.

## User-confirmed minimum configuration and retention

The current development host has six logical processors and about 24 GB RAM;
the product must remain stable and responsive on a two-core, 8-GB machine.
The requirements now make that the minimum qualification target while retaining
12/36 execution capacity, the 4,000,000,000-byte application budget, and the
existing input/switch/Stop latency gates. A two-CPU affinity run on this larger
host is only preflight, not evidence of target RAM/paging behavior. No result
has yet qualified the complete product on the minimum target.

First-release control receipts and transfer journals are not automatically
deleted. This supersedes earlier unresolved-retention notes in the historical
progress sections above. Implementation can proceed without another retention
decision; later explicit deletion remains a separate data-compatibility feature.

## Explicit process-exit confirmation prerequisite

HostProcess and AgentSidecar now expose `confirmExit(timeoutMs)` without changing
ordinary disposal behavior. The helper observes the original child, removes its
listeners on completion, refuses a live/failed-spawn/unconfirmed child, and does
not signal a process or infer descendant cleanup. Fourteen public-interface
tests fail before the addition and pass after it, including disposal timeout,
transport errors, late exit, concurrent waits and invalid budgets.

The real-process harness starts the production Rust Host and a deterministic
sidecar fixture through the production wrappers, refuses live confirmation and
confirms both exits after their public shutdown/disposal calls. Independent child
close observations confirm cleanup. This is one S03b-2 prerequisite, not a
completed transfer or minimum-hardware performance qualification.

The first full Host-runtime test run had 203 pass, 1 fail and 3 platform skips:
the production ParentHostProxy child could not resolve shared/dist in the linked
worktree environment. Direct Node import reproduced `ERR_MODULE_NOT_FOUND`.
The candidate shared package was built and the retry uses a scratch-only Node
resolver pinned to that output. Preserve the first result; the corrected run
is reported separately.

The corrected full Host-runtime run passes **204 tests with 3 existing platform
skips** (31 files). The shared build, affected-source TypeScript check, scoped
lint and docs check pass. Rust code is unchanged in this slice, so the prior
Rust integration limitations remain; no full Rust rerun or UI verification is
claimed. The exact clean-commit process result is recorded after commit.

The exact exit-confirmation candidate
`8fa4b7e217995838e53f51ea1ea7190fb697b7bf` passes the real-process check from
a clean worktree, with both owned processes closed; retain the
[candidate report](ai-command-center-p0-evidence/exit-confirmation-after.json).
The previously pending VitePress build completed successfully in 54.82 seconds.

## Prioritized Windows defect closure

The follow-up fixes the remaining 15 named Rust baseline failures at their
causes: remote POSIX paths were interpreted using the controller OS (two
permission/relay failures), and temporary Git repositories inherited global
`core.autocrlf=true` (13 byte-content assertions after checkout/merge). Remote
lexical authorization now uses POSIX components; remote canonical/symlink checks
remain authoritative. Tests set LF policy only in their own repositories.

The separately observed cmd quoting defect is fixed through one shared shell
command constructor: only cmd's final command body uses native command-line
quoting, with ordinary argument handling retained for other shells. The real
Stop harness now uses quoted executable/script paths and a workspace with spaces,
Unicode and ampersands; it also checks foreground arguments, streams and exit 7.
Both new lower-level regressions and both real Host harnesses first failed on
the old implementation. Keep the old
[cmd failure](ai-command-center-p0-evidence/windows-cmd-before.json) and
[remote authorization failure](ai-command-center-p0-evidence/remote-permissions-before.json).

Focused checks pass: remote tools 10/10, cmd 1/1, worktree core 67/67 and
worktree RPC 6/6. Four existing Clippy warnings were removed with equivalent
byte/iterator expressions; `cargo clippy --all-targets --locked -- -D warnings`
passes. The final full-suite and clean-candidate results below close the known
Windows correctness blockers without claiming the dependent product milestones.

Implementation commit: `b5c9ebbd52bde42c869ee217be335cc892a56552`.
Candidate: `38c502af7ee67c13db929e9f998def706a0e2bb0`, including only a subsequent
delivery-checklist correction; base `fd28eb89866ac513912ed109716e7120cf60f18c`.
The checklist now follows request-worktree and PR integration-candidate policy,
removing a contradictory reference to a local-main gate. No local-main merge,
push, PR or deployment was performed.

- Full Rust suite: 1,103 passed / 0 failed / 1 ignored in 827.22 seconds. The
  ignored live plugin-marketplace test requires its own explicit authorization.
  [Raw log](ai-command-center-p0-evidence/windows-validation-rust.txt) and
  [194 Rust/build inputs](ai-command-center-p0-evidence/windows-validation-inputs.json)
  are retained. The run began before commit; input hashes and committed-source
  comparison prove it tested the same executable source.
- `cargo fmt --check`, strict Clippy with `-D warnings`, Host build and Biome lint
  (176 files) pass. New regressions' original failures remain in the
  [before log](ai-command-center-p0-evidence/windows-validation-regressions-before.txt).
- Clean-candidate [cmd and Stop E2E](ai-command-center-p0-evidence/windows-cmd-after.json):
  five checks pass with confirmed cleanup.
- Clean-candidate [remote permission E2E](ai-command-center-p0-evidence/remote-permissions-after.json):
  four checks pass with confirmed cleanup. Both reports have `dirty:false` and
  Host SHA-256 `d13925a6722ca96e08acfcd9f76782aeed609c388301b0fa0a0a4e6d823ef37f`.

No further known failure remains in the executed Windows Rust/CLI checks.
Continue with S03b local transport and native execution fencing. Exact target
hardware/OS access and the native/mobile fixture matrix are still needed for
their dependent acceptance; they are not silently replaced by this machine's
unit/process results. No live provider, user profile or `verify:ui:*` was used.

## S03b-1 local discovery implementation

The opt-in Windows owner-discovery channel is implemented as separate protocol,
native identity and pipe-lifecycle modules. It supports only `status`, validates
both process peers, derives its address from SID plus directory volume/file ID,
and claims the pipe after the data-directory lock but before AppState/recovery.
Queries never create or migrate profiles. See the
[discovery ADR](../adr/windows-owner-discovery.md).

Eight Rust protocol/native tests pass, including 100 sequential real-pipe
queries, restricted-token ACL denial, malformed/oversized/truncated frames,
stale epochs, competing listeners, timeout and restart. The shared package's
source-only suite passes 680 tests in 54 files; an earlier default invocation
selected both source and generated dist tests and is not double-counted.
Shared build, scoped lint and strict Rust Clippy pass.

Candidate binary validation encountered `LNK1318` followed by an explicit
disk-full error on D:. Only the identified failed task incremental cache is
removed; the retry reuses dependencies, disables this build's incremental
output and directs PDB data to session scratch with a larger page size. No
user data or another task's cache is deleted. Real CLI/ownership acceptance
is recorded once the rebuilt binary passes; it remains pending until then.
Native execution fencing, durable transfer and later milestones remain open.

The recovered Host build succeeds with the documented PDB override. The real
owner-discovery CLI passes eight checks, including both counterfeit-peer
directions, default-off behavior, junction aliases, stale epoch and pipe-name
collision before database mutation. Fourteen owned test processes close.
Final candidate binary SHA-256:
`e26511096476e2374d938188f8527ebee0bc5b2cc55269e59fbbc681024086d9`.
The data-directory ownership compatibility regression is checked separately.
No full Rust rerun is claimed for this slice; the new native/contract tests,
strict all-target Clippy, shared source suite and real process paths are the
targeted gates. Current-user discovery does not close S03b execution handoff.
The existing real-process data-directory-owner compatibility suite also passes
all seven checks with confirmed cleanup on this candidate. S03b-1 discovery
is ready for the next dependent implementation slice; exact committed-candidate
evidence is retained separately.

Committed discovery candidate: `954fbb01c` on base
`fd28eb89866ac513912ed109716e7120cf60f18c`. The
[clean CLI report](ai-command-center-p0-evidence/owner-control-after.json)
passes all eight checks with `dirty:false` and all 14 fixture processes closed.
The [ownership compatibility report](ai-command-center-p0-evidence/owner-control-ownership-compat.json)
retains its seven-check pass from the same executable, before commit.
S03b-1 discovery acceptance is complete on this Windows host. Proceed to the
native execution fence/startup barrier; cross-platform and complete-transfer
acceptance remain explicitly separate.

## S03b-2 native execution fence candidate

Windows opt-in `--execution-fence` now holds a sidecar generation in a Rust-owned
kill-on-close Job. A same-image stateless launcher authenticates and enters the
Job before starting Node, so preloads and detached descendants cannot run before
containment. Private one-use registration checks the exact Host identity, newly
created child and original live coordinator. Strict status/Stop operations retain
native exit and Job-emptiness proof; timeouts never become success. Production
HostProcess/AgentSidecar expose this additive path without changing default app
launch. See [the ADR](../adr/windows-execution-fence.md).

Current local evidence: 3 new native tests plus all 8 discovery/security tests
pass; host-runtime passes 209 tests with 3 pre-existing skips; shared build,
affected TypeScript checks, strict all-target Clippy, formatting and lint pass.
The final precommit process run passes 11 checks, including production stdio
startup/RPC/Stop and original-handle confirmation after launcher, Host and
coordinator crashes. All 19 direct fixture processes close. Shared contract tests
pass 4/4; documentation checks cover 630 pages. Clean candidate evidence follows.

The first new harness run timed out before handshake and could not confirm
cleanup within its short budget; a subsequent process inspection found no
remaining fixture. After aligning the startup budget with existing Host tests,
the old binary correctly fails with missing `executionFence.prepare`, and cleanup
passes. An expanded invocation was interrupted by the outer tool's 60-second
limit, with no completed report; the independent background run is used instead.
The Windows link initially failed with `LNK1180` on the nearly full D: volume.
Builds reuse installed dependencies but now emit executable and PDB on C:. Only
17 verified objects from this failed link (258,862,739 bytes) were hash-checked,
copied to session scratch and removed from D:; other caches remain untouched.

P0-3 must add durable owner/containment records and restricted startup/recovery;
P0-4 must integrate idle admission, resource inventory and successor attachment.
No full Rust suite, minimum-hardware result, other-platform support, complete
handoff or automatic app opt-in is implied by this slice.

S03b-2 is accepted on this Windows host. Clean candidate `8bea4c100` on base
`fd28eb89866ac513912ed109716e7120cf60f18c` passes the
[11-check process acceptance](ai-command-center-p0-evidence/execution-fence-after.json)
with `dirty:false`, all 19 direct fixtures closed and native descendant exit
observations confirmed. The same binary passes all eight
[owner-discovery compatibility checks](ai-command-center-p0-evidence/execution-fence-discovery-compat.json)
with all 14 fixtures closed. Its SHA-256 is
`3fe33175711fdcd92f6c5a86c02fe157c584bdfcba485f6962e4d5a1245f5caf`.
The [old-binary failure](ai-command-center-p0-evidence/execution-fence-before.json)
retains the missing-method baseline and confirmed cleanup. No source changed
during either committed-candidate run. Proceed to S03b-3 durable owner/journal
migration, CAS and guarded bootstrap; the broader product gates remain open.

## S03b-3 durable journal and restricted recovery acceptance

Schema v28 now adds retained owner/generation/transfer/receipt tables with a v27
backup and transactional migration. Named current-user Jobs and native owner/root
identities commit before runtime admission. Ordinary startup performs read-only
inspection before AppState; unfinished transfers, unknown schemas and unproven
native closure block it. Retirement waits until discovery endpoint acquisition.

The explicit existing-profile-only Windows `--owner-handoff` mode implements
private status/claim/recover. Claim atomically retires the source and records the
native target identity with its phase/revision/receipt. Recovery proves source
and any prior claimed target ended before rotating the target/capability. It does
not open AppState, publish readiness or admit execution. Source orchestration is
test-only until P0-4 supplies complete idle inventory and admission closure.

Two repository regressions first failed (pending root admitted after prepare;
generic phase advancement without target identity), then passed after atomic
admission/claim corrections. A real crash run exposed Windows image queries
failing on an exited process whose handle remains retained. A native regression
reproduced this before the fix: exact creation FILETIME plus signalled original
handle now proves exit; live/mismatched/inaccessible identities still refuse.
The fixed targeted Rust set passes 72 tests, including 40 existing database tests.
Strict all-target Clippy, Rust formatting, Biome lint over 187 files and the
630-page documentation check pass. No new full Rust suite is claimed.

The first restricted process run failed conservatively and cleaned all 7 direct
fixtures. The next dirty candidate passes 8 checks with all 50 direct fixtures
closed, original-handle observations, each source phase and target-claimed crash,
no early turn recovery, capability rotation and truncated-input cancellation.
Output-backpressure/coordinator cleanup and clean committed-candidate acceptance
subsequently passed, as recorded below.

The broader Biome `check` invocation also applies import organization and reports
95 errors; the configured `biome lint` gate passes without edits to unrelated
files. Locale verification still reports pre-existing structural mismatches in
`03-runtime/08-error-codes.md` and `06-delivery/04-e2e-test-plan.md`; the RPC
containment/recovery addendum is synchronized. Local base and agent-policy checks
pass. P0-4, P1-P4 and minimum-hardware/external-device acceptance remain open.

The expanded precommit run now passes all 11 checks with 58 direct fixture
processes closed, plus original-handle descendant observations. It also covers
crash before transfer prepare, output backpressure and restricted coordinator
death. An earlier expanded run failed at blocked output and cleaned 51 fixtures;
a focused diagnostic reproduced `HANDOFF_IO_TIMEOUT` followed by an unbounded
global stdout flush on process exit. Independent owned pipe handles remove that
flush; the same probe exits in 8.652 seconds and confirms cleanup. The final
targeted Rust run remains 72/72 after this correction. Precommit binary SHA-256:
`7e3362d0fee8049659521a01ae3441b12ebc89c2ae27512b9ba654b6e5a45ef8`.

Clean candidate `7a03eda09a5521fe2822c0b7a8269fcde6275899`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passes all three sequential suites:

- [Restricted recovery](ai-command-center-p0-evidence/handoff-journal-after.json):
  11 checks, 58 direct fixture processes closed.
- [Discovery compatibility](ai-command-center-p0-evidence/handoff-journal-discovery-compat.json):
  8 checks, 14 direct fixture processes closed.
- [Execution-fence compatibility](ai-command-center-p0-evidence/handoff-journal-fence-compat.json):
  11 checks, 19 direct fixture processes closed.

All reports record `dirty: false`, confirmed cleanup and binary SHA-256
`99dc4e4f69b2ba20832df31bd7fbc605f5a07cd5e3132b085fbecaf928c5444b`.
The reports were copied byte-for-byte and hash-checked. The earlier
[native identity failure](ai-command-center-p0-evidence/handoff-journal-native-before.json)
and [output-backpressure failure](ai-command-center-p0-evidence/handoff-journal-backpressure-before.json)
are retained unchanged with confirmed fixture cleanup. The clean suite exited 0;
no source or binary changed during those runs.

P0-3 is accepted for this Windows development host. These injected durable phases
qualify the production restricted bootstrap, not complete idle Desktop handoff.
P0-4 now owns complete admission/resource inventory, production source transitions,
successor readiness and epoch-aware snapshot reattachment. The two locale baseline
mismatches, minimum-hardware qualification and P1-P4 remain open.

## S03b-4 admission foundation (full idle handoff remains open)

The existing maintenance gate now offers a non-expiring, identity-bound handoff
hold while preserving ordinary 120-second maintenance leases. It validates all
19 resource counts, closes before inspection, and forbids cancellation after
fencing starts. Stale handles, ordinary release and time passage cannot reopen
the held gate. AgentHost and RuntimeService expose owner-derived interactive,
operation, finalization, write and tool counts without a second state store.

Four reproduced plan-admission defects are fixed: waiting on the session lock
was omitted from inventory; a late lock acquisition could claim after closure;
failed pre-launch finalization disappeared from busy counts; and disposal did
not prevent queued claims. A further red regression covers disposal while
`beginTurn` awaits acknowledgement; the resulting turn is now settled before
any sidecar launch. Deferred retry timers now have an owner and cleanup.
Claimed work remains counted through launch/settlement so a busy transfer refuses
without leaving an abandoned running row.

Validation at this checkpoint: AgentHost 90/90; host-runtime 220 passed with
3 existing skips; ordinary maintenance compatibility 7 passed with 5 Unix-socket
tests skipped on Windows. Typecheck and configured 193-file lint pass. The new isolated Windows
`e2e-owner-idle-admission.mjs` passes 4 checks with confirmed cleanup on a dirty
candidate. Its first run correctly refused a new hold while asynchronous queue
inspection remained pending after transcript settlement; the updated harness
waits for actual owner-reported idle, with a bounded deadline. The failure report
is retained, not reclassified. The accepted P0-3 Rust binary is reused because
this slice changes no Rust/build inputs.

The production application is not yet handoff-capable. Remaining P0-4 work:
wire the gate into all Desktop/headless execution owners; report complete live
resource inventory and reject uncontained/unknown families; integrate durable
source prepare/cancel/fencing and successor readiness; reattach clients using
new owner epochs and authoritative snapshots. P1-P4 and external acceptance
remain pending.

The admission foundation is accepted at clean candidate
`4b2517e95346e512c3a895ce841a0086d49f377a`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`. The
[process report](ai-command-center-p0-evidence/idle-admission-after.json) passes
4 checks with `dirty: false` and confirmed cleanup. Its
[1,161 build inputs](ai-command-center-p0-evidence/idle-admission-inputs.json)
have canonical manifest SHA-256
`99149455151f3191a6c0d76bfa98b0d03e5de12c04d3ad05d404c0c2acf7b4b7`;
the bundled candidate SHA-256 is
`7cff90ac1e0c59f8019cef965aef08a765fd25b494346f3d6efa517e3eba5926`.
Rust inputs match the accepted P0-3 binary
`99dc4e4f69b2ba20832df31bd7fbc605f5a07cd5e3132b085fbecaf928c5444b`.
The [initial synchronization failure](ai-command-center-p0-evidence/idle-admission-before.json)
is retained unchanged. Report and manifest copies were verified byte-for-byte.
This closes only the admission foundation; full P0-4 acceptance remains open.

## S03b-4 sidecar quiescence acceptance (A0 complete)

The real Node sidecar now provides strict private `sidecar.handoff`
acquire/status/cancel/seal. Requests bind a transfer, source epoch and revision;
the returned hold identity prevents stale cancellation from reopening another
hold. Ordinary RPC and reverse Host calls close synchronously. Initialization
requests and acknowledged background executions stay counted through their real
completion. Runtime counts include children despite parent cancellation, tools,
pending input/plan decisions and settlement. Native initialization, trusted
extensions and unconfirmed retirement/replacement conservatively refuse transfer.
Reverse-RPC timeout keeps a lifetime unconfirmed marker rather than treating
local promise rejection as closure proof. The coordinator consumer validates
identity, all counters and operation state, and reconciles by status without
automatically replaying a lost request.

The runtime/sidecar/proxy/event-coalescing set passes 399 tests;
consumer/fence/exit compatibility passes 23; shared sidecar/discovery contracts
pass 4. Source typecheck and configured 205-file lint pass.
Real contained production sidecar acceptance passes 5 checks on the dirty
candidate, with one deterministic local provider request and confirmed cleanup.
The initial process run failed before scenarios because the test bundle banner
collided with an esbuild helper; its report records confirmed cleanup. A subsequent
helper edit failed at syntax parsing before processes started. The corrected
helper and harness pass syntax checks. The clean committed-candidate run below
subsequently closes this prerequisite.

Remaining P0-4 work is unchanged: complete coordinator/Host resource admission,
durable source orchestration, successor readiness and client epoch/snapshot
reattachment. No full application transfer or platform/capacity acceptance is
claimed by this sidecar slice.

Clean candidate `0d8e7f6090427bf85989296bf7212f145a2e2f86`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passes the
[five process checks](ai-command-center-p0-evidence/sidecar-handoff-after.json)
with `dirty: false`, one local fixture provider request and confirmed cleanup.
The [3,533 build inputs](ai-command-center-p0-evidence/sidecar-handoff-inputs.json)
have canonical manifest SHA-256
`afc3ceec8ffaf944e240f6e0964812495d758cb9efb70829273e7fbf8167a517`;
the real sidecar bundle SHA-256 is
`885be0509e836a671751c1f5a50d9c04d5abab6fcfe643241a1fddd30ea43520`.
The native binary remains
`99dc4e4f69b2ba20832df31bd7fbc605f5a07cd5e3132b085fbecaf928c5444b`;
Rust/build inputs are unchanged from its accepted P0-3 candidate.
The [initial startup failure](ai-command-center-p0-evidence/sidecar-handoff-before.json)
is retained unchanged. All three archived files were verified byte-for-byte.
A0 is complete; proceed to H0 executable handoff contracts and the H1-H4
integration lanes. Full P0-4 remains open.

## H0 executable contracts and restricted consumer acceptance

Shared schemas now bind source intent, durable v28 records, internal original-
coordinator inventory exchanges and target readiness. They preserve exact u64
FILETIME, canonical identities, signed-safe revisions, UTF-8 byte caps and strict
unknown-field refusal. The 19-count inventory type is shared with the existing
maintenance gate. Source intent cannot supply idle/process proof or an arbitrary
phase; advisory preflight cannot grant readiness. The ready snapshot must match
the committed ready record. These schemas do not register source/ready operations.

`OwnerHandoffProcess` and its fixed-buffer serialized channel consume the existing
Rust restricted status/claim/recover service. Transport timeout/frame corruption
or identity mismatch poisons the channel without retry; known Rust refusal is a
typed response. Cleanup targets only the created child. Two new red lifecycle
regressions now pass: final stdout is consumed after process exit, and failed
spawn cleans without inventing exit confirmation. The same record/command fixture
passes Rust parsing and identity validation. Production source transitions,
coordinator transport wiring and target ready publication still belong to H1-H4.

At this checkpoint the shared source suite passes 693 tests, AgentHost passes
90 and the targeted Rust owner-handoff set passes 22. The real Node-to-Rust
consumer fixture passes four checks with five restricted children cleaned on a
dirty candidate. A broad host-runtime run exposed a Node strip-only compatibility
regression from the earlier proxy parameter-property syntax; it is replaced by
an equivalent ordinary field assignment, and the real-child regression plus
proxy tests pass. The same broad run hit unrelated large-filesystem fixture
timeouts; the focused 15-second-budget retry passed, with each case taking about
three seconds. The final full-suite run and clean process acceptance are recorded
after completion, without reclassifying those failed runs. Shared build, source
typecheck, configured lint, Rust formatting and documentation checks pass.

The final host-runtime run passes 235 tests with 3 existing skips across 36
source test files, using two workers and the unchanged default test deadline.
The eight focused retry tests are not added again to that count. H0 source and
readiness schemas remain integration contracts; only the existing restricted
bootstrap has a live consumer in this slice. Clean-candidate acceptance below
closes H0; H1-H5 application integration remains open.

Clean candidate `bf5c042b7b997d02ca9572343976aa64e3e55145`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passes the
[restricted client suite](ai-command-center-p0-evidence/owner-contract-client-after.json)
(four checks, five restricted children) and
[sidecar compatibility suite](ai-command-center-p0-evidence/owner-contract-sidecar-after.json)
(five checks, one deterministic local provider request). Both record `dirty: false`
and confirmed cleanup. The [775 consumer inputs](ai-command-center-p0-evidence/owner-contract-client-inputs.json)
and [3,827 sidecar inputs](ai-command-center-p0-evidence/owner-contract-sidecar-inputs.json)
are archived byte-for-byte. Their canonical manifest digests are respectively
`92e16413349ba06daa342b9be8c32a0a05048e2abee1de341b75a8736b92baf5`
and `e06f529b3ece65673ff8a4c778b951278fbfb5c3e6e452182eece0febd1e2eb4`.
The native binary remains `99dc4e4f69b2ba20832df31bd7fbc605f5a07cd5e3132b085fbecaf928c5444b`;
only a Rust test fixture changed, and that newly compiled test passed with the
21 existing owner-handoff tests. Strict all-target Clippy also passes.
Proceed to H1 coordinator/resource wiring and H2-H4 integration; neither schema
acceptance nor restricted claim is full Desktop transfer/readiness acceptance.

## H1 coordinator and scheduler checkpoint (integration pending)

The process-local coordinator now binds admission to the original Host and
sidecar, reconciles ambiguous sidecar replies through status, and requires the
original Rust journal to authorize cancellation or fencing. It retains closed
admission after uncertain effects and rejects replaced owners and generations.
The scheduler accepts the same admission gate and counts pending polls and every
dispatch until acknowledgement, including dispatches belonging to an older Host.
The execution-fence state schema uses explicit literals to preserve its inferred
TypeScript union without changing the wire contract.

The targeted coordinator/fence tests pass 18 cases, scheduler tests pass 13, and
the explicit coordinator source typecheck passes. These are module-level checks;
Desktop composition, complete resource inventory, source journal transport and
real-process coordinator acceptance remain pending. H1 is not accepted, and no
production transfer entry point or target readiness is enabled by this checkpoint.
Continue with the shared Desktop admission owner, IPC and AgentHost wiring,
scheduler integration, plan/restart races and resource-owner inventory.

## H1 Desktop admission and lifecycle checkpoint

Desktop now owns one shared admission object for local IPC (including internal
and event-bearing invokes), AgentHost, scheduling, boot and restart setup.
Pending work remains counted until its original async operation settles.
Remote routing remains ahead of local admission; only quit and authenticated
lifecycle dialogs bypass closure. Confirmed shutdown closes admission, while
cancelled confirmation leaves it usable. Restart closure prevents follow-up
execution and readiness; normal rebind, locale and plan-drain behavior is covered.

The seven focused Desktop files pass 43 tests, including actual bridge/router/
scheduler/lifecycle composition and existing quit persistence cases. The shared
supervisor passes nine tests; two new shutdown-during-start/follow-up failures
were reproduced before correction. The earlier partial lifecycle edit is repaired.
Full Desktop source typechecking with the provisioned Pi 1.4.0 declarations passes.
It exposed a production-only missing upstream AgentMessage augmentation: an
explicit type-only import fixes it, with byte-identical JavaScript emission when
comments are removed. Configured lint covers 227 files and passes.

This checkpoint preceded the plan lifecycle slice below. Complete H1 resource
inventory, bounded original-owner journal transport and native/coordinator
integration remain pending. Default transfer remains unavailable.

## H1 Desktop plan lifecycle checkpoint

Approved-plan dispatch and finalization now live in one owner-aware module,
reusing the existing execution maps, session lock and turn finalizer. Admission
counts lock waits and setup; owned retries stop on disposal. Original Host,
sidecar and bridge references survive awaits and cleanup. A late begin-turn
reply is closed on its original Host without publishing a new active turn;
an execution interrupted during setup cannot resume afterward. Launch resolution
also guards Host reads and awaited catalog/MCP/plugin setup against replacement.

Lost mutation replies and unconfirmed turn cleanup remain busy after local
execution completion or disposal. Terminal-write retries retain the original
Host and first outcome; no claim, turn creation or execution is replayed.
Application shutdown owns dispatcher disposal after confirmation, while cancelled
confirmation and unsaved todos preserve it.

Validation: 105 tests pass across 17 focused Desktop files, including 24 plan
dispatch cases, six launch-owner races and existing user paths. Seven original
dispatch races, six launch-owner failures and the setup-abort race were observed
before their corrections. Full Desktop source typecheck and configured Biome
lint pass. Production Rust is unchanged; no new full Rust suite was run.

`scripts/e2e-desktop-plan-handoff.mjs` passes four development-run checks through
the real Rust Host, production Desktop plan/launch modules and a deterministic
contained sidecar. It confirms extension registry isolation, original native
closure and durable outcomes after reopen. The first development run retained
three passing checks but failed because the fixture omitted the SubmitPlan
history message; it also exposed the need for explicit Rust global capability
directory isolation. Both are corrected in the fixture, and its failed report
is retained. Clean committed-candidate evidence is recorded separately below.

The first clean `b2902ac2962e` run failed in plan approval with `database is
locked`; its submitted message exists, its proposal remains pending and its
turn remains running. Cleanup was confirmed. The fixture prepared user work
without confirming registration: `createFenced` returns the launcher, whereas
Desktop waits for a configuration response. Registration could therefore
overlap approval; the exact conflicting write is not yet established. The fixture
now waits for its first response and verifies native `running` state before
preparing a proposal, with no mutation retry. This qualifies the ready-owner
path only. Concurrent registration/journal writes versus deferred plan-approval
transactions remain an explicit H1 integration investigation before full
handoff acceptance; changing the fixture is not a production SQLite fix.

This completes the plan lifecycle implementation slice, not H1 acceptance.
Next: inventory all actual resource families, compose the coordinator with
bounded original-source journal operations, and validate the complete process
path before joining H2-H5. Loaded or unconfirmed resources must still refuse
idle transfer; absent counters cannot be filled with zero.

### Clean plan lifecycle candidate evidence

Production implementation: `b2902ac2962eccd6c71d701bb89b7da94467820d`.
Test readiness correction and tested candidate:
`de9a8f7d921076775295fd64b8f275ceedc2692b`, with base
`fd28eb89866ac513912ed109716e7120cf60f18c`. The workspace was clean during the
four-check process run; extension registries were isolated, native registration
was confirmed before user work, and all owned native processes were confirmed
closed. This accepts the ready-owner plan lifecycle slice only.

- [Clean process report](ai-command-center-p0-evidence/desktop-plan-after.json):
  SHA-256 `ee034c36f745d452606661536a670cdf36a5b63f6c91be7661cb3c860a62fccd`.
- [Build inputs](ai-command-center-p0-evidence/desktop-plan-build-inputs.json):
  3,232 inputs; normalized manifest digest
  `19b9af6830506cd7a7b926ad8dea440902c427da1004c26609e1b011bdf9b9aa`;
  archived file SHA-256
  `b7e10c7ef9d0bc6fb3d8ccc55cd060723f43c10d549f7a8d15a0987bf04ed9ff`.
- Candidate bundle SHA-256:
  `42cdf42b2a3864dfd8ecca99fcdb9914f30317e1302dbda5daa6e6790def6400`.
- Unchanged Rust binary SHA-256:
  `99dc4e4f69b2ba20832df31bd7fbc605f5a07cd5e3132b085fbecaf928c5444b`.
- Retained failures: [missing fixture history and capability isolation](ai-command-center-p0-evidence/desktop-plan-before-history.json)
  and [approval before confirmed registration readiness](ai-command-center-p0-evidence/desktop-plan-before-registration.json).
  Both confirmed cleanup; neither is counted as passing acceptance.

The 105 focused tests, complete Desktop source typecheck, Biome check (234 files),
architecture check, agent-policy check, main-ancestry check and documentation
link check (631 pages) passed. The locale check still reports the existing
Chinese source-notice mismatches for runtime error codes and the E2E plan.
No live Desktop probe, external provider, new full Rust suite or minimum-hardware
qualification was run. H1 remains open, including the observed pre-readiness
SQLite contention investigation and complete resource/native integration.
