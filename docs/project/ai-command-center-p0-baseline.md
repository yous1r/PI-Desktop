# AI command center: P0 runtime baseline and capability gaps

- Status: Historical pre-fix P0 measurement slice; M0 remains open.
- Recorded: 2026-11-08 local / 2026-11-07 UTC.
- Requirements: [capacity and acceptance](ai-command-center-requirements.md).
- Design: [development design](ai-command-center-development-design.md),
  [schedule](ai-command-center-schedule.md), [current V3 review](ai-command-center-visual-review.md).
- Follow-up: [1 MiB correction and validation](ai-command-center-1mib-validation.md)
  resolves the recorded persistence overload for the tested envelope. The sections
  below describe the original implementation and measurements; its failed
  artifacts remain unchanged. Current limits and verification are in the follow-up.

## Result and decision

The real headless session path completed twelve and thirty-six overlapping main
sessions at 128 KiB of synthetic context per session. Each final assistant message
was compared byte-for-byte with the fixture after the production persistence flush.
All measured child processes closed. This supports retaining the existing shared
sidecar as the starting point; it does not establish full command-center capacity.

The 36-session run with 512 KiB of context per session **failed**: Host RPC
admission rejected a transcript append and turn settlement with
`HOST_OVERLOADED`. This is a concrete prerequisite for expanding the workload.
It must stay visible; the run is not made successful by its sub-4-GB sampled memory.

No production runtime, quota, schema, permission, provider or UI behavior changes
in this slice. The deliverable is the executable baseline harness, recorded
measurements, failure evidence and the next implementation gates. The proposed
architecture, complete P0/M0 gate and AC-07 are not marked accepted by these runs.

## Measured scope

The harness composes current source implementations of `AgentHost`,
`RuntimeService`, `HostProcess` and `AgentSidecar`, and starts a real Rust Host and
Node sidecar. Sessions are created through Host RPC; prompts enter through the
AgentHost public interface; production events and persistence write the results.
Only launch configuration and the external model endpoint are fixtures. The
loopback HTTP/SSE endpoint returns deterministic text, without model credentials.

Each session waits at an all-session provider barrier. Once every session has an
open request, the endpoint sends fifty chunks at a requested 100 ms interval.
Every stream receives an independent completion marker. Startup has four lanes;
this does not limit overlapping model streams to four. There is no model queue
that could turn the thirty-six-session test into a serial run.

The topology is independent main sessions in one shared sidecar. It does not
implement or prove three logical workspaces, 12-per-workspace admission, child
agents, Worker accounting, child goal changes or cross-device control. The current
native subagent limit of ten per session remains unchanged.

Context is an ASCII payload measured in **bytes**, excluding the fixture prefix,
system prompt and tool schemas. Tokens are `NOT_MEASURED`; 128 KiB must not be
presented as 32k tokens. These are fresh, single-turn sessions with about 45 KiB
of generated assistant text each, not long histories or tool-intensive tasks.

## Environment and provenance

| Item | Actual value |
|---|---|
| OS | Windows 10, `10.0.19045`, x64 |
| CPU / RAM | 6 logical CPUs / 25,765,265,408 bytes (about 24 GiB) |
| Node | `v24.12.0` |
| Source HEAD | `7674ca53cd839a13f44749de52453111ea192e0d` plus the uncommitted P0 harness |
| Refreshed remote base | `fd28eb89866ac513912ed109716e7120cf60f18c`; verified ancestor of HEAD |
| Host | Current Rust source, debug build, shared Cargo target |
| Host binary SHA-256 | `104a99fc334c43548cbd384c8b170bb09093de4d8883bb5369e7eacaad93fe4d` |
| Input manifest digest | `a77da7e07c7afd08cd9e3b92bcdde79b6f6e9ec4e897b2dbfb6d2c52bf9830cb` |
| Sidecar heap option | `--max-old-space-size=2048`; not a process-memory cap |
| Pi packages | `pi-ai`, `pi-agent-core`, `pi-coding-agent` 1.4.0 with current repository patches |

This is not the proposed Windows 11 / eight-core / 32 GB reference machine.
No release binary, renderer, GPU-disabled Desktop or RDP interaction was measured.
The source HEAD names the documentation baseline, not a committed harness release;
input hashes identify the executable sources actually used. The three recorded
runs share the same manifest and binary digests. Later command aliases, lint
inclusion and documentation do not alter the measured executable code.

The primary dependency tree was reused by junction. Its installed Pi 1.4.0 package
lacked required patched `utils/hosted-search` and `utils/local-request-error`
exports. After that incompatibility was demonstrated, an isolated scratch overlay
was installed offline using the exact three Pi versions and repository patches:
120 cached packages reused, zero downloaded, install scripts disabled. The primary
package tree was not replaced. `PI_COMMAND_CENTER_DEPENDENCIES` selects this
optional overlay; normal compatible installations need no overlay.

The pnpm launcher also attempted dependency management when invoking `pnpm exec`
in the linked worktree and rejected its junction. Validation therefore invoked
the already installed tool entry points directly. Do not run another install just
to work around the launcher.

## Measurements

Decimal MB = bytes / 1,000,000. Peaks are maxima of the process sums within each
sample, not sums of unrelated lifetime peaks.

| Run | Context/session | Verified transcripts | All-stream overlap | Peak Private Bytes | Max sample gap | Result |
|---|---:|---:|---:|---:|---:|---|
| 12 sessions | 131,072 B | 12/12 | 5,306 ms | 472,596,480 B (472.6 MB) | 120 ms | Baseline PASS |
| 36 sessions | 131,072 B | 36/36 | 5,309 ms | 656,027,648 B (656.0 MB) | 137 ms | Baseline PASS |
| 36 sessions, larger context | 524,288 B | 0/36 before fail-fast exit | 5,287 ms | 844,554,240 B (844.6 MB) | 150 ms | FAIL: Host RPC overload |

Both successful runs report no aborted streams, no unexpected tool/approval/error
events, no runtime warnings, and successful process cleanup. Verified assistant
output totals are 554,598 and 1,664,814 bytes. The larger-context fixture delivered
all 36 streams, but verification stopped at the first unsuccessful durable
settlement; zero verified is not evidence that every transcript was lost.

The peak sample's component Private Bytes were:

| Run | Coordinator including fixture | Rust Host | Node sidecar |
|---|---:|---:|---:|
| 12 | 100,438,016 | 152,313,856 | 219,844,608 |
| 36 | 175,636,480 | 174,215,168 | 306,176,000 |
| 36 larger context (failed run) | 279,416,832 | 189,784,064 | 375,353,344 |

Measurement limitations are part of the result:

- The coordinator contains production AgentHost/RuntimeService and test provider
  overhead. That combined process is included conservatively. The outer test
  driver and PowerShell sampler are instrumentation and excluded.
- Each sample records PID, process start identity, Private Bytes, working set,
  timestamp and collection duration. Reads within a sample are sequential, with
  maximum collection durations of 27.3 / 41.8 / 55.8 ms in these runs.
- All runs missed the strict no-greater-than-100-ms sampling gate. They preserve
  `samplingTargetMet: false`; no correlated OS allocation trace was captured.
  A baseline PASS checks this bounded fixture and reports sampling limitations;
  it is never an AC-07 PASS or an absolute peak guarantee.
- Process startup before the initial ready barrier is excluded. Sampling covers
  pre-load idle, streaming and post-completion verification, and stops before
  teardown. Renderer, plugins, native resources, browser edge and external
  programs are absent. CPU, event-loop pressure, latency and soak are unmeasured.

## Retained evidence

The evidence directory contains synthetic data only: no user profile, database,
credentials, provider traffic capture or executable binaries.

| Run | Report | Raw samples |
|---|---|---|
| 12 | [report](ai-command-center-p0-evidence/12-report.json) | [samples](ai-command-center-p0-evidence/12-memory.ndjson.txt) |
| 36 | [report](ai-command-center-p0-evidence/36-report.json) | [samples](ai-command-center-p0-evidence/36-memory.ndjson.txt) |
| 36 larger context | [failed report](ai-command-center-p0-evidence/36-large-report.json) | [samples](ai-command-center-p0-evidence/36-large-memory.ndjson.txt) |

Raw samples retain newline-delimited JSON; `.txt` makes them downloadable through
the documentation site without changing their contents.

[Build inputs](ai-command-center-p0-evidence/build-inputs.json) records source,
resolved dependency, harness and lockfile hashes. Paths identify this machine's
resolved inputs, including scratch dependencies; another machine should resolve
its own compatible environment. The digest is SHA-256 of `JSON.stringify(records)`.
Per-run scratch directories additionally contain config, bundled JS and bounded
stderr tails; those temporary files are not required to read the retained results.

## Host capability and failure inventory

| Surface | Current evidence | Required next work |
|---|---|---|
| Session execution and persistence | Real public session/turn path passes 12/36 at 128 KiB | Preserve behavior while adding Host ownership and admission |
| RPC burst protection | Rust `rpc/mod.rs` limits in-flight requests to 32; larger context run records `HOST_OVERLOADED` | Bounded, fair persistence/settlement backpressure with cancellation and failure tests; preserve Host protection |
| Transcript writes under overload | `TurnPersistence` retries `HOST_UNAVAILABLE`; other errors log and return. `finishTurn` reports `settled: false` if endTurn fails | Prove no acknowledged completion loses its final message; retry policy must distinguish retryable capacity from invalid input and avoid duplicate durable effects |
| Host parity | Real headless resolver rejects vendor OAuth; plugin tools/trusted extensions are empty; RuntimeService rejects attachments and Native Pi sessions | Inventory required capabilities and explicit unavailable states before moving existing Desktop sessions |
| Existing history/live attachment | AgentHost and RACP provide session attachment and replay seams; not exercised here | Bounded monitoring projection, history pagination, subscription barrier and stale-state handling |
| Workspace identity/quota | No command-workspace allocator is supplied by this harness | Canonical workspace/execution membership, all-entry atomic 12/36 reservations and recovery; retain narrower child/tool/RPC limits |
| Owner handoff | `pi-host` composition exists; Desktop still owns its normal local prompt path | Exclusive data-directory ownership and interrupted-handoff/reconnect tests before independent service mode |
| Direct child control / goals | Existing delegation IDs and controls are reuse seams, not command-center goal receipts | Freeze target, parent revision, acknowledgment and idempotency contracts before schema changes |
| Browser/mobile | Current Renderer uses Electron API; RACP loopback/SSH is not browser deployment | Portable client boundary, authenticated same-origin browser edge and real device qualification |
| V3 Desktop/native programs | Reviewed design assets only | Implement toolbar/Host status, monitoring and A/B/C entry tabs later; the two lower overview regions remain undecided |

Source references at the measured production base:
[RPC admission](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/crates/host-core/src/rpc/mod.rs),
[turn persistence](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/host-runtime/src/turn-persistence.ts),
[runtime service](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/host-runtime/src/runtime-service.ts),
[headless resolver](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/host-runtime/src/launch-resolver.ts),
[AgentHost](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/agent-host/src/agent-host.ts),
[RACP operations](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/racp/src/operations.ts),
[subagent limits](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/packages/shared/src/subagent-definition.ts),
[Host deployment](https://github.com/yous1r/PI-Desktop/blob/fd28eb89866ac513912ed109716e7120cf60f18c/apps/pi-host/README.md).

## Reproduce

Use the dedicated request worktree and the host's compatible installed toolchain.
Refresh `origin/main` and incorporate it before candidate validation. Build Rust
from this checkout, reusing the existing Cargo target. Example for Windows Git Bash:

```sh
cargo build -p host-core --locked --target-dir /path/to/shared/target
node scripts/check-pr-base-main.mjs
node --test scripts/e2e/command-center/*.test.mjs
node scripts/e2e-command-center-baseline.mjs \
  --host-bin /path/to/shared/target/debug/pi-desktop-host-core.exe \
  --scratch-dir /path/to/isolated/scratch --sessions 12
node scripts/e2e-command-center-baseline.mjs \
  --host-bin /path/to/shared/target/debug/pi-desktop-host-core.exe \
  --scratch-dir /path/to/isolated/scratch --sessions 36
```

At the original source manifest, `--context-bytes 524288` exposed the recorded
failure. The corrected candidate is validated separately at 1 MiB; the old failure
must not be expected or claimed on current code. `PI_DESKTOP_HOST_BIN` and `PI_SCRATCH_DIR` are
optional equivalents of the two explicit paths. Each run creates a unique child
directory, copies the nominated Host binary and bundles current workspace sources
instead of borrowing another worktree's `dist`. For a demonstrated incompatible
Pi installation only, point `PI_COMMAND_CENTER_DEPENDENCIES` at a prepared patched
overlay. The baseline scripts never install dependencies.

Package aliases are `test:command-center-baseline` and
`test:e2e:command-center-baseline`; use the direct Node commands when the pnpm
launcher rejects linked dependency state. The collector currently requires Windows.
CLI ranges and defaults are available with `--help`. Run different capacities
sequentially so they do not compete for the same host resources.

The harness allowlists the child environment, isolates data/HOME/appdata/temp,
uses no configured provider secrets, and bypasses global Skills/Subagents discovery
through an explicit fixture launch. This is intentional: Windows Rust home lookup
is not isolated merely by setting `HOME`. No tools are requested by the provider.
Unexpected tool/approval/input/error events, missing/PID-reused samples, partial
outputs, overload diagnostics, failed startup or unconfirmed cleanup fail the run.
Only the fixture's owned process tree is eligible for the timed cleanup fallback.

## Verification and phase gates

Executed: current-source Rust debug build; ten Node harness tests; targeted Biome
lint; real-runtime smoke; 12/36 runs and the failed 36 large-context run above;
remote-base ancestry check; independent recomputation of all three retained reports
and verification of all 3,551 recorded input hashes; invalid-Host-path failure
artifact check. The report regression test first failed on duplicate
inventory, then passed after validation was corrected. Smoke also exposed and
fixed test configuration drift (`ProjectInstructions.entries`) and a premature
persistence assertion; production behavior was not changed to satisfy the test.

Desktop typecheck/full JS build, Electron/RDP/browser journeys, `verify:ui:*`,
real providers and full Rust tests were not run for this test-only implementation.
The harness bundles the source modules actually executed. Product acceptance,
long-running stability, platform performance and deployment remain unverified.

Before M0 can close and dependent P1 behavior is accepted:

1. Address the observed RPC overload with a regression that drives overlapping
   completions and checkpoint writes. Keep resource bounds and verify final text,
   durable settlement, cancellation and recovery before claiming the larger load.
2. Freeze a token-counted representative context/mixed main-child-Worker fixture,
   a target machine, plugin/tool workload and the complete application process set.
   Improve collection cadence and startup coverage; retain OS-trace limitations.
3. Complete the workspace/execution/goal/receipt contract review and Host parity
   inventory. Keep the single SQLite writer and old-session compatibility intact.
4. Run the four-surface/RDP probe and nominate native applications and mobile
   devices. Existing review images do not count as executable UI evidence.

The immediate next scoped implementation is the persistence/settlement overload
path. It precedes any claim of 36-instance qualification; independent Host handoff,
UI implementation and browser exposure retain their separate design/test gates.
