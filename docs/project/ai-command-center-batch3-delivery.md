# AI command center: Batch 3 delivery record

- Status: Local engineering delivery; **uncommitted work was committed on the
  request branch**, not product acceptance. External-device and Voice lanes stay
  out of this batch by user decision.
- Branch/worktree: `feat/command-center-wiring-20261111` in
  `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111`; base
  `1cdb4ce1d`, previous Batch 2 head `fdc93a975`.
- User authorization: items 1-3 and 5 of the remaining-wiring list approved as
  new capabilities; item 4 uses the remote `dev` machine for integration
  verification; item 6 keeps external devices and Voice last; item 7 pushes the
  result to `origin` branch `AI-Panel`.

## Lanes

| Lane | Scope | Result |
|---|---|---|
| C3/C4 (`cc-capability`) | Optional `commandCenter` capability, in-repo host composition, C4 dispatch claim/ACK semantics | Capability advertised only with a bound control service and `advertiseCommandCenter: true`; `createCommandCenterHost` composes repository → control → dispatcher; one durable claim per `(requestId, fingerprint)`, payload conflict, lost-reply reconciliation, expected-revision ACK in the same receipt store. Tests: shared 1,616; agent-host 160; racp 47; host-runtime focused 11 |
| H3 (`h3-supervisor`) | Supervisor spawns `--owner-target`, validates claim, gates Ready | `OwnerHandoffTargetSupervisor` states spawned→claim-sent→claimed→ready/ready-refused; strict claim envelope and receipt validation; Ready only through injected `ReadyResources`; child exit/timeout/cancel/dispose fail closed. Rust target 24/24, full `owner_handoff` 148/0, new vitest 20 |
| H4 (`h4-reattach`) | Desktop attachment composition | `createDesktopHandoffReattachment` opt-in port: snapshot then ordered replay, stale-epoch refusal, no turn start, dispose cleanup; 14 tests (7 existing + 7 composition) |
| M1/U1 (`m1-u1-live`) | Monitor producer seam + Desktop live data port | `CommandCenterMonitorProducer`: bounded cut/apply/page, cursor/epoch/error refusal; Desktop page accepts an injected provider while the default fixture preview is unchanged; producer 9, Desktop command-center 32, i18n 33 |
| Lead | Integration, exports, dependency, docs, cross-platform verification | `host-runtime` entry exports the new seams; Desktop declares `@pi-desktop/command-center-client`; RACP spec updated; Linux verification on `dev` |

## Verification (Lead, final tree)

| Suite | Result |
|---|---|
| shared package | 1,616/1,616 (144 files) |
| agent-host package | 160/160 (13 files) |
| racp package | 47/47 (6 files) |
| command-center-client | 259/259 (15 files) |
| host-runtime focused (target, process, host, monitor, attachment, repository) | 69/69 (6 files) |
| Desktop command-center + attachment composition | 46/46 |
| i18n | 33/33 |
| Rust `command_center` | 59/59 |
| Rust `owner_handoff::target` | 24/24 |
| Rust `owner_handoff` | 148/148 |
| Foundations / style tokens | 12/12 PASS; OK |

Not run: `cargo clippy` (known ring/MSVC limit), Desktop package-wide typecheck
only reports pre-existing `electron/main` dist errors, `verify:ui:*`, Electron
journey, real cross-process successor launch, device/hardware qualification.

## Remaining joins after Batch 3

1. Rust side of H3 Ready: the real `--owner-target` binary still stops with
   `HANDOFF_TARGET_ADOPTION_UNAVAILABLE` after the claim; it must open the
   restricted AppState/recovery, prepare the generation and publish `ReadyOutcome`
   on the same process, plus a ready wire exchange or in-process composition.
2. Production composition: a host composition root must inject `ReadyResources`
   and call `launchOwnerHandoffTarget`; `bootstrap/remote-hosts.ts` must construct
   and dispose `createDesktopHandoffReattachment` (including the RACP subscription
   budget change: host+7 sessions leaves no room for the attachment's host+session).
3. C4 runtime consumer and all-entry quota: `CommandCenterRuntimeHandoff.dispatch`
   must be provided by a real exact-target runtime; Desktop/plugin/schedule/Task/
   Worker entry-point quotas and exact-generation Stop are still open.
4. C3 Rust adapter: `commandCenter.intervention.ack` must exist on the Rust side;
   until then C4 dispatch should stay opt-in with no runtime dispatch injected.
5. Real pi-host binding: `operations.commandCenter = host.control`,
   `advertiseCommandCenter: true` and `createDispatch: createCommandCenterDispatch`
   belong to the external pi-host repository.
6. External lanes remain out of scope for now: N1, W1/W2, Q1-Q3, X1, Voice.
