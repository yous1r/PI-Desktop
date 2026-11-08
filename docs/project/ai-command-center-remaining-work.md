# AI command center: remaining implementation and acceptance

- Basis: [schedule](ai-command-center-schedule.md), [requirements](ai-command-center-requirements.md), [control contracts](ai-command-center-control-contracts.md).
- Status: Incremental execution; no milestone is closed by planning documents alone.
- Current branch starts from the committed runtime/soak/sampling corrections.

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
3. Token-counted mixed main/child/Worker/tool/plugin workload and reference
   hardware. The synthetic 1-MiB main-only soak cannot replace it.
4. Terminal receipt retention/tombstone period and deletion policy. Unresolved
   receipts must remain recoverable; do not assign a purge policy silently.
5. Full Host handoff still needs its concrete control transport, durable phase
   journal and old-sidecar fencing. Current-user background execution and idle
   handoff are the conservative first slice, not Windows service installation
   or implicit interruption/replay of active turns.

## Ordered work and acceptance

| Priority | Step | Implementation status | Required acceptance before completion |
|---|---|---|---|
| 1 | S03a: Rust data-directory ownership | Implemented candidate in this slice | Same-directory and alias contenders fail before recovery; independent directories run; normal/crash exit releases ownership; relocation refuses live destination before mutation; existing history remains readable |
| 2 | S03b: Exclusive execution handoff | Pending | Existing admission gate blocks new work; busy handoff rejects or drains under explicit policy; old sidecar proven stopped/fenced; one successor; crash at every phase leaves recoverable journal; no turn/tool replay |
| 3 | S02/S04: Finalize versioned metadata contract | Draft complete, implementation pending | Stable task vs concrete execution identity; strict request schema; desired/effective goal CAS; retention/deletion policy resolved; golden producer/consumer fixtures |
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
