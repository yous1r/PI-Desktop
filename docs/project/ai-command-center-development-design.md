# AI command center: development design

- Status: Proposed development design; not implemented or approved for rollout
- Date: 2026-11-08
- Source baseline: `origin/main` at `fd28eb89866ac513912ed109716e7120cf60f18c` (v0.22.3)
- Architecture rationale: [AI command center ADR](../adr/ai-command-center.md)
- Product requirements and quantitative gates: [Requirements proposal](ai-command-center-requirements.md)
- Delivery scope: documentation and local Git submission only; no code, migration, listener, deployment or default change

## Contents

1. [Background and design inputs](#background-and-design-inputs)
2. [Scope and invariants](#scope-and-invariants)
3. [Technology choices](#technology-choices)
4. [Architecture and process ownership](#architecture-and-process-ownership)
5. [Module decomposition](#module-decomposition)
6. [Data model and persistence](#data-model-and-persistence)
7. [Interfaces and protocol contracts](#interfaces-and-protocol-contracts)
8. [Data flows and failure handling](#data-flows-and-failure-handling)
9. [Client layout and foreground scheduling](#client-layout-and-foreground-scheduling)
10. [Resource governance](#resource-governance)
11. [Native applications and platform delivery](#native-applications-and-platform-delivery)
12. [Security and client authentication](#security-and-client-authentication)
13. [Migration and compatibility](#migration-and-compatibility)
14. [Milestones and effort](#milestones-and-effort)
15. [Risk register](#risk-register)
16. [Acceptance and validation](#acceptance-and-validation)
17. [Open inputs and decision gates](#open-inputs-and-decision-gates)
18. [Source references](#source-references)

## Background and design inputs

The product is a monitoring and intervention center for background AI work.
Operators normally see status, current activity, child tasks and requests for
attention. They attach to a task only when they need history, live output or
control. Opening a view must neither start another Agent nor take ownership away
from its execution Host.

The user prioritizes low memory usage, remote-desktop usability, one permanent
overview plus three application-internal workspace surfaces, workspace maximize,
a twelve-agent workspace limit and an application-process budget of 4 GB.
Windows comes first; macOS, Linux and mobile are target platforms. The proposed
interpretation counts main agents, native subagents and Worker sessions together,
for up to thirty-six live executions on one Host.

The existing code supports a useful foundation: independent Host/runtime packages,
RACP, session history, queued input, steering, approvals, delegation history,
background browser pages and PTYs. It does not yet provide the complete proposed
monitoring projection, workspace quota, browser client or child-control contract.
The baseline renderer still depends on Electron preload and active-session state.

Sufficient information exists to specify module boundaries and interaction flows.
Before promising implementation capacity, P0 must obtain the actual machine and
workload, required program names/versions, mobile test devices, deployment/network
choice and platform order. These inputs are enumerated in the final section;
unknown measurements are not treated as passing tests.

This document elaborates the ADR rather than replacing it. The requirements retain
FR-01 through FR-10 and AC-01 through AC-16 as the product/acceptance source. New
package names, records, operations and types below are proposed implementation
contracts. They are not exports or endpoints present in v0.22.3.

## Scope and invariants

| Area | Included design | Boundary |
|---|---|---|
| Monitoring | Bounded summaries, parent/child tree, attention queue and freshness | No full conversation mounted for every task; no invented progress percentage |
| Workspace UI | Overview plus at most three surfaces; resize, focus, maximize/restore | One application window; mobile switches logical surfaces instead of showing four tiny panes |
| Conversation access | Paged main/child history, live tail, drafts and reading position | Attach/detach does not create or stop an execution |
| Intervention | Main and child steering, versioned goals, approval, input and explicit stop | No implied rollback, universal pause, automatic permission widening or guaranteed semantic obedience |
| Execution | Independent same-machine Host, 12 agents/workspace and 36/Host | One authoritative owner; existing narrower tool/session limits still apply |
| Programs | Associate ordinary user-session native windows; optional named embedding adapters | No universal embedding, Agent desktop-control grant or remote video stream |
| Platforms | Electron desktop plus responsive Android/iOS Web/PWA | No mobile Agent runtime; native privilege differences remain visible |
| Capacity | Measure all application-owned processes against the qualified 4 GB workload | Queued work is not simultaneous execution; external payload costs are disclosed separately |

Preserve the frozen ownership boundaries: Renderer handles presentation; Electron
Main handles platform orchestration; Rust exclusively owns SQLite; Node owns Agent
execution; shared contracts do not depend on desktop implementation; plugin sandbox,
permission, event ordering, usage and stop semantics remain enforced.

A command workspace is not a project group, filesystem root or Git worktree.
A view references a session but cannot change its execution workspace. Three
workspaces may admit work concurrently; hidden workspaces still count. Additional
clients share this quota. Work on other Hosts is not a means of bypassing the
first release's single-Host contract. Existing remote workspace tools keep their
current routing semantics until explicitly extended.

## Technology choices

| Concern | Selected proposal | Reason and alternative |
|---|---|---|
| Desktop shell | Retain current Electron and its existing React/TypeScript stack | Preserves browser/CDP, plugin and native investments. Tauri 2 remains a measured alternative after equivalent-feature profiling |
| Layout | Small typed reducer, CSS layout and existing UI primitives | Four surfaces do not require a general docking framework. Layout remains versioned application data |
| Client state | Zustand selectors around normalized, session-keyed views | Reuses the current stack; removes global-active-session dependence from commands |
| Portable client | Browser-safe TypeScript package with injected transport | Electron preload and native browser WebSocket adapters share models and reducers without importing Node server dependencies |
| Mobile | Responsive Web/PWA; native shell later if justified | Supports monitoring/control first. Capacitor is an optional packaging step, not an execution engine |
| Host coordination | Existing `agent-host` and `host-runtime` packages | One admission, permission and lifecycle path; no second Agent scheduler or transcript service |
| Durable command metadata | Versioned dedicated SQLite tables through Rust repositories | Membership, reservations, goal CAS and receipts require transactional constraints; whole-document KV replacement is a poorer fit |
| Layout preferences | Versioned per-device record through Host persistence | Reuse the existing KV extension boundary for small preferences; keep live focus local |
| Control transport | Extend RACP capabilities and operation catalog; preserve stdio internals | Existing roles, cursors and reconnect rules are reusable. Do not publish raw Electron IPC or Host RPC |
| Browser access | Same-origin HTTPS entry with browser sessions and a limited RACP adapter | Native browser WebSocket cannot set the current Node client's Authorization header; browser access is a new binding, not a port-opening change |
| Native program bridge | Rust platform adapters plus interactive desktop orchestration | Reuse Windows API support; isolated OS-specific behavior with association fallback |
| Validation | Existing Node/Vitest/Rust suites, VitePress and targeted Electron/browser journeys | Real internal wiring; deterministic provider/network boundaries for repeatable capacity and race tests |

The dedicated-table choice is a proposed resolution of the earlier KV-versus-tables
question. It requires an actual schema migration and producer/consumer tests before
implementation acceptance. It does not assign a future schema version in advance.
Installer size alone cannot justify replacing Electron; Agent contexts and native
resource pages remain in the process budget under either shell.

## Architecture and process ownership

```text
Desktop React client                  Mobile / browser client
        | preload IPC                          | HTTPS / WSS
Electron platform adapter              Browser authentication edge
        | local control adapter                 | limited control adapter
        +---------------------+-----------------+
                              |
                 Agent Host command-center services
                 admission / monitor / intervention
                     |                    |
            Host-runtime ports      Native resource bridge
                     |              (interactive user session)
             Node Agent sidecar             |
             main and child runs      associated applications
                     |
               existing tool bridge
                     |
               Rust host-core
       repositories / permissions / tools / SQLite
```

The arrows describe permitted control paths, not new public raw-RPC access. The
browser edge authenticates and dispatches a reviewed catalog to Agent Host. Rust
host-core remains behind its trusted internal transport. Electron remains the
owner of WebContentsView and desktop-specific display lifetimes.

In command-center service mode, one supervisor owns the execution Host, sidecar
and database owner. Closing a client disconnects observation; stopping the Host
is an explicit operation with the existing durable drain/interruption semantics.
A user-session bridge may be needed for desktop-only browser, plugin, native
window and authentication capabilities. Its availability is advertised rather
than presumed. Windows service Session 0 cannot own ordinary interactive windows.

Initially retain one sidecar. Record per-session memory and event-loop pressure
before choosing a bounded process pool. Any sharding change must separately define
session routing, native subagent placement, cancellation, cleanup and recovery;
all shards remain counted within 4 GB.

## Module decomposition

Names in the proposed column are design locations; existing files stay the source
of truth until extraction is implemented.

| Module | Proposed location and responsibility | Dependencies and exclusions |
|---|---|---|
| Shared schemas | `packages/shared/src/command-center/` for target identities, capabilities, commands, summaries and layouts | TypeBox and shared types only; no desktop or filesystem access |
| Client core | `packages/command-center-client` for transport interface, subscriptions, receipts and resync | Browser-safe shared contracts; no Node `ws`, Electron or server imports |
| Shared presentation | `packages/command-center-ui` for overview, task inspector and resource selectors | React, i18n and an injected client; extract/reuse UI primitives rather than copy them |
| Desktop shell | `apps/desktop/src/features/command-center/` for four-surface composition and platform resources | Existing store/services through explicit target adapters; no Agent loop |
| Web shell | `apps/command-center-web` for responsive routes, installability and browser lifecycle | Shared client/UI; capability-based native placeholders |
| Host domain | `packages/agent-host/src/command-center/` with admission, projection and intervention services | Injected repository/runtime ports; no direct SQLite or Electron |
| Host adapters | `packages/host-runtime/src/command-center/` and `apps/pi-host` composition | Internal Rust RPC, sidecar and existing supervisors; no alternate turn queue |
| Child control | A focused module under `packages/agent-runtime/src/` | Delegation registry and Agent safe boundaries; extract from the large runtime entry before adding lifecycle state |
| Durable metadata | `crates/host-core/src/command_center/` plus DB repositories/migration registration | Rust-owned transactions and permission checks; no public network listener |
| Browser edge | A focused adapter composed by `apps/pi-host` | Browser authentication, role checks, bounded payloads and connections; reuses Agent Host services |
| Desktop resources | Focused Electron services plus Rust platform adapter | Existing browser/plugin/terminal owners and authenticated interactive bridge |
| Resource telemetry | Host-owned process inventory and budget controller | OS metrics plus runtime counters; bounded samples and no transcript bodies in metrics |

Refactor in independently testable stages. Introduce explicit target-aware APIs
before mounting multiple resource views. Extract current UI primitives for both
clients without maintaining competing implementations. Avoid extending central
app-store, Electron main or runtime files with the entire command-center workflow.

## Data model and persistence

### Identities and ownership

Keep the canonical `sessionId`, `turnId` and `delegationId`. A native delegation
also has its parent session/turn and a generation identifying this concrete run.
A resumed chain gets a new execution generation while retaining the existing
continuation relationship. Worker sessions use their real durable session IDs.
Do not create a parallel task identity that substitutes for those IDs.

`commandWorkspaceId` is a new operational grouping identifier. The authority is
always paired with `hostId`; neither value accepts filesystem paths. Goals bind
to a stable task reference: the session ID, or the existing delegation-chain root
with its parent session. They survive a new turn or a supported continuation.
Receipts additionally bind the concrete turn/delegation generation being controlled.
Resolve a live execution back to its stable goal owner through Host-owned history,
not a client-supplied alias. Background processes are monitorable targets but are
not Agent runtimes; they have independent process/resource limits.

### Proposed durable records

All tables below are logical schema designs with a `cc_` namespace, not current DDL.

| Record | Key / important fields | Integrity and lifetime |
|---|---|---|
| `cc_workspaces` | ID, name, enabled state, revision | Optimistic revision; at most three enabled execution groups under the Host admission transaction |
| `cc_session_memberships` | Session ID, workspace ID, revision | One membership per session; cannot rebind live work; references existing session records |
| `cc_execution_reservations` | Canonical execution tuple, workspace, owner epoch, state | Unique live reservation; atomic count/check; terminal states release capacity once |
| `cc_goal_heads` | Canonical task target, desired revision, effective revision | CAS on desired head; effective head advances only after the runtime consumption acknowledgement |
| `cc_goal_revisions` | Target plus revision, objective, constraints, actor, request ID | Immutable history; bounded input size; references the affected parent goal revision when applicable |
| `cc_intervention_receipts` | Principal plus request ID, input hash, target, status, timestamps, outcome | Reused key with a different payload conflicts; receipt and goal mutation commit together |
| `cc_parent_notifications` | Parent/child target, goal revision, receipt ID, delivery state | Durable notification intent; parent cannot accept the superseded child revision |
| Layout KV record | Device ID plus profile, format version, layout revision | Preferences only; no live handles, credentials, full transcripts or cross-device focus authority |

Derive quota counts from reservation rows within the same transaction. Agent Host
owns policy; Rust is the sole authoritative reservation store. A Host-side cache
is a projection and cannot grant a slot independently. Never hold a database
transaction across a provider request, subprocess launch or client network await.

Use foreign keys/unique constraints where compatible with canonical identity and
explicit cleanup when child executions do not have independent session rows.
Define task-deletion behavior transactionally: live work must settle or be
explicitly stopped before membership deletion; goals and receipts follow the
existing user-controlled history retention policy. Unresolved receipts cannot be
silently pruned. Hot receipt/projection caches are bounded; durable history stays
paged on disk. The advertised idempotency retention policy must prevent an expired
or unknown old request from being silently treated as a new mutation.

### Runtime-only state

Keep active runtimes, native handles, subscription buffers and pending dispatch
handles in their existing owners. Monitoring rows are reconstructible projections;
full provider messages remain in Agent memory and the canonical transcript store.
Do not persist DOM, WebContents handles, sockets or assumed resumable model calls.
The monitor has a boot epoch and stream sequence; epoch changes force a new snapshot.

## Interfaces and protocol contracts

### Existing operations to reuse

The baseline RACP operation catalog implements `connection/ping`, `session/attach`,
`session/history`, `events/subscribe`, `events/ack`, `events/unsubscribe`, `turn/start`,
`turn/stop`, `turn/interrupt`, `turn/cancel`, `approval/respond` and `input/respond`.
`RuntimePort.steer` and sidecar `agent.steer` exist; a public RACP `turn/steer`
operation must not be assumed to exist. The current default subscription limit
is eight per connection, so monitoring thirty-six tasks must not create thirty-six
session subscriptions.

Extend session creation/binding and the existing start/admission paths rather
than adding an independent command-center executor. Only service-mode sessions
with qualified capabilities enter the new Host-owned path. Existing endpoints
retain role, approval-lifetime and remote-tool disconnect behavior unless an
explicit versioned amendment changes it.

### Proposed client operations

These operation names are a version-1 draft. Add TypeBox schemas, catalog role
rules, producers, consumers and negotiation tests together; do not advertise an
operation until its complete path is implemented.

| Draft operation | Purpose / principal inputs | Result / authority |
|---|---|---|
| `commandCenter/workspaces/list` | List permitted operational groups | Versioned metadata and quota summary; viewer or stronger |
| `commandCenter/workspaces/update` | Create/update/disable with expected revision | New revision; owner; reject changes that strand live reservations |
| `commandCenter/membership/bind` | Session plus workspace and expected membership revision | Explicit association; authorized controller; no live rebind |
| `commandCenter/monitor/open` | Workspace filter and optional resume cursor | Bounded summary snapshot plus subscription/cursor; viewer |
| `commandCenter/conversation/attach` | Canonical main/delegation target, view generation, history limit | Bounded history/live-tail cut and stream subscription; viewer |
| `commandCenter/conversation/history` | Same target and opaque history cursor | Page plus next cursor; viewer; reuses existing history repositories |
| `commandCenter/interventions/submit` | Typed intent and expected target/goal revisions | Durable receipt; intent-specific role, not generic owner bypass |
| `commandCenter/interventions/get` | Request ID and authorized target scope | Same receipt after response loss; no redispatch |
| `commandCenter/nativeApplications/list` | Interactive bridge ID; explicit user request | Ephemeral selectable bindings, permission-filtered |
| `commandCenter/nativeApplications/associate` | Workspace, binding token, expected bridge generation | Association; local/native permission checked |
| `commandCenter/nativeApplications/activate` | Known association ID | Activated, OS-refused or unavailable; no guaranteed focus steal |
| `commandCenter/nativeApplications/detach` | Association ID | Idempotent unlink; does not close the external program |

Reuse subscription acknowledgement/unsubscribe conventions, with connection-owned
subscription IDs and the same backpressure rules. New monitor/conversation stream
kinds need explicit negotiation; do not send unknown event kinds to legacy clients.
Native program operations are absent when the interactive bridge is unavailable.
Mobile receives only the capabilities actually authorized for its principal.

### Illustrative types

The following is schema design, not production TypeScript or a committed wire API.
All identifiers and arrays need bounded TypeBox validation at the actual boundary.

```ts
type AgentTarget =
  | { kind: "session"; sessionId: string; turnId: string }
  | {
      kind: "delegation";
      parentSessionId: string;
      parentTurnId: string;
      delegationId: string;
      generation: number;
    };

type InterventionIntent =
  | { kind: "append"; text: string }
  | { kind: "steer"; text: string }
  | { kind: "reviseGoal"; objective: string; constraints: string[] }
  | { kind: "stop"; scope: "target" | "subtree" };

type InterventionRequest = {
  version: 1;
  requestId: string;
  hostId: string;
  commandWorkspaceId: string;
  expectedHostEpoch: string;
  expectedGoalRevision?: number; // Required for non-stop intents; absent for Stop.
  target: AgentTarget;
  intent: InterventionIntent;
};

type ReceiptStatus =
  | "recorded" | "accepted" | "consumed" | "completed"
  | "rejected" | "conflicted" | "interrupted" | "outcome_unknown";

type InterventionReceipt = {
  requestId: string;
  target: AgentTarget;
  status: ReceiptStatus;
  desiredGoalRevision: number;
  effectiveGoalRevision: number;
  revision: number;
  error?: { code: string; message: string };
};

type MonitorCursor = { epoch: string; sequence: number };
type MonitorSnapshot = {
  version: 1;
  cursor: MonitorCursor;
  generatedAt: string;
  rows: TaskSummary[];
  nextPage?: string;
};
```

`TaskSummary` is a bounded display record: canonical target, workspace/project
references, parent reference, status, waiting reason, latest activity time,
short goal/activity labels, effective/desired goal revisions, pending-human counts
and reported usage. It contains neither full transcript nor provider credentials.
Task discovery uses a summary reference; live interventions require the concrete
current execution target. A settled session has no fabricated active `turnId`.

Start with at most 100 summary rows/page and 100 history items/page, subject to the
existing frame limit and byte-bounded previews. These are versioned proposal limits
to validate in P0. Respect negotiated prompt/frame/subscription limits rather than
copying unrestricted payloads through a new endpoint. Approval/input responses
retain their existing vocabulary and request IDs; they are not flattened into a
free-text steering intent.

### Outcomes, errors and idempotency

`recorded` means a durable intent exists; `accepted` means the live runtime accepted
it; `consumed` identifies a supported execution boundary; `completed` means the
control operation reached its defined terminal result. It is not proof that the
model met the revised objective. For Stop, acceptance and confirmed settlement are
different events. No stop action implies rollback of a prior file write or command.

Reuse existing error categories where accurate: invalid input, forbidden,
capability unavailable, conflict, resource limit, Host disconnected and overloaded.
Draft-specific stale-target or goal-conflict details must be registered before use.
The authenticated principal comes from the transport, never from request fields.
Validate ownership against Host data and recheck execution identity after awaits.

Non-stop mutations require the expected goal revision. Stop validates the Host
epoch, live execution identity, ownership and requested subtree, but a changed
goal revision alone must not block cancellation. The final discriminated request
schemas enforce this difference. Stopping a settled target returns its settled
state rather than selecting a newer run implicitly.

Duplicate request ID with the same payload returns the original receipt without
redispatch; a changed payload conflicts. There is no distributed transaction across
SQLite and arbitrary tools. A failure after dispatch but before confirmed result
can be `outcome_unknown`; inspect/reconcile instead of claiming exactly-once
execution or automatically replaying side effects.

## Data flows and failure handling

### A. Discover and monitor

1. Authenticate, initialize RACP and negotiate command-center capabilities.
2. `monitor/open` captures summary state and cursor at one projection barrier,
   registers the subscription and returns the snapshot plus bounded live buffer.
3. Apply the snapshot, then events newer than its cursor; discard duplicates.
   Buffer overflow, cursor eviction or epoch mismatch requires a fresh snapshot.
4. One monitor subscription feeds all overview/workspace summary lists. Attach
   full conversation streams only for selected resources; stay within connection
   limits and unsubscribe when detached.
5. Foreground clients use `connection/ping` every two seconds, marking stale within
   one further second after six seconds without a reply. Suspend/reconnect uses
   fresh synchronization, not mobile background-timer assumptions.

The new snapshot barrier must be tested with events arriving during history/database
reads. The baseline session snapshot method is a reuse seam, not evidence that a
cross-workspace atomic snapshot already exists. A paged summary snapshot uses a
bounded stable generation; expired pages require restart rather than mixing epochs.

### B. Attach history and live output

1. Capture target and client view generation. Resolve capabilities and read a
   bounded history page plus the current inflight tail at a consistent cut.
2. Register/buffer live events across the cut; merge by canonical message/tool IDs
   and revision. Ignore replies for an obsolete view generation.
3. While reading older pages, keep the reading anchor and update a live-activity
   indicator. Returning to the tail joins the current execution without restarting.
4. On detach, cancel pending reads, unsubscribe content and release expensive view
   objects. Keep only bounded drafts/bookmarks and the summary subscription.

Current RACP text deltas are ephemeral and not replayed. On reconnect, reload the
current inflight/full-item projection and durable history before joining new deltas.
Do not pretend an event cursor can recover every dropped token. Keep durable event
acknowledgement and transient display coalescing separate; publish final complete
messages so the canonical result is not truncated by presentation pressure.

### C. Admit and execute work

1. Existing start/delegation/Worker paths resolve immutable workspace membership.
2. Rust transaction checks membership revision, owner epoch, 12/36 counts and
   duplicates; persist a launch reservation before allocating a runtime.
3. Host-runtime performs launch outside the transaction using the existing Agent
   path. Transition the reservation using the same canonical execution identity.
4. Existing provider/tool/session budgets apply. A waiting tool does not release
   the Agent slot; queued-not-started work has no live runtime.
5. Confirmed settlement releases once. Launch failure rolls back the reservation
   through an idempotent transition. If the outcome is uncertain, reconcile the
   owner/generation before releasing; do not admit replacement work blindly.

All entry points, including plugins and scheduled work, use the same reservation
port. Preserve the current ten-child session ceiling. Use round-robin wake-up
between eligible workspaces around the existing queues; do not add another
persisted prompt queue. Reserve progress for control operations under tool pressure.

### D. Steer or revise a main/child goal

1. Client captures the exact target, Host epoch and expected goal revision.
2. Host authorizes the intent. Rust atomically records the receipt and, for a goal
   revision, appends the new desired goal and durable parent-notification intent.
3. Runtime checks the same live generation, accepts the request and exposes a
   receipt. A stale turn, already-settled child or unsupported boundary rejects it
   explicitly; a durable proposed revision is not silently described as effective.
4. At the next supported model/tool scheduling boundary, runtime consumes the
   instruction, updates the effective revision and records an acknowledgement.
   Already-issued tool effects are not undone. Mark boundaries and receipts so
   history can distinguish earlier actions from actions under the revised goal.
5. Parent coordination invalidates the old child-result revision and supplies the
   correction before the parent accepts the result. A settled parent gets a
   durable follow-up requirement, not an invisible restarted turn.
6. Clients observe the same receipt and revision. A lost response is recovered by
   receipt lookup. A crash with uncertain delivery is not an automatic resubmit.

The child control module needs an explicit steer port; using `Task(resume)` on a
running or explicitly stopped child is not a substitute. Result-version fencing
can prevent the system from accepting a stale result as current; it cannot guarantee
the LLM never semantically drifts. The operator sees the actual subsequent activity.

### E. Recover the Host or change clients

A renderer reload/mobile disconnect releases client subscriptions, not Host-owned
turns. Reconstruct client state with negotiated snapshots and receipts. Desktop
focus and mobile focus remain separate. Concurrent approvals use the original
request identity and settle once.

On Host/sidecar failure, apply existing interruption and no-replay semantics. Recover
persisted records, invalidate old live epochs, reconcile reservations and classify
uncertain commands. Before admitting new work, prove the old execution owner is
stopped or fenced; startup cannot release slots while an orphan sidecar still runs.
Browser-edge restart may invalidate client sessions and require authentication;
it must not launch another database owner or resume side effects.

## Client layout and foreground scheduling

Represent layout as a versioned tree restricted to four leaf surfaces. The overview
leaf cannot be deleted. Workspace leaves reference operational groups and selected
resources; a `maximizedSurfaceId` is view state over the retained layout rather than
a second execution mode. View generation counters prevent delayed history/native
bounds from applying to a reassigned leaf.

Normalized stores separate task summaries, attached transcript windows, drafts,
receipts and local layout. Use per-target selectors. Commands always receive an
explicit captured target; no command consults a mutable global active session after
an await. The existing single-session layout uses the same models and components.

| View condition | Presentation policy | Execution policy |
|---|---|---|
| Focused/maximized | Prioritize input; coalesce live text on animation frames; bounded markdown/highlighting | No extra permission or execution ownership |
| Visible but unfocused | Update summaries/live content in bounded batches; no unrelated auto-focus | Normal fair execution |
| Hidden behind maximize | Stop transcript layout, measurement, follow-scroll and speculative history loads | Continue Agent and required browser/terminal activity |
| Overview not expanded | Keep attention counters and lightweight state subscription | Always allow explicit stop/approval access |
| Mobile suspended | No promise of active JS/socket; mark stale on resume until resync | Host continues independently |

Make scheduling adaptive to measured main-thread budget; animation-frame batching
alone does not make expensive markdown work free. Blocking dialogs must occlude all
native resource views. Native bounds updates carry surface identity and generation.
Software-rendering profile is selected before Electron ready; core UI requires no
WebGL/WebGPU, continuous screenshots, video capture or GPU inference.

## Resource governance

Use the [resource contract](ai-command-center-requirements.md#resource-and-performance-contract)
unchanged: proposed decimal 4 GB, contemporaneous Private Bytes across all owned
processes, maximum 100 ms sampling interval plus available correlated diagnostics,
and explicit external-payload accounting. The sidecar old-space limit is not a
process-memory meter. Measure both normal desktop and software-rendering/RDP paths.

Separate budgets for live Agents, prompt/context retention, display history,
subscriptions, browser/plugin pages and PTYs. One overview and three attached
resources do not justify thirty-six hidden WebViews. Count the browser chrome,
backing window and plugin workers as well as visible pages. Do not count an external
application in the budget simply because it is associated; do not exclude an owned
bridge just because it is detached.

A Host resource controller observes the owned process inventory and applies
configurable high/low watermarks with hysteresis, chosen from P0 measurements:
release rebuildable view caches, stop speculative loads, then defer new resource
admission with a visible reason. It cannot silently discard runtime state, approvals,
unsaved browser forms or terminal processes. Capacity qualification still requires
36 actual overlapping executions under the frozen workload, not safe queuing.

Bound event buffers by bytes as well as count, because a tool result can be much
larger than an activity update. Limit outstanding history reads; cancellations
release buffers. Retain only bounded recent receipts in memory. Larger tool results
and images follow canonical durable storage and paged previews. Disk growth and
retention remain visible; low RAM is not a license for unbounded logs or silent data
loss. The monitoring path should not run an extra LLM per task.

## Native applications and platform delivery

Association is a host-mediated link to an explicitly selected program/window.
The desktop bridge enumerates eligible windows only on user request, issues opaque
short-lived selection tokens, and validates PID plus process creation identity,
window identity, bridge generation and ownership before every action. Renderer and
mobile requests cannot supply an arbitrary trusted HWND or invoke raw Win32 calls.

Support activate/locate and detach first. OS focus denial returns an actionable
result. Association does not resize/embed a program unless that adapter and action
are supported and requested. Detach never closes it. Optional embedding must restore
parent/style/bounds and account for child dialogs, DPI changes, elevated/protected
windows, bridge crash and program restart. No universal compatibility is asserted.

| Platform | First supported path | Additional qualification |
|---|---|---|
| Windows/RDP | Electron desktop, interactive bridge, ordinary application association | Software rendering, IME, DPI, disconnect/reconnect; selected Win32 embedding later |
| macOS | Electron plus native association capabilities allowed by the OS | Actual Mac and permissions; no promise of arbitrary cross-process embedding |
| Linux | Electron/Host plus browser control; report native capability matrix | Separate X11/Wayland and distribution tests; explicit fallback where enumeration/control is restricted |
| Android/iOS | Responsive Web/PWA monitoring, history, intervention and approval | Actual devices, touch, suspension/reconnect; native packaging/push independently qualified |

Phone UI retains four logical destinations with one focused content area. Tablets
may show multiple areas when usable. A mobile command can address an authorized
Host-side program operation; it cannot embed arbitrary phone apps or become a full
remote desktop stream through this protocol. Remote desktop access and command-center
network control are separate deployment concerns.

## Security and client authentication

The proposed browser edge serves the app and control endpoint from the same HTTPS
origin. Enrollment uses an expiring, single-use Host-approved pairing exchange.
After enrollment, use a secure HttpOnly browser session cookie with explicit
SameSite policy; validate Origin at connection establishment and require a
session-bound CSRF value for mutations. Tokens never appear in URLs. Persist and
revoke device identity using the Host credential authority, not a renderer secret
store. A private network does not remove authentication or authorization checks.

Adapt authenticated principals into the existing RACP role checks. Do not proxy
all browser traffic through one unrestricted owner credential. Preserve device
identity and apply the policy ceiling; each new operation receives a catalog role
rule and target-scope validation. Revoke active connections promptly. No raw
Electron IPC, stdio RPC, provider keys or arbitrary shell endpoint is exposed.

Browser bindings must respect the same schema, payload, connection and rate limits
as native clients. TLS termination and trusted-proxy settings are deployment-owned;
the existing loopback listener is not simply rebound to a public interface. New
security-sensitive storage and transport semantics require protocol/security-spec
updates before exposure.

Local application association is not authorization for Agent computer use. Plugin
views retain their sandbox, partition and network rules. Session worktrees remain
opt-in compatibility behavior until explicitly changed; multiple writing tasks need
clear root/worktree selection and collision warnings. Worktrees do not isolate all
MCP/external-service/absolute-path effects.

## Migration and compatibility

1. Add schemas and pure client/domain seams with existing behavior unchanged.
2. Add Rust schema migrations for the proposed command metadata, with old populated
   data and interrupted-upgrade tests. Assign the next schema version only at the
   actual implementation base; do not change existing transcript semantics.
3. Introduce an explicit command-center service mode after inventorying provider
   authentication, attachments, MCP, plugins, browser/terminal and approval support.
   Retain unsupported existing sessions on their original path with clear capability
   status rather than silently switching execution location.
   This is an exclusive deployment-mode choice for a data directory, not two
   concurrent writers. Until parity exists, remain on the original mode or migrate
   only through an explicitly supported ownership handoff.
4. Transfer data-directory ownership only while existing work is quiescent, under
   the established exclusive lock/maintenance boundary. Stop the previous writer,
   preserve rollback/recovery metadata and start one new owner. Never copy active
   SQLite files or run Desktop and service writers together.
5. Add negotiated command-center operations and browser binding. Old clients keep
   the current protocol surface; missing capability is explicit. Regenerate relevant
   schemas/fixtures when implementation changes shared contracts.
6. Restore layout conservatively when a referenced session/plugin is missing. Keep
   an accessible overview and offer a recovery action. Layout rollback does not
   imply database downgrade; old binaries must refuse unsupported new schemas.

Service mode keeps model secrets and transcripts on the selected same-machine Host
unless the user explicitly chooses another execution location. It does not silently
supersede the existing local-Agent/remote-tools decision. Local indefinite permission
approvals and remote approval policies must retain their distinct documented
lifetimes; do not accidentally inherit a headless default during handoff.

Update the affected baseline, process, runtime, storage, IPC/RACP, UI, security,
plugin and E2E specs in each implementing phase as listed in the requirements.
This proposal remains outside the normative implemented-behavior claims until those
changes are approved and verified.

## Milestones and effort

The [requirements phase table](ai-command-center-requirements.md#delivery-phases-dependencies-and-estimates)
remains the cost source: P0-P6 total 80-135 person-days, or approximately 100-169
including a 25% uncertainty reserve, for Windows plus mobile Web/PWA. Native
macOS/Linux, selected embedding, possible sidecar sharding and native mobile
packaging are separately estimated there. These are planning ranges, not a quote.

| Milestone | Engineering output and dependency | Exit evidence |
|---|---|---|
| P0: qualify design | Freeze load fixture, devices, apps, Host parity and interface/data decisions | Baseline memory artifacts, prototype feasibility, reviewed contracts; no capacity promise without evidence |
| P1: execution boundary | Rust records/ports, independent owner handoff, negotiation and durable receipts | Migration/crash tests; one writer; compatibility matrix and security foundation |
| P2: monitoring client | Portable API/models, summary projection, four surfaces, paged attach/maximize | Main/child user paths, snapshot races, focus and history tests |
| P3: task control | Atomic admission, steering and child/parent revision coordination | All start paths covered; stale/duplicate/race cases; no quota bypass |
| P4: desktop programs | Interactive bridge and association adapters | Nominated apps, focus denial, identity replacement, detach and RDP tests |
| P5: mobile access | HTTPS browser edge, responsive Web/PWA and cross-client synchronization | Enrollment/revocation, phone intervention, concurrent approval and resume tests |
| P6: release qualification | Capacity/performance tuning and complete regression evidence | AC-01 through AC-16 for the claimed release/platform scope |

P1 and UI work in P2 can overlap after shared contracts stabilize. P4 and P5 can
proceed independently after control targets are stable. One integration owner
maintains the contracts and acceptance matrix. Each work item names its owning
module, representative user path, applicable spec change and check set.
Windows-first is confirmed; mobile versus native macOS/Linux order is proposed
and remains a P0 scheduling decision. Do not label the full cross-platform product
complete when only the Windows/mobile subtotal has been delivered.

Each code-bearing phase uses its own branch/worktree from current remote main,
reuses compatible toolchains, and validates the known task and PR integration
candidates under repository policy. Commit/push/merge boundaries follow the user's
actual instruction. This documentation request authorizes a local documentation
commit; it does not itself authorize runtime implementation or remote publication.

## Risk register

| Risk | Detection | Response / release consequence |
|---|---|---|
| 36 contexts exceed 4 GB | Fixed 32k-token fixture plus larger-context measurement, complete process inventory | Optimize measured retention; revise implementation/cost if needed; queued agents cannot pass capacity |
| Snapshot misses events | Controlled event injection around async history and subscription setup | Atomic projection cut, bounded buffer and explicit resync |
| SQLite/dispatch failure creates duplicate or unknown action | Crash after each receipt/dispatch/ack boundary | Persist identity and outcomes; reconcile uncertain delivery; never promise arbitrary exactly-once side effects |
| Parent accepts obsolete child work | Race goal revision against child completion and parent consumption | Result revision fencing and durable parent notification; expose settled-parent follow-up |
| Admission deadlock or leaked slots | Simultaneous starts/stops, provider waits, maintenance and orphan process tests | One reservation authority, no transaction held over awaits, terminal reconciliation before reuse |
| GUI capability disappears with desktop | Close/restart bridge, RDP disconnect/logoff, missing plugin/provider | Advertise dependency and fail safely; independent non-GUI work continues |
| Browser access weakens local boundaries | Role/Origin/CSRF/revocation tests and schema fuzz cases | Dedicated authenticated edge and explicit operation catalog; block exposure until gate passes |
| Software rendering stalls input | Native input and page telemetry during full load | Reduce hidden work and expensive synchronous render steps; protect control admission |
| Native application adapter corrupts placement or targets reused identity | Program restart, HWND/PID reuse, elevation, child-dialog and crash cases | Validated binding tokens, restoration and association fallback; no unsupported embedding claim |
| Platform scope expands indefinitely | Compare nominated device/app matrix with milestone acceptance | Explicit support levels; separate optional adapter/shipping work from core control semantics |

## Acceptance and validation

All acceptance cases below are **NOT RUN** for this design document. The quantitative
thresholds and workload are defined in the [requirements acceptance table](ai-command-center-requirements.md#acceptance-criteria).
This mapping adds development evidence without creating competing target numbers.

| Gate | Required implementation evidence |
|---|---|
| AC-01, AC-02 | Four-surface reducer and real UI interaction; protected overview; health timeout with controlled clock; monitor projection without per-task transcript loading |
| AC-03 | Main/child paged history plus concurrent stream, loss of ephemeral deltas, stale view generations, bounded detach cleanup and canonical final output |
| AC-04 | 1,000 mixed controls with target switching/delayed replies; duplicate key with same/different payload; crash around dispatch; inspectable uncertain outcomes |
| AC-05 | Direct running-child steering, effective goal revision, parent notification, result fencing, settled parent and unsupported continuation paths |
| AC-06 | Atomic 12/36 limit across all start sources, two clients, pending approvals, cancellation, hidden workspaces and failure before/after runtime allocation |
| AC-07 | Co-located real runtime/Host/storage/UI path, 36 overlapping instances and complete process-memory artifacts under the fixed fixture |
| AC-08 | Full-load software-rendered native input: P95 at most 100 ms input-to-paint, 250 ms warm switch and 500 ms stop-request admission; at least 1,000 samples |
| AC-09 | Two-hour/100-cycle soak; at most 10% equivalent steady-state memory growth; no orphan subscriptions/resources; hidden running resources survive |
| AC-10, AC-11 | Nominated real programs, explicit focus denial, detach/recovery, RDP reconnect, DPI and Chinese IME; no native view above a blocking dialog |
| AC-12, AC-13 | Desktop start and phone steer/approval, independent focus, suspended mobile/network change, no mutation replay and consistent resync |
| AC-14 | Existing populated data, exclusive handoff, schema-too-new, partial migration, orphan sidecar and Host/runtime crash recovery |
| AC-15 | Device/principal isolation, session/target validation, revoked devices, invalid Origin/CSRF/URL tokens, no secret/raw-RPC exposure |
| AC-16 | Existing desktop, plugin, permissions, provider and remote-tools paths; accessibility/i18n; each claimed native/mobile platform tested on its nominated matrix |

Use pure tests for layout/identity/reducers; contract tests for schemas, roles,
capabilities and error mapping; integration tests for admission, persistence,
receipts and stream handoff; targeted Electron/browser/native journeys for actual
process, input and OS boundaries. Provider fixtures must exercise real internal
wiring. Real-provider quality/limits and cost need separate authorized evidence.

For the current documentation-only change, run page/ADR and locale checks,
agent-policy synchronization, the VitePress build, local link/TOC and pinned-source
validation, plus Git whitespace/base checks. No runtime E2E or provider call is
needed to validate a design document. Report skipped implementation gates as not
run; do not turn a successful documentation build into a performance claim.

## Open inputs and decision gates

| Input / decision | Needed by | Proposed default / owner |
|---|---|---|
| Machine, OS, CPU/RAM, RDP client and network | P0 capacity fixture | Eight-core Windows 11 reference from requirements; user supplies actual environment |
| Model/context/tool/plugin workload | P0 budget qualification | Thirty-six 32k-token runtime fixtures; owner records larger-context envelope and provider quotas |
| Required native programs and privilege levels | P0/P4 | Association first; user nominates at least three programs/workflows before adapter qualification |
| Meaning of twelve agents and workspace grouping | P0 schema/admission | Count all live main/child/Worker instances; one Host and three enabled groups |
| Browser/mobile devices, access network and push | P0/P5 | Same-origin self-hosted HTTPS and Web/PWA; no mandatory cloud or background socket |
| Native macOS/Linux versus mobile schedule | P0 planning | Windows first; remaining order is a product decision, not an assumed confirmed sequence |
| Dedicated schema and receipt retention | P1 design review | Tables and versioned KV as specified; assign actual migration version at implementation base |
| Runtime consumption boundary and parent fence | P3 contract review | Defined model/tool scheduling boundary, explicit old-result handling; no implicit Task-resume substitute |
| Desktop capability parity and Host startup | P0/P1 | Explicit same-machine service mode; inventory credentials, providers, MCP, plugins and GUI dependencies |

Missing entries do not prevent this document's submission. They prevent particular
implementation or release guarantees. Resolve them with evidence or explicit
product choices before dependent work; preserve the hard user constraints and
record changes instead of silently reducing the acceptance workload.

## Source references

Pinned evidence, inspected for this design; links describe existing behavior only:

- [Agent Host ports and runtime boundary](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/agent-host/src/ports.ts)
- [Agent Host admission and snapshots](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/agent-host/src/agent-host.ts)
- [Event retention, replay and slow-client handling](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/agent-host/src/event-log.ts)
- [RACP operation catalog](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/racp/src/operations.ts)
- [RACP event and capability schemas](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/shared/src/racp.ts)
- [Loopback WebSocket binding](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/racp/src/ws-binding.ts)
- [Runtime steering and lifecycle](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/host-runtime/src/runtime-service.ts)
- [Rust-owned schema](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/crates/host-core/src/db/schema.rs)
- [Independent Host composition](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/pi-host/src/app.ts)
- [Headless runtime architectural boundary](../adr/0284-headless-runtime-boundary.md)
- [Browser/native remote security profiles](../spec/05-security/02-remote-control-security.md)
