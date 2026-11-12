# AI command center: Batch 7 delivery record

- Status: Local engineering delivery committed and published to
  `origin/AI-Panel`; not a release or platform qualification.
- Base: `1cdb4ce1d`; previous head `fbc25c04a`; branch
  `feat/command-center-wiring-20261111`.
- Scope: wire C2 quota into the production turn entry point and finish the
  Node side of the successor serving channel.

## Lanes

| Lane | Result |
|---|---|
| Turn-entry quota (`cc-capability`) | `CommandCenterControl` gains `admitSessionTurn`/`holdSessionTurn`/`releaseSessionTurn`: the command workspace and revision come only from the C2 membership record (missing membership → `NOT_FOUND`, disabled workspace → `CONFLICT`), then the existing C2 reservation transaction decides capacity. `RuntimeService` gains an optional `RuntimeTurnAdmissionPort`: `startTurn` reserves after the durable turn row and before any prompt; a refusal settles the turn as failed and never starts the sidecar; `finishTurn` releases `completed`/`aborted`/`failed` exactly once and holds `outcome_unknown` when the terminal row is unconfirmed. `pi-host --command-center` installs the port on the same runtime and clears it on dispose; flag off changes nothing. |
| Post-Ready serving client (`h4-reattach`) | `OwnerHandoffTargetProcess` now offers `rpcCall`/`onTargetNotification`/`closeTargetNotifications` over the same 4-byte framed channel after Ready: id-correlated JSON-RPC requests (out-of-order, coalesced or split frames), error mapping with `errorCode`, 32 in-flight bound, timeouts, a bounded 64-entry/256 KiB notification queue with explicit overflow failure, and dispose that rejects everything and still waits for the child. |

## Verification (Lead, final tree)

| Check | Result |
|---|---|
| agent-host package | **172/172** |
| racp package | **53/53** |
| command-center-client | **259/259** |
| host-runtime focused (runtime-service, target, target-process, successor, control host, admission, repository, checkpoint) | **94/94** |
| pi-host command-center suite | **11/11** (3 unrelated `config` failures remain the pre-existing Windows path/mode-bit environment ones) |
| Desktop command-center route/component/view/user-path/provider/bootstrap/preload/monitor-e2e | **47/47** |
| Desktop `typecheck` | exit 0 |
| i18n | **33/33** |
| foundations / style tokens / agent policy | 12/12 PASS; OK; pass |
| `scripts/e2e-command-center-control.mjs` | **PASS**, cleanup confirmed |
| `scripts/e2e-command-center-pi-host.mjs` (command-center) | **PASS** |
| `scripts/e2e-command-center-pi-host.mjs --default-mode` | **PASS** |

The turn-admission path is proved by the pi-host suite through the real
`RuntimeService` and `CommandCenterControl` with a fake host transport: quota
full refuses without prompting, a completed turn releases once, abort releases
`aborted`, an unacknowledged terminal row holds `outcome_unknown`, missing
membership/disabled workspace refuse, and flag-off keeps the original path.

## Still open

1. Desktop local session start, plugin tool execution, scheduler, Task/subagent,
   native child/Worker orchestration and background tasks do not call the
   admission port yet; only the headless Host's RACP `turn/start` does.
2. Rust `target_serve` still drops server notifications and is serial; the Node
   client contract exists but the forwarding and ordinary-`rpc::serve` parity
   remain.
3. The Desktop successor still lacks a prepared-claim producer and the target's
   live hub event epoch, so an opted-in Desktop host fails closed.
4. `membership.remove` and per-intent consumption boundary policy keep their C2
   gaps.
5. External lanes remain deferred: N1, W1/W2, Q1-Q3, R1, X1, Voice.
