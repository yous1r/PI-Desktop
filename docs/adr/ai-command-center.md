# ADR: A resource-bounded AI command center with independent execution and multiple clients

- Status: Approved for core implementation; partial candidate, not release-qualified
- Date: 2026-11-08
- Evidence baseline: `origin/main` at `fd28eb89866ac513912ed109716e7120cf60f18c` (v0.22.3)
- Requirements and release gates: [AI command center requirements](../project/ai-command-center-requirements.md)
- Development design: [Modules, interfaces and data flows](../project/ai-command-center-development-design.md)
- Related: [Host runtime boundary](0284-headless-runtime-boundary.md), [RACP transport](0285-racp-ws-transport.md), [remote control architecture](../spec/02-architecture/05-remote-agent-control.md), [local Agent with remote tools](local-agent-remote-workspace-tools.md), [retained session panes](0137-retained-session-panes.md), [plugin views](0104-plugin-contributed-work-panel-views.md), [delegation continuation](0279-resumable-subagent-delegations.md), [session worktree isolation](0329-session-worktree-isolation.md)

## Context

The desired product is a command center for background AI work. The operator
normally monitors task state and intervenes when a task needs information,
approval, cancellation, or a revised objective. They must be able to inspect
historical and live conversations, including subagent work, without restarting
execution. Low memory consumption is a primary product constraint.

The confirmed presentation target is one Electron application window with one
permanent monitoring overview and at most three workspace surfaces. A workspace
can maximize inside the application; the focused surface should remain
responsive while other work continues. Each workspace admits at most twelve
live agent instances, giving a target of thirty-six across three workspaces.
The application's own process group must fit within 4 GB under a qualified
maximum-concurrency workload. External applications are measured separately.
Windows and remote-desktop operation come first; macOS, Linux, phones, and
tablets are part of the platform direction. Core functionality must not depend
on GPU-specific features.

A traditional multi-pane chat UI would mount expensive transcripts, markdown,
composers, and native views for tasks the operator is not reading. Replacing
Electron alone would not address agent context retention or execution ownership.
A mobile client also cannot depend on a desktop renderer staying connected.

### Source-grounded starting point

These observations describe the pinned baseline, not capacity measurements:

| Surface | Existing behavior | Consequence for this design |
|---|---|---|
| Renderer | `ChatSurface` retains session panes but shows one conversation with one Composer; transcript reads and several actions follow the active session | Introduce explicit view and command targets rather than duplicating the application store |
| Background state | Session statuses, approvals, questions, drafts, and work-panel contexts already have session-scoped structures | Reuse their identity and semantics; add a bounded host-produced monitoring projection |
| Agent execution | A shared Node sidecar keeps session runtimes; Desktop launches it with a 2,048 MiB V8 old-space limit | This is not a total-process memory limit or proof of thirty-six-agent capacity |
| Admission | Host RPC has 32 in-flight slots; tools have class/session budgets; a session currently allows at most ten concurrent subagents | Add workspace admission above existing gates; do not equate RPC slots with agent capacity or merely raise constants |
| Native views | Browser pages have session/tab ownership; plugin presentation has one visible key and rectangle and a four-view retention bound | Multiple native surfaces need explicit identity, bounds, occlusion, and cleanup |
| Terminals | xterm/node-pty and local/remote routing exist; the workspace terminal service limits a device to eight PTYs | Reuse the implementation with a separate resource budget; twelve agents do not require twelve PTYs |
| Headless execution | `agent-host`, `host-runtime`, `racp`, and `pi-host` provide execution and transport seams without a desktop UI | Build on these modules; establish feature parity before transferring existing sessions |
| Remote projects | The ordinary new remote-project workflow keeps Agent/model/transcript ownership on Desktop and executes tools remotely | Remote workspace support is not already an independent command-center service |
| Browser clients | Renderer API requires `window.piDesktop`; the shipped RACP binding uses loopback/SSH and Authorization headers | Browser transport, authentication, and a portable client API are new work |

Relevant executable sources: [renderer](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/desktop/src/components/ChatSurface.tsx), [events](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/desktop/src/stores/slices/events-slice.ts), [sidecar launch](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/desktop/electron/main/agent-sidecar.ts), [tool budgets](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/crates/host-core/src/tool_budget.rs), [subagent limit](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/shared/src/subagent-definition.ts), [plugin views](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/desktop/electron/main/plugin-view-host.ts), [terminal service](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/host-runtime/src/workspace-terminal-service.ts), [headless composition](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/pi-host/src/app.ts), [remote workflow](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/pi-host/README.md), and [RACP binding](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/racp/src/ws-binding.ts).

The baseline tech-stack document still says Desktop has no interactive PTY
dependency. `apps/desktop/package.json`, its bundler configuration, and terminal
code contradict that statement. This proposal uses executable evidence;
implementation must synchronize the affected specification.

## Decision scope

This record selects the target architecture, ownership, client strategy,
resource model, and external-application integration policy. The companion
requirements define observable behavior and acceptance. The user approved the
core handoff/control/monitor implementation and branch-only publication as
`AI-Panel`; external devices and Voice remain later qualification lanes.
Implementation remains incremental and preserves defaults unless a caller opts
in. Approval is not native-platform, throughput, security or release evidence.

The production headless composition exists in this repository under
`apps/pi-host`; prior handoff reports describing it as an unavailable external
repository were incorrect. Current executable wiring and candidate-bound checks,
not those reports or this ADR, determine which gates are satisfied.

The first command-center deployment has one authoritative execution Host and up
to three admitted command workspaces. A command workspace is an operational group
of tasks, distinct from a project group, filesystem root, or Git worktree. Views
may attach to any authorized session without moving that session's execution
ownership. Remote tool hosts remain possible through existing boundaries.
Cross-Host federation and a global distributed quota are outside the first
release.

Not selected here: replacing the desktop shell, thirty-six simultaneously
expanded chats, an operating-system window manager, arbitrary cross-platform
window embedding, desktop video streaming, on-device mobile agent execution,
or continuous model-based automatic supervision of every task.

## Alternatives considered

| Option | Benefits | Costs and limitations | Outcome |
|---|---|---|---|
| Retain Electron, mount many full chats, keep execution coupled to Desktop | Smallest initial visual prototype; reuses all desktop integrations | Unnecessary rendering/retention; weak mobile independence; does not deliver the background-first workflow | Reject as the target; retain single-session behavior during transition |
| Retain Electron, reuse independent Host modules, add Web/PWA clients | Preserves existing integrations; shares execution semantics; makes UI lifetime independent | Requires API extraction, Host parity work, browser authentication, and cross-client control | Select |
| Replace Electron with Tauri 2 for desktop and mobile | System WebViews; potentially smaller distribution and shell footprint | Rebuilds Electron-specific IPC, views, browser/CDP, plugins and packaging; retains agent runtime costs; different WebView engines need qualification | Defer until an equivalent prototype demonstrates a material benefit |
| Browser-only product | Broad client reach and one Web presentation layer | Still needs a native execution Host and desktop application bridge; browser alone cannot manage arbitrary local programs | Use as a client, not the entire platform |
| Rewrite clients with native UI or Flutter | Platform-specific interaction and resource tuning | Substantial UI rewrite and multiple integration surfaces; no demonstrated need | Reject for this scope |

| Integration choice | Trade-off | Outcome |
|---|---|---|
| Associate external native windows | Low presentation overhead; program retains its normal rendering and lifecycle; activation may be denied by the OS | Default desktop integration |
| Embed selected native windows | Can place compatible program UI inside a workspace; DPI, focus, child dialogs, permissions and recovery vary by application | Optional, named and qualified adapters only |
| Mirror every program into the workspace | Uniform-looking surface but adds capture, encoding, input mapping and network/resource costs | Deferred; not the default remote-desktop path |

For the four-surface shell, select a small typed layout model with React and
CSS, with split/resize/maximize commands in the existing shortcut registry.
A general docking library is not justified for the fixed four-surface contract.
Reconsider it only if a later requirement needs arbitrary docking; layout state
must remain application-owned and versioned.

## Decision

The following is the selected proposed direction. Approval and phased validation
are required before it replaces any frozen behavior.

### 1. Retain process ownership and make execution independent of clients

Reuse `packages/agent-host` for admission and lifecycle, `packages/host-runtime`
for supervision, `packages/agent-runtime` for Agent execution, and Rust host-core
for authoritative persistence and privileged operations. Electron Main remains
a thin platform orchestrator. Renderer and browser clients never access SQLite
or run Agent loops. Shared contracts never depend on desktop implementations.

Complete the existing headless composition into a user-owned execution Host.
Use one active Rust database owner per data directory. In command-center mode,
Desktop connects to that owner rather than starting a competing local Host.
Do not silently copy model credentials to a remote machine or convert existing
local-Agent/remote-tools sessions. Initially, run the independent Host on the
same machine so execution and credential location remain explicit.

Desktop-only browser, plugin, authentication, and native-window facilities need
a capability inventory and either an equivalent Host implementation or an
explicit desktop bridge. A session requiring an unavailable capability reports
that dependency; it must not fall back to a different machine or execution path.

Keep execution ownership separate from a client connection. This is a deliberate
extension beyond connection-owned remote tool calls that currently cancel on
disconnect; those existing endpoints retain their semantics. New Host-owned work
must use an explicit lifetime contract instead of pretending it already survives
a desktop or mobile disconnect.

### 2. Make monitoring cheap and conversations demand-loaded

Build one host-produced projection of task identity, goal revision, lifecycle,
parent/child relationships, current activity, waiting reason, usage, and freshness.
It derives from existing authoritative events and records, not a second task
executor or transcript database. Native subagents, full Worker sessions, and
background processes retain their distinct identifiers and supported actions.

Clients subscribe to summaries by default. An attached conversation subscribes
to bounded live content and reads history by cursor. Inactive views release
layout work and expensive presentation caches; running agents and their required
resources keep executing. Terminal, browser and plugin content has explicit
owners, memory bounds, and cleanup independent of chat visibility.

### 3. Bound surfaces, agents, and resources independently

One overview is permanent; at most three workspaces are open as application
surfaces. Maximizing one workspace hides the other heavy surfaces while retaining
an overview entry and urgent status. Layout and focus are device-local and cannot
redirect commands from another client.

Host admission counts main agents, native subagents, and Worker sessions against
twelve live instances per command workspace and thirty-six per command-center
Host. Reservations are atomic and count launches, resource waits, approvals and
cancellation until settlement. Hiding a workspace or opening another client does
not release or multiply capacity. Preserve narrower existing per-session/tool
limits unless a separately tested change modifies them.

The 4 GB target covers all application-owned processes, including detached Host,
Agent, plugin, bridge and browser processes. External user programs and build
payloads are reported separately. The requirements define measurement units,
workload, sampling, cache bounds and pressure behavior. Memory-based refusal to
admit work is a safety mechanism, not proof of thirty-six-agent throughput.
Do not remove durable-write guarantees or evict running state to meet the budget.

### 4. Prefer the focused page without starving background control

Batch/coalesce presentation updates, prioritize input and visible text, and stop
hidden-pane measurement, highlighting and automatic scrolling. Reserve control
capacity for stop, approvals, and user intervention; task execution remains
fair across workspaces. Persist full results independently of display coalescing.
Never coalesce away authorization decisions, failures, completion, usage or
command outcomes. Existing RPC/tool gates must be evaluated under load before
changing their limits.

Use ordinary DOM/CSS for core interactions. Add an explicit remote-desktop/software
rendering profile, configured before Electron readiness. This does not silently
change existing appearance defaults. No continuous live thumbnails, WebGL,
WebGPU or GPU-dependent local inference is required by the command center.

### 5. Make intervention an explicit, durable control operation

A command identifies its Host, command workspace, session, expected turn, and,
where applicable, delegation execution and goal revision. These are validated
against the authenticated principal and Host-owned bindings. The final schema
must be additive, versioned and capability-negotiated.

Separate submission, runtime acceptance, consumption at a supported boundary,
and observed outcome. Use idempotency and revision checks for concurrent clients;
return a conflict for stale objectives or already-resolved requests. A stop does
not promise rollback of external side effects or immediate termination of every
child process.

Main-session steering is reusable. Direct steering of a running native subagent
requires a new runtime/control path. Existing `Task(resume)` is not that path,
and stopped delegations cannot be assumed resumable. A child goal change must
invalidate stale parent expectations and notify the parent before it accepts a
result under the old goal. Preserve delegation chains and histories.

### 6. Add mobile as a control client, not an execution host

Extract browser-safe client contracts and presentation models from the current
preload-dependent renderer API. Supply separate Electron and browser transport
adapters; do not bundle server/Node `ws` dependencies into the browser client.
Reuse RACP identities, cursors, authorization and idempotency semantics.

Desktop remains Electron on Windows, macOS and Linux. Deliver responsive Web/PWA
for phones and tablets first; consider Capacitor or another native mobile shell
only for demonstrated push/device requirements. Phones show one focused surface
with access to the same overview and three logical workspaces. They do not
execute the Node/Rust Agent stack or embed arbitrary phone applications.

Implement a reviewed HTTPS browser edge, preserving the existing loopback Host
boundary. Browser-native WebSocket cannot reuse the Node client's arbitrary
Authorization header. Use the browser authentication profile from the security
spec (for example, same-origin HttpOnly sessions with Origin and CSRF controls),
with device enrollment and revocation. Do not put tokens in URLs or expose raw
Electron IPC, host-core RPC or provider secrets. No vendor-operated cloud is
required; reachable self-hosted networking remains a deployment prerequisite.

Allow mobile suspension. Reconnect with cursors or a complete state refresh and
never replay a mutation automatically. Push is an additional platform-qualified
capability, not a promise of a permanent background socket.

### 7. Associate local applications; embed only qualified programs

Desktop workspace surfaces can associate ordinary user-session programs on the
machine running the desktop bridge. Use platform adapters behind the native Host
boundary, explicit selection and validated process/window identity. Association
is not permission for an Agent to automate the application. Focus denial and
unsupported programs have an actionable external-window fallback.

Do not place interactive window control inside a Windows Session 0 service.
A user-session bridge owns interactive desktop resources; a headless Host may
continue non-GUI work while the bridge is unavailable. RDP disconnect, logoff,
DPI changes, child dialogs and process replacement need explicit lifecycle tests.

Optional Win32 embedding requires a per-program compatibility contract and
restore/detach behavior. macOS and Wayland cannot promise equivalent arbitrary
window embedding. Mobile can observe a Host application's state and invoke
allowed Host operations; full remote GUI streaming is a separate feature.

## Consequences

### Benefits

- Most tasks cost a small monitoring row rather than a mounted conversation.
- Existing Electron/plugin investment is preserved while a mobile client becomes
  possible through a shared execution boundary.
- Background work, human intervention and multi-client state have explicit owners.
- Resource limits and performance become measured release gates instead of
  assumptions about shell technology or process counts.

### Costs and risks

| Risk | Required response |
|---|---|
| Thirty-six contexts exceed the budget | Profile realistic contexts and child fan-out first; bound retention; keep admission visible; do not claim the target by queuing work |
| Shared sidecar stalls or crashes all runs | Measure heap, event-loop delay and fault recovery; consider a bounded sidecar pool only through a follow-up decision if required |
| Headless Host lacks desktop feature parity | Inventory providers, attachments, MCP, plugins, browser and terminal lifetimes; retain the existing path until each capability is qualified |
| Cross-client or child/parent intervention races | Stable execution identities, revision checks, durable receipts, and conflict/race tests |
| Browser control expands the security boundary | Dedicated browser edge and role-limited catalog; enrollment/revocation and Origin/CSRF tests; no raw RPC exposure |
| Native application integration differs by OS | Named capability matrix and association fallback; qualify optional embedding separately |
| Software rendering or RDP adds latency | Measure client-local and remote interaction separately; bound hidden work rather than increasing global process priority |
| Migration creates duplicate ownership | Single-owner handoff, version checks and recovery tests; never run two writers against one data directory |

### Compatibility and specification impact

Keep existing sessions, transcripts, provider bindings, permissions, SDK contracts
and ordinary single-session behavior compatible. The traditional presentation can
remain a single-surface layout using shared components. Command-center service
mode is explicit until capability parity and migration are qualified.

Persist new workspace membership, objective revisions and command receipts only
through Rust-owned repositories. The [development design](../project/ai-command-center-development-design.md#data-model-and-persistence)
proposes dedicated transactional tables for these records and versioned KV for
per-device layout preferences. Confirm the schema during P0/P1, with migrations
and compatibility tests. Existing data must never require manual deletion.
Older clients receive explicit unsupported-capability responses. Rollback must
not start an older binary against a newer unsupported schema or revive work.

On approval and implementation, synchronize these domain specifications in the
same staged changes: [baseline](../spec/00-baseline.md),
[remote architecture](../spec/02-architecture/05-remote-agent-control.md),
[IPC](../spec/03-runtime/01-ipc-protocol.md),
[runtime](../spec/03-runtime/02-agent-runtime.md),
[storage](../spec/03-runtime/04-data-storage.md),
[process model](../spec/03-runtime/07-process-model.md),
[RACP](../spec/03-runtime/19-remote-agent-control-protocol.md),
[UI](../spec/04-ux/01-ui-ia.md),
[components](../spec/04-ux/08-component-spec.md),
[remote security](../spec/05-security/02-remote-control-security.md), and
[E2E scenarios](../spec/06-delivery/04-e2e-test-plan.md).

This proposal would schedule previously deferred browser access and qualify
background service ownership. It does not silently supersede the current
local-Agent/remote-tools decision, approval lifetimes, plugin isolation, or
single-visible-pane rules. The applicable amendments must identify the exact
behavior changed when implemented. The companion plan carries acceptance and
costs; this record is not a replacement for executable contracts or a work plan.

## Acceptance and reconsideration

The proposal is implementation-ready only after the P0 decisions in the
[requirements](../project/ai-command-center-requirements.md#open-decisions-and-p0-exit)
are recorded. Release acceptance requires the AC-01 through AC-16 gates there,
including the qualified 4 GB/36-agent workload, child intervention, cross-client
recovery, remote-desktop input and upgrade compatibility. No performance, native
embedding, mobile or real-provider result is claimed by this document.

Reconsider Electron only after an equivalent client prototype demonstrates a
material total-process benefit on the same workload without losing required
browser/plugin/native behavior. Reconsider sidecar topology only after profiling
or fault-isolation requirements justify it. Neither a smaller installer nor
moving memory to an uncounted process satisfies the resource requirement.

## External references

- [Electron platform scope](https://www.electronjs.org/docs/latest)
- [Electron hardware acceleration control](https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration)
- [Tauri 2 platform support](https://v2.tauri.app/)
- [Tauri WebView implementations](https://v2.tauri.app/reference/webview-versions/)
- [Capacitor mobile Web runtime](https://capacitorjs.com/docs)
- [Win32 SetParent and DPI constraints](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)
- [Win32 foreground activation restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
