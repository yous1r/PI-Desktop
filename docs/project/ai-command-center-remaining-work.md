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
qualification was run for this candidate. The subsequent SQLite correction is
recorded below; complete H1 resource/native integration remains open.

### SQLite approval contention correction

Implementation and clean process candidate:
`0e44d092e8d9c5a30e4f680ed863572297cae6f9`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`.

Two real WAL connections reproduced immediate `SQLITE_BUSY` in lazy expiry and
the approval transaction after expiry committed. Both read before upgrading a
deferred transaction. They now acquire an immediate transaction first, then
evaluate the current deadline. The existing busy budget, approval CAS, immutable
artifact validation, permission choice, audit atomicity and duplicate-result
semantics remain; no mutation retry or timeout increase was added.

- Three valid contention regressions failed on the previous production source.
  A fourth baseline failure was a fixture assertion that expected `ask` instead
  of the existing `inherit` default; it is retained but is not product evidence.
- Final Rust selection: 24 Plan/Goal tests (five new contention cases), plus 22
  ownership-journal/recovery tests, all passing. The selection is not a full
  Rust-suite result. Format, strict all-target Clippy, production build, policy
  sync, main ancestry and the 631-page documentation check passed.
- Clean `desktop-plan-FLdqbM`: four process checks passed, isolated extension
  registries and native readiness confirmed, all owned processes confirmed
  closed. Independent reopen preserved completed/interrupted execution outcomes.
- Native binary SHA-256:
  `2736fc03e23862cbeac334e35aa5bf5c4793dd743a1d2da5df12ceaffd33d036`.
  The 219 Rust/build input hashes were unchanged across build and acceptance.
  The Node bundle/input manifest matches the prior accepted plan fixture.

Evidence: [verification and hashes](ai-command-center-p0-evidence/approval-contention-verification.json),
[clean process report](ai-command-center-p0-evidence/approval-contention-after.json),
[Rust inputs](ai-command-center-p0-evidence/approval-contention-rust-inputs.json),
[baseline failures](ai-command-center-p0-evidence/approval-contention-before.log),
and [final regressions](ai-command-center-p0-evidence/approval-contention-tests.log).
The earlier pre-readiness process failure did not capture the exact failing RPC
or competing writer; deterministic service tests establish the failure mechanism,
while this ready-owner process run establishes compatibility. Full H1 acceptance
still requires actual resource inventory, coordinator/source transport and native
integration. No live Desktop/provider or minimum-hardware qualification ran.

### H1 user MCP resource activity checkpoint

Implementation and clean candidate:
`91391c342097ba328bbea6ea4b43041db4de3de6`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`.

User MCP discovery, connection tests, tool calls and status probes share the
Desktop gate. Counts survive OAuth/handshake waits, invalidation, cancellation,
parallel setup failure and disposal until original operations finish. Delayed
setup checks current records and admission; tool dispatch checks the exact cached
client identity. A saturated scalar retains unqualified client-construction
evidence without retaining retired client objects. Ordinary close and timeout
cannot turn those resources into idle proof. Disabled, never initialized records
do not invent live resources. Complete Desktop inventory composition is pending.

- A valid closed-gate baseline admitted work, and a separate valid retired-client
  regression dispatched after invalidation; both are corrected. Initial loader
  failures are environment errors, not regression evidence. Initial activity
  tests also confirmed the new inventory API was absent.
- Final combined regression: 115 passed, zero failed/skipped/cancelled, across
  ten files. This covers 12 handoff cases, existing local stdio/HTTP MCP behavior,
  OAuth/certificates, composer discovery, install refresh, cancellation,
  session-launch binding, Main wiring and confirmed shutdown.
- Full Desktop source typecheck, Biome (236 files), architecture (Main stays
  1115 lines), script syntax, policy sync, main ancestry and documentation
  links (631 pages) passed.
- Clean-candidate run: all 12 handoff cases passed on Windows/Node 24.12.0,
  including the actual stdio tool path and shared admission refusal. The
  original fixture child emitted `close`, its temporary directory was removed,
  and the worktree remained clean. This observation does not qualify arbitrary
  MCP process-family closure; refusal evidence deliberately remains.

Evidence: [candidate report](ai-command-center-p0-evidence/user-mcp-handoff-after.json),
[candidate output](ai-command-center-p0-evidence/user-mcp-handoff-candidate.log),
[combined regressions](ai-command-center-p0-evidence/user-mcp-handoff-regressions.log),
and [retired-client failure](ai-command-center-p0-evidence/user-mcp-handoff-retired-before.log).
No full Electron transfer, live provider, external MCP service, full Rust suite
or minimum-hardware qualification ran. The older Composer MCP process script
received the required fixture admission dependency and syntax validation; it
was not used as acceptance because its separate dist/provider fixture is outside
this resource-owner slice. Next: remaining actual H1 resource owners and the
coordinator/native/source-status composition, followed by H2-H5 integration.

### H1 workspace terminal activity checkpoint

Implementation and clean candidate:
`761a63383ffaf858ddb070a1cda015e8d34be549`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`.

Terminal router entries share Desktop admission, capture original Host and
remote connection generations, and retain pending binding/create/actions through
window retirement. Local service admission is checked after directory I/O before
native spawn or input. Late creation/attachment cleanup uses the original
connection; explicit reconnect and concurrent replay remain supported. Output
already accepted by a sink remains counted until its original completion.

The window registry retains active retirement and then compacts settled routers
to saturated unqualified-resource counts. Local PTY creation attempts, remote
creation/legacy attachment and unconfirmed cleanup cannot disappear when handles
or windows are removed. Catalog filesystem checks alone remain idle. Counts are
refusal evidence, not capacity or native-family closure certificates.

- Three behavior regressions failed on the prior source: closed entries,
  closure during binding and stale-client input dispatch. They are corrected.
  An intermediate same-owner concurrent-replay regression was also reproduced
  and fixed before acceptance.
- 57 Desktop regressions passed across terminal handoff/routing, workspace
  resolution, protocol, Main wiring and shutdown. Ten shared terminal service
  tests passed, including five new admission/output/uncertainty cases.
- The dirty process run passed both real PTY user paths and observed each
  original PTY exit. The provisioned node-pty 1.1.0 ConPTY cleanup helper also
  emitted `AttachConsole failed`: its process-list request races native close
  and retains a five-second PID fallback. This is recorded as a native cleanup
  limitation, not a process-family closure pass. No dependency/native cleanup
  policy was changed; unqualified-resource refusal remains required.
- Desktop source typecheck, Biome (246 files), architecture, policy sync,
  main ancestry, diff and documentation checks (631 pages) passed. The headless
  RACP terminal contract also passed, preserving authorization, detached replay
  and nonduplicated input.
- On the clean candidate, all 19 handoff regressions and both real PTY user paths
  passed. Both original PTY exits were observed, focused source hashes remained
  unchanged and the worktree stayed clean. Two `AttachConsole failed` diagnostics
  remain; the result is `PASS_WITH_NATIVE_CLEANUP_LIMITATION`, with native-helper
  cleanup and qualified process-family closure explicitly unconfirmed.

Evidence: [candidate report and source identities](ai-command-center-p0-evidence/terminal-handoff-after.json),
[clean regression output](ai-command-center-p0-evidence/terminal-handoff-candidate-regressions.log),
[clean PTY output and native diagnostics](ai-command-center-p0-evidence/terminal-handoff-candidate-process.log),
[prior-source failures](ai-command-center-p0-evidence/terminal-handoff-before.log),
[intermediate replay failure](ai-command-center-p0-evidence/terminal-handoff-concurrent-before.log),
[Desktop regressions](ai-command-center-p0-evidence/terminal-handoff-regressions.log),
[shared service tests](ai-command-center-p0-evidence/terminal-handoff-service.log),
and [RACP contract](ai-command-center-p0-evidence/terminal-handoff-racp.log).
These source identities are not a complete dependency/bundle manifest. Full H1
resource/coordinator/native composition and H2-H5 remain open. No Electron
transfer, live provider, full Rust suite or minimum-hardware qualification ran.
Next: browser/plugin/voice/remote resource ownership and complete inventory.
The shared-service and RACP archived logs remove one trailing blank line each
to satisfy repository whitespace checks; their original scratch logs remain
unchanged. Candidate logs and report are byte-identical copies.

### H1 browser activity checkpoint

BrowserHost now requires the application admission callback and passes an
original-page scope into its Pane and CDP owners. `BrowserActivity` retains
original operations independently of page maps, and `BrowserPageOperations`
owns caller deadlines, viewport execution and screenshot output. BrowserHost
shrinks from 657 to 605 lines. `createBrowserSessionServices` binds session roots,
worktree lookup and link preferences to the original Host object/generation.

Navigation's early commit result does not release the native `loadURL` promise.
CDP timeout does not release the underlying command. Concurrent initialization
joins one binding; later commands and element uids cannot use a replacement
binding. An old timeout cannot detach a new connection on the same WebContents.
Queued captures recheck admission, and late results cannot create screenshot
files after closure. Background console/link failures are observed. Temporary
guest disposal permits plugin reload, while permanent disposal seals entry.

The inventory exposes operations, pages and a saturating count of unqualified
WebContents/backing-window/watcher/external-launch attempts. Ordinary destruction,
failure, timeout or cache removal never supplies native-family closure proof.
Retired owners remain only while their original work needs them; historical
refusal evidence is scalar. Full nineteen-family composition and H1 transfer
acceptance remain open.

Validation before the fixed candidate: 133 Desktop tests passed across 16 files,
including 29 new ownership/session races, 80 browser compatibility cases and
24 main-wiring/plugin/quit checks. Full Desktop plus browser fixture types,
Biome (268 files), architecture, agent-policy, source syntax, diff whitespace,
631 documentation pages and latest-main ancestry passed. Three prior-source
behavior failures established admission/late navigation/retired CDP dispatch;
additional valid failures covered stale deadline cleanup and old native UIDs.

The isolated Electron preflight passed four steps with real visible-page
screenshots, background input, pending evaluation and persistent handoff refusal.
Two original WebContents, all fixture windows and the original Electron child
were observed closed. This is not native-family closure qualification. A prior
fixture could not find Electron at a hard-coded worktree path; package resolution
now reuses the provisioned Electron binary without installation.

**Retained existing defect:** never-presented background screenshots time out at
30 seconds on both committed `2d489098fb9cf25ec5cf725e37cc968502be47df`
and changed code under Windows/Electron 43.6.0. The committed baseline's layout
query completed before `Page.captureScreenshot` stalled. Adding a main window
alone did not resolve it. The four-step acceptance uses a visible screenshot
before background input and makes no claim to close this defect. Full browser
qualification must revisit it; this slice does not increase the deadline or
change native settings.

Next: archive the fixed-candidate browser evidence, then continue plugin, voice
and remote resource owners before complete H1 composition and H2-H5 transfer.

Fixed browser candidate `63b1554bf70800a77f5e68f374ed66e5873998e1`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passed the four-step isolated
Electron run `browser-handoff-sEFRUa` with `dirty:false`, `endedDirty:false`
and unchanged inputs. The source manifest contains 790 inputs, normalized SHA-256
`93781e6d65707e34fe36147ab9e7c08cbd2cc7bf1480e706124c8cf7d6d16853`;
the bundle SHA-256 is
`530a3193bdf547331047825e68571bbc67ab0b76953cf880a2f48408dba9e83c`.
Provisioned Electron 43.6.0 executable SHA-256 is
`9e1b3c401c1a1988942d5684fede8040d089b0c496ab86b899415ba9bfa0e49c`.
Final activity was zero operations/pages with seven retained unqualified
resource attempts. Both original WebContents, all fixture windows and the
original Electron child closed; `qualifiedNativeFamilyClosure:false` remains.

The [candidate report](ai-command-center-p0-evidence/browser-handoff-after.json),
[source manifest](ai-command-center-p0-evidence/browser-handoff-build-inputs.json),
[native output](ai-command-center-p0-evidence/browser-handoff-process.log),
[regressions](ai-command-center-p0-evidence/browser-handoff-regressions.log),
[failure baselines](ai-command-center-p0-evidence/browser-handoff-before.json)
and [verification scope](ai-command-center-p0-evidence/browser-handoff-verification.json)
retain the evidence. Candidate report/manifest and test log are byte-identical
copies. The native log follows Git's CRLF-to-LF normalization (622 to 621 bytes);
the verification JSON preserves its exact original text and both hashes. Failure
logs are also preserved as exact JSON strings. Final lint covered 270 files
after including the native harness. No Rust rerun, live-profile operation,
full Desktop transfer or hardware qualification is claimed.

Browser admission/activity is accepted within this scope. Remaining H1 work
continues with plugin, voice and remote owners, mandatory nineteen-family
composition, bounded Rust status transport and native/coordinator integration.
The background-capture defect and native-family closure limits remain explicit
qualification work.

### H1 plugin lifecycle checkpoint

`PluginLifecycle` and `loadPluginFromPath` extract original-load ownership from
the plugin runtime. The application passes its required shared admission callback;
standalone test embeddings declare their admission explicitly. Load identities
are invalidated by unload, replacement and permanent shutdown. Late native
handles are cleaned before initialization, and old cleanup cannot delete newer
registrations. Service startup rechecks ownership between stages; restart records
are instance-bound so a superseded failure cannot overwrite new service state.

Concurrent cleanup, including the pre-load panel cleanup, joins its original
promise. Shutdown seals admission and marks children synchronously; expiry of
the existing three-second caller budget does not erase unfinished work. The
lifecycle inventory retains original operations, loaded entries, timers and
saturating unqualified process-attempt evidence. This is an intermediate plugin
inventory, not the complete nineteen-family adapter or native closure proof.

Validation includes eighteen deterministic lifecycle cases and an isolated
two-path real Node plugin runner fixture. The native paths exercise empty hold
and cancellation, service start, command invocation, unload/reload, permanent
shutdown and late process return; all three original child exits were observed
in preflight. Native-family closure remains unqualified. Existing permissions,
tool invocation, extension owner, workspace, UI-slot and service tests cover the
preserved user paths. Full Desktop source types, lint, architecture and policy
checks pass. The final candidate and exact totals are recorded after commit.

Verification-environment repairs are limited to explicit test admission, current
i18n/live-voice source aliases, one Windows file-URL registration and a
platform-specific existing filesystem refusal assertion. Committed `61873c591`
reproduced the same `INVALID_ARGUMENT` versus `NOT_FOUND` difference. Using the
task's canonical temporary path avoids unrelated `ADMINI~1` versus
`Administrator` comparisons. Four ConPTY `AttachConsole failed` diagnostics in
workspace compatibility tests preserve the previously recorded native cleanup
limitation; their assertions pass without changing the dependency or policy.

Next: finish plugin callback, MCP, workspace and retired-owner accounting, then
voice/remote owners, nineteen-family aggregation and native/coordinator/source
transport integration. H1 and the overall command-center plan remain open.

Fixed lifecycle candidate `bb782f73a1fa87054a46a45049b2eb89d5b63f09`, based
on `fd28eb89866ac513912ed109716e7120cf60f18c`, passed all eighteen lifecycle
regressions and both real-process paths on Windows/Node 24.12.0. Before/after
worktree state was clean and fourteen focused source hashes were unchanged;
this is not a full bundled-input or dependency manifest. All three original
children exited. Final lifecycle activity had zero operations/plugins/timers
and retained unqualified native-attempt counts of two and one. Status remains
`PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The compatibility runs cover 297 unique passing assertions and two skipped
actual-Git-plugin cases requiring `PI_GIT_PLUGIN_PATH`. Counts are not summed
across overlapping reruns: final group A passed 121, group B passed 175 with two
skips, and the final focused 42-case run adds one synchronous-shutdown case and
rechecks the other affected cases. The clean 18-case candidate run overlaps
that coverage. The native two-path fixture is reported separately. Final
checks passed full Desktop source types, Biome 274 files, architecture,
agent-policy, 631 documentation pages, diff whitespace and current-main ancestry.
The plugin runtime shrank from 7038 to 6967 lines; new loading/lifecycle modules
are 96 and 85 lines respectively.

The [candidate report](ai-command-center-p0-evidence/plugin-lifecycle-after.json)
and [verification, baselines and raw logs](ai-command-center-p0-evidence/plugin-lifecycle-verification.json)
preserve exact output and scope. The candidate report SHA-256 is
`9150ce0da1308bd27adfbdd1e6f84c0bbd535903613274f393b2e11c45ac0bb3`;
the verification archive SHA-256 is
`e04bc373b9b659b1243e1d0ddc6f824ad6e7067fe01a2c69510b6dce1c997cf8`.
Raw logs are exact JSON strings, so Git text normalization cannot change their
embedded newline provenance. No Rust/full-repository rerun, utility-process
closure qualification, live-profile operation or full transfer is claimed.

Plugin lifecycle admission is accepted within this scope. Plugin callback,
MCP/workspace and retired-owner aggregation remains the next H1 implementation
slice; the broader command-center plan continues.

### H1 plugin callback, MCP and workspace ownership checkpoint

`plugin-process-calls.ts` and `plugin-mcp-registration.ts` extract request and
MCP registration responsibilities. Ordinary panel/child callbacks, command/tool
dispatch and event broadcasts respect shared admission. Original installation,
parent-call and tool authorization are rechecked after workspace awaits; active
teardown hooks preserve their existing permission scope. An aborted tool caller
does not erase its continuing host callback. Child error replies remain known
results, while cancellation, timeout and transport loss retain bounded refusal
evidence even after late replies.

Workspace creation/context lookup and cleanup retain original promises after
retirement. Late child handles are stopped before init; an old exit cannot delete
a new pending registration. Unfinished retired startups retain the existing
64-instance limit. Managed connection configuration captures the existing
lifecycle generation across storage queues; original storage/network activity
survives unload. MCP discovery rechecks settings/handshake/publication/sibling
boundaries. Optional host-only MCP hooks count actual transport sends and HTTP
body reads beyond caller cancellation, with default behavior unchanged for
other embeddings. No Plugin SDK wire or persistence format changes.

Twenty-two new deterministic tests cover these paths. Twenty behavior failures
were reproduced before their corrections; two additional boundary tests cover
known-result versus timeout uncertainty and retained instance limits. The initial
process-call extraction passed 45 compatibility tests before admission changes.
Final validation covers 387 unique passing regression/compatibility test names,
plus two shared workspace-MCP tests, three isolated real-plugin-process paths
and one connection settings UI path. Overlapping groups and candidate reruns
are not added to that total. Two actual-Git-plugin cases remain skipped because
`PI_GIT_PLUGIN_PATH` was not provided.

Four original Node children exited across the three process paths. Cancellation
and original child exit left the paused host callback counted until it settled.
Native-family closure remains unqualified. Four existing ConPTY helper
`AttachConsole failed` diagnostics remain visible in workspace compatibility.
The connection UI fixture needed installed-package resolution and a presented
window for its focus/animation-frame actions; the prior module-resolution failure
and hidden-window timeout are retained as fixture/environment failures. Three
source-location assertions were updated for the MCP extraction. The shared test
initially used a missing package-local Vitest executable; the provisioned root
executable then ran both tests successfully without installation.

Full Desktop source types, Biome 281 files, architecture, agent-policy, current
main ancestry, whitespace and 631 documentation pages pass. The runtime shrank
from 6967 to 6833 lines. Clean-candidate provenance is recorded after the code
commit. No Rust/full-repository rerun, live provider/profile operation, utility
process/native-family qualification or full transfer is claimed.

Next: complete external plugin resource owners with voice/remote ownership,
mandatory nineteen-family aggregation, original Rust status transport and fenced
Desktop/coordinator composition. H1-H5 and the remaining command-center plan
continue; no transfer endpoint has been enabled by this checkpoint.

Fixed candidate `27f394700e8f963640319125a71eafb924c82c28`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passed all 22 regressions and
three real-plugin-process paths with a clean worktree before and after. Twenty-five
focused changed/direct input hashes were unchanged. All four original Node child
exits were observed; final activity had zero operations/plugins/timers and retained
unqualified-resource counts of two, one and two. The status remains
`PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The [candidate report](ai-command-center-p0-evidence/plugin-callbacks-after.json)
is 6753 bytes, SHA-256
`eab3d6c35a63354b27a1ef2841281f09f52ac21cf10978b42fcf0b6ff91ef6c6`.
The [verification archive](ai-command-center-p0-evidence/plugin-callbacks-verification.json)
is 225751 bytes, SHA-256
`38364eb1e802f4b86e9d42973f01336ce356942f538bcdab1989911f750ee79e`.
Raw logs are preserved as exact JSON strings with byte counts and hashes,
including twenty valid behavior failures, corrected source assertions, fixture
errors and native cleanup limitations. The candidate input list is focused,
not a complete dependency/bundle manifest. This callback/MCP/workspace slice is
accepted within the stated scope; external owners and full H1 composition follow.

### H1 plugin socket and workspace external-resource checkpoint

Plugin WebSocket, workspace port and workspace resource services now require
the shared Desktop admission source. Original entries/leases are rechecked at
async boundaries and immediately before new I/O or publication. Released socket
events cannot reach a replacement plugin; a released pending handshake settles
without waiting for its deadline. Workspace downloads cannot continue from a
late dialog into file creation or application launch after closure. HTTP preview
delivery is extracted into `workspace-resource-server.ts`, preserving scoped
paths, headers, CSP and limits while tracking original reads and response closure.

Retired pending forwards retain the eight-lease budget. Close calls join their
original work, initiate cleanup synchronously and remain counted through actual
settlement. Temporary admission closure pauses periodic checks rather than
stopping an active forward. Port reservation and SSH spawning retain the original
connection generation and lease; optional transport guards recheck after SSH
environment preparation. Remaining SSH transport behavior is unchanged.
Plugin runtime activity includes these service snapshots and refuses a configured
resource service without activity reporting. Ordinary close retains saturated
unqualified-resource evidence; it does not certify native-family closure.

The behavior-preserving HTTP extraction passed 22 compatibility cases. Twenty-two
new regression/boundary cases cover admission, events, retirement, response
ownership, microtask interleavings and timer behavior. Sixteen behavior failures
were reproduced before correction; three initial failures were missing new
interfaces. Two implementation regressions (deferred close initiation and an
active forward closed by a temporary hold) were also caught and corrected.
Final relevant runs contain 107 unique passing test names; overlapping reruns
are not added again. Two actual-Git-plugin cases remain skipped without
`PI_GIT_PLUGIN_PATH`. Three portable SSH transport cases pass; ten existing
script-process cases fail with Windows `ENOENT`, identically reproduced against
committed `7abcc95ad6b8342a519b0386263edaf445e90885`. They are not SSH acceptance.

The new real-process path loads an isolated Node plugin, sends an exact payload
through its SDK and a loopback WebSocket echo server, refuses handoff, closes
admission, runs teardown and observes its original child and peer close. Final
socket activity is zero operations/resources with one retained unqualified
attempt; runtime activity is zero operations/plugins/schedules with two retained
attempts. Existing File Manager and plugin lifecycle process paths also pass.
The status remains `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

Full Desktop source types, Biome 289 files, architecture, agent-policy, current
main ancestry and whitespace checks pass. The first resource test failed before
assertions because it imported absent worktree `dist`; importing current source
restored the existing three cases. No dependency installation, live SSH/provider,
live Desktop/profile, Rust or hardware-qualification run was performed. Clean
candidate and raw-log evidence follow the implementation commit.

Next: remaining panel/view/shortcut, speech/voice, OAuth/user-MCP raw transport,
extension-owner and remote Host owners; then mandatory nineteen-family inventory,
bounded original-Rust status and fenced Desktop/coordinator composition. These
are H1 prerequisites; H2-H5 and the rest of the approved command-center plan
continue without enabling a partial transfer endpoint.

Fixed candidate `beb5dfbaa1871711fbe6c374853d874314a9c9ea`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passed all 22 new cases and the
real-plugin WebSocket path with a clean worktree before and after. Thirty-four
focused changed/direct input hashes were unchanged. The original Node child and
loopback peer closed; retained resource uncertainty remained as specified.
The [candidate report](ai-command-center-p0-evidence/external-resources-after.json)
is 8935 bytes, SHA-256
`950925397d140d7b0b8849ff4a7c568f592473eb691357f0aa8712a05a2c7e78`.
The [verification archive](ai-command-center-p0-evidence/external-resources-verification.json)
is 107788 bytes, SHA-256
`2bfc8ad76d31fc470194f942b16faec39a7764274eed94ad51c8adfda95f04a9`.
Raw logs are retained as exact JSON strings with byte counts and hashes, including
the ten matching committed-source SSH fixture failures and two corrected local
implementation regressions. The focused input list is not a complete dependency
manifest. This socket/workspace-resource slice is accepted within its stated
scope; remaining external owners and full H1 composition continue.

### H1 plugin panel, view and shortcut ownership checkpoint

Panel/view hosts and global shortcut registries now share Desktop admission.
The new `plugin-surface-activity.ts` owns original page/work activity separately
from the live window/view cache. A panel captures the original installation before
serialization and permission waits; closing retires earlier queued opens, and
shutdown seals admission synchronously. Original load promises remain counted
after the existing fifteen-second caller deadline destroys the hidden window.
Panel bridge and view-popup operations retain their original completion. Retiring
pages remain resources until their own destroyed events, even after cache removal.

View reopening, visibility, external links and panel senders recheck the original
installation. Renderer panel/view entrypoints capture it before workspace lookup
and recheck immediately after the await. View disposal removes the original zoom
listener. Temporary admission closure preserves completed load state, so cancelling
a hold does not cause an unnecessary fresh navigation of a retained view.
Shortcut callbacks require the exact current registration; original callback work
remains counted after unregister. Actual service wiring returns the callback
promise, supplies the immutable shared gate and combines surface/shortcut activity
into the existing plugin runtime snapshot. Missing configured statistics refuse
handoff. Native attempts retain saturated uncertainty after ordinary cleanup.

Twenty-three new regression/boundary cases pass. The first run recorded eleven
behavioral failures and five missing-interface baselines. Later tests reproduced
two IPC continuation races and one implementation regression that discarded view
readiness while admission was temporarily closed; all were corrected. Four older
source-shape assertions were updated for tracked loads, permission checks and the
shared close helper. The existing shortcut conflict/permission/limit, panel chrome,
view location/scale/navigation/context, plugin lifecycle/callback and shutdown
behavior remains covered by the relevant passing tests.

The new isolated Electron path uses the actual sandbox preload, panel/view hosts,
shared admission and a real Node plugin child. Both local HTML control paths return
exact bridge results; hiding/reopening retains the view; a registry callback runs
the plugin command; busy inspection refuses handoff; closed admission refuses new
page/bridge work; original teardown destroys both pages and exits the child.
Final runtime activity is zero operations/plugins/schedules with six unqualified
resource attempts (panel two, view two, shortcut one, plugin child one).
The status is `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`; the native key-registration
edge is deterministic and does not inject real OS keys.

The first process build failed before startup because the existing bundle helper
did not map two MCP wildcard exports. Explicit current-source mappings fixed it.
A second fixture used a top-level ESM ready await and never entered its probe;
the parent deadline terminated its original Electron child and observed closure.
Registering the ready continuation instead fixed startup. The existing renderer
bounds fixture initially could not resolve hard-coded worktree dependency paths;
it now references provisioned packages and uses an isolated visible window for
animation frames. Its position-only bounds check passes. Failures remain evidence,
not product regressions or successful process runs.

Full Desktop source types, Biome 298 files, architecture, agent policy, current
main ancestry, whitespace and 631 documentation-page checks pass. The initial
successful Electron run was uncommitted; clean-candidate acceptance follows the
implementation commit. No dependency installation, live Desktop/profile/provider,
microphone, real SSH, Rust change, full transfer or hardware qualification occurred.

Next: speech/voice, OAuth/user-MCP raw transport, extension-owner and remote Host
ownership; then complete the nineteen-family inventory, bounded original-Rust
status and fenced Desktop/coordinator composition. H2-H5 and the remaining approved
command-center dependency plan continue after their prerequisites.

Fixed candidate `3a65c0b957e38dad06ade7dae78f79d958fb659f`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passed all 23 new regressions and
four isolated Electron process checks with a clean worktree before and after.
All 33 focused changed/direct inputs and 3065 native-build input hashes remained
unchanged. Final relevant logs contain 211 unique passing test names, excluding
overlapping reruns. The original Electron process and Node plugin child exited;
both pages were destroyed and resource uncertainty remained positive.

The [candidate report](ai-command-center-p0-evidence/plugin-surfaces-after.json)
is 9085 bytes, SHA-256
`b4c3c7f0545edbad6b11b2df5a0092c948165e812aa74f7fed37c3d133836da6`.
The [verification archive](ai-command-center-p0-evidence/plugin-surfaces-verification.json)
is 940887 bytes, SHA-256
`8e46961d962d5b0c9bf728d4eecb1a57fafd9c17aa45d72d84c82169e9034c6a`.
The archive preserves raw logs as exact JSON strings with byte hashes and the
native bundle-input manifest. Focused inputs are not a complete dependency
manifest. This surface/shortcut slice is accepted within its stated scope;
remaining external owners and complete H1 composition continue.

## H1 extension-owner activity checkpoint

The plugin extension-owner broker now requires shared admission and original
Host authority. Its bridge captures the Host object and startup generation at
creation, checks availability and exact launch identity across awaits and caller
continuations, and refuses registration before consuming a stale launch binding.
Ordinary calls stop before lookup when admission is closed. Registration, original
scope queries, plugin dispatch and result validation remain counted after caller
cancellation, timeout or broker disposal. The original request ID and one of the
existing 256 request slots remain reserved until that work settles.

The Desktop sidecar aggregates current and retiring owner bridges, accepted RPCs
and cleanup calls. Empty completed retired records can be compacted; pending or
unknown activity remains visible. Original session disposal cannot close a newer
lifecycle or launch, and a stale idle-retirement query cannot send disposal or a
replacement prompt. Failed session/shutdown cleanup keeps saturated refusal
evidence after late replies and ordinary root exit.

The existing authorized retirement path remains single-use, bounded to two
seconds and subject to live mode, grants, frozen turn identity and cancellation.
The plugin process receives only the existing wire contract. A host-only marker
on the original call permits its active descendants through temporary admission
closure while preserving exact parent/installation checks and permanent shutdown.
Ordinary calls receive no bypass. No public SDK, Rust schema, persistence,
permissions or V3 interface contract changes.

Twenty-six new deterministic regression/boundary cases and six real plugin-process
paths pass, including two new closed-admission retirement paths. The initial 21
cases produced 16 behavioral failures and five missing-statistics baselines.
The real retirement path additionally reproduced `HOST_BUSY` in the plugin send
layer. A later boundary check exposed an ordinary retiring call performing a Host
lookup before rejection; its admission guard now runs before that lookup.
Three old broker assertions reused a cancelled, still-owned request ID; they now
use a fresh request ID to verify stale generation rejection without bypassing the
new original-work reservation.

The existing actual runtime path loads a trusted extension, recalls into a local
HTTP model fixture, advances its turn and retires with the frozen identity. Main
sidecar routing, Plan/Goal writes, grants, last-turn retirement, two-second expiry,
session deletion, plugin unload, file audits and descendant cancellation remain
covered. The related run passes 123 unique tests across eleven files; the final
affected five-file selection passes all 68. Full Desktop source types, Biome 309
files, architecture, agent policy, whitespace and 631 documentation-page checks
pass. All runs so far are pre-commit checks; clean-candidate acceptance follows.

Process fixtures use original child handles and isolated state, and the plugin
child environment is sanitized. Six new sidecar process fixtures confirm their
original roots exiting; six plugin process cases confirm child closure and empty
stderr. Retained uncertainty remains positive where cleanup or native-family
qualification is unknown. These observations are not complete descendant-family
certificates and do not enable an ownership transfer endpoint.

Next: finish other trusted-extension resource owners, user-MCP raw transport and
OAuth, speech/voice and remote Host ownership. Then compose all nineteen families,
bounded original-Rust journal status and the fenced Desktop/coordinator factory.
H2-H5 and the rest of the approved dependency plan remain in progress. No live
Desktop/profile/provider, microphone, real SSH, paid API, dependency installation,
hardware qualification or remote delivery was used for this slice.

Clean candidate `de881ccbf2565cd93fde8ab44840a9719549d73d`, based on
`fd28eb89866ac513912ed109716e7120cf60f18c`, passed the 68-case five-file
selection with zero failures, cancellations or skips. The worktree was clean
before and after; all 1617 tracked source input hashes remained unchanged
(manifest digest `67eedf1b91b1d69c34511226177623d3b30c19a6108492c839d7871f5a12212d`).
This tracked source set is not a complete third-party dependency manifest.
All six instrumented sidecar roots and six plugin children exited, with zero
remaining operations and retained uncertainty where required. Native-family
qualification remains false: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The [candidate report](ai-command-center-p0-evidence/extension-owner-after.json)
is 6666 bytes, SHA-256
`06a1fa01df913fd8e3d67fde9328f52543c22ab598fd5a8ed7f15c61f6a185d9`.
The [verification archive](ai-command-center-p0-evidence/extension-owner-verification.json)
is 407249 bytes, SHA-256
`73ffb2abf13fe1c150ca68920647c95735e9dc48eb848ab944533c855de95bfd`.
It retains twenty exact raw artifacts, their byte hashes, the source manifest and
the 123 unique related passing test names. This owner-call slice is accepted;
other trusted-extension/external owners and complete H1 composition continue.

### Owner-extension Host restart continuation

Integration follow-up found that ordinary Host restart reuses the existing
sidecar. The fixed owner bridge correctly refused implicit replacement authority,
but needed an explicit rebind to admit future owner-extension launches. Four
new actual-sidecar regressions reproduced missing retirement, delayed cancellation
and closed-gate rebinding. This is an integration defect in the preceding slice;
its clean-candidate results remain valid for the tested scope, not restart parity.

Desktop `AgentSidecar.setHost()` now invokes the existing bridge's explicit
rebind before changing its proxy Host. Rebind validates the requested/current
Host, generation, availability and shared admission, revokes old broker
generations and launch authority, and preserves pending original work and request
slots. Individual in-flight queries retain their captured Host/generation.
The same Host/generation is a no-op. Existing retirement markers make the next
idle launch dispose the old runtime; retained old IDs cannot re-register, and a
fresh runtime can register against the new launch. The existing sidecar, locale
restoration, supervisor and plan-drain order remain intact.

Two more boundaries verify pending registration and sessions without owner
extensions. The latter reproduced an overly broad invalidation and was corrected
to select only owner-bearing launches/generations. Six new regression paths and
the relevant six-file suite now pass: 80 tests, zero failures/cancellations/skips.
Full Desktop source types, Biome 309 files, architecture, agent policy and
whitespace checks pass. Clean-candidate validation follows the implementation
commit. This continuation changes no wire protocol, Rust state, permissions or
native-family qualification; complete H1 and remaining resource owners stay open.

Clean restart candidate `2810a403bbda5dbba31e80d4d9587003f892ee83` on
base `fd28eb89866ac513912ed109716e7120cf60f18c` passed all 80 related
tests with zero failures, cancellations or skips. Worktree status stayed clean
and all 1617 tracked source hashes were unchanged (digest
`8b789495e9ee0574a9a38879f710d2d5c6872cd68bc739b6955e5df318f9eab2`).
The result remains `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`; the Host RPC edge is
deterministic, and native-family/complete-transfer qualification is not claimed.

The [restart candidate report](ai-command-center-p0-evidence/extension-owner-rebind-after.json)
is 6226 bytes, SHA-256
`98f6de7815091ef978ed6f6f43cc73e1ab496565ba91553b72a800cd088823df`.
The [restart verification archive](ai-command-center-p0-evidence/extension-owner-rebind-verification.json)
is 368096 bytes, SHA-256
`34e670ed7d3fb79bc66d035e63c85ff3c23eccb858e253cec8d4339894231adf`.
It preserves fifteen exact raw artifacts and the source manifest. Owner-call
activity and ordinary Host restart continuation are now accepted together;
remaining trusted-extension and external-resource integration continues.

### H1 trusted-extension workspace process ownership

The process router now requires the shared admission gate, an original local Host
binding and an observable cleanup reporter. Start/read/write/end and idle checks
retain original operations through cancellation, owner invalidation and cleanup.
Workspace resolution checks the captured caller after every Host await, pins the
remote client before later queries, and preserves resolver revision history.
No command or input is replayed on another Host or connection.

The 64-handle bound and duplicate IDs include retired work. Exact close requests
join before invoking the transport, and a pending startup settles before the
original close is sent. Cleanup acknowledgement is validated; failure remains
observable. Temporary holds preserve valid active processes and suspend polling.
Original cleanup remains available through closure; the saturating native-attempt
evidence survives successful ACKs, logical removal and ordinary root exit.

`SidecarWorkspaceProcesses` retains replaced routers and compacts only settled
retired uncertainty. Actual Desktop sidecar disposal/exit seals the router,
session disposal captures its original handles, and explicit Host rebind retires
old handles while admitting future starts. This corrects the former exit-listener
only cleanup, which did not run during deliberate shared-sidecar disposal.

Thirty new focused cases cover the ownership and lifecycle paths. The initial
twenty-case baseline had nineteen behavioral failures and one missing activity
API; seven subsequent lifecycle cases first exposed missing interfaces. One
capacity fixture reply omitted the required process ID and was corrected without
relaxing the protocol. Baseline teardown produced late assertion rejections after
expected early failures; final fixtures observe those assertions and all final
tests finish without unhandled activity. A temporary edit-range mistake was
corrected before execution and is not a behavioral result.

The related eight-file selection passed 118 tests, with zero failures, cancellations
or skips. The final 33-case focused selection also passed the enhanced real
extension command path: closed shared admission refuses before startup, cancelling
the fixture hold permits literal-argv execution, original output/exit completes,
and retained native uncertainty still refuses handoff. Six actual sidecar children
exit with empty stderr; these are not native-family certificates. Full Desktop
source types and Biome 313 files pass. Clean-candidate acceptance follows the local
implementation commit; no Rust build/full suite or live Desktop/SSH/provider test
is required for this slice. Other trusted-extension, MCP/OAuth, voice and remote
owners, the 19-family H1 composition and H2-H5 remain open.

Clean process-ownership candidate `75ceb6293e9cdb0f43ed3e9b2206b2573dead1d4`
on base `fd28eb89866ac513912ed109716e7120cf60f18c` passed all 118 related
tests with zero failures, cancellations or skips. Worktree status remained clean;
all 1619 tracked source inputs were unchanged, digest
`abc919ad528e076be703513de64253ccdc0d4a1f6b724bb82cce89249977bfe3`.
Seven diagnostic observations confirm six original sidecar exits with empty
stderr and one complete extension-to-process-service user path. All observed
operation/resource counts settled to zero while native refusal evidence remained.
Result: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The [process candidate report](ai-command-center-p0-evidence/extension-processes-after.json)
is 4200 bytes, SHA-256
`6dd696c7e96430b1081d8774f521d0636b8b4c3537bf8915f5a034eff64ba629`.
The [process verification archive](ai-command-center-p0-evidence/extension-processes-verification.json)
is 432350 bytes, SHA-256
`0c3d97c60120e1afcc7c64e34d9aac081a6b0094bd98dfd56b1da10c519cde6b`.
It retains seventeen exact artifacts, input hashes and 118 unique passing test
names. This process-owner slice is accepted within its stated limits; remaining
trusted-extension UI/configuration and other external owners continue.

## H1 trusted-extension UI and Desktop service ownership

The UI/state bridge is separated from extension import generation, preserving its
existing re-export. The 24-test command/import/UI cancellation baseline passed
before and after that behavior-preserving extraction. The bridge now requires the
shared admission gate and explicit sidecar source bindings. Queued prompt tails
and IDs remain counted after caller cancellation; queued publication and renderer
responses recheck the original source. Old-source cleanup cannot clear newer
state. Prompt observer failures are reported without stranding timers or waiters.

`createTrustedExtensionServices` owns the original Host/generation, model and queue
callbacks, UI source and post-await publication. Admitted persistence is not rolled
back or replayed. Unknown dispatch completion retains saturating refusal evidence;
known error replies do not create it. Actual Desktop Sidecar disposal/exit, captured
session cleanup, replacement and explicit Host rebind retain original activity.
No command/tool deadline, SDK wire field, Host protocol or database change occurs.

The focused suite has 43 cases (16 UI, 21 service, six process paths). Initial UI
tests exposed eleven behavioral failures and three missing APIs; the service
baseline exposed seven dispatch-owner failures, eight missing lifecycle APIs and
one obsolete callback/UI interface. Two later observer-reentry tests failed before
activity tracking was added. A first implementation used a nonexistent error-code
constant and an old test assumed a fixed microtask count; these were corrected,
with the latter now waiting for actual prompt publication. Temporary edit-range
mistakes were corrected before execution and are not behavioral results.

The final 12-file compatibility selection passed 160 tests, zero failures,
cancellations or skips. Six new original Sidecar children exited with empty stderr;
their actual reverse-RPC paths cover prompts, model/queue work, caller timeout,
disposal, process exit, service replacement, Host rebind and retained uncertainty.
Host/queue/renderer edges are deterministic; no actual Rust model write or live
Desktop is claimed. Full Desktop source types, Biome 321 files, architecture and
agent-policy checks passed. Clean-candidate acceptance follows the implementation
commit. Native-family closure, remaining MCP/OAuth/voice/remote owners, complete
19-family H1 composition and H2-H5 remain open.

Clean service-ownership candidate `6ebac7e97854187fc91a8d96b40a02fa23e3251f`
on base `fd28eb89866ac513912ed109716e7120cf60f18c` passed all 160 tests with
zero failures, cancellations or skips. Worktree status remained clean; all 1625
source hashes were unchanged, digest
`acf8cd77c96372a1be142beeff071eeca8eba51b75c9202b265d714bb2f0fd4a`.
Six new service-sidecar observations and thirteen related owner/process observations
retain zero final operation counts and explicitly deny native-family qualification.
The malformed-report case intentionally retains refusal evidence after disposal.
Result: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The first clean run passed 159 tests and failed one unchanged npm fixture's raw
temporary-path prefix comparison. A restricted path probe confirmed Windows
normalization reached the same directory. Normalizing only the candidate script's
TEMP/TMP fixed it; product and test inputs remained byte-identical. The report's
diagnostic count was corrected from 13 to 19 to include existing owner tests. Both
runner versions and the failed run are retained, not relabeled as passing.

The [service candidate report](ai-command-center-p0-evidence/extension-services-after.json)
is 7993 bytes, SHA-256
`5eb92e6a9dbe0633cf8b30bb87b36aaf75ec28bbbe27cfd4312ee55278564a20`.
The [service verification archive](ai-command-center-p0-evidence/extension-services-verification.json)
is 566072 bytes, SHA-256
`8f16119bac9b3d12955aa4d8151c9d4b5791a83cd2c196c26fb3d4d2d154c8d0`.
It retains 23 exact artifacts, source hashes and 160 unique passing test names.
This service-owner slice is accepted within its limits. User MCP raw transport,
OAuth, voice and remote owners continue before complete H1 composition.

## H1 user MCP original transport ownership

`UserMcpRuntime` now supplies the shared client's existing transport hooks. The
exact cache entry guards native transport creation and ordinary sends; redirects
recheck after awaited responses. Original sends, HTTP/SSE readers and their
cleanup remain counted independently of JSON-RPC cancellation or early replies.
An async-local cancellation marker permits only the original cancellation send
through closed admission, without allowing a new transport. Cache retirement
precedes close, and factory completion rechecks admission/current configuration.
Existing scopes, timeouts, TLS/redirect credential handling, cache limits and
native-attempt refusal remain unchanged. No shared wire or client API is added.

Seven initial tests failed on the old implementation, covering raw JSON/SSE
retention, cancellation-send accounting, gate/retired-entry redirects, old-client
reconnect and factory retirement. All passed after the fix. An eighth test uses
real loopback HTTP/SSE: the tool result arrives before stream EOF, original reader
activity survives invalidation, and response closure leaves zero logical activity
with positive unqualified-native evidence. The eight-file compatibility selection
passed 123 tests, zero failures/cancellations/skips. Desktop source types, Biome
322 files, architecture, policy and current-main checks passed. Clean-candidate
acceptance follows the implementation commit. OAuth ownership is still pending;
these tests do not establish full H1 or native-family closure.

Clean transport candidate `a98767d1cb9637735263e3bace32d5ca380d271f` on base
`fd28eb89866ac513912ed109716e7120cf60f18c` passed all 123 tests, zero failures,
cancellations or skips. Worktree status stayed clean; all 1626 source inputs were
unchanged, digest
`236b7fcda70b87392327b8c3b3e89d36fce5a46328afa6daed0bebbc8cf7e6e4`.
The loopback observation confirms result-before-EOF, original response closure,
final `mcp: 0`, `uncontainedResources: 1` and `nativeFamilyQualified: false`.
Result: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The [transport candidate report](ai-command-center-p0-evidence/mcp-transport-after.json)
is 2457 bytes, SHA-256
`daef78186f0bd049cdc0c7add871d87aafb5e850a4176e93f323fddc1121dead`.
The [transport verification archive](ai-command-center-p0-evidence/mcp-transport-verification.json)
is 393703 bytes, SHA-256
`9589649fadba932f149e279a6256653a72ba89a89b8c26211da1d1bb65386f36`.
It retains thirteen exact artifacts, source hashes and 123 unique passing names.
Original user-MCP transport ownership is accepted within this scope. OAuth
ownership, voice/remote owners and the remaining H1-H5 composition continue.

## H1 MCP OAuth ownership and cancellation

OAuth protocol helpers, discovery/DCR, token storage, login state and loopback
lifecycle now have separate responsibility boundaries. Existing exports remain;
the 43-test OAuth baseline passed after the initial behavior-preserving extraction.
The manager requires shared admission and an original Host/generation binding.
Original HTTP bodies, discarded-body cleanup, browser launch, callback writes,
post-auth tests, pending binds and listener close callbacks remain observable
after cancellation/disposal. Native attempts and unknown Host completion retain
saturating refusal evidence. Existing TLS/PKCE/state/scope/DCR/refresh contracts
are preserved; no SDK wire, Host protocol, persistence schema or V3 UI changes.

Per-secret queues cover refresh, login writes, deletion and transfer; old refresh
cannot resurrect deleted storage. Admitted writes are neither rolled back nor
replayed. Exact login/record cleanup preserves newer authorities. Configuration
updates and five OAuth-related IPC continuations reject stale owners. Authorized
MCP re-test propagates its original guard, and explicit owner errors cannot become
anonymous client startup. Callback consumption no longer prevents later exchange,
storage, timeout or cancellation settlement. Observer errors cannot skip cleanup.

The new focused suite contains 37 deterministic regressions and one actual HTTP
user path. Initial tests exposed fifteen behavior failures and three missing
activity APIs. Later tests exposed configuration/IPC continuation, anonymous
fallback, reentrant login and post-token re-test races. Two compatibility regressions
(synchronous cancel cleanup and preferred-port fallback) and timeout event
classification were fixed with their failures retained. An early type command used
the wrong scratch path; an initial lint selection covered only the test. Neither
is counted as source validation. Event union typing was corrected before final checks.

The actual path enters registered IPC under shared admission, completes loopback
OAuth/PKCE, re-tests with the real MCP client and invokes a tool. A second login is
cancelled during its token body; both original listeners and the original response
close, prior storage remains unchanged, and final operations/resources are zero
with unqualified-resource evidence 13. Host encrypted storage and browser/renderer
edges are fixture boundaries. Full H1/native-family acceptance is not claimed.

Final compatibility and clean-candidate results follow this implementation slice.
Voice/remote owners, complete 19-family composition, bounded Rust status transport,
fenced Desktop composition and H2-H5 remain pending.

The final twelve-file selection passed 188 tests with no failures, cancellations
or skips. Desktop source types, Biome 335 files, architecture, policy, current-main
ancestry, whitespace and 631 documentation pages passed. The 37 focused cases and
the real HTTP journey are included in that total, not additional unique coverage.
Clean-candidate acceptance follows the implementation commit.

Clean OAuth candidate `b1ded096dd0ffb019c3a7bfbd53c4f4005017e7c` on base
`fd28eb89866ac513912ed109716e7120cf60f18c` passed all 188 tests with no failures,
cancellations or skips. Worktree status stayed clean and all 1634 source inputs
were unchanged, digest
`7d02a9f0c3b695bb8643efcff8b3a456b3e41d4374e78c7ed7d3fc6338922b46`.
The real OAuth journey observed two original listeners closed, the cancelled token
response closed, one successful tool result and final
`{operations: 0, resources: 0, uncontainedResources: 13}`. Native-family qualification
remains false. Result: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The first clean run passed 187 tests and failed an unchanged plugin-MCP fixture's
20ms initialization budget before reaching its long-running tool assertion. The
test, re-export and shared MCP transport source were unchanged from `d4546b0d4`;
the isolated file passed 31 tests. Changing only candidate concurrency from two
to one passed all 188, with every deadline and source hash preserved. Both runners,
the failed report/log/manifest and the isolated result are retained.

The [OAuth candidate report](ai-command-center-p0-evidence/oauth-after.json) is
3023 bytes, SHA-256
`a8c69b6a12257a9a1c9e48d42603567fefb896953827c5f322cc5165a1ddfd7b`.
The [OAuth verification archive](ai-command-center-p0-evidence/oauth-verification.json)
is 959469 bytes, SHA-256
`c37cf38f280909e8788806feecc6bd135ca134b305853f1993002a19745af6ce`.
It retains 28 exact artifacts, source hashes and 188 unique passing test names.
OAuth ownership is accepted within these limits. Speech/voice and remote owners
continue before the remaining H1 integration.

### OAuth response diagnostics follow-up

Three public-path regressions confirmed that JSON parser errors could include a
credential-bearing response fragment in token-exchange events, DCR errors or
refresh logs. OAuth JSON decoding now returns fixed diagnostics and requires an
object before consumers inspect fields. Malformed refresh keeps the original
access-token fallback; cancellation/body ownership remains unchanged.

All 84 OAuth-focused/compatibility tests passed, including the actual HTTP user
path. Desktop types and Biome 335 files passed. The focused ownership suite now
contains 40 cases; clean candidate acceptance follows this bounded security fix.
The earlier 188-test result remains historical evidence, not acceptance of this
additional response-confidentiality requirement.

Clean confidentiality candidate `40f7cb29ff2a258da46865d478f90083a9317dee` on
base `fd28eb89866ac513912ed109716e7120cf60f18c` passed all 191 tests with no
failures/cancellations/skips. The worktree stayed clean, and all 1634 source inputs
were unchanged, digest
`2b5c01ab10a6e6312a9fd3c012ae592a22185a4521b140b389b5246b1ddadb8f`.
The actual HTTP path again closed both original listeners and the cancelled token
response, with final zero operations/resources and native uncertainty 13.
Result: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

The [confidentiality candidate report](ai-command-center-p0-evidence/oauth-json-after.json)
is 3027 bytes, SHA-256
`fb1289ab4f52bed062df3161155ded61db24293407646676a75e0a9c0aee1fbb`.
The [confidentiality verification archive](ai-command-center-p0-evidence/oauth-json-verification.json)
is 414726 bytes, SHA-256
`481e7c407a6044c518720bb3e1d0ea832439521d14a3296477d2e9763617a010`.
It retains thirteen exact artifacts and 191 unique passing test names. This is the
latest accepted OAuth candidate; remaining voice/remote and H1-H5 work is unchanged.

### H1 Speech original ownership checkpoint

Speech status/transcribe/synthesize now require shared Desktop admission and
capture one original Host/generation. Provider/secret lookup, plugin adapter
selection, scratch reads/writes and HTTP continuations cannot adopt replacements.
Adapter identity includes its registration and installation; its original Host
guard survives the pending request into plugin callbacks and workspace checks.
Original teardown/retirement rules and the 60-second adapter deadline remain.

`SpeechActivity` retains original work through disposal, abort-ignoring bodies,
late headers and unused-response cleanup. Confirmed shutdown seals Speech before
awaited teardown. Already-started file writes finish under the original owner
without rollback/replay; stale results cannot publish success. Unknown Host
completion and native HTTP attempts remain saturated refusal evidence. Existing
size caps, protocol behavior, provider origin checks and normal error mapping are
unchanged; shared HTTP ownership hooks are optional and wire contracts unchanged.

The parser extraction passed nine existing compatibility tests before and after
the structural change. Initial ownership tests produced fifteen behavioral reds
and five missing-API failures; a subsequent actual plugin callback test reproduced
one lost-owner-guard failure. The final source run passes 126 Desktop tests in
thirteen files, including 29 focused cases, a real registered-IPC/loopback-HTTP
transcription+synthesis/cancellation path, plugin processes and quit compatibility.
Eight shared adapter tests also pass: 134 unique tests, no failures/cancellations/
skips. The first shared runner selected zero tests because its reused configuration
fixed a different package root; the corrected explicit-root run selected all eight.
Desktop types, Biome (348 files), architecture, agent policy and whitespace pass.

Real HTTP response closure leaves `{operations:0,resources:0,
uncontainedResources:3}` and still refuses handoff. Host RPC and renderer are
fixtures; no actual provider, account, microphone, stored SSH Host, live profile,
dependency install or full transfer was exercised. Clean-commit acceptance is
recorded separately below. Next: Voice/audio/LiveVoice and remote ownership,
then complete nineteen-family H1 composition, bounded Rust status and fenced
Desktop/coordinator integration before H2-H5.

### H1 Speech clean-candidate acceptance

Implementation `adeabcf4f74c4acc14e9948ce30a709f583ec72c` passed 126 Desktop
tests and eight shared adapter tests on a clean worktree against refreshed base
`fd28eb89866ac513912ed109716e7120cf60f18c`. All 1,639 tracked source inputs
remained unchanged (manifest digest
`e58cebe8537c69a7946e459def4049b781cdd9f405b85499a96e369c06040350`).
The [candidate report](ai-command-center-p0-evidence/speech-after.json) records
actual IPC/HTTP/scratch results and the positive uncontained-resource count.
The [verification archive](ai-command-center-p0-evidence/speech-verification.json)
preserves 21 exact logs/runner/input artifacts, failure classification and 134
unique passing test names. Earlier focused runs are overlapping evidence.

Status is `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`. This accepts the Speech
ownership slice only. Continue Voice/audio/LiveVoice and remote ownership before
full H1 composition and H2-H5 transfer acceptance.

### H1 Dictation capture ownership

PvRecorder queues native reads through a timer while release deletes the handle.
The previous cancel path released that handle before the original queued read
returned. Capture now reserves one original recording before lazy import, joins
concurrent/reentrant stop and cancel, waits for the original read before release,
and suppresses cancelled frames. Another capture cannot bypass pending cleanup
or a failed release. Shared Desktop admission is required; temporary holds preserve
admitted recording. Backend disposal seals acquisition and retains original work.
Native attempts remain saturated refusal evidence after ordinary cleanup.

The first 15 cases produced nine behavioral failures and four missing-API failures
on the old implementation (two passed). Follow-up tests caught an introduced
temporary-hold interruption and a throwing cleanup observer that stranded
completion; a replacement-capture test also reproduced premature reacquisition.
All are fixed. The final source run passes 44 unique tests in six files, including
20 focused capture cases, the real controller/engine/model-manager/backend user
path with native boundaries substituted, seven idle-unload cases and existing
download/plugin-audio/wiring compatibility. Types include current Voice sources;
architecture, agent policy and whitespace pass. No real microphone, model download,
provider/account or live Desktop was used.

The user path verifies exact PCM and transcript, two original releases and final
`{operations:0,resources:0,uncontainedResources:2}`; idle handoff still refuses.
This is capture-module acceptance only. Controller/model/download ownership,
VoiceService initialization, confirmed shutdown and microphone lease retention
remain next, followed by LiveVoice/remote owners and full H1 composition. Clean
candidate acceptance is recorded separately.

### H1 Dictation capture clean-candidate acceptance

Implementation `8c8dea7cf7bad082100e40453e8815573a583a22` passed all 44 tests
on a clean worktree against refreshed base
`fd28eb89866ac513912ed109716e7120cf60f18c`. All 1,676 tracked inputs remained
unchanged (manifest digest
`83bd6f831bf806803306d1210763476bb3858e67433e7885fe0c3ea35c001824`).
The [capture report](ai-command-center-p0-evidence/audio-capture-after.json)
records exact PCM, original release and retained uncertainty observations.
The [verification archive](ai-command-center-p0-evidence/audio-capture-verification.json)
preserves 17 exact artifacts and 44 unique passing test names. Status is
`PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`; remaining controller/model/service/lease,
LiveVoice/remote and H1-H5 work is unchanged.

### H1 Dictation controller ownership

Each recording now owns its model preparation, capture, stream, PCM/settings and
abort signal. Original promises stay counted after cancellation/disposal; stale
frames, startup errors, results and cleanup cannot mutate a later recording.
Cancel reaches a capture still starting and cleans late acceptance on that saved
capture again. Concurrent stop joins one transcription. Cancelled stream failure
cannot start fallback, while ordinary fallback uses original PCM/settings.
Cleanup exceptions retain saturated uncertainty and report through Desktop's
existing logger; state-observer exceptions do not strand operation completion.

Initial thirteen cases produced ten behavioral failures and two missing activity
API failures (one compatibility case passed). Two added reentry cases exposed
duplicate cancellation publication and stale done publication during cleanup;
both are fixed through revocation and transition identity checks. The final source
run passes 63 Desktop tests in seven files plus 23 shared controller/PCM tests:
86 unique cases including nineteen focused controller cases and the real internal
controller/engine/model/backend user path with native boundaries substituted.
Selected stream tests substitute only the engine's public stream contract.
Types, Biome (359 files), architecture, agent policy and whitespace pass. The
controller stays below its previous line count; no IPC/SDK wire, persistence,
Rust or V3 UI change is included.

That acceptance covered the controller module only. The following native-runtime
step reproduces and corrects the transcribe-cpp 0.2.2 mismatch: asynchronous
stream creation/feed/finalize and structured final text. Cache mutations,
VoiceService initialization, lease retention and confirmed shutdown remain next.
No real microphone/provider/model download or native-family/full-handoff
qualification was claimed by the controller-only candidate.

### H1 Dictation controller clean-candidate acceptance

Implementation `848586494d5d88b3f86f7951014351ae993596f4` passed all 63
Desktop and 23 shared tests on a clean worktree against refreshed base
`fd28eb89866ac513912ed109716e7120cf60f18c`. All 1,677 tracked source inputs
remained unchanged (manifest digest
`19f8686336e0036d30b9d76ce3b770ec2857097d447ff131d90cfef95c39914d`).
The [controller report](ai-command-center-p0-evidence/voice-controller-after.json)
records the candidate, source identity and original capture user path.
The [verification archive](ai-command-center-p0-evidence/voice-controller-verification.json)
retains 17 exact artifacts and 86 unique passing test names. Status remains
`PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`. Proceed with native model/stream/download
lifetime and VoiceService initialization/lease/confirmed-shutdown ownership before
LiveVoice/remote and the remaining H1-H5 integration.

### H1 Dictation native model and streaming ownership

Native model lifetime now has one owner separate from cache-file management.
Same-model loads coalesce; replacement loads serialize behind original load/use
completion. Unload revokes identity before callbacks, late models are disposed,
and active native computations retain their original model lease. Cleanup failure
is observable and prevents another model acquisition. Engine shutdown seals new
work, propagates cancellation and retains the original promises.

The streaming adapter now matches transcribe-cpp 0.2.2: synchronous session creation,
asynchronous stream/feed/finalize and `stream.text.full`. Feeds copy PCM and are
ordered with a bounded 8 MiB/256-chunk backlog. Stream failure/overflow preserves
batch fallback; cancellation cannot publish stale text. Concurrent finalize joins
once; reset/session disposal follow original compute and retain saturated native
uncertainty. Batch receives linked cancellation and rechecks identity after output
conversion. Public AudioCapture and TranscriptionStream shapes are unchanged.

The initial fourteen tests failed: thirteen behavior/API-contract failures and one
missing activity API. The model-owner extraction preserved twenty existing tests
before behavior changes. Two later reentry tests reproduced stale model-status
publication and ignored cancellation during stream cleanup; both are fixed. Two
new-test assumptions were corrected (linked AbortSignal identity and cancellation
before native initialization), and two older exact-options assertions now also
validate the forwarded signal. A missing current-source loader caused one earlier
compatibility run to fail; the original failure is retained separately.

The final source run passes 87 Desktop tests in eight files and 30 shared tests in
four files: 117 unique cases, including 24 focused native-runtime cases. Real
controller start/frame/stop paths prove streaming success and asynchronous stream
failure with exact-PCM batch fallback using deterministic native boundaries.
Current-source Desktop/Voice type checking passes. Cache download/delete lifetime,
VoiceService initialization/admission/lease/confirmed-shutdown, LiveVoice/remote,
the full nineteen-family inventory and H1-H5 composition remain unfinished.
Ordinary wrapper disposal is not native-family closure; no real microphone, native
model, provider, stored SSH Host, live Desktop/profile or dependency download ran.

### H1 Dictation native-runtime clean-candidate acceptance

Implementation `7fa0961108e17d3939d068319d9b24b4a01c75f8` passed 87 Desktop
and 30 shared tests on a clean worktree against refreshed base
`fd28eb89866ac513912ed109716e7120cf60f18c`. All 1,681 tracked source inputs
remained unchanged (manifest digest
`9f2901fda02e2faf010e86206ac61cb296a15f07ad6e9f5cd2b795d24601d8ad`).
The [native-runtime report](ai-command-center-p0-evidence/voice-native-after.json)
records the tested commit, scope and limits. The
[verification archive](ai-command-center-p0-evidence/voice-native-verification.json)
retains 21 exact artifacts and 117 unique passing test names. Biome (365 files),
architecture, agent policy, refreshed base, whitespace and 631 documentation pages
also pass. Status remains `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`; proceed to
cache download/delete and VoiceService initialization/admission/lease/shutdown
ownership, then LiveVoice/remote and the remaining H1-H5 composition.

### Priority override: pause Voice and continue non-Voice work

The user explicitly paused further Voice development. The unaccepted downloader
WIP was preserved outside the worktree in the current session scratch directory;
all six WIP files were removed/restored only after preservation, returning to
clean accepted commit `d445574fb4f2ac683cf83fa452a9c3162d548987`. Accepted Voice
commits remain intact. Download/delete, VoiceService leases/shutdown and LiveVoice
are deferred, not completed. Continue remote ownership, then the remaining H1-H5,
control/UI and platform dependency graph. Pausing development does not bypass
idle inventory or native-resource safety: active/unknown Voice owners must still
refuse handoff until separately qualified.

### H1 paired-Host SSH tunnel ownership

The tunnel manager now reserves one exact creation/adoption record before
external callbacks, passes its owner guard through asynchronous credential setup,
and retains original readiness, reservation, forward and cleanup work. Close
revokes synchronously, starts original transport disposal before waiting, joins
concurrent/reentrant cleanup and closes late forwards. Overlapping adoption
cannot remove newer records; disposed managers permanently refuse acquisition.
Shared Desktop admission is injected by startup without changing SSH bootstrap
network/cache configuration. Temporary holds preserve already active tunnels.

Authenticated deployment-completion callbacks capture their original record,
coalesce concurrent invocation and recheck identity/admission after the original
command. Retired callbacks cannot invoke a replacement transport. Cleanup failure
is observable even when its observer throws. Bounded native uncertainty remains
after ordinary close/dispose and root exit; this is refusal evidence, not capacity
or a native-family closure certificate.

The eleven initial regressions had ten failures and one pass. The strengthened
concurrent-close test plus six additional races pass: seventeen focused cases.
The final source run also passes forty-nine tunnel/boot/connection/RACP-client/
deployment tests, forty-two pairing/preparation/realignment/supervisor/external-
resource compatibility tests and one actual local process path: 109 unique
passing tests, three existing POSIX process-inspection skips on Windows. The
local path drives paired-Host boot, registry, manager and system transport with
only external SSH/RACP replaced. Both original child processes exit; activity is
`{operations:0, resources:0, uncontainedResources:1}`. No real SSH Host, stored
credential, live Desktop/profile, microphone, provider or dependency installation
was used.

Earlier failures remain recorded: two old tests waited for close before releasing
their deliberately paused original work; two exact forward-options assertions
needed to validate the existing optional owner guard separately. Missing RACP
test-harness/current Pi dependency aliases were runner failures, and the first
local-process attempt lacked its temporary profile directory. These do not count
as additional product regressions or unique coverage. Full remote Host/client/
bootstrap accounting, nineteen-family inventory and native coordinator composition
remain next; Voice stays deferred.

### H1 SSH tunnel clean-candidate acceptance

Implementation `52447f377accc9c971e51e653726f8f62dcc356b` passed 109 unique
tests in twelve files, with three existing POSIX process-inspection skips on
Windows, on a clean worktree against refreshed base
`fd28eb89866ac513912ed109716e7120cf60f18c`. All 1,684 tracked source inputs,
including the private C# process fixture, remained unchanged (manifest digest
`104f84653ba1d2df9002806c85ba285569cc020bc9e6d50825c908dcd2a7a977`).
The [tunnel report](ai-command-center-p0-evidence/ssh-tunnel-after.json) binds
the result to the tested commit; the
[verification archive](ai-command-center-p0-evidence/ssh-tunnel-verification.json)
retains 24 exact artifacts, unique test names and platform skips. Source types,
Biome (371 files), architecture, policy, refreshed base and 631 documentation
pages pass. Status is `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

A subsequent unaccepted Host-boot exploration was preserved outside the worktree
and restored before this clean candidate. Its fixture errors are not product
failure evidence or accepted tests. Continue exact remote client/bootstrap/Host
ownership and H1 composition from this clean result. Voice remains paused;
no inventory or native-closure requirement is waived.

### H1 remote RACP client ownership

Implementation `c7f7e277f` wraps each remote RACP transport in a local ownership
record. Pairing, connect and reconnect are admitted by the shared Desktop
handoff gate before the transport factory runs, and the gate is passed to the
adapter that `remote-hosts.ts` creates for each Host. Each record counts its
operations and resources; close retires it synchronously, and a transport that
arrives after closure is closed before initialization.

Inbound server-request handlers run inside an `AsyncLocalStorage` binding to
their admitting connection. A stale callback can neither send a mutation through
a reopened client nor close the replacement; it is refused with
`HOST_DISCONNECTED`. Reconnect callbacks, backoff timers and sibling recovery
remain counted until they settle. Concurrent and reentrant close join the same
original completion. The RACP protocol, wire format and RPC semantics are
unchanged.

The fifteen-case deterministic suite (`handoff-racp-client.test.mjs`) had one
pass and ten failures against the prior wrapper. Its final run passes fifteen
of fifteen, and the existing compatibility suites pass: 57 of 57 for the RACP
client, remote connection, boot, SSH tunnel, pairing and realignment tests.

### H1 RACP client clean-candidate acceptance

Implementation `c7f7e277f` passed 101 unique tests in eleven files on a clean
worktree, with three existing POSIX process-inspection skips on Windows. All
1,687 tracked source inputs remained unchanged (manifest digest
`c858fa43ef980049aa03addf55f71a18a492f29ad606ac16424a904da8bf9ee2`). The
[client report](ai-command-center-p0-evidence/racp-client-after.json) binds the
result to the tested commit; the
[verification archive](ai-command-center-p0-evidence/racp-client-verification.json)
retains the exact log and input manifest. Status is
`PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.

This acceptance covers the RACP client wrapper only, using the in-memory
transport and real `RacpClient` state machine. It does not contact a real Host,
SSH server, stored credential or device token, and it does not certify
native-family closure of Node, Electron, socket or browser resources. Remote Host
boot accounting, nineteen-family inventory and H1 composition remain next.
Voice stays deferred.
