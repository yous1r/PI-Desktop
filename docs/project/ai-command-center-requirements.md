# AI command center: requirements and delivery proposal

- Status: Proposed; requirements for review, not an implementation or capacity claim
- Date: 2026-11-08
- Source baseline: `origin/main` at `fd28eb89866ac513912ed109716e7120cf60f18c` (v0.22.3)
- Architecture: [AI command center ADR](../adr/ai-command-center.md)
- Development design: [Modules, contracts and data flows](ai-command-center-development-design.md)
- Scope of this change: documentation only; no executable behavior, default, data, network listener, or protocol version changes

## Purpose and problem

Provide a low-memory command center for AI work that runs mainly in the
background. An operator monitors many tasks, attaches to any authorized session
or subagent, reads its history and live output, corrects its direction, resolves
questions and approvals, and returns to monitoring without restarting the work.
Desktop, phone and tablet clients observe and control the same execution owner.

The current application has reusable session, permission, delegation, terminal,
browser and remote-Host foundations. Its single-active-session presentation,
connection-specific runtime paths and desktop-only client API do not yet provide
this product. The ADR records baseline evidence and technology alternatives.

## Confirmed requirements and proposed interpretations

| ID | User requirement | Interpretation used in this proposal |
|---|---|---|
| U-01 | Preserve low memory consumption | Measure both absolute capacity and the change from the current version under the same workload |
| U-02 | Background execution with live monitoring and intervention, including subagents | Monitoring is the default; conversations are loaded on demand; direct subagent steering is a required new capability |
| U-03 | One permanent overview plus at most three application-internal workspace windows | Four surfaces in total, not four OS windows; maximize/restore stays inside the application |
| U-04 | Maximize a workspace and favor its page performance | Maximize within the application, retain urgent status/overview access, reduce hidden presentation work |
| U-05 | No more than twelve agents per workspace | Proposed counting includes main agents, native subagents and Worker sessions; three workspaces yield a thirty-six-instance Host limit |
| U-06 | At maximum parallelism, application processes stay within 4 GB | Use a qualified workload and measured application-owned process group; propose decimal 4,000,000,000 bytes as the stricter interpretation |
| U-07 | No GPU-dependent features; remote connections are the usual environment | Core monitoring/control works with software rendering; qualify Windows RDP explicitly |
| U-08 | Each of the three workspaces can connect to local programs; compare embedding and association | Recommend association by default, named embedding adapters optionally; universal embedding is not promised |
| U-09 | Cross-platform, including mobile; Windows first, macOS later | Keep Electron for desktop, add responsive Web/PWA for Android/iOS; qualify Linux and desktop-native adapters separately |

U-05 counting, decimal memory units, service deployment, mobile feature scope,
and the external-application compatibility list are explicit design proposals.
They are not silently presented as already approved implementation details.
P0 resolves them without weakening the confirmed window, capacity or memory goals.

## Scope and vocabulary

| Term | Meaning and ownership |
|---|---|
| Execution Host | One authoritative command-center deployment; owns execution, admission and persistence through the existing Host modules |
| Command workspace | An operational grouping of tasks with a twelve-agent limit; not a filesystem root, existing project group, or Git worktree |
| Workspace surface | A device-local view that can attach to authorized work; changing it does not transfer execution ownership |
| Agent instance | An admitted main-session turn runtime, native delegation execution, or Worker-session execution; canonical IDs remain distinct |
| Task summary | A bounded projection of authoritative state, not a copy of the full transcript or a new executor |
| Attached conversation | A selected session/delegation with paged history and live updates, using the existing execution instance |
| Local application | A program on the machine where the desktop bridge runs; for RDP, this is the remote desktop machine |

The first deployment has one execution Host, up to three workspaces admitting
agents, and at most three workspace surfaces per client. Other saved workspaces
can be inactive. Hiding an executing workspace does not free an execution slot.
A desktop and a phone share those limits; they do not each receive thirty-six
slots. Viewing another session does not move its quota, credentials or tool root.

Out of scope for the first release: arbitrary OS window management, remote GUI
video streaming, unlimited simultaneously mounted conversations, local mobile
Agent execution, GPU inference, automatic semantic correction of all tasks,
a mandatory vendor cloud, and distributed admission across multiple execution
Hosts. Ordinary remote workspace tools remain within their existing contracts.

## Representative user paths

1. **Monitor and intervene:** create tasks in three workspaces, leave the overview
   visible, open a task requiring attention, page through its history, submit a
   correction to its current execution, observe the receipt, then return to the
   overview while the task continues.
2. **Correct a child:** expand a task's delegation tree, attach to a running
   child, revise its objective, observe the child's consumption boundary and the
   parent's updated expectation, and inspect the result against the new revision.
3. **Focus under load:** maximize workspace B while all workspaces execute; type,
   scroll and stop a task; receive an urgent approval from workspace A without
   losing B's draft or focus; restore the previous layout.
4. **Use an external program:** associate a user-selected program with workspace
   C, activate it, return to the workspace, and detach it without closing or
   corrupting the program. Unsupported embedding falls back to association.
5. **Switch devices:** start a task on Desktop, inspect and steer it on a phone,
   suspend the phone, reconnect, and see a consistent history and one command
   result on both devices. Desktop focus remains unchanged.
6. **Recover:** reload the renderer, disconnect RDP, restart a client, or crash a
   runtime in an isolated fixture. Recover the documented state without duplicate
   execution, stale actionable approvals or a second database writer.

## Functional requirements

### FR-01: Global monitoring

Show workspace/project identity, task objective and revision, parent/child links,
status, current tool/activity, last change time, waiting reason, pending human
requests, bounded output summary and reported usage. Group and filter by workspace,
project, state and attention. Do not invent completion percentages or equate a
completed tool with a completed task. Model cost is unknown when pricing is absent.

Present a compact list/tree by default. Do not mount transcripts, native browser
pages or terminals for every task. Use one summary subscription per client with
bounded aggregation. Routine summaries may be coalesced; urgent events and final
outcomes must be delivered reliably. A foreground client sends one application-level
health probe per connection every two seconds. If six seconds pass without a valid
health reply, mark the projection stale/unknown within one further second. An
explicit connection-loss signal marks it stale on the next UI update. On return
from mobile suspension, keep it stale until resynchronization completes rather
than relying on background timers. Freshness is distinct from whether an Agent
is doing useful work.

### FR-02: Four-surface shell and focus

Support one non-closable overview and zero to three logical workspace surfaces,
with keyboard navigation and workspace maximize/restore. The latest
[v3 visual review](ai-command-center-visual-review.md#v3-desktop-toolbar-and-settings)
replaces the default side-by-side workspace previews: the overview shows monitoring
at upper left and workspace entry tabs at upper right. Selecting a tab enters that
workspace as a focused page. Both lower overview regions remain undecided and
non-interactive; no task tree, review view or other feature is assigned to them.
Do not permit a fourth workspace. Desktop uses top-toolbar icons for Overview,
History and Settings, with accessible names and hover/focus labels; it has no global
left navigation sidebar. Host status also appears in the toolbar. Workspace task
lists and Settings' internal category navigation retain their local purpose.
Return/maximize preserves attention state, drafts and reading position. Narrow
displays retain the same logical destinations without forcing four content panes.

Each workspace surface selects one detailed resource: conversation, child history,
terminal, review, browser/plugin view, or associated-application controls. Switching
resources must preserve ownership and relevant drafts/bookmarks. By default, avoid
multiple editable views of the same conversation within one client: focus its
existing view. Device-local focus does not alter another client's selection.
All product strings use i18n, controls use shared UI primitives, and shortcuts
extend the configurable registry with IME/editable-control guards.

### FR-03: Attach, inspect and detach

Attaching resolves a canonical execution identity and capability set, loads a
bounded history page and joins the live tail without launching another Agent.
Earlier history uses cursor pagination and preserves scroll anchors. Displayed
history is not silently replaced with a model compaction summary. Detaching saves
bounded draft/bookmark state and releases heavy view resources while work continues.

Unknown/deleted sessions, changed generations and missing resources show explicit
states. A late reply cannot repaint a newly selected task. Background summaries
remain current even when no conversation is attached. Large text, images and tool
results use bounded previews and explicit expansion.

### FR-04: Human intervention

Support append information, steer the current main execution, revise a task goal,
resolve an owned approval/question, stop a chosen execution, and continue where the
runtime advertises a supported continuation. Do not promise a universal pause or
rollback. Changing provider/model mid-turn remains subject to existing capabilities.

Every mutation carries an idempotent request identity and explicit target. Validate
Host/workspace/session membership, expected turn and generation, and applicable goal
revision. Capture the target before asynchronous work. Distinguish submitted,
accepted, consumed, rejected/conflicted and failed/interrupted results. A response
loss produces an inspectable outcome; reconnect does not submit the mutation again.

Persist objective revisions and intervention receipts through Rust ownership.
Concurrent revisions conflict instead of silently overwriting each other. An
already-resolved approval is shown as resolved on every client. Permissions remain
Host-authoritative; no intervention silently widens a tool grant or operating mode.

### FR-05: Native subagent control and parent consistency

Expose the real delegation chain and execution ID, live state, history, tools and
supported actions. Add direct steering of a running child at a defined runtime
boundary. Existing `Task(resume)` only supports qualifying settled delegations and
must not be used as a disguised running-child input channel.

A child-goal revision records its relationship to the parent goal. Parent result
acceptance must check that revision: notify a running parent at its next supported
boundary and durably invalidate an idle parent's stale expectation. A parent must
not silently reissue the superseded goal or accept an old result as satisfying the
new one. If the parent already settled, report that state and require an explicit
follow-up rather than pretending to revise a completed outcome.

Explicit child Stop, interruption, failure and completion retain their distinct
continuation eligibility. When continuation is unavailable, the interface says so;
a new run, if requested, records its relationship and preserves prior history.
Stopping one child does not implicitly stop its siblings or parent. Parent/subtree
stop behavior must be explicit and tested.

### FR-06: Atomic workspace admission

Cap live agents at twelve per command workspace and thirty-six per Host. Count
launch reservations, model streaming, tool/resource waits, waiting for human input,
and cancellation until confirmed settlement. Count parent runtimes waiting on live
children; do not count a settled parent twice merely because its children continue.
Reserve before creating a runtime. Retry/reconnect retain identity and capacity.
Release once after settlement; reconcile abandoned reservations on Host recovery.

Apply admission to desktop, mobile, scheduled work, plugins, native Task delegation
and Worker creation. A live execution belongs to one workspace; membership cannot
change while live. Unassigned starts require an explicit workspace selection or a
recorded default, not an unmetered path. Existing ten-child per-session and tool
budgets remain additional constraints. A twelve-instance test can use two main
agents plus ten children in each workspace without raising the existing child cap.

Queued work has an explicit reason and does not allocate a live Agent. Closing or
hiding a surface does not free its execution workspace; starting work in a fourth
workspace is refused/queued until a slot is available. Tool, PTY, browser, provider
and memory budgets are independent. The current eight-PTY device bound stays unless
separately changed and tested.

### FR-07: Resource lifecycle and foreground scheduling

Prioritize user input, visible output and current-history fetches. Batch other
visible updates and stop hidden measurement/highlighting/auto-scroll. Keep summaries,
permissions, cancellation and durable results independent of presentation throttling.
Do not raise the whole application to real-time OS priority or starve other tasks.

Bound history caches by bytes as well as count. Release settled runtime state when
safe, preserve recoverable history, and never serialize an assumed resumable model
call or evict pending approvals to save memory. Do not discard browser forms or
terminate shells simply because another workspace maximized. Native surfaces share
explicit bounds, occlusion, zoom and cleanup ownership; blocking overlays cannot
leave an unrelated WebContentsView receiving clicks above them.

Memory pressure first drops rebuildable presentation caches, stops speculative
loads, and limits new resource admission. Show the reason for any wait. Do not kill
running work or weaken persistence to satisfy a memory number. Workload overload is
a visible operating condition; sustained capacity must still pass the separate gate.

### FR-08: Native application association

Each workspace can associate ordinary user-session applications through explicit
selection; its current application can be launched or activated when permitted.
Store a validated binding with process start identity and window generation, not
only a reusable PID/handle. Handle application restart, multiple windows, focus
refusal and elevated/protected windows without controlling an unrelated program.

Association preserves the external application's own window. It does not show that
program inside the application surface and does not authorize Agent desktop input.
The UI distinguishes association from embedding. Detach does not close the program.
Optional embedding is a named adapter with tested restoration of parent/style/bounds,
child-dialog behavior and crash recovery. No live screenshot wall is required.

Interactive control belongs to a user-session bridge, not a Session 0 Windows
service. During RDP disconnect/logoff, surface availability follows actual platform
capabilities; execution requiring an absent bridge reports unavailable/blocked.
Headless non-GUI work remains independent. Native remote GUI streaming is deferred.

### FR-09: Independent Host, persistence and compatibility

In service mode the selected Host owns Agent execution, metadata, transcripts,
credentials, queues and approval state, even when clients disconnect. Closing a
client and stopping the Host are distinct actions. Host shutdown drains documented
durable writes and interrupts work without automatic side-effect replay. GUI bridge
loss must be distinguished from Host failure.

Only one Rust owner may access the application's SQLite database. Service adoption
requires exclusive handoff, schema/version checks, failure recovery and a tested
upgrade path. Do not automatically relocate credentials or change existing remote
project ownership. Keep current desktop paths available until their providers,
attachments, MCP, plugins, browser/terminal and permission behavior have qualified
Host equivalents. Unsupported capability is explicit, never an implicit fallback.

### FR-10: Cross-platform clients and secure transport

Share browser-safe domain models and presentation components; implement Electron
IPC and browser network adapters separately. Reuse RACP semantics and negotiation.
Add an authenticated HTTPS browser edge; preserve internal stdio RPC and loopback
restrictions. Browser authentication, Origin/CSRF controls, device revocation and
role checks must follow the remote security specification. Never forward arbitrary
IPC/RPC or provider secrets to a client. Do not use credentials in URLs.

Mobile supports overview, task detail/history, main/child intervention, stop and
approval on the same Host. It has no local Agent runtime. A phone uses one focused
surface and switches among the overview and three logical workspaces; a tablet may
show multiple surfaces where usable. Mobile suspension/network changes are normal:
resynchronize from cursors or a snapshot, show disconnected state, and avoid replay.
Push notifications are a separately qualified capability with redacted content;
continuous background sockets and offline mutation submission are not promised.

## Platform delivery matrix

| Platform | Core target | Native applications and limits | Qualification |
|---|---|---|---|
| Windows | Electron, four surfaces, independent Host, software-rendering profile | Association baseline; selected embedding optional; interactive user session required | First native release; real RDP, DPI and IME tests |
| macOS | Electron and the same Host/client contracts | Association through allowed APIs; permission prompts where required; no universal embedding | Later native release on a Mac |
| Linux | Electron/Host where supported, plus browser client | Distinguish X11 from Wayland; explicit fallback for restricted window enumeration/control | Separate distribution/display-server matrix |
| Android phone/tablet | Responsive Web/PWA control client | Host-side application status/actions only; no arbitrary local-app embedding | Real-device browser, background/reconnect and touch tests |
| iPhone/iPad | Responsive Web/PWA control client | Same control semantics; installed-PWA/push support qualified by OS/browser version | Real iOS/iPadOS device; native packaging later requires macOS/Xcode |

Cross-platform does not imply identical native window privileges. Preserve the
existing desktop behavior on other platforms while adding the Windows path.
A mobile control client is not a remote desktop client. The Host must be reachable
through a user-approved private network or secured endpoint; no cloud service is
introduced by default.

## Resource and performance contract

### Measurement boundary

The proposed hard budget is **4,000,000,000 bytes (decimal 4 GB)**. On Windows,
measure the sum of Private Bytes for the contemporaneous application-owned process
set; also report private working set, total working set, CPU, queue depths and
sidecar heap/external allocations. Working set alone can fall through paging and
is not sufficient. Do not sum each process's lifetime peak as if those peaks
occurred simultaneously.

Include Electron processes, Rust Host, Agent sidecars, plugin workers, browser
views/backing hosts, terminal hosts, desktop bridge and any new browser-edge
process. Track detached processes by explicit ownership, not only current parent
PID. Test fixture/provider generators are separate instrumentation. Report external
applications, shell/build payloads and independently operated model servers
separately. Moving an application component to another process or machine cannot
hide its footprint; the principal acceptance configuration co-locates execution,
control edge and Desktop. Distributed deployments report all components per host.

Sample at intervals no greater than 100 ms and compute the maximum of the
contemporaneous process-set sums over the whole run. Preserve timestamps,
collection skew, process membership and raw values. Per-process OS high-water
statistics are diagnostic cross-checks, never added to claim a group peak.
Capture correlated OS allocation/commit traces around launches and transitions
where available; any demonstrated group-budget breach fails the gate even if it
falls between samples. Record instrumentation coverage and unseen-peak limits:
this evidence does not prove an absolute allocation bound for arbitrary workloads.
Do not use process-kill/OOM enforcement to pass the functional capacity test.
Mobile/browser client budgets are frozen in P0 on nominated devices.

### Initial engineering allocation

| Category | Decimal MB planning envelope |
|---|---:|
| Electron Main, Rust Host and coordination | 400 |
| Shared renderer, overview and attached views | 500 |
| Agent execution contexts across all instances | 1,800 |
| Plugin processes and embedded resource pages | 400 |
| Remaining owned bridge/transport helpers | 200 |
| Peak and allocation headroom | 700 |
| Total | 4,000 |

Allocate each process exactly once. These envelopes are planning hypotheses, not
measured baselines or individually enforced quotas. The average implied execution
budget of roughly 50 MB per instance must be tested with real runtime context
construction. Do not use a V8 heap limit as a total-process estimate.

### Proposed reproducible load suite

All numbers below are initial gate inputs, to be frozen and checked into fixtures
at P0. Any later relaxation must be recorded with a reason and reviewed; it cannot
be applied after a failed run merely to report success.

- User-confirmed minimum target: **two CPU cores and 8 GB RAM**, SSD, no required
  discrete GPU. The current development machine has six logical processors and
  approximately 24 GB RAM; it is a comparison host, not minimum-target evidence.
  Record exact OS/build, CPU model, physical/logical core topology, usable bytes,
  storage and Electron/Node/display settings. A two-vCPU, 8-GB VM is a documented
  qualification candidate, not automatically equivalent to every two-core CPU.
  The same 12/workspace, 36/Host, 4,000,000,000-byte application budget and AC-08
  interaction gates apply. CPU affinity on the larger machine is preflight only;
  it does not reproduce 8-GB system paging pressure. The historical 6-GB soak
  stop threshold is not a product memory allowance.
- Test 1920-by-1080 and 2560-by-1440, software rendering, four-surface mode and each
  workspace maximized. All runtime processes run on the reference machine.
- Each workspace has two live main sessions and ten live children, preserving the
  existing ten-child per-session ceiling. Record every admitted execution and
  periodic progress; all thirty-six are active in the sustained streaming phase.
- Add a representative mixed phase per workspace: two main sessions, six native
  children (three per main) and four Worker executions, for twelve total. Record
  exact execution identities and synchronized progress for all 36. This phase
  complements the existing two-main/ten-child fixture; it does not raise native
  child limits or count queued work as simultaneous execution.
- Each execution starts with approximately 32,000 model-input tokens under a fixed
  tokenizer, with ordinary mixed text/code/tool-result fixtures; also measure a
  documented larger-context case to establish the operating envelope.
- A local deterministic provider fixture emits ten approximately 1 KiB deltas per
  second per active execution in synchronized ten-second streaming bursts, followed
  by controlled turn/tool transitions. Repeat for sixty minutes with observable
  overlap and real runtime ingestion/persistence. Do not append endless text to a
  single impossible model turn. Keep a bounded model context while durable history
  grows, and verify complete final output against fixture expectations.
- A mixed phase exercises bounded Read/Edit calls against isolated fixture files,
  short Bash commands, queue saturation, model retry, approvals and cancellation.
  Respect real tool budgets and record waits; never call queuing full concurrency.
- Seed paged history equivalent to at least 10,000 messages per main session,
  including a 1 MiB tool result and image references. Display three attached
  conversations in one pass; in another pass display one conversation, one real
  terminal and one controlled embedded browser page. Include any extra browser
  chrome/plugin process in the budget.
- Run a two-hour lifecycle soak with at least 100 attach/detach/maximize cycles.
  After cleanup and five minutes without new work, steady memory must be within
  10% of the post-warmup baseline with an equivalent live workload and cache state.
- Test a desktop plus one mobile client with fixture networking, and actual RDP
  disconnect/reconnect. Record RTT/bandwidth; separate local input-to-paint timing
  from network transport latency.
- On the minimum target, also record system available memory, commit pressure,
  hard faults, CPU saturation and disk stalls. Report external program/resource
  costs separately. Passing a process-memory threshold cannot substitute for
  meeting the interaction gates under OS pressure; no OOM/restart or lost output
  is accepted as graceful operation.

Use mocks only at external provider boundaries; use real internal admission,
runtime, IPC/RPC, storage and presentation paths. Fixture capacity does not prove
provider rate limits or real-model correction quality. A separately authorized,
budgeted real-provider test records the provider/model/context and observed
outcomes. Unavailable real-service evidence is reported, never inferred.

## Acceptance criteria

Every row is **NOT RUN** for this documentation proposal. These are future gates,
not existing tests. Add executable cases to the repository E2E plan as each phase
implements them, with tested head/base and environment recorded.

| ID | Requirement | Pass condition | Lowest useful evidence |
|---|---|---|---|
| AC-01 | FR-01, FR-02 | One persistent overview and at most three workspace surfaces; fifth-surface request refused; keyboard resize/focus/maximize/restore works and keeps drafts/reading positions | Reducer tests plus real component interaction |
| AC-02 | FR-01 | Summary changes reach the visible overview with P95 at most 1 s; a foreground connection probes every 2 s and marks stale within 1 s after 6 s without a health reply; explicit disconnect is shown on the next UI update; urgent requests need no full chat | Host-to-renderer integration with a controlled clock and user path |
| AC-03 | FR-03 | Attach to main and child histories, page older content while output streams, return to live tail, then detach; no new execution, missing final text, duplicated rows or stale-target repaint | History/event integration plus Electron journey |
| AC-04 | FR-04 | 1,000 interleaved operations with focus changes and delayed replies never affect the wrong session/turn; stale revisions conflict; repeating a request ID does not duplicate its effect | Contract/race tests through public control API |
| AC-05 | FR-05 | A running child consumes a correction at the defined boundary; parent observes the new revision before result acceptance; old result, settled parent and child-stop cases are explicit | Real parent/child runtime with deterministic provider |
| AC-06 | FR-06 | Simultaneous starts across all entry points never exceed 12 per workspace or 36 total; pending approval and cancellation count; hidden workspaces and extra clients cannot bypass limits | Host admission tests with controlled barriers |
| AC-07 | FR-06, FR-07 | The specified thirty-six-instance load suite completes with real overlap and complete output; the maximum contemporaneous sum of application-owned Private Bytes, sampled at intervals no greater than 100 ms, is at most 4,000,000,000 bytes; no additional correlated OS trace demonstrates an over-budget interval; process coverage and sampling limits are disclosed | Full runtime/storage/UI load artifact |
| AC-08 | FR-02, FR-07 | Under AC-07 load, maximized-page local input-to-paint P95 at most 100 ms, warm workspace switch P95 at most 250 ms, and Host stop-request admission P95 at most 500 ms; measure at least 1,000 samples | Production-renderer instrumentation and native input |
| AC-09 | FR-07 | Two-hour/100-cycle soak meets the 10% residual-growth bound; no orphan subscriptions/processes; required running browser/terminal resources survive view hiding | Lifecycle integration and process/memory capture |
| AC-10 | FR-08 | Each nominated program can associate, activate or show explicit OS refusal, survive identity replacement, and detach without being closed; optional embedding restores native state even after bridge failure | Windows real-program tests |
| AC-11 | FR-02, FR-07, FR-08 | Software rendering, Windows RDP reconnect, 100/125/150/200% DPI and Chinese IME preserve focus/input and bounds; critical dialogs receive clicks instead of underlying native views | Isolated native Electron/RDP qualification |
| AC-12 | FR-04, FR-10 | Desktop starts, phone observes/steers, both see one receipt; concurrent approvals settle once; device-local navigation never changes the other device's command target | Browser/Desktop/Host integration and mobile journey |
| AC-13 | FR-09, FR-10 | Suspend/terminate mobile client and disconnect Desktop while headless work continues; after connectivity is restored, state resync reaches a consistent snapshot within 5 s on the controlled network; no automatic mutation replay | Fault-injection integration and real mobile resume |
| AC-14 | FR-09 | Upgrade populated data and transfer ownership without two database writers; interrupted handoff recovers; schema-too-new refuses safely; Host/sidecar crash never silently restarts a side-effecting execution | Migration, process crash and recovery tests |
| AC-15 | FR-04, FR-10 | Unauthorized/stale-device/cross-session control, URL tokens, invalid Origin and CSRF attempts are refused; revoke a device and terminate its access; no credential/raw-RPC leakage | Security and protocol contract tests |
| AC-16 | All | Existing single-session/permission/plugin/remote-tools paths remain compatible; platform capability gaps are explicit; each claimed platform passes its user paths, accessibility and locale checks | Existing regression suites plus platform matrix |

A failure of AC-07 is a capacity failure even if memory-pressure admission safely
queues work. Provider quotas or unsupported native applications are reported as
specific limitations. Stop-request admission is distinct from actual tool exit;
show stopping/unknown external outcome where the existing tool contract requires it.

## Implementation boundaries and integration points

The following names for new modules are proposals, not existing files or APIs.
Keep entry points thin and do not grow known architecture hotspots.

| Area | Existing seam | Proposed responsibility/change |
|---|---|---|
| Renderer shell | `features/app/AppShell.tsx`, `ChatSurface`, `SessionPane`, work-panel components | `features/command-center/` layout, summary list and attachment controller; preserve shared primitives |
| Session presentation | `stores/slices/events-slice.ts`, `queue-slice.ts`, `session-runtime.ts`, transcript hooks | Session-targeted projections, cancellation generations, paged histories and explicit command targets |
| Client contracts | `lib/api.ts`, shared schemas, `packages/racp/src/client.ts` | Browser-safe client interface and transport adapters; avoid importing Node server exports |
| Admission and monitoring | `packages/agent-host` | Workspace ownership, atomic reservations and derived status subscriptions |
| Execution and supervision | `packages/host-runtime`, `apps/pi-host`, Electron runtime adapters | Explicit independent-Host lifecycle, feature inventory, exclusive owner handoff |
| Native delegation | `packages/agent-runtime/src/runtime.ts`, `subagent.ts`, delegation history | Extract bounded child-control responsibility before adding state to the large runtime module |
| Durable state | Rust repositories, RPC, permissions, transcripts and turn queue | Versioned workspace/goals/receipts with atomic checks; no second transcript store |
| Resource/native presentation | `plugin-view-host`, `browser-host`, terminal router | Per-surface geometry and cleanup; budgeted resources without weakening plugin isolation |
| Local applications | Existing Rust Windows API dependency and native-window RPC pattern | Dedicated platform adapter and user-session bridge, behind explicit capability/permission checks |
| Browser entry | Existing loopback RACP and remote security profiles | Reviewed HTTPS/session adapter and enrollment; no direct public host-core listener |

Use behavior-preserving extractions first where current single-selection state,
large runtime modules or lifecycle coupling would otherwise create parallel
execution paths. Maintain role, tool-call, error, cancellation, usage and stop
semantics through client/event changes. Keep source code and repository documents
in English and all product text in the locale system.

## Delivery phases, dependencies and estimates

Estimates are engineering ranges, not a quote or historical confidence interval.
They assume familiarity with React/Electron, TypeScript runtime work and Rust,
existing toolchains, and fixture-based verification. Earlier chat-only estimates
are superseded by this broader Host/mobile/application-control scope.

Windows-first is confirmed. The sequence below proposes mobile Web/PWA before
native macOS/Linux qualification to validate shared control semantics early;
that relative platform order has not been confirmed. P0 may bring the native
platform stage forward without changing the shared Host/client architecture.

| Phase | Deliverable and exit gate | Depends on | Person-days |
|---|---|---|---:|
| P0 | Baseline/prototypes, scope decisions, fixed resource fixtures, native program matrix, Host parity assessment | None | 6-10 |
| P1 | Independent execution ownership, additive control contracts and compatible handoff; AC-14/15 foundation | P0 | 12-20 |
| P2 | Overview, three workspaces, maximize and on-demand main/child history; AC-01/02/03 | P0 contracts; completes on P1 | 12-20 |
| P3 | Workspace admission and main/child intervention with parent consistency; AC-04/05/06 | P1, P2 | 12-20 |
| P4 | Windows program association and user-session bridge; AC-10/11 | P1, P2 | 8-15 |
| P5 | HTTPS browser edge and responsive Android/iOS Web/PWA client; AC-12/13/15 | P1, P2, P3 control semantics | 15-25 |
| P6 | Capacity tuning, recovery, regression, RDP and Windows/mobile qualification; AC-07/08/09/16 and all outstanding gates | P1-P5 | 15-25 |
| Total | Windows command center plus mobile Web/PWA target | Critical path above | 80-135 |

With a 25% uncertainty reserve, plan approximately **100-169 person-days**.
P1 and the presentation portion of P2 can proceed in parallel after contracts
stabilize; P4 and P5 can later proceed independently. Do not divide person-days by
headcount without allowing for Host/control dependencies and platform test access.

Native macOS and Linux remain target deliverables, estimated separately at an
initial 10-20 person-days per platform. Each needs AC-16 plus the applicable
AC-01 through AC-15 cases before that platform is claimed supported; these costs
are not in the Windows/mobile subtotal. Additional distributions and native
application requirements can change the range.

Conditional work: bounded sidecar sharding (15-25 person-days if measured
necessary); embedding a small nominated application set (10-20 person-days after
P0 validation). Native mobile packaging/push and a desktop-shell change require
separate estimates. API usage, hardware, signing and remote test access are outside
engineering effort estimates. Monetary budget equals agreed loaded daily rate
times the selected scope; no model usage price is assumed.

Each code phase uses its own request branch/worktree from current `origin/main`,
reuses compatible host tooling, and follows the repository candidate/integration
gates. Commits and remote publication require the corresponding user request.
Select tests by changed surface; run required relevant E2E on the known candidate.
Do not use `verify:ui:*` unless specifically requested. This proposal itself needs
document structure/link/fact checks, not a running desktop or paid provider.

## Specification and migration synchronization

Before the corresponding code phase is declared complete, update the affected
English specs and required Chinese mirrors, with actual behavior and test evidence:

| Surface | Documents to synchronize when implemented |
|---|---|
| Scope and architecture | `docs/spec/00-baseline.md`, `02-architecture/02-tech-stack.md`, `02-architecture/05-remote-agent-control.md` |
| Execution, control and storage | `03-runtime/01-ipc-protocol.md`, `02-agent-runtime.md`, `03-tools-and-permissions.md`, `04-data-storage.md`, `06-host-rpc-protocol.md`, `07-process-model.md`, `19-remote-agent-control-protocol.md` under `docs/spec/` |
| Product interaction | `docs/spec/04-ux/01-ui-ia.md`, `08-component-spec.md`, `09-interaction-patterns.md` and shortcut documentation |
| Browser/native security | `docs/spec/05-security/02-remote-control-security.md`; affected plugin contracts under `docs/spec/07-plugins/` only when changed |
| Validation and release | `docs/spec/06-delivery/04-e2e-test-plan.md`, `07-remote-control-rollout.md`, `docs/spec/08-meta/decisions-log.md`, released-surface changelog |

Browser access and general load qualification are deferred/non-goals in parts of
the existing specs. Schedule those amendments explicitly for this feature instead
of claiming they already apply. Do not broadly rewrite unrelated delivery policy.
Keep the current data/protocol source of truth authoritative until additive
contracts and migrations are implemented and tested.

## Open decisions and P0 exit

These items do not block producing this proposal. They block specific implementation
or release commitments and need recorded answers before dependent work proceeds.

| Decision | Proposed starting point | Evidence/decision needed |
|---|---|---|
| Agent counting and workspace model | All live parents/children/Workers count; one Host, three admitted workspaces | Confirm operational grouping and compatibility for existing/scheduled sessions |
| Memory interpretation and workload | User-confirmed two-core / 8-GB minimum; decimal 4-GB application budget and co-located 36-instance suite | Exact CPU/OS/target access, tokenizer/corpus and tool/plugin versions, measurement tooling and accepted mobile budget |
| Native programs | Association first; optional named embedding | At least three must-have program names/versions, privilege levels and ordinary workflows; no arbitrary-app guarantee |
| Host parity/deployment | Same-machine independent Host with explicit opt-in | Inventory desktop providers/auth, attachments, MCP, plugins and GUI lifetimes; service startup/shutdown and ownership handoff design |
| Persistence and child intervention | Rust-owned dedicated tables and explicit consumption boundary; first-release receipts/journals have no automatic deletion | Finalize schemas and child/parent conflict contracts; assign migration versions at implementation; explicit future receipt deletion is separate |
| Mobile and network | Android/iOS Web/PWA, reachable self-hosted HTTPS edge | Nominated OS/browser devices, private-network versus secured endpoint, enrollment/revocation and push requirements |
| Platform acceptance | Windows/RDP first; native macOS/Linux separately | Mac and mobile hardware access, Linux display-server scope; Windows alone cannot prove iOS/native-macOS qualification |
| Performance feasibility | Measure before sidecar/shell changes | Baseline artifacts and repeatable 36-instance prototype; if budget fails, revise architecture and cost before promising delivery |

P0 exits with a reviewed ADR, frozen acceptance fixture parameters, named owners
for contract and platform work, and baseline/prototype artifacts. All unmeasured
properties remain explicitly unverified. No phase may mark the entire product
complete by excluding a required failing workload or treating queued agents as
simultaneous execution.
