# AI command center: Batch 6 delivery record

- Status: Local engineering delivery on the request branch; committed and
  published to `origin/AI-Panel`. Not a release or platform qualification.
- Branch/worktree: `feat/command-center-wiring-20261111` in
  `D:\Packages\PI-Desktop\.worktrees\command-center-wiring-20261111`; base
  `1cdb4ce1d`, previous head `3c1912797`.
- Scope: close the real production joins left open by Batch 5 — Rust quota /
  monitor persistence cuts, same-process native-root Ready, the production
  `pi-host` composition, and an authenticated end-to-end verification.

## Correction to earlier handoff records

Earlier Batch 3/4/5 records described the production RACP composition as an
**external pi-host repository** and treated it as a blocker. That was wrong:
`apps/pi-host` is tracked in this repository and is now verified present and
composed. The blocking statement is corrected here and in the acceptance index.

## Lanes

| Lane | Result |
|---|---|
| Rust C2 persistence and quota (`cc-capability`) | `command_center_admission.rs`: `reservation.reserve/hold/release/state` inside one immediate C2 transaction; 12/workspace, 36/Host, idempotent duplicate, exactly-once release, workspace/epoch ownership checks, auth-scoped snapshot. `command_center_rpc.rs` hardened: mandatory boot-owner epoch (`require_epoch=true`), `CC_EPOCH_CONFLICT`/`CC_EPOCH_UNAVAILABLE` refusals. |
| Rust monitor cut (Lead) | `command_center_monitor.rs`: bounded, single-transaction cut of the newest reservation per task plus goal heads, approval counts, real boot epoch and monotonic watermark; ≤100 rows / 256 KiB; no transcript, prompt or credential read. |
| Subject authentication (Lead) | `AppState::command_center_owner_epoch()` + `app.handshake` additive `commandCenter {version, hostEpoch}`. Both private adapters require that epoch, so quota and monitor reads are fenced to the live Rust process on every platform, not only when the Windows fence is active. |
| H3 native root (`h3-supervisor`) | Real Job/one-use pipe/ticket, `launch-sidecar` and `attach-epoch` frames, `Registry::wait_root` then `ReadyTarget::commit`, bounded framed serving via `rpc::target_serve`. Production unrooted Ready exception removed (`ReadyIntent` now requires a real root; regression test refuses before any write). Directory guard retained in `main` outside the Tokio runtime so the served profile stays exclusive. Node frame parser now handles coalesced/split chunks and owns sidecar cleanup on cancel/late completion. |
| Desktop wiring (`h4-reattach` / `m1-u1-live` / q0) | Startup-owned successor root with the existing handoff-command registration entry; opt-in reattachment bootstrap; fixed preload/IPC command-center contract with observation-Host selection; renderer live provider only for a capability-advertising Host. |
| Production `pi-host` (q0) | `--command-center` (default off) binds the real control service and monitor page port to the single running host-core, advertising the capability only after the real handshake. Exact-turn steer/reviseGoal and stop are dispatched through `RuntimeService`; append/delegation/inactive turns and subtree stop refuse before a receipt exists. |

## Verified results (Lead, final tree)

| Check | Result |
|---|---|
| `cargo test -p host-core --locked --offline` | see run record; `command_center` **82/82**, `command_center_admission` **11/11**, `owner_handoff` **165/0/1 ignored**, `execution_fence` **10/10**, `state::tests` **5/5** |
| `cargo fmt -p host-core --check` | exit 0 |
| `cargo clippy -p host-core --all-targets --locked --offline` | completed (warnings only) |
| shared | **812/812** source tests, **144/144** files |
| agent-host | **172/172** (14 files) |
| racp | **53/53** (6 files) |
| command-center-client | **259/259** (15 files) |
| host-runtime focused (target/successor/admission/host/monitor/repository/attachment) | **112/112** (10 files) |
| Desktop command-center + handoff + preload | **74/74** |
| Desktop `typecheck` | exit 0 (official project) |
| pi-host `command-center` tests | **4/4** |
| pi-host full suite | 49 pass / 37 fail / 10 skip — all 37 are pre-existing Windows environment failures (POSIX mode bits, 8.3 paths, admin socket, packaging fixtures); no new failure |
| i18n | **33/33** |
| `check-command-center-foundations` | 12/12 PASS |
| `check-style-tokens`, `check-agent-policy` | pass |
| `scripts/e2e-command-center-control.mjs` | **PASS**, 18 checks, Rust binary `92ad3809…`, cleanup confirmed |
| `scripts/e2e-command-center-pi-host.mjs` (command-center mode) | **PASS**, 5 checks, real `startPiHost` + Rust + WebSocket, cleanup confirmed |
| `scripts/e2e-command-center-pi-host.mjs --default-mode` | **PASS**, default Host advertises no command-center capability |

Both end-to-end scripts run the real Rust binary, real SQLite, the production
`HostProcess`, and authenticated loopback WebSocket. The only doubled edge is
the model sidecar (deterministic external runtime acknowledgement / a
`sidecar.configure`-only stub), so no provider, paid API or user profile is used.

## Cross-machine verification on the remote `dev` Linux host

The same candidate (`7afbd2bb6`, then the docs commit) was cloned on
`dev` (Debian 12, x86_64, Node 24.21, rustc 1.89) and exercised there:

| Check | Result |
|---|---|
| `cargo test -p host-core command_center` | **82/82** |
| `cargo test -p host-core owner_handoff` | **141/141** (the 24 Windows-only native-root/serving tests correctly do not compile here) |
| `cargo test -p host-core state::tests` | **5/5** |
| `cargo fmt -p host-core --check` | pass |
| shared / agent-host / racp / client / i18n | 812 / 172 / 53 / 259 / 33 passed |
| `scripts/e2e-command-center-control.mjs` | **PASS**, 18 checks, cleanup confirmed |
| `scripts/e2e-command-center-pi-host.mjs` | **PASS**, command-center mode, cleanup confirmed |
| `scripts/e2e-command-center-pi-host.mjs --default-mode` | **PASS**, no capability advertised |

`cargo test -p host-core` as a whole is **not green on this host**: the
`dev` account is root, so suites that simulate permission failures
(`config_sync` transport/crypto), network-facing review/S3 suites and some
transcript-integrity cases fail for environment reasons. Those modules are
outside this change's surface and were not modified here; the scope suites
listed above are the authoritative signal. This limitation is recorded, not
waived.

Two harness defects found by that run were fixed and re-verified on both
platforms: a clone carrying only the request branch has no `origin/main`, and
a POSIX Host data directory must be owner-only (`0700`) before startup.

## Still open after Batch 6

1. Desktop successor production launch: startup constructs the root and the
   existing handoff command registers a prepared transfer, but the H5
   composition still needs a prepared-claim producer plus the target's real live
   event epoch from the Node hub; until then an opted-in Desktop host fails
   closed with `HANDOFF_ATTACHMENT_READY_UNAVAILABLE`.
2. `target_serve` is serial and drops notifications; the ordinary `rpc::serve`
   concurrency/notification parity and a Node post-Ready RPC/notification client
   remain tickets.
3. Entry-point quota wiring: `admitExecution`/`holdExecution`/
   `releaseExecution` exist and are C2-authoritative, but Desktop session start,
   RACP turn/session create, plugin tools, scheduler, Task/Worker and background
   tasks do not call them yet.
4. `membership.remove` and `intervention.ack status=consumed` boundary
   whitelisting keep their documented C2 gaps.
5. External lanes remain out of scope: N1, W1/W2, Q1-Q3, R1, X1, Voice.
