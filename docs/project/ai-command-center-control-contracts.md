# AI command center: P0 control contracts, version 1 draft

- Status: Reviewable S02 design output. This is not a shipped schema, capability advertisement, migration or M0 approval.
- Basis: [requirements](ai-command-center-requirements.md), [development design](ai-command-center-development-design.md), [schedule](ai-command-center-schedule.md).
- Existing runtime evidence: [1 MiB validation](ai-command-center-1mib-validation.md).
- Compatibility: keep the existing session, turn, delegation, permissions and transcript authorities. No new executor or transcript store.

## Purpose and acceptance boundary

This document makes the P0 identity, capacity, goal and receipt draft specific
enough to implement and test in P1/P3. It distinguishes an existing mechanism
from an extension still to build. References are to current source paths; names
under `commandCenter/*` remain proposed until schemas, producer, consumer,
permissions and capability negotiation ship together.

S02 can supply concrete contracts while S01 load qualification runs. It cannot
close M0 without the representative main/child/Worker workload, native/mobile
matrix, interactive feasibility and unresolved policy decisions. No migration
version is assigned in advance.

## Identity and authority

| Identity | Lifetime | Authority | Must not substitute |
|---|---|---|---|
| `hostId` | Persisted Host installation | Existing Host configuration | Machine name, IP, SSH alias or browser origin |
| `hostEpoch` | One exclusive execution-owner generation | Host supervisor, fenced through Rust | Connection ID or renderer reload counter |
| `commandWorkspaceId` | Operational group | Rust workspace repository | Project ID, directory, Git worktree or visual pane |
| `sessionId` | Conversation history | Existing session repository | Local active-session selection |
| `turnId` | One admitted main/Worker turn | Existing durable `session.beginTurn` | Provider request ID or client request ID |
| `delegationId` | Existing delegation record/continuation relationship | Existing delegation registry/history | Tool label, child title or array index |
| `executionGeneration` | One concrete native child run | Host/runtime admission result | Resuming the same chain without a new generation |
| `requestId` | One control attempt and all its retries | Client generated, Host journal scoped by principal | Automatic new ID on response loss |
| `goalRevision` | Immutable desired goal version | Rust compare-and-swap transaction | Latest UI text or runtime's assumed current objective |
| `receiptRevision` | Monotonic receipt state version | Rust receipt transition | Event sequence; event cursors have a separate epoch |

A stable goal owner is either a canonical session or a canonical delegation-chain
root resolved by Host history. A live execution target adds its turn/generation.
A client must never infer a chain root from a display tree or submit an arbitrary
alias that the runtime follows without Host validation.

Main and Worker execution targets reuse their real `sessionId + turnId`.
A native child target contains `parentSessionId + parentTurnId + delegationId +
executionGeneration`. Every mutation also carries `hostId`, `hostEpoch`, the
expected command workspace and membership revision. The Host resolves the target
from its own registries, checks authorization and membership, and rechecks the
same identity after asynchronous preparation.

Read-only discovery can reference a settled session or child chain with no live
turn. An intervention cannot fabricate a turn ID for such a row. Explicitly
starting a new turn uses the existing admission path and creates a new execution.

### Examples

- A phone sends a correction to session S / turn T1 while Desktop starts T2.
  The T1 command conflicts or reports T1 settled; it never falls forward to T2.
- A child is resumed under the same continuation chain. Its goal owner may stay
  stable, but its new execution generation invalidates a delayed stop for the old
  run. Continuing a stopped child remains governed by existing resume semantics.
- A view moves from workspace A to B. Navigation changes only the selected view.
  Session membership changes require a separate authorized operation while idle.
- Host restart changes the owner epoch. Requests naming the old epoch return a
  stale-owner result and require reconciliation, even if session/turn IDs match.

## Admission and reservation state

Rust owns the transaction that checks and reserves capacity. Agent Host owns
policy and scheduling; the sidecar consumes the accepted identity. A client cache
or renderer count can never grant a slot.

Count states `reserved`, `starting`, `running`, `waiting_tool`, `waiting_human`,
`stopping` and `outcome_unknown`. Do not count queued entries that have not
reserved a runtime. Terminal `completed`, `aborted`, `failed` and reconciled
`launch_failed` release capacity exactly once. A parent waiting on children
still owns a slot. A settled parent is not counted again just because children
remain live. A native child is counted separately from its parent; a Worker is
counted through its own canonical session/turn.

| Transition | Preconditions | Durable effect | Runtime side effect |
|---|---|---|---|
| queue → reserved | Current epoch, enabled workspace, expected membership, below 12/workspace and 36/Host, existing child/provider/tool constraints | Insert unique live reservation in the same capacity transaction | None before commit |
| reserved → starting | Same reservation/epoch/generation; no prior launch acknowledgement | Persist launch intent | Dispatch outside DB transaction |
| starting → running | Runtime accepted that exact identity | Record acknowledgement | Continue existing runtime |
| any live state → stopping | Authorized Stop for the exact execution/subtree | Record cancellation intent; keep slot counted | Existing stop/abort port |
| live → terminal | Owning execution settled, persistence outcome classified | Terminal transition and release once | Release owned resources |
| uncertain launch/stop | Lost response or owner failure | `outcome_unknown`; keep reservation | Reconcile; no blind launch/replay |
| old epoch → interrupted | Old process proven stopped/fenced | Reconcile reservations before new admission | No model/tool replay |

Reservation keys are canonical execution identities. A duplicate admission for
the same identity returns the existing reservation; a changed workspace or
principal cannot borrow that reservation. Workspace disable, session rebind and
delete reject while live reservations would be stranded. There is no fourth
hidden operational group, unassigned unlimited default or per-client extra quota.

All entry points must call the same reservation port: Desktop, remote/browser,
scheduled tasks, plugins, native Task and Worker/session orchestration. Existing
prompt queues remain the only durable prompt queues. Waiting-for-capacity is a
reason on those queues; per-workspace fairness is scheduling policy around them,
not a second queue store. Existing ten-child session and tool/RPC limits remain
additional checks. Releasing Agent capacity does not release unrelated external
process/PTY/browser resources.

## Intervention request and idempotency

The principal and role come from authenticated transport state. A request cannot
supply or widen them. Role checks precede existence-sensitive target details.
Proposed v1 supports `append`, `steer`, `reviseGoal`, and `stop`, with explicit
capability and target-kind checks. An operation may be unavailable even for an
owner; role is not proof that the runtime has a consumption boundary.

Non-stop requests require the expected desired goal revision. Stop requires the
execution/epoch/membership fence but does not fail merely because the goal
revision advanced. Subtree scope is explicit; stopping one child never silently
stops siblings or parent. Membership rebind is a separate idle-only operation.

The idempotency key is `(hostId, principalSubject, requestId)`. Hash the normalized
validated versioned payload, including target, expected revisions and intent,
with deterministic key ordering. Transport connection IDs, timestamps and retry
counters are not semantic payload fields. Same key/same hash returns the original
receipt; same key/different hash conflicts. Authorization is rechecked on receipt
lookup so old access cannot disclose newly forbidden targets.

For a new goal revision, commit the receipt, desired goal head/history and parent
notification intent atomically. Do not hold the transaction over runtime/network
I/O. Record the dispatch attempt before calling the runtime; on uncertain delivery,
query/reconcile the existing receipt rather than generate a new ID or replay.
User decision for the first release: **no automatic deletion** of control
receipts or transfer journals, including terminal records. Unresolved records
remain recoverable. Expired hot caches reload the durable identity; they never
turn an old request into a new mutation. Queries are paginated and hot caches
bounded independently of on-disk retention. Do not add a cleanup endpoint or
cascading receipt deletion as part of task/session deletion; any later explicit
deletion/tombstone contract requires its own compatibility and privacy design.

Current `AgentHost` has an in-memory idempotency cache for turn start. It is a reuse
reference, not a replacement for this durable control journal. Provider import
also has its own recovery receipts; those are not command-center goal receipts.

## Goal revisions and consumption

`desiredRevision` is the latest committed user intent. `effectiveRevision` is
the latest version the exact runtime execution confirms it consumed. A committed
intent is not automatically effective. Runtime acknowledgements must name target,
generation, request ID, desired revision and the supported boundary identifier.
Reject an acknowledgement for an old owner or an unrelated execution.

A goal revision does not undo file writes, tools or remote actions already issued.
The consumption boundary controls the next supported model/tool scheduling step.
Queued revisions preserve order. If coalescing is later chosen, the replaced
receipt must explicitly record supersession; the implementation cannot silently
skip accepted user intent. Do not invent a `consumed` acknowledgement merely
because `agent.steer` returned `{ accepted: true }`.

Current `RuntimePort.steer` targets a live main turn and reports acceptance. A
running native child needs a focused control port and a consumption
acknowledgement; `Task(resume)` is a new run of settled work, not that port.

### Parent/child consistency

1. Commit child's new desired revision plus a parent-notification intent.
2. Fence acceptance of the old child result at the same authoritative revision.
3. Deliver the notification through existing parent coordination at a supported
   boundary. A repeated delivery uses the notification identity and is idempotent.
4. Child result carries the goal revision and concrete execution generation.
   Parent acceptance compares both to its authoritative expected state.
5. If parent already consumed an old result before the new transaction, record the
   ordering and require an explicit follow-up; do not claim to reverse prior model
   decisions or tool effects.
6. If parent is settled, persist the follow-up requirement. Do not restart it
   invisibly. A child stopped during delivery gets an explicit interrupted/rejected
   control outcome, not a replacement child run.

## Receipt transitions

| State | Evidence required | Legal continuation |
|---|---|---|
| `recorded` | Rust intent transaction committed | accepted, rejected, conflicted, interrupted, outcome_unknown |
| `accepted` | Exact runtime target admitted the control intent | consumed, completed for supported non-consumption operations, interrupted, outcome_unknown |
| `consumed` | Runtime boundary acknowledgement for this revision/generation | completed, interrupted, outcome_unknown |
| `completed` | Operation-specific terminal evidence | Terminal; lookup only |
| `rejected` | Validated reason that intent was not accepted | Terminal; a deliberate new attempt needs a new ID |
| `conflicted` | Epoch/identity/revision/hash conflict | Terminal; refresh before a deliberate new attempt |
| `interrupted` | Cancellation/owner loss with known disposition | Terminal; no automatic redispatch |
| `outcome_unknown` | Dispatch may have occurred but no authoritative outcome | Reconciliation transition only; no blind replay |

Stop is completed only after the addressed execution/subtree settles, not after
accepting a cancel request. `completed` for goal control proves delivery/consumption
according to that operation's definition, not model obedience or task success.
Receipt transitions increment a revision and publish an event after commit.
Delayed events cannot roll a client back to an older receipt revision.

Reuse existing error families (`INVALID_ARGUMENT`, `FORBIDDEN`, `CONFLICT`,
`CAPABILITY_UNAVAILABLE`, payload/resource limits, unavailable/overloaded Host).
New machine-readable detail codes require shared registration and consumer tests.
Never infer successful persistence from a live completion bubble.

## Monitoring and attachment contract

The monitor is a bounded summary stream, not 36 detailed conversation
subscriptions. Current RACP defaults permit eight subscriptions per connection.
A proposed monitor open obtains a consistent summary/cursor boundary; changes
after that cut are sequenced before live delivery. Epoch mismatch, evicted history
or a slow subscriber requires resync. No silent gap or fabricated continuous replay.

Summary rows hold canonical identity, status/wait reason, short labels, desired
and effective goal revisions, parent reference and pending-human counts. Full
provider context, tool bodies, credentials and native handles stay out of the
summary. Proposed page limits are 100 rows/items plus byte caps; those caps must
be validated against negotiated transport limits, not just item count.

Detailed attach reads canonical history without starting execution. Pagination
and streaming merge on stable message identity; live final rows supersede partial
rows. A client view-generation token prevents delayed history for a previous
selection from repainting the current view. Detach releases observation only.
Browser backgrounding cannot stop Host-owned execution. Restart requires a new
snapshot barrier and refreshed capabilities.

## Implementation and executable acceptance matrix

These are required future tests, not claims that the proposed APIs exist.

| ID | Trigger / sequence | Required observation | Lowest useful test level |
|---|---|---|---|
| CC-ID-01 | Read T1, switch focus, submit while T2 starts | T1 conflict/settled response; no T2 side effect | Public control API integration |
| CC-ID-02 | Resume a child then deliver old-generation Stop | New child remains untouched | Runtime/Host contract |
| CC-ID-03 | Restart owner between validation and dispatch | Old epoch rejected/fenced | Supervisor + repository integration |
| CC-Q-01 | Concurrent 13 starts in A and 37 total across entries | At most 12 A / 36 Host reservations; no runtime before commit | Rust transactional barrier test |
| CC-Q-02 | Count waiting approval/tool, stopping and unknown launch | Capacity remains occupied until evidence permits release | Repository state tests |
| CC-Q-03 | Duplicate terminal and launch-failed acknowledgements | Exactly one release; counts never negative | Repository transition tests |
| CC-Q-04 | Hide panes, add clients, plugin/schedule/Worker/Task starts | No bypass of shared reservation port | Entry-point integration |
| CC-Q-05 | Rebind/delete/disable with a live execution | Conflict without orphaned membership | Repository contract |
| CC-R-01 | Lose response after commit, repeat same ID/payload | Same receipt; one dispatch intent | Public API + durable journal |
| CC-R-02 | Same ID, changed payload or other principal | Conflict or distinct authorized scope; no reused privilege | Authorization contract |
| CC-R-03 | Crash before dispatch / after dispatch / after ack | Known interruption or unknown outcome; no replay | Fault-injected integration |
| CC-G-01 | Two clients revise same goal head concurrently | One CAS winner; loser sees current revision | Rust transaction test |
| CC-G-02 | Accept steer, delay runtime consumption | Desired advances; effective stays until exact ack | Runtime boundary integration |
| CC-G-03 | Child completion races goal revision | Old result cannot satisfy new goal; ordering explicit | Real deterministic child flow |
| CC-G-04 | Parent settled or already consumed old child result | Durable follow-up, no invisible restart/rollback claim | Parent-child integration |
| CC-S-01 | Goal changes before Stop is processed | Stop is not blocked solely by goal revision | Public control API |
| CC-M-01 | Snapshot read races events and history page response | No gap/duplicate/focus mix-up; stale epoch resyncs | Projection/client integration |
| CC-M-02 | 36 monitored tasks, slow background client | Bounded summaries/buffers; explicit resync | Transport load test |
| CC-P-01 | Final append or endTurn fails under load | Error/unknown outcome, never confirmed completion | Existing runtime regression + E2E |

## Next implementation slices

1. Build shared versioned schemas and golden request/receipt fixtures only after
   the identity and receipt policies above are accepted for implementation.
   Add producers/consumers and negotiation together; keep capability absent until
   the whole path exists.
2. Implement exclusive owner fencing and a capability-qualified service-mode
   launch path; prove one database writer before any automatic handoff.
3. Add focused Rust workspace/membership/reservation repositories with migrations
   and transaction tests; integrate all admission sources before claiming 12/36.
4. Add durable goal/receipt/parent-notification journals and runtime consumption
   acknowledgement; then expose child control and monitor projection.

User decisions now fix first-release receipt/journal retention (no automatic
deletion) and the minimum Windows target (two CPU cores, 8 GB RAM; current
development host: six logical processors, about 24 GB). Remaining qualification
inputs are exact CPU/OS/target access, tokenizer/corpus and tool/plugin fixture
versions, and native/mobile devices. These decisions remove the retention-policy
blocker; they do not turn unimplemented contracts into passing product evidence.

## Source references

- `packages/agent-host/src/agent-host.ts`: existing admission/queue, idempotency,
  turn identity, event publication and terminal handling.
- `packages/agent-host/src/ports.ts`: RuntimePort, Principal, SessionPort, QueueStore.
- `packages/agent-host/src/event-log.ts`: replay, epochs, eviction and slow-client handling.
- `packages/shared/src/racp.ts`: current operation roles, limits and capabilities.
- `packages/racp/src/operations.ts`: input validation and real dispatched catalog.
- `packages/host-runtime/src/runtime-service.ts`: durable turns, stop/abort/steer and settlement.
- `packages/agent-runtime/src/subagent.ts`: concrete child run and continuation behavior.
- `crates/host-core/src/turn_queue.rs`: existing durable turn queue.
- `apps/pi-host/src/admin-socket.ts`: exclusive admin channel and maintenance integration.
