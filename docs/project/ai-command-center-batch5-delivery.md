# AI command center: Batch 5 delivery record

- Status: Local engineering delivery on the request branch; not product
  acceptance. Pushed to `origin/AI-Panel` for cross-machine verification.
- Branch/worktree: `feat/command-center-wiring-20261111` in
  `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111`; base
  `1cdb4ce1d`, previous head `6b5ec1f91`.
- Scope: C4 runtime seam and consumed acknowledgement, H3 restricted serving
  foundation, H4/H5 successor composition, monitor page transport. External
  devices and Voice stay out.

## Lanes

| Lane | Scope | Result |
|---|---|---|
| C4 (`cc-capability`) | Runtime injection seam + consumed acknowledgement | `createCommandCenterHost` gains `runtimeMode` (`record-only` default, `required` fails at construction without a dispatch consumer). Shared consumption binding validator; ACK `status=consumed` requires boundary/target/consumedRevision evidence and is persisted through the existing C2 `acknowledge_consumption`; dispatch can no longer claim consumption. Tests: shared 1,618, agent-host 163, racp 50, Rust RPC 7, command_center 66 |
| H3 (`h3-supervisor`) | Restricted AppState, registry adoption, serving foundation | `AppStateOpenMode` + `open_restricted_target` (skips recovery/scheduled/plugin reconcile; normal open unchanged), `event_epoch` accessors (default None, never minted), `Registry::adopt` reusing the captured owner/epoch, a bounded framed JSON-RPC serving loop and a `target_serve` skeleton that refuses with `HANDOFF_TARGET_SERVING_UNAVAILABLE` until a real root and live epoch exist. Tests: target 34/34, full owner_handoff 158/158, state 4/4, execution_fence 10/10 |
| H4/H5 (`h4-reattach`) | Production successor composition | `OwnerHandoffSuccessor` validates the original record/claim, launches through the injected launcher, exposes `ensureStarted`, claim-based `identity()` and strict `readStatus()` (record ready + target Ready + matching event epoch), fails closed on every mismatch and stops the child on dispose. Desktop bootstrap consumes the structured successor port and keeps the default off. 8 successor tests + 22 handoff tests |
| M1/U1 (`m1-u1-live`) | Monitor page transport and renderer channel | New `commandCenter/monitorPage` RACP operation (viewer, bounded, capability-gated) with strict request/response schemas and server-side port; Electron main/preload fixed IPC contract (capability, monitorPage, ping, workspaceList, receiptList) with no renderer RACP access; renderer bootstrap builds the live client provider only for a capability-advertising connected Host, otherwise fixture preview and explicit offline. racp 53/53, Desktop command-center 65/65 |

## Verification (Lead, final tree)

| Suite | Result |
|---|---|
| shared package | 1,618/1,618 (144 files) |
| agent-host package | 163/163 (13 files) |
| racp package | 53/53 (6 files) |
| command-center-client | 259/259 (15 files) |
| host-runtime focused (target, successor, monitor, host, repository, attachment) | 90/90 (8 files) |
| Desktop command-center + handoff + preload | 65/65 |
| i18n | 33/33 |
| Rust `command_center_rpc` | 7/7 |
| Rust `command_center` | 66/66 |
| Rust `state::tests` / `execution_fence` | 4/4 / 10/10 |
| Rust `owner_handoff::target` | 34/34 |
| Rust `owner_handoff` | 158/158 |
| Foundations / style tokens | 12/12 PASS; OK |

Not run: `cargo clippy` (known ring/MSVC limit), Desktop package-wide typecheck
only pre-existing `electron/main` dist errors, `verify:ui:*`, Electron journey,
real binary successor launch, real-device qualification.

## Remaining joins after Batch 5

1. Real root: after `Registry::adopt` the active generation is absent; the
   target PreparedGeneration needs a Job/one-use pipe, a ticket for the Node
   supervisor to start the sidecar with `--internal-execution-runner`, peer
   parent/creation validation and `prepared.bind_root`.
2. Live event epoch: Rust has no hub event source; the Node successor must send
   the exact pre-ready/registration epoch to the target and call
   `set_event_epoch` before serving.
3. Node post-Ready serving client and notification channel; readiness admission
   opening must be wired explicitly by the composition layer.
4. H5 composition root: provide the prepared claim/targetBuild, original-host
   reader, live epoch provider and `launchOwnerHandoffTarget`, then pass the
   resolver into `startup.ts` (still default off).
5. C4: a real exact-target runtime must call `acknowledgeConsumption` after
   accepted; entry-point quotas and exact-generation Stop remain open, and C2
   has no per-intent boundary whitelist.
6. Monitor: the in-repository headless Host (`apps/pi-host`) must bind the monitor page port with a trusted
   scope key; RACP initialize has no Host epoch, so the observer identity stays a
   local lifecycle value; Host selection UI is absent.
7. External lanes remain out of scope: N1, W1/W2, Q1-Q3, X1, Voice.
