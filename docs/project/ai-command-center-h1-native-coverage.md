# H1 native-resource coverage and refusal map

This is the H1-R08 adapter qualification map. It does not extend the native
protocol or declare H2-H5 transfer readiness. The inspection protocol still
reports `nativeCoverage: execution_generation_only`. Every family outside that
proof remains an explicit obstruction in Desktop inventory.

## Evidence rules

A known original object, Host generation, process creation identity, and retained
native handle establish provenance. A timeout, cancellation signal, successful
`kill`, registry removal, renderer destruction request or `dispose` return is
not an exit receipt. A new owner cannot erase an old owner's pending operations
or uncertainty. Missing and malformed required reports refuse inspection.

| Family | Production authority | Current evidence and remaining refusal |
| --- | --- | --- |
| Rust Host and fenced Node Sidecar | `runtime/backend-owner.ts`, `packages/host-runtime/src/execution-fence.ts`, `crates/host-core/src/owner_handoff/native.rs` | Host identity/generation is fixed before asynchronous setup; retired Sidecars require both Rust fence confirmation and child exit. Cleanup failures and retained extension reports obstruct inventory. Rust proof checks process creation identity/user and the recorded Job Object. This certifies only the registered execution generation. |
| Rust handles and source control outside that generation | `crates/host-core/src/owner_handoff/{source,native.rs}`, `runtime/handoff-inventory.ts` | No wider closure claim. `native-resources-outside-execution-generation` and the H2 source-integration gap remain fixed obstructions. H1 does not add an unverified nativeCoverage enum. |
| Plugin processes and connections | `plugin-runtime.ts`, `plugin-lifecycle.ts`, `plugin-connections.ts` | Original plugin generations own calls and continuations. Native handoffs add retained uncertainty; plugin removal or process kill does not clear it. |
| Plugin windows, pages and embedded workers | `plugin-{panel,view}-host.ts`, `plugin-surface-activity.ts` | Original pages and asynchronous calls remain observable; native creation adds uncertainty. Page disposal alone is not native worker/process closure. |
| Browser/CDP and hidden backing windows | `browser-host.ts`, `browser-activity.ts`, `browser-{view,backing-host}.ts` | Original browser owners retain pending work and pages; native attempts remain uncertain after ordinary page cleanup. |
| Workspace terminals | `terminal/workspace-terminal-{registry,router}.ts` | Registered original routers and local/remote terminal reports are aggregated; unconfirmed cleanup and retired uncertainty remain. No arbitrary PID adoption. |
| Extension processes and services | `agent-sidecar-processes.ts`, `agent-sidecar-extension-services.ts`, `runtime/backend-owner.ts` | Retired Sidecars remain in the aggregate until their original reports and native/child evidence allow pruning. Registry removal cannot hide a pending process call. |
| Remote clients, tunnels and bootstrap | `remote/remote-boot-activity.ts`, `remote/remote-host-supervisor.ts` and `bootstrap/remote-hosts.ts` | Original clients/tunnels are retained; external SSH/transport uncertainty is not cleared by a JavaScript close or replacement. No live SSH operation is required for adapter tests. |
| Model catalog | `models-dev-catalog-loading.ts` | Local read, fetch, body parse/cancel remain counted to actual settlement. Fetch abort is not connection-pool closure; the model-catalog gap remains. |
| Updater | `updater-activity.ts`, `updater.ts`, `bootstrap/updater.ts` | Checks/downloads/cache/settings/external browser work belong to immutable operation scopes. Transport/installer/browser handoffs retain uncertainty. The updater gap remains. |
| Vendor OAuth | `oauth.ts`, `oauth-activity.ts`, `bootstrap/oauth.ts`, `ipc/provider-ipc.ts` | Login/refresh/credential/identity/model work retains original Host/plugin attribution and actual lifetime. Lost admission refuses new effects and IPC discovery fallbacks; original-ID terminal events close existing dialogs. Fixture settlement does not certify provider native transport/listener closure; the vendor-oauth gap remains. |
| Inbound MCP | `mcp-control-lifecycle.ts`, `mcp-control.ts`, `bootstrap/main-state.ts` | Every created instance is retained. Live listeners/sockets and unresolved handlers obstruct inventory, including failed starts and bounded-stop timeouts. Authenticated loopback fixture closure proves the tested Node lifecycle only; the mcp-control gap remains. |
| Personal todos | `personal-todos/{activity,runtime,coordinator,window}.ts` | Drafts, pending persistence, editor/window work and original-owner/refusal bindings remain observable. Quit cannot bypass closed admission; explicit retries preserve mutation identity. Window cleanup is not wider native proof; the personal-todos gap remains. |
| Main windows, launcher, tray and listeners | `surface-activity.ts`, `bootstrap/{window,launcher,app-lifecycle}.ts` | One shared owner counts original handles/registrations and pending loads/writes, and gates fresh effects. Prewarmed reuse remains supported. The electron-surfaces-and-listeners gap remains until wider native closure is proven. |
| Worker execution | `services/session-collaboration.ts`, original AgentHost, Rust collaboration ledger | `workers` counts linked sessions with queued/running obligations; `children` and `nativeSessions` remain distinct. Immutable dispatch ownership, retryable busy refusal and retained settlement do not prove native Worker closure; the worker gap remains. |
| Voice/LiveVoice | Existing paused owners | Explicit user deferral. Inspection must not initialize audio, microphone, models or downloads. The voice-and-live-voice gap remains. |

## Acceptance mapping

- `handoff-backend-owner.test.mjs` and `handoff-sidecar-factory.test.mjs` cover
  captured generations, closure-vs-exit, retained failures and refusal to publish
  a replacement before original cleanup.
- `handoff-external-resources.test.mjs`, `handoff-plugin-lifecycle.test.mjs`,
  `handoff-plugin-surfaces.test.mjs`, `handoff-browser.test.mjs`,
  `handoff-workspace-terminal.test.mjs`, `handoff-remote-hosts.test.mjs` and
  `handoff-extension-processes.test.mjs` cover original resource lifetime and
  conservative uncertainty for the respective families.
- `handoff-inventory.test.mjs` verifies all 19 public fields, required producer
  reports, source identity across awaits, retained old owners and the unchanged
  ten fixed qualification gaps. Adapter reports are not supplied by a caller's
  qualification flag.
- Exact test results and candidate identity belong to the R09 verification
  record. This map alone is not a passed test or a native exit certificate.

The earlier [profile isolation incident](./ai-command-center-p0-evidence/rust-inspection-isolation-incident.json)
remains unresolved. Later isolated tests do not establish that earlier profile
data was unaffected.
