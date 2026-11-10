# Private exchange acknowledgement acceptance

- Status: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.
- Tested candidate: `7df16a925c9b9b4ac09aad1ba6124350078f024d`.
- Base: `7e493e8b18d277d8d13f682cf250604ed94fb00d`.
- Execution: `2026-11-10T05:07:03.594Z` to `2026-11-10T05:09:52.643Z`.
- Clean before/after; 2,888 tracked source inputs unchanged; 812 distinct build
  inputs and verification artifacts independently rehashed.

## Regression and acceptance

The old implementation failed two deterministic ordering tests while 33 exchange
cases passed. The fix retains one immutable next notification during completion
ACK only, serializes coordinator work and includes waiting in the original
25-second coordinator deadline. Duplicate/extra notifications, invalid identities,
failed/timed-out ACKs and original-owner loss still revoke the channel.

Exact-candidate validation passed 78 runtime, 5 shared contract and 40 Desktop
coordinator tests (123 total), plus 10 isolated native process scenarios with
four Hosts and confirmed cleanup. The application service test uses real
coordinator/inventory wiring and an RPC fixture that emits the next notification
before the previous ACK; both attempts return the existing busy refusal without
revoking an unheld subscription. The native suite verifies existing completion
refusal, inventory and startup/restart boundaries; it does not initiate a
successful source mutation.

The exchange module was bundled from current source. TypeScript, lint,
architecture, agent-policy, documentation, base and whitespace checks passed.
No Rust implementation changed: 261 manifest entries and the complete tracked
native tree (`crates/host-core`, `.cargo`, `Cargo.toml`, `Cargo.lock`) match accepted
candidate `b189901bbc1931f15a6e010021d006e469f24597`. The full-tree check includes SQL
files omitted by the older extension-filtered manifest. Its verified Host binary
was reused; no new Cargo/full Rust-suite execution is claimed.

## Artifact binding

Artifacts are in session scratch
`C:/Users/Administrator/.pi-desktop/scratch/233744ff-b9c5-46dd-9a91-5169100d5569`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `h1-ack-candidate.json` | 221573 | `b03897f12ab3e970804e5c78634d34288155ae222f5f43f5f0c49eb482f47405` |
| `h1-ack-candidate-inputs.json` | 495638 | `ce9364eed511d35ba25a7bafcc58d433e511fdf1b0cc5876a82cbbec67e57a68` |
| `h1-ack-candidate-exchange.mjs` | 464237 | `93f4eb6327f0c02b88b05c0dfa64a079622684db198f1010a84dcd79861c64df` |
| `h1-worker-steps-candidate-host.exe` | 35436032 | `921247d6632c1762af6158014e98a701ddb76701fcf130f312b23962aa84029c` |
| `owner-inspection-eTiFUZ/report.json` | 2249 | `91201a516ca9b88f721f35d56ec0a0f942c253071da92f046fed8d7d31b36132` |
| `h1-ack-verify.mjs` | 4835 | `1b88f6e8dab8aa160cfdc3846f34b0aeddcf6407096f9b00a27f5bb2d4781cdc` |

Independent verification checked test identities/results, artifact hashes,
source/commit equality, native reuse, cleanup and clean worktree state. The
native test ran once in a separate agent while the parent ran JS/static checks.
Its generated `runtime-exports.mjs` path differs per isolated run; source content
and the native consumer bundle remain unchanged.

Source commands remain preflight/status-only. Authenticated prepare/cancel/fence/
release orchestration and all ten resource qualifications are still open.
Voice/LiveVoice remain paused. No live Desktop, real provider or microphone test
was performed. The [earlier isolation incident](./rust-inspection-isolation-incident.json)
and unknown default-profile effects remain unresolved; this acceptance does not
prove the earlier profile was unaffected.
