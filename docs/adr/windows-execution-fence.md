# ADR: Rust-owned Windows sidecar execution fence

- Status: S03b-2 accepted on Windows; S03b-3 durable recovery candidate under validation
- Scope: Native execution containment and durable owner recovery prerequisites
- Context: [Idle handoff](../project/ai-command-center-idle-handoff.md)

## Context

The data-directory lock fences cooperating database writers. Node sidecars can
outlive their coordinator, and observing a single child exit does not prove that
detached descendants ended. Assigning an already executing Node process to a Job
Object leaves a window for preload, plugin initialization and child creation.

## Decision

An explicit Windows `--execution-fence` Host mode captures the original parent
coordinator handle, token SID and creation identity before AppState opens. It
provides private stdio `executionFence.prepare`, `status` and `stop` operations.
The ordinary Host protocol stays at version 11; default launches do not opt in.
The discovery flag may be combined with this mode, but discovery continues to
advertise only its implemented `status` operation.

Prepare creates one native execution generation and a non-inheritable Windows
Job Object with kill-on-close and no breakaway permission. Only one pending or
live generation is admitted. The five-second private registration pipe has a
current-user protected DACL, first-instance ownership, remote-client rejection,
strict bounded frames and a one-use capability. It is bound to the exact live
Host PID/creation identity and thus its data-directory owner lifetime. Schema v28
extends this with a protected named Job, durable profile/owner/generation records,
and a pre-AppState recovery guard. Owner registration precedes execution RPC;
generation registration precedes ticket return; root identity commits before
assignment and acknowledgement. Collision with an existing Job refuses.

The coordinator starts the same Rust executable in stateless internal-runner
mode. Both pipe peers authenticate their kernel process identity and canonical
Host image using the owner-discovery identity code. Rust verifies that the runner
was created after prepare by the captured, still-live coordinator. No API accepts
an arbitrary adoption PID. The original runner handle is retained through cleanup.

Only after assignment to the Job and admission acknowledgement does the runner
start Node with inherited stdio and the selected launch arguments/environment/cwd.
The capability is removed from Node's environment. This places Node preloads,
module initialization and detached children after native containment. The runner
remains alive while Node executes. Host death triggers kill-on-close; coordinator
or runner death triggers native Job termination. Registration failure, timeout
and cancellation never fall back to an ordinary launch.

Stop serializes against assignment, closes registration, terminates the Job and
waits up to 2,000 ms. Confirmation requires the registration/supervision task to
finish, zero active Job members and original root-handle exit when a root was
assigned. A zero budget observes immediately. Pending-empty containment is not
closure proof. Termination errors, inaccessible native state and timeouts remain
errors or unconfirmed results. Stop can be repeated for the same generation;
a replaced generation is stale. No transmitted operation is automatically replayed.

`HostProcess.executionFence` and `AgentSidecar.createFenced` expose this path to
embedding coordinators. `fenceExecution` is separate from ordinary disposal and
single-child `confirmExit`. Existing constructors and default app launches retain
their behavior until durable startup/recovery and full resource inventory exist.

## Consequences

A JavaScript startup barrier permits Node preload effects before registration.
Post-spawn process-tree snapshots cannot close that window or contain detached
future descendants. Rust owning the native launcher keeps the frozen division:
Node executes agents, Rust owns native resources, coordinators retain stdio.

The extra Rust launcher has a small process cost that must be included in later
2-core/8-GB measurements. First registration requires the same canonical Host
binary path. Same-user executable replacement/injection and privileged actors
remain outside the identity boundary. Other process families (plugin/MCP owners,
terminals and external applications) are not implicitly adopted. Full handoff
must inventory and fence every application-owned resource, and must durably prove
previous execution closure before successor recovery. The v28 migration is
additive and retains journals/receipts independently of session deletion. No
service installation or macOS/Linux native recovery support is included.

Across Host lifetimes, recovery opens the recorded Job for query only and checks
every retained generation. Process reopening requires query/synchronize access
and the exact recorded creation FILETIME; access errors or PID reuse refuse.
For an already signalled process handle, creation identity proves original exit:
Windows may no longer provide the exited image path. Live handles still require
SID/image validation and are refused as alive. This never terminates or adopts
an arbitrary process. A durable `closed` flag is not native proof.

An explicit existing-profile-only `--owner-handoff` mode provides private framed
status/claim/recover before AppState. It holds the directory lock, validates the
target executable hash/schema/protocol and current native user/profile, proves
old owners ended, then commits ownership, revision/phase and receipt atomically.
Recovery rotates the target reservation and capability hash, retaining earlier
identities and receipts. Named Jobs permit conservative cross-lifetime queries;
they add collision/ACL failure modes, which remain refusals rather than fallback.
The restricted mode cannot publish readiness or start execution. Full idle
inventory and source orchestration remain required before enabling app transfer.

## Validation

Native tests cover original identities, strict capability serialization and
pending/cancelled closure. Transport tests cover malformed and lossy responses,
launch preservation, timeout budgets and no replay after lost replies. Real
process acceptance covers the production HostProcess/AgentSidecar path, detached
descendants, explicit Stop, stale/invalid/cancelled/expired capabilities,
unexpected parents, counterfeit Node clients, Host/coordinator crashes and
unrelated-process survival. Crash observers retain original Windows handles
before the fault and wait for their signalled exit, rather than relying on PID
absence. All fixtures use temporary profiles and no paid providers.
