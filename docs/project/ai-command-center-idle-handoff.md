# AI command center: idle handoff protocol design

- Status: Proposed S03b implementation contract; no endpoint, journal migration or ownership transfer is implemented by this document.
- Source inspected: `d6a648fd5` (Windows ownership, relocation and Stop prerequisites included).
- Basis: [architecture decision](../adr/ai-command-center.md), [requirements](ai-command-center-requirements.md), [control identities](ai-command-center-control-contracts.md), [capability inventory](ai-command-center-host-parity.md).
- First supported direction: explicit, same-machine Desktop-to-current-user background Host, only while idle. Reverse transfer and other platforms need their own acceptance.

## Confirmed reuse and missing guarantees

| Source | Current behavior | Handoff consequence |
|---|---|---|
| `crates/host-core/src/data_directory_owner.rs` | Cooperating binaries hold an OS lock before AppState/recovery | Reuse the lock; it does not prove Node/tool execution stopped |
| `packages/agent-host/src/maintenance-admission.ts` | Closes admission before async inspection; lease auto-opens after 120 seconds | Reuse admission wiring, but an expiring maintenance lease is not a transfer fence |
| `apps/pi-host/src/app.ts` | Windows skips the admin channel; existing maintenance reports several live resource owners | Windows needs a local control binding and a complete owner inventory |
| `apps/pi-host/src/admin-socket.ts` | Owner-only Unix channel; Windows reports unavailable | Do not silently substitute loopback TCP or a permissive named pipe |
| `packages/host-runtime/src/agent-sidecar.ts` | `dispose()` can resolve after its two-second grace without an exit event | Ordinary dispose completion is not a process-exit receipt |
| `packages/host-runtime/src/host-process.ts` | Forced-exit wait result is ignored by ordinary disposal | The transfer must explicitly verify exit before successor readiness |
| `apps/desktop/electron/main/bootstrap/shutdown.ts` | Bounded quit settlement; some failures are logged or collected with `allSettled` | Keep ordinary quit semantics; handoff uses a stricter, separately verified workflow |
| Windows tool ownership | Job Objects plus a corrected snapshot fallback | Snapshot cleanup alone is not a durable execution-generation fence |

Implemented prerequisite: both process wrappers now expose
`confirmExit(timeoutMs)`. It observes their original child without signalling it
and keeps timeout/transport failure distinct from exit. The old disposal behavior
is unchanged. This supplies child-exit evidence only; native descendant fencing,
durable owner records and the transfer protocol below remain unimplemented.

S03b-1 discovery is now implemented behind explicit `--owner-control` and
`--owner-status` modes on Windows; see the [discovery ADR](../adr/windows-owner-discovery.md).
The current-user native channel validates both executable identities and
advertises only `status`. The transfer operations and fencing/journal below
remain future work; discovery is not execution-transfer readiness.

The first transfer must refuse a pre-existing source that lacks the execution
fence capability. Restarting an updated source while idle may be required before
it becomes eligible. Do not attempt to adopt an arbitrary live process by PID.

## Ownership and transport

Keep the established boundaries: Electron Main orchestrates native presentation,
Node executes Agents, and Rust owns persistence and native resource authority.
The existing single sidecar topology remains. The first implementation adds no
Windows service, elevation, remote deployment, credential copy or automatic
execution on startup.

The proposed local binding is a Rust-served Windows named pipe, qualified for the
current user. Its name derives from a trusted canonical profile identity and user
SID; a name is discovery information, not authentication. Require an explicit
DACL for the intended SID, reject remote clients, reject a second server instance,
and validate the peer SID and process identity using Windows APIs. Never accept a
client-supplied SID, PID alone, data path or executable path as authority. An
unexpected pipe server causes a refusal, not a less-protected retry transport.

Use a separately negotiated `owner-transfer` protocol version 1. Proposed frames
are length-prefixed UTF-8 JSON, at most 16 KiB, with strict operation-specific
schemas. Keep operation IDs, enums, errors and limits in shared contracts with
producer/consumer fixtures. No raw Host RPC or arbitrary process/file operation
is exposed. The existing Unix maintenance protocol and RACP remain unchanged.

Rust authenticates the request and owns the journal; the existing Node
coordinator still owns execution admission. Use a bounded internal control
exchange over their existing stdio relationship to request quiescence and return
owner-reported idle/exit results. Bind every exchange to transfer ID, source
epoch and transition revision. Rust cannot commit `prepared` before Node has
closed admission and completed its inventory. Missing/late acknowledgements do
not authorize native fencing or reopening; reconcile against the durable phase.
This adds no Agent scheduler inside Rust and no second admission authority.

| Alternative | Assessment |
|---|---|
| Reuse the expiring maintenance lease unchanged | Cannot survive disconnect/crash safely after source stopping begins |
| Local TCP with a bearer secret | Adds listener, discovery and credential lifecycle; unnecessary for this first local transfer |
| Owner-restricted native pipe plus Rust state | Selected first implementation direction; requires real SID/ACL and process-identity tests |
| Install a privileged Windows service | Outside the authorized current-user first slice and unnecessary for idle transfer |

Desktop discovers only its configured profile through the existing trusted
bootstrap. A transfer request identifies that profile and an installed target
build; the launcher resolves executable locations. Secrets travel through an
inherited private channel, never command-line arguments, logs or a public marker.

## Stable identities and requests

Reuse `hostEpoch` from the control-contract draft as the exclusive execution-owner
identity. Keep it distinct from a RACP event epoch, a client connection, the
HostProcess wrapper generation, a PID and a child execution generation.

A transfer record has:

- Protocol version, transfer UUID and trusted profile identity.
- Source `hostEpoch`, reserved target `hostEpoch`, source/target build identities
  and the relevant supported data/protocol versions.
- Authenticated requester identity, request fingerprint, monotonic transition
  revision, phase and last classified failure.
- Native containment identity and the exact registered source process identities
  needed for conservative recovery; no user-provided process inventory.
- A hash of the one-use successor launch capability; raw capabilities are never
  persisted in the journal or returned by `status`.

Each mutation names the transfer ID, source epoch and expected journal revision.
The same request ID and fingerprint returns the recorded operation; a different
fingerprint conflicts. A stale epoch or transition revision has no effect.

Proposed operations are `preflight`, `prepare`, `status`, `cancel`, explicit
current-user `recover` and private successor `claim`. `preflight` performs no
shutdown. `cancel` is allowed only before native fencing begins and only by the
still-authoritative source. A request timeout does not cancel or replay the
operation. Reconnect queries its existing ID before any deliberate new request.

## Idle proof and execution fencing

Close every existing execution-admission entry synchronously before collecting
idle state. Wait for already admitted hand-offs to resolve; then inspect the
owners themselves. Include active/finalizing turns, queued input, native children,
Workers, approved-plan dispatch, schedules, tools, background processes, pending
approvals/input, native sessions, terminals and plugin/MCP work. Unknown state or
an owner that cannot report is a refusal. Do not count only visible sessions or
only RACP turns.

Connected execution clients must detach before this first transfer can prepare.
Desktop may retain its last read-only presentation locally and poll the local
transfer operation. Reuse the existing maintenance connection refusal instead of
quietly changing ordinary maintenance semantics. Loaded resources must have a
verified closure path even when they report zero active work. Associated external
user applications are not adopted or killed by the transfer.

Before a source becomes handoff-capable, register its sidecar with a Rust-owned,
kill-on-close Windows Job Object while the runtime is behind a startup barrier.
No plugin initialization, model call, local tool or child launch may pass that
barrier before the owner confirms containment. The registration rendezvous is
one-use, profile/epoch-bound and tied to the authenticated launching process and
child creation identity. Reject arbitrary PID adoption and unexpected parents.
Do not grant breakaway from this job. Other application-owned process families
must provide equivalent owned containment or make transfer unavailable.

For normal transfer, stop idle resource owners, observe the original sidecar
process handle exit, and verify the owned containment is empty. A timeout,
failed termination, unknown descendant or unconfirmed cleanup leaves admission
closed and records an actionable failure. Ordinary `dispose()` returning, a
closed pipe, missing PID file or successful `kill()` call is insufficient.

On source crash, a successor must independently verify the prior containment is
empty or that the exact original process identities have exited before admitting
work. A persisted 'exit observed' field alone cannot authorize a different
process generation. PID reuse, missing access and inaccessible containment fail
closed. macOS/Linux must remain explicitly unsupported for this transfer until
their native containment/recovery proof is implemented and qualified; a process
group alone is not asserted to contain arbitrary detached descendants.

## Rust-owned journal and transitions

Schema v28 stores the transfer journal in a dedicated Rust repository. Preserve
existing profiles and transcripts with the additive migration and v27 backup.
Require one active transfer per profile, transactional revision CAS and unique
transfer/request identities. Do not keep a second JavaScript journal.
The user has selected no automatic deletion of terminal or unresolved control
receipts and transfer journals in the first release. Keep hot caches bounded and
durable reads paginated. Exhausting a storage budget must not silently lose a
transfer or allow an old request to execute again.

In handoff-capable mode, persist the active owner epoch and native containment
registration before releasing the runtime startup barrier. Transfer records
reference this owner record. Startup must verify the previous owner even when a
coordinator crashed before `prepare` committed; absence of an active transfer
is not proof that previous execution has ended.

After acquiring the data-directory OS lock, startup needs a restricted metadata
read before migration, turn recovery, scheduling or sidecar launch. Validate the
journal, supported schema and target capability first. A profile with an
unfinished transfer must not enter the ordinary startup/recovery path. This
startup guard applies to cooperating updated binaries; it cannot retrofit an
old executable that ignores the protocol. Rollback must refuse unsupported data
and transfer versions rather than automatically launching such a binary.

| Phase | Required fact before committing it | Allowed next action |
|---|---|---|
| `prepared` | Admissions closed, idle inventory settled, target version/capabilities accepted | Cancel safely or begin native fencing |
| `source_fencing` | Durable intent written before stopping registered resources | Confirm containment empty; otherwise remain blocked |
| `source_fenced` | Exact source runtime/process closure confirmed; Rust still owns the directory | Persist release intent |
| `release_pending` | Successor launch identity reserved; no source execution can restart | Source Rust exits and releases its OS lock |
| `target_claimed` | Target holds the OS lock, validates capability/journal, and proves old containment ended | Recover metadata while all execution admissions remain closed |
| `ready` | Recovery complete, target epoch/capabilities published | Open target admission and permit fresh client attachment |
| `cancelled` | Source still owns the directory; no native fencing effects occurred | Restore source admission exactly once |

Failures preserve the last durable phase and a classified error. A transient
failure is not an alternate phase that permits admission. `release_pending` is
an intent, not a claim that the source has already exited. `ready` is the only
successor-admission transition. Acquire of a data-directory lock alone does not
make a successor ready.

Lost replies are reconciled from the same journal ID and revision. No transition
replays a model/tool call, silently releases unknown reservations or changes a
session's permission mode. Recovered interrupted work stays interrupted until a
separate user-authorized action starts a fresh execution.

## Successor launch and attachment

Launch the selected current-user target with only the transfer rendezvous and
trusted profile identity. It may wait for the source release, but it must not
open AppState, recover turns or start its sidecar while waiting. The source keeps
its lock until the fenced state is durable. Only the matching reserved target
can claim an unfinished transfer; a competing ordinary startup refuses.

If the reserved successor crashes or its one-use capability is lost, explicit
current-user recovery starts a restricted Rust control process that acquires the
same directory lock and validates the journal before ordinary AppState. It must
prove both source containment and any prior target generation have ended. It
then CAS-rotates the target epoch, launch capability and recorded recovery
attempt; the prior capability becomes invalid. Concurrent recovery has one
winner. It never clears an unresolved journal, resumes the old source, launches
arbitrary binaries or replays work. Failure to prove either generation dead
keeps recovery blocked. This is also the retry path after `target_claimed` but
before `ready`; it is not an automatic retry of an ambiguous process launch.

After `target_claimed`, the target reconciles records with admission closed,
verifies capability parity, and only then publishes `ready`. Client connections
reattach using the new Host/event epochs and fresh snapshots. History reads and
attachment do not start turns. Missing desktop-only capabilities remain explicit;
there is no credential movement or fallback to a different execution machine.

RDP disconnect and Windows user logoff are separate cases. A current-user
background process can remain during an RDP disconnect; this is not a promise
that it survives logoff. Interactive resources are bound to their native session
and must be unavailable when that session cannot provide them.

## Ordered implementation and acceptance

| Slice | Deliverable | Required evidence |
|---|---|---|
| S03b-1 | Versioned local binding, peer identity and strict shared schemas | Same-user success; other SID/remote/stale owner rejection; malformed/oversized frames; name collision; no arbitrary-path/PID authority |
| S03b-2 | Native execution fence and explicit exit confirmation | Startup barrier precedes effects; parent/Host crash terminates owned runtime; original handles confirmed; unrelated processes untouched; timeout remains unconfirmed |
| S03b-3 | Journal migration, CAS and guarded bootstrap | Populated profiles; duplicate/lost request; every phase crash; schema-too-new; unsupported old source refuses; no early recovery write |
| S03b-4 | Idle transfer orchestration and reattachment | Desktop-to-background user path; all admission entry points fenced; busy refusal; one ready successor; history and capability parity; no execution replay |

| Case | Fault or race | Required result |
|---|---|---|
| HT-01 | Two prepare requests for one profile | One active transfer; other request conflicts or reads its own existing receipt |
| HT-02 | New start races idle inspection | Start is accounted as admitted work or refused; never slips past the gate |
| HT-03 | Source crashes in `prepared` | No new execution until prior native owner is proven gone; recovery remains observable |
| HT-04 | Sidecar ignores shutdown / exit is not observed | Keep source ownership and admission closed; no successor readiness |
| HT-05 | Source dies while fencing | Native containment ends owned processes; successor verifies this before proceeding |
| HT-06 | Source exits after `release_pending`, before target start | One reserved successor recovers without replay; ordinary launch refuses |
| HT-07 | Successor fails schema/capability validation | Preserve data/journal; no old-version fallback or auto-release of unknown work |
| HT-08 | Client disconnects or loses an acknowledgement | Query the original operation; no second shutdown or new transfer ID on retry |
| HT-09 | Cancel races native fencing | Exactly one CAS wins; no reopening once fencing has begun |
| HT-10 | Unrelated/recycled PID appears | No termination based on PID alone; ambiguous proof blocks admission |
| HT-11 | `dispose()` resolves by timeout | No exit receipt and no transfer readiness |
| HT-12 | New owner is ready while an old client sends a command | Reject the old epoch; require current snapshot/identity |
| HT-13 | RDP disconnect / unavailable interactive session | Execution ownership remains explicit; unavailable native capabilities stay unavailable |
| HT-14 | Journal tampering, corruption or unsupported version | Classified refusal before migration/recovery/admission; preserve evidence |
| HT-15 | Target capability lost or target crashes before ready | Explicit authenticated recovery proves old owners ended, CAS-rotates target/capability, and rejects the old claim without replay |

These are acceptance requirements, not passed tests. S03a ownership, the focused
Windows Stop regression and the one-hour synthetic soak do not satisfy them.
Full M0 still needs the frozen reference workload/hardware and platform inputs
listed in the [remaining-work register](ai-command-center-remaining-work.md).
No service rollout or change to existing session ownership is authorized by a
passing document/link check.

## Native execution-fence implementation checkpoint

S03b-2 now has an opt-in Rust-owned Windows Job and a stateless Rust launcher.
The coordinator prepares a one-use ticket, starts that launcher, and Node begins
only after authenticated native assignment. This closes the preload window that
a JavaScript-only barrier would leave open. The captured coordinator and runner
handles anchor creation identity; the current Host lifetime scopes the ticket.
`AgentSidecar.createFenced` and explicit `fenceExecution` expose this primitive.
Default app launch remains unchanged until durable startup and the complete idle
inventory are integrated. See [the execution-fence decision](../adr/windows-execution-fence.md).

S03b-3 now has candidate durable owner/containment registration, a pre-AppState
ordinary-startup guard and explicit restricted claim/recover. Named Jobs retain
the native recovery identity. Source prepare/phase orchestration remains test-only
until S03b-4 supplies complete idle inventory; restricted recovery never declares
readiness or admits execution. Current validation and remaining gates are tracked
in the [remaining-work register](ai-command-center-remaining-work.md).
