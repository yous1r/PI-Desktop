# H1 remaining implementation and acceptance

Accepted adapter candidate: `a360fc5050e8cb751386819dbee9f1cb20b364d1`.
Base: `e977efc96b6b735aeef5066a0b66c6565ad5691f`.
See the [candidate acceptance record](./ai-command-center-p0-evidence/h1-adapters-verification.md).
Historical checkpoints remain evidence for their stated candidates, not assertions
of full native qualification or transfer readiness.

## Scope and task numbering

The authoritative [work-package table](./ai-command-center-parallel-work.md#work-packages)
defines H1 as Desktop coordinator admission and resource inventory adapters for
prompt, plan, schedule, Task/Worker, plugin/MCP, terminal, native and remote-client
entry points. H2 owns Rust source prepare/cancel/fencing/release and durable
receipts; H3 owns successor readiness; H4 owns client reattachment; H5 joins the
complete user path. Historical checkpoints sometimes grouped H2 prerequisites
under H1 headings. Those implementations stay; this list corrects classification.

H1 closes new execution ingress synchronously, retains admitted work through
actual settlement, binds delayed work to its original owner, and refuses missing
or unknown reports. Zero visible work, abort, timeout, dispose or successful kill
is not native closure proof. Unqualified native families remain explicit blockers.

`H1-Rxx` identifiers below subdivide H1; they do not replace H0–H5. **R01–R09 are
accepted for non-Voice Desktop adapter scope. Full H1/native qualification and
complete transfer remain incomplete:** D01 is user-deferred, X01 belongs to H2,
and all ten native/source qualification gaps remain. No additional user input
was needed for the completed local adapter work.

## Task outcomes and acceptance

| ID | Status | Description and principal files | Expected output | Acceptance |
| --- | --- | --- | --- | --- |
| H1-R01 | Adapter accepted | `models-dev-catalog.ts`, `models-dev-catalog-loading.ts`, inventory and catalog tests | Actual loading lifetime and shared admission for local/remote flights | Closed fresh I/O refuses; shared flights count once; abort/body cleanup stays counted; no cancelled/disposed publication. Included in exact-candidate tests; transport gap retained. |
| H1-R02 | Adapter accepted | `updater.ts`, `updater-activity.ts`, `bootstrap/updater.ts`, updater/inventory tests | Original-owner checks/downloads/cache/settings/browser/installer intent | Immutable per-operation Host guard, queued write accounting, retained timeout/disposal work and ambiguous transport refusal pass; production factory feeds inventory. Native gap retained. |
| H1-R03 | Adapter accepted | `oauth.ts`, `oauth-activity.ts`, `bootstrap/oauth.ts`, `ipc/provider-ipc.ts`, OAuth/discovery tests | Owned login/refresh/identity/credential/model continuations | Host/plugin runtime replacement cannot redirect late effects; real settlement governs counts; original-ID terminal events close dialogs. IPC refusal triggers no fallback effects. Native transport gap retained. |
| H1-R04 | Adapter accepted | `mcp-control.ts`, `mcp-control-lifecycle.ts`, `bootstrap/{main-state,startup}.ts`, MCP tests | Retained original instances and listener/socket/request/start-stop accounting | Authenticated body/manifest await races recheck admission; failed starts/replacement preserve original work; bounded stop cannot erase handlers. Real loopback producer feeds inventory; native gap retained. |
| H1-R05 | Adapter accepted | `personal-todos/{activity,runtime,coordinator,window}.ts`, todo/quit/inventory tests | Owned drafts/debounce/editor/window work and original-Host writes | Closed quit cannot bypass admission; queued sequences retain original Host or original capture failure; explicit retry keeps mutation ID/revision; timeout/dispose cannot fabricate commit or native closure. |
| H1-R06 | Adapter accepted | `services/session-collaboration.ts`, collaboration/Worker tests and inventory | Immutable Host/generation/runtime dispatch and retained settlement | Busy delivery remains queued; old passes cannot borrow replacements; admitted settlement stays visible and a new drain can replay receipts. Existing Rust Worker counting and native gap unchanged. |
| H1-R07 | Adapter accepted | `surface-activity.ts`, `bootstrap/{window,launcher,app-lifecycle,main-state}.ts`, `index.ts`, surface tests | One concrete owner and guarded creation/registration | Original handles/loads/writes remain tracked; prewarm-to-show works; Windows keyboard refusal is observed; stale/closed creation refuses. Native/compositor qualification remains open. |
| H1-R08 | Evidence/refusal map accepted | [Native coverage map](./ai-command-center-h1-native-coverage.md), existing backend/plugin/browser/terminal/remote owners | Family-by-family evidence or explicit unsupported-resource refusal | Focused ownership and inventory cases pass; `execution_generation_only` and all ten fixed gaps stay. No wider native closure claim. |
| H1-R09 | Scoped candidate accepted | Inventory/coordinator, adapter suites, `scripts/e2e-owner-inspection.mjs`, evidence documents | Exact candidate, coverage matrix and immutable input/result/cleanup evidence | 792 tests/51 files; current-source types, lint, architecture, policy, docs/base/whitespace; fresh offline Host; 10 isolated scenarios/4 Hosts with confirmed cleanup; 4,514 tracked files unchanged and 23 artifacts rehashed. |
| H1-D01 | Deferred by user | Voice/LiveVoice and existing fixed gap | Preserve prior work and explicit refusal | No resumed Voice development, initialization, downloads or microphone testing; native Voice qualification remains incomplete. |
| H1-X01 | H2 dependency | Rust source integration through `owner_handoff`, original stdio exchange and native owner | Authenticated source mutations, durable receipts and full integration | Existing ingress and internal journal-step evidence retained; production prepare/cancel/fence/release belongs to H2 and joins H5. Not implemented by this adapter change. |

The 792-test result is one candidate run, not an addition of overlapping developer
selections. The process suite validates original Rust/Sidecar ownership and the
Desktop exchange; other process-harness producers are controlled fixtures. Real
adapter user paths are separately mapped in the acceptance record.

## Already accepted prerequisites

- Original Desktop/Host identity binding, fenced Sidecar creation and retained
  backend lifecycle; plan/schedule and existing resource adapters.
- Bounded read-only Rust inspection and 19-field Desktop inventory; malformed,
  missing and replaced owners refuse.
- Worker durable obligation count, original Rust ingress and named internal
  journal transitions (H2/shared prerequisites under the authoritative split).
- Private stdio registration and acknowledgement ordering. See
  [Worker/source-step evidence](./ai-command-center-p0-evidence/worker-steps-verification.md)
  and [ACK ordering evidence](./ai-command-center-p0-evidence/ack-ordering-verification.md).

## Remaining boundaries

Continue H2 source transactions and independently qualify the resource families
before removing any fixed gap. Counter coverage or fixture closure is not enough.
Voice remains paused unless the user explicitly resumes it. Later H3–H5 readiness
and complete transfer are not part of this acceptance.

No push, PR, remote merge, deployment, live Desktop/default-profile testing, real
provider/account, paid API, microphone, model download or SSH test was performed.
The existing request worktree and provisioned dependencies were reused. The
`pnpm check:pr-base` automatic dependency-sync attempt failed on the linked
`node_modules`; the direct repository check and subsequent candidate tests passed.
Other pre-existing test/loader/lint limitations are enumerated in the acceptance
record and are not silently reported as passing.

The [earlier isolation incident](./ai-command-center-p0-evidence/rust-inspection-isolation-incident.json)
and unknown default-profile effects remain unresolved. Later isolated acceptance
cannot establish that earlier data was unaffected.
