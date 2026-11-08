# AI command center: Host capability parity and handoff inventory

- Status: P0/S02 source-grounded inventory and S03 preparation; no service-mode migration or capability rollout is implied.
- Related: [control contracts](ai-command-center-control-contracts.md), [development design](ai-command-center-development-design.md), [initial runtime evidence](ai-command-center-1mib-validation.md).
- Source baseline: `fd28eb89866ac513912ed109716e7120cf60f18c` plus the isolated P0 persistence correction. Files and executable tests take precedence over architectural labels.
- S03a update: [Rust data-directory ownership](../adr/host-data-directory-ownership.md)
  now guards cooperating Host startup and relocation destinations. Full execution
  handoff remains pending; see [remaining acceptance gates](ai-command-center-remaining-work.md).

## Three paths that must remain distinct

1. **Desktop-owned local Agent.** Electron owns local launch orchestration and
   desktop bridges. The renderer remains a client. Rust owns persistence, and
   Agent execution stays in the sidecar.
2. **Local Agent with remote workspace tools.** The current experimental Remote
   Hosts project workflow keeps model credentials, model requests and transcript
   local. Authenticated workspace tools/files/PTY/plugin/process services run on
   the paired Host. It does not move the Agent loop or data ownership remotely.
3. **Headless Agent Host.** `apps/pi-host` composes AgentHost, RuntimeService,
   HostProcess, AgentSidecar and RACP. It can execute supported text sessions, but
   the launch resolver has explicit gaps compared with Electron. Its existing
   SSH/loopback binding is not a browser authentication edge.

Command-center independent execution must deliberately select the third path
with qualified capabilities. It cannot infer ownership transfer from a remote
project binding or silently mix these routes for a session.

## Capability matrix

"Present" means source implementation exists; it is not a blanket platform/E2E
claim. The validation column identifies actual coverage or a remaining gate.

| Surface | Current headless behavior | Desktop/remote-tools distinction | Command-center action / validation |
|---|---|---|---|
| Text main turns | RuntimeService opens durable turn/user row, dispatches sidecar, persists reply and settlement | Desktop has its own adapter/local prompt path | Reuse; real 1-MiB loopback E2E covers the headless runtime path |
| Large prompt transport | Internal Host stdin line limit 64 MiB; 1 MiB runtime fixture passes | RACP default prompt limit is 256 KiB and frame limit 1 MiB | Do not advertise browser/RACP 1-MiB input from internal tests; any negotiated extension needs producer/consumer limits and security tests |
| Provider keys / no-auth | Headless resolver reads Host provider registry and secrets; supports configured generic/API-style providers | Remote-tools model request stays on Desktop | Qualify exact required providers without copying secrets into clients/metrics |
| Vendor OAuth | Headless resolver explicitly rejects OAuth launch | Desktop owns vendor account binding | Advertise unavailable until an authorized interactive credential bridge is designed and tested |
| Trusted-extension model agents | Headless resolver rejects plugin-agent provider identity | Desktop handles trusted extension launch | Keep unavailable; do not fallback to a different Agent silently |
| Attachments / vision input | RuntimeService and RACP turn start reject attachments; attachment operations unavailable | Desktop supports its attachment pipeline | Port full validation/storage/resolution before claiming parity |
| Native Pi sessions | RuntimeService rejects `native-pi:` session IDs | Existing Desktop continuation path is separate | Explicit unsupported outcome; no transcript conversion by surprise |
| User skills / subagent definitions | Reads Host registries and project instruction chain | Soak uses empty catalogs to isolate load | Resolver tests exist; actual operator configuration remains a separate qualification |
| Project/group instructions | Headless resolver loads group roots/instructions/memory with legacy fallback | Desktop preflight may include additional interactive state | Compare effective instruction provenance before session handoff |
| Native Task delegates | Runtime supports concrete child runs and continuation | Current ten-child/session ceiling remains | Mixed 2-parent/10-child workspace test still needed; main-only soak does not prove it |
| Main steering | RuntimePort.steer and sidecar agent.steer target a live turn | No standalone public RACP turn/steer operation assumed | Existing acceptance port is reusable; add consumed-revision receipt for new control contract |
| Child steering / goal revision | No command-center running-child revision/acknowledgement contract | Task resume creates a new run of settled work | Extract focused child-control module; prove parent notification/result fencing |
| Stop / abort | Existing separate graceful stop and abort semantics | Already-issued tool effects are not rolled back | Preserve identity and abort lock; retain capacity until confirmed settlement |
| Approval / ask input | AgentHost approval broker and RACP handlers present | Role and session permission ceilings still apply | Reuse; multi-client identity/expiry tests before new UI |
| Transcript history / replay | Canonical Host history with AgentHost snapshots and event cursors | RACP defaults to eight subscriptions/connection | Build bounded monitor summaries; do not open 36 full histories |
| Workspace quotas | Command-workspace membership/reservation repository absent | Session concurrency and tool budgets are narrower safeguards | Atomic Rust 12/36 reservation integration required across all starts |
| Plan/Goal execution | Headless PlanExecutionDispatcher reuses lifecycle/Host plan contracts | Goal mode is not the proposed immutable task-goal revision journal | Add new journal without replacing existing approvals or plans |
| Plugin tools / user MCP in headless model launch | Headless resolver has empty plugin tooling/trusted extension catalogs | Workspace plugin services exist for the local-Agent remote-tools route | Keep these capabilities distinct; add routing/lifecycle/security tests before parity |
| Workspace files/tools | Owner-only RACP operations, bounded payloads and path validation | Local Agent can use remote files without moving transcript | Reuse existing routing, never fallback to local on disconnect |
| Workspace processes / PTY | Conditional server capabilities when adapters are composed | Native PTY dependency/platform ABI can disable capability | Surface actual capability; qualify Windows interactive/session ownership separately |
| Browser/CDP/native views | Electron owns WebContentsView and native integration | Not part of plain headless resolver | Use authenticated interactive bridge; unavailable on noninteractive service desktop |
| Native app association | Proposed command-center bridge | Arbitrary embedding is not guaranteed | Program/privilege/DPI/RDP matrix before native adapter rollout |
| Browser/mobile control | Server advertises RACP-WS; browser profile is not implemented by merely opening a port | Node WS auth behavior does not map directly to browser WebSocket headers | Same-origin HTTPS/session binding, origin/CSRF/revocation and role tests required |
| Service owner handoff | Rust now holds a data-directory OS lock before recovery; pi-host also claims its Unix admin channel where supported | The lock covers cooperating binaries, not old sidecars or complete ownership transfer | Execution epoch/fencing, idle handoff and interrupted-transfer tests still required |
| Resource telemetry | Isolated P0 harness measures owned coordinator/Host/sidecar | No product-wide UI/plugin/native process inventory yet | Retain sampled scope; full AC-07/08/09 needs complete process and interaction evidence |

## Evidence map

| Claim | Current source | Existing automated coverage / evidence |
|---|---|---|
| Launch limits and provider resolution | `packages/host-runtime/src/launch-resolver.ts` | `launch-resolver.test.ts` |
| Attachments/native session rejection; stop/steer/settlement | `packages/host-runtime/src/runtime-service.ts` | `runtime-service.test.ts`; P0 runtime E2E |
| Transcript ordering and error barriers | `packages/host-runtime/src/turn-persistence.ts`, `turn-events.ts` | persistence/events/service regressions |
| Shared RPC admission and overload | `packages/host-runtime/src/host-process.ts`, `host-write-admission.ts` | `host-write-admission.test.ts`; real Rust boundary load |
| Roles, limits, operation names | `packages/shared/src/racp.ts` | `racp.test.ts`; RACP integration suite |
| Actual advertised capability flags | `packages/racp/src/server.ts` | server/transport tests |
| Prompt byte check and unsupported attachment handlers | `packages/racp/src/operations.ts` | RACP request/validation tests |
| Existing remote-project architecture | `apps/pi-host/README.md`, `apps/pi-host/src/app.ts` | remote MVP suites exist; not run as part of this source inventory |
| Conditional workspace services | `packages/host-runtime/src/workspace-*.ts` | host-runtime workspace service tests |
| Admin ownership claim | `apps/pi-host/src/admin-socket.ts` | admin-socket/maintenance tests; not evidence of Windows cross-owner handoff |
| Rust database startup | `crates/host-core/src/main.rs`, `state.rs` | AppState opens Database; independent-owner fence still requires explicit design/test |
| Existing child run identity | `packages/agent-runtime/src/subagent.ts` | subagent/fallback/continuation tests |

The 1-MiB fixture bypasses global instructions/skills/subagents and provider secrets
by injecting a deterministic launch resolver. It proves the RuntimeService path,
not all entries in this matrix. In particular its direct AgentHost entry bypasses
RACP's smaller negotiated prompt limit. This distinction is intentional and must
remain in all capacity reports.

## S03 owner-handoff acceptance design

The following is a concrete next implementation gate, not a current feature.

1. Resolve the canonical data directory and existing owner through the trusted
   local bootstrap. Reject arbitrary client paths, symlink surprises and a second
   owner. SQLite locking alone is not an Agent-runtime ownership contract.
2. Establish a cross-platform owner identity and generation that Desktop and
   pi-host both honor before starting Rust/sidecar. Unix socket lock behavior is
   not assumed to work unchanged on Windows; Windows user-session/service
   identity and interactive bridge ownership must be explicit.
3. Block new admissions during handoff. Existing turns follow an explicit drain
   or interrupt decision; they are not replayed by the successor. Keep the old
   owner alive until its state is settled or conservatively marked uncertain.
4. Persist the handoff phase and source/target generation in Host-owned state.
   No process may claim the same data directory on a client-only acknowledgement.
5. Confirm old processes/resources have stopped or are fenced, then let the
   successor acquire ownership and reconcile reservations. Restart cannot free
   unknown slots while an orphan still runs.
6. Publish capability-qualified readiness only after recovery. Clients reconnect
   with new epochs and snapshots. Desktop close merely disconnects observation
   once service mode is actually established.

| Fault point | Required result |
|---|---|
| Two owners start simultaneously | Exactly one owner starts execution/persistence; loser is observable |
| Crash before source drain | Original owner remains authoritative or recovery reports interrupted handoff |
| Crash after source stop, before successor acquire | Recovery claims one new epoch; no model/tool replay |
| Successor boot/schema failure | Data preserved; explicit failure; no unsafe old-version fallback |
| Old sidecar survives supervisor failure | No replacement capacity until fenced/stopped |
| Client disconnects during handoff | Host-owned operation can be queried; no second attempt from a retry |
| Unsupported interactive capability | Explicit unavailable state; no authorization downgrade or silent fallback |
| Windows RDP disconnect / Session 0 | Execution ownership survives appropriately; interactive native resources remain correctly associated or unavailable |

## S02 platform and workload matrix

| Gate | Available evidence | Still required |
|---|---|---|
| Windows execution baseline | Windows 10 x64, six logical CPUs, about 24 GiB, current-source debug Host | Reference hardware/release build qualification |
| 36 × 1 MiB text | ASCII and UTF-8 deterministic main-session E2E; one-hour repeated fixture is recorded separately | Token-counted mixed parents/children/Workers, real provider quotas |
| Full 4-GB application | P0 measures coordinator/Host/sidecar only | Renderer, plugins, native views, startup peaks, <=100-ms qualification and interaction latency |
| Long lifecycle | One-hour fixed-context loop exercises same service processes and repeated session disposal | Required two-hour/100-cycle mixed UI/resources soak and residual-growth gate |
| Native programs | Association-first design | Named applications, privilege levels, dialogs, IME, DPI and RDP scenarios |
| Mobile/browser | Web/PWA proposal | Android/iOS devices, browsers, suspend/resume, HTTPS ingress and notification requirements |

These remaining inputs limit M0/product acceptance, not the ability to finish the
current isolated load test or publish a reviewable P0 contract draft.
