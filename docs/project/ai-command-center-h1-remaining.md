# H1 remaining implementation and acceptance

Baseline: `0e691ce0e21a8e5d7d0648346b5e03e5705a72c8` on
`feat/owner-idle-handoff`. This is the current work list; historical checkpoints
remain evidence for their stated candidates, not assertions of full H1 readiness.

## Scope and task numbering

The authoritative [work-package table](./ai-command-center-parallel-work.md#work-packages)
defines H1 as Desktop coordinator admission and resource inventory adapters for
prompt, plan, schedule, Task/Worker, plugin/MCP, terminal, native and remote-client
entry points. H2 owns Rust source prepare/cancel/fencing/release and durable
receipts; H3 owns successor readiness; H4 owns client reattachment; H5 joins the
complete user path. Recent progress grouped some H2 prerequisites under H1
headings. Those implementations stay; this list corrects their classification.

H1 must close new execution ingress synchronously, retain already admitted work
through actual settlement, bind delayed work to the original owner, and refuse
missing/unknown sources. Unqualified native families must remain explicit blockers.
Zero visible work, an abort signal, timeout, dispose return or successful kill is
not native closure proof. H1 adapter acceptance alone does not enable transfer.

The `H1-Rxx` identifiers below are local subdivisions of H1, not replacements for
the original H0-H5 work packages. Only scoped implementation plus its relevant
checks can move a row to accepted. Full transfer/native qualification is recorded
separately from adapter coverage.

## Remaining tasks

| ID | Status | Description and principal files | Expected output | Acceptance |
| --- | --- | --- | --- | --- |
| H1-R01 | Implemented; integrated acceptance pending | Model-catalog loading/refresh: `apps/desktop/electron/main/models-dev-catalog.ts`, `models-dev-catalog-loading.ts`, `runtime/handoff-inventory.ts`, `index.ts`, catalog/inventory tests | Actual original-owner activity report and gate wiring for startup/local/remote loads | 77 catalog/lifecycle and109 inventory/coordinator cases pass; closed fresh I/O, shared flights, retained abort/body cleanup and late publication are covered. Static/clean-candidate acceptance remains pending; native transport gap stays |
| H1-R02 | Implemented; final candidate pending | Updater: `apps/desktop/electron/main/updater.ts`, `updater-activity.ts`, `bootstrap/updater.ts`, inventory and updater tests | Owned checks/downloads/cache/settings/installer intent with immutable per-operation Host guards | 32 producer cases and production-wiring inventory cases pass in development; queued writes count from enqueue; original timeout work remains visible; final candidate validation pending and native gap retained |
| H1-R03 | Implemented; final candidate pending | Vendor OAuth: `oauth.ts`, `oauth-activity.ts`, `bootstrap/oauth.ts`, `ipc/provider-ipc.ts`, OAuth/discovery tests | Counted login/refresh/model-list continuations, captured Host/plugin runtime and guarded credential/identity persistence | 129 focused/compatibility cases and 98 inventory cases pass in development (overlapping other rows); IPC discovery refusal regression is included in final validation. Late effects cannot borrow replacement owners; original-ID terminal events close dialogs. Native transport gap retained |
| H1-R04 | Implemented; final candidate pending | Inbound MCP: `mcp-control.ts`, `mcp-control-lifecycle.ts`, `bootstrap/{main-state,startup}.ts`, inventory and MCP tests | Retained original instances, counted listener/socket/request/start-stop work and shared admission | 24 producer/wiring/registry cases and real-loopback inventory cases pass in development; body/manifest await boundaries recheck admission; failed starts/replacement cannot erase original work. Final candidate pending; native gap retained |
| H1-R05 | Implemented; final candidate pending | Personal todos: `personal-todos/{activity,runtime,coordinator,window}.ts`, quit/inventory wiring and todo tests | Owned debounce/appearance/editor/window work and original-Host writes | 42 main/window/preload/handoff cases pass; closed quit refuses without bypass, pending drafts/writes remain visible, missing/replaced original Host cannot be recaptured after waits, and explicit retry keeps mutation ID/revision. Final candidate pending; native gap retained |
| H1-R06 | Implemented; final candidate pending | Worker entry coverage: `services/session-collaboration.ts`, collaboration/Worker tests and inventory | Immutable per-sequence Host/generation/runtime, retained settlement and retryable busy dispatch | 32 service cases pass, including original-owner changes and queued `HOST_BUSY` recovery; wider 173-case development run overlaps other rows. Exact candidate acceptance remains pending; accepted Rust counting and Worker native gap are unchanged |
| H1-R07 | Implemented; final candidate pending | Electron surfaces/listeners: `surface-activity.ts`, `bootstrap/{window,launcher,app-lifecycle,main-state}.ts`, `index.ts`, surface tests | Shared concrete ownership and guarded creation/registration | 20 surface cases pass, including prewarm-to-show and Windows chord refusal; 69 existing window cases also pass. Original handles and pending work stay tracked through cleanup. Final candidate pending; native gap retained |
| H1-R08 | Evidence map and development checks ready; final candidate pending | [Native coverage map](./ai-command-center-h1-native-coverage.md), existing backend/plugin/browser/terminal/remote owners and Rust execution-fence interfaces | Family-by-family closure evidence or explicit unsupported-resource refusal | 189 focused ownership cases pass; all ten gaps retained. Exact candidate validation remains pending; no wider native closure or full-transfer claim |
| H1-R09 | Pending | Composition/acceptance: `runtime/handoff-inventory.ts`, coordinator/service, H1 test suites, `scripts/e2e-owner-inspection.mjs`, evidence documents | Clean candidate, coverage matrix, immutable result/cleanup artifacts | Required producer identity checked across awaits; all19 fields validated; busy refusal and cancellation invariants pass; accepted/deferred/unqualified cases explicitly separated; no unsupported full-transfer claim |
| H1-D01 | Deferred by user | Voice/LiveVoice families and their existing fixed gap | Preserve prior work and explicit refusal | No initialization, downloads, microphone tests or resumed Voice development; cannot mark native Voice qualification complete |
| H1-X01 | H2 dependency | Rust admission/source integration through `owner_handoff`, original stdio exchange and captured native owner | Cross-lane interface/negative-path compatibility | Existing Rust ingress and journal-step evidence retained; actual authenticated mutations belong to H2 and join H5. Their absence must not be reported as completed H1 source orchestration |

## Already accepted prerequisites

- Original Desktop/Host identity binding, fenced Sidecar creation and retained
  backend lifecycle; plan/schedule and many existing resource adapters.
- Bounded read-only Rust inspection and19-field Desktop inventory with fixed
  qualification gaps; malformed/missing owners refuse.
- Worker durable obligation count (including queued-only linked sessions),
  original Rust ingress and internal named journal transitions. The Rust items
  are H2/shared prerequisites under the authoritative package split.
- Private stdio application registration and acknowledgement ordering. See
  [Worker/source-step evidence](./ai-command-center-p0-evidence/worker-steps-verification.md)
  and [ACK ordering evidence](./ai-command-center-p0-evidence/ack-ordering-verification.md).

## Implementation order and constraints

Implement R01, then R02-R05 in bounded independent file sets where useful, then
close R06-R08 coverage/qualification and run R09. Preserve one main agent and at
least one meaningful concurrent subagent task during implementation/validation;
do not edit the same file concurrently. Common composition/spec files have one
owner. Do not clear a fixed gap merely because a counter or test fixture exists.

No new user input is required to begin local non-Voice implementation. Voice is
an explicit deferral, not missing information. Real accounts, provider traffic,
user Desktop/default profiles, paid APIs, hardware, other operating systems and
remote deployment are not inferred test environments. Request a concrete missing
input only if its dependent acceptance becomes ready; continue independent work.
Use the existing request worktree and provisioned dependencies, isolated scratch
profiles and exact executable identities. No push/PR/merge/deploy/install is
implied. Local implementation, checks and commits remain authorized.

The [earlier isolation incident](./ai-command-center-p0-evidence/rust-inspection-isolation-incident.json)
and unknown default-profile effects remain unresolved. New isolated acceptance
cannot establish that earlier data was unaffected.
