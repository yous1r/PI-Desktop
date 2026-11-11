# AI command center: Batch 4 delivery record

- Status: Local engineering delivery on the request branch; not product
  acceptance. The branch is pushed to `origin/AI-Panel` for cross-machine
  verification.
- Branch/worktree: `feat/command-center-wiring-20261111` in
  `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111`; base
  `1cdb4ce1d`, previous head `b8f7f4773`.
- Scope: the user-approved remaining joins from Batch 3 — Rust Ready, Rust
  commandCenter RPC, Desktop reattachment bootstrap, real monitor transport.
  External devices and Voice stay out of this batch.

## Lanes

| Lane | Scope | Result |
|---|---|---|
| Rust commandCenter RPC (`cc-capability`) | Private `commandCenter.*` adapter consumed by `RustCommandCenterRepository` | New `rpc/command_center_rpc.rs`: strict `{binding, auth, input}` envelope, role/scope/binding/epoch checks, workspace/membership/receipt/intervention record+ack over the existing C2 APIs. `intervention.record` replays the retained receipt for the same request/fingerprint and conflicts on changed payload; `intervention.ack` uses expected-revision CAS. Errors carry `CC_<CODE>:` families. Tests: 6 new, command_center suite 65/65 |
| Rust Ready (`h3-supervisor`) | Same-process restricted Ready for `--owner-target` | New `TargetReadyResources`/`TargetReadyPublisher` and a bounded `ready` frame; claim, restricted initialization, `ReadyTarget::commit`, then wait for channel EOF. Ready refusals: not-initialized, identity mismatch, incompatible build, stale revision; failed generations close while the claim stays recoverable. Tests: target 29/29, full owner_handoff 153/153 |
| Desktop reattachment bootstrap (`h4-reattach`) | Production construction of the H4 port | Opt-in `handoffAttachment` resolver in `bootstrap/remote-hosts.ts`; per-host port created after `connection.open()`, disposed before connection close on close/restart/shutdown; opted-in hosts use `maxSessionSubscriptions: 5` so the 8-subscription budget fits the attachment's host+session. Without a real Ready source the port fails closed with `HANDOFF_ATTACHMENT_READY_UNAVAILABLE`. Tests: 19 handoff tests |
| Real monitor transport (`m1-u1-live`) | HostRpcPort-backed monitor provider and Desktop bootstrap | `createCommandCenterMonitorProvider` feeds `CommandCenterMonitorProducer` from `RustCommandCenterRepository` over `HostRpcPort`; Desktop `command-center-bootstrap.ts` builds a live provider only when the Host advertises `commandCenter`, with the fixture preview as the fallback and explicit offline states. Tests: 26 focused host-runtime, 38+ Desktop command-center |

## Verification (Lead, final tree)

| Suite | Result |
|---|---|
| shared package | 1,616/1,616 (144 files) |
| agent-host package | 160/160 (13 files) |
| racp package | 47/47 (6 files) |
| command-center-client | 259/259 (15 files) |
| host-runtime focused (target, monitor, host, repository, attachment) | 80/80 (7 files) |
| Desktop command-center + handoff | 57/57 |
| i18n | 33/33 |
| Rust `command_center_rpc` | 6/6 |
| Rust `command_center` | 65/65 |
| Rust `owner_handoff::target` | 29/29 |
| Rust `owner_handoff` | 153/153 |
| Foundations / style tokens | 12/12 PASS; OK |

Not run: `cargo clippy` (known ring/MSVC limit), Desktop package-wide typecheck
only reports pre-existing `electron/main` dist errors, `verify:ui:*`, Electron
journey, real binary end-to-end (no prepared profile), real-device qualification.

## Remaining joins after Batch 4

1. Full same-process serving: the restricted initialization currently registers
   an unrooted generation with an explicit restricted flag; it does not open
   AppState/recovery, start the sidecar/scheduler, adopt the native target
   identity/coordinator into the execution Registry, or run an RPC serving loop.
   The Ready event epoch is a fresh UUID and must become the live event source.
2. Production Host composition must call `launchOwnerHandoffTarget` and own the
   child lifetime; the Desktop bootstrap must provide the real `readStatus`
   (`record.phase=ready`, matching revision, protocol 11, target event epoch,
   `snapshotRequired=true`) and authenticated identity from the target handshake.
3. C4 runtime consumer: `CommandCenterRuntimeHandoff.dispatch` still needs the
   real exact-target runtime; entry-point quota and exact-generation Stop remain
   open, and `intervention.record` requires a live reservation from the C4
   admission path.
4. C2 gaps: `intervention.ack` with `status=consumed` needs the execution
   boundary/target evidence; `membership.remove` needs a revision tombstone.
   Both refuse explicitly today.
5. RACP/preload: there is no monitor page-read operation or renderer/preload
   channel carrying the `commandCenter` capability and monitor pages; the live
   Desktop provider therefore waits for an authenticated adapter.
6. External pi-host binding and external input lanes (N1, W1/W2, Q1-Q3, X1,
   Voice) remain out of scope for this batch.
