# AI command center: 1 MiB context reliability validation

- Status: Persistence/settlement correction implemented and verified on the bounded fixture. Full P0/M0 and AC-07 remain open.
- Historical failure: [P0 baseline](ai-command-center-p0-baseline.md).
- Contracts: [RPC admission](../spec/03-runtime/06-host-rpc-protocol.md#21-runtime-admission-and-backpressure), [process model](../spec/03-runtime/07-process-model.md).

## Outcome

The final candidate passed four real Host/runtime runs with **1,048,576 UTF-8
bytes of text per session**, including repeated 36-session runs and a longer
Chinese/emoji fixture. All 120 inputs and replies matched in full before runtime
disposal and after reopening the data with a new Rust Host process. No run
reported overload, unexpected events, persistence diagnostics or cleanup failure.
This fixes the burst failure observed at 512 KiB in the historical baseline;
it does not qualify arbitrary workloads or the full command-center application.

## Implementation

`packages/host-runtime/src/host-write-admission.ts` provides FIFO admission for
`session.appendMessage`, `session.recordUsage`, `session.saveInflightMessage`
and `session.endTurn` through the shared `HostProcess`. Eight writes can be in
flight. Active and queued writes together are limited to 256 requests and 64 MiB
of serialized request bytes. Overflow returns `LIMIT_EXCEEDED` before sending;
waiting uses the existing transport deadline. Timed-out active writes retain
their permits until response or process loss, because timeout does not cancel
Rust execution. Closing the transport rejects waiting calls. Tool cancellation,
permission decisions and other RPCs bypass this write queue and retain Host
admission checks. Rust's 32-RPC cap and 64-MiB request-frame limit are unchanged.
Existing explicit-overload retries remain 50/100/200/400 ms; no retry layer was
added for arbitrary failures or timed-out writes.

`TurnPersistence` preserves session order, continues archiving after a failed
row, and records the first failure for the owning turn. `TurnEventPipeline`
orders the final checkpoint before the final transcript append. `RuntimeService`
waits for that session's writes before ending its durable turn. Only an
acknowledged transcript and `endTurn.ok === true` can produce successful
settlement. Persistence/settlement failures report an error and `settled: false`;
previously locked abort reasons remain aborted. Failures from late old-turn rows
do not affect the new turn.

Root terminal events now come from the claimed finalization, after that barrier.
Previously, raw `agent_end` could mark AgentHost complete before persistence,
which also prevented a later failure from correcting its terminal state. Failed
persistence now produces an error event rather than early completion. Concurrent
terminal events still join one finalization. Shutdown waits for queued writes
and claimed finalizations before clearing listeners.

No schema, wire fields, permission rules, provider defaults or model limits
changed. The shared admission improvement also applies to Electron's transport;
its separate file-backed outbox and local turn lifecycle remain in place.

## Measured results

All rows use fresh independent main sessions in one sidecar. Decimal MB/GB are
bytes divided by 1,000,000/1,000,000,000. The peak is the maximum concurrent sum
of coordinator, Rust Host and Node sidecar Private Bytes, not a sum of unrelated
process peaks.

| Run | Context | Output chunks / requested interval | Verified before disposal and after reopen | Stream overlap | Peak Private Bytes | Max sample gap |
|---|---|---|---:|---:|---:|---:|
| 12 sessions | 1 MiB ASCII | 50 / 100 ms | 12/12 | 5,310 ms | 745,959,424 B (746.0 MB) | 122 ms |
| 36 sessions A | 1 MiB ASCII | 50 / 100 ms | 36/36 | 5,336 ms | 1,023,750,144 B (1.024 GB) | 137 ms |
| 36 sessions B | 1 MiB ASCII | 50 / 100 ms | 36/36 | 5,300 ms | 1,018,331,136 B (1.018 GB) | 181 ms |
| 36 sessions, extended | 1 MiB mixed UTF-8 | 600 / 50 ms | 36/36 | 35,833 ms | 2,942,394,368 B (2.942 GB) | 192 ms |

The extended run produced 19,992,314 bytes of assistant text in total, about
555 kB/session, versus about 46 kB/session in the short runs. Larger output
substantially increased memory use. The observed stream duration exceeded the
requested minimum; no latency or throughput SLA is inferred.

The four sample counts are 76 / 137 / 150 / 480. Maximum collection durations
were 42.0 / 50.7 / 120.6 / 174.0 ms. All four report `samplingTargetMet: false`.
Their sampled peaks are below the proposed 4,000,000,000-byte budget, but these
are **not full-workbench 4 GB acceptance results**.

## Evidence and reproducibility

| Run | Report | Samples | Reopen verification |
|---|---|---|---|
| 12 | [report](ai-command-center-p0-evidence/12-1mib-report.json) | [samples](ai-command-center-p0-evidence/12-1mib-memory.ndjson.txt) | [reopen](ai-command-center-p0-evidence/12-1mib-reopen.json) |
| 36 A | [report](ai-command-center-p0-evidence/36-1mib-a-report.json) | [samples](ai-command-center-p0-evidence/36-1mib-a-memory.ndjson.txt) | [reopen](ai-command-center-p0-evidence/36-1mib-a-reopen.json) |
| 36 B | [report](ai-command-center-p0-evidence/36-1mib-b-report.json) | [samples](ai-command-center-p0-evidence/36-1mib-b-memory.ndjson.txt) | [reopen](ai-command-center-p0-evidence/36-1mib-b-reopen.json) |
| Extended UTF-8 | [report](ai-command-center-p0-evidence/36-1mib-utf8-600-report.json) | [samples](ai-command-center-p0-evidence/36-1mib-utf8-600-memory.ndjson.txt) | [reopen](ai-command-center-p0-evidence/36-1mib-utf8-600-reopen.json) |

All four share [the source/dependency manifest](ai-command-center-p0-evidence/1mib-build-inputs.json),
SHA-256 `58cd2f620e5fa11a2971dc723adcc1bd8465aa6b8ec16dd3b79187117c597409`
(over `JSON.stringify(records)`). Source HEAD is
`7674ca53cd839a13f44749de52453111ea192e0d` plus this uncommitted task diff;
remote base `fd28eb89866ac513912ed109716e7120cf60f18c` was fetched and verified
as an ancestor. The manifest identifies the executed code more precisely than
that documentation-only HEAD. Host binary SHA-256 remains
`104a99fc334c43548cbd384c8b170bb09093de4d8883bb5369e7eacaad93fe4d`.
Each reopen artifact records the binary, original input-manifest and verifier
script hashes, plus per-session content hashes.

Environment is Windows 10 `10.0.19045`, Node `v24.12.0`, six logical CPUs and
25,765,265,408 bytes RAM. The Host is a current-source debug build. Installed
tools and the previously prepared compatible patched Pi 1.4.0 overlay were
reused; no new dependency installation or paid provider was used in this fix.
The sidecar uses `--max-old-space-size=2048`, which is not a process-memory cap.

From the request worktree, using an already built matching Host:

```sh
node --test scripts/e2e/command-center/*.test.mjs
node scripts/e2e-command-center-baseline.mjs \
  --host-bin /path/to/pi-desktop-host-core.exe \
  --scratch-dir /path/to/isolated/scratch \
  --sessions 12 --context-bytes 1048576
# Repeat with --sessions 36 twice, then add:
# --context-kind utf8 --ticks 600 --interval-ms 50
node scripts/e2e-command-center-reopen.mjs /path/to/completed-run
```

Run capacities sequentially. The main harness bundles current workspace source,
allowlists the environment and creates fresh data directories. The loopback
provider checks exact context content, waits for all streams, and emits known
output. The worker checks full user/reply content and no pending appends before
`RuntimeService.dispose()`. The reopen script starts a new Host against only
that fixture and checks message count, status and content hashes. Failures retain
artifacts and exit nonzero. No user Desktop, profile or configured credentials
are used. `PI_COMMAND_CENTER_DEPENDENCIES` is needed only for the previously
identified incompatible host dependency installation.

## Regression verification

- The original added regression run failed seven assertions on the old code:
  unbounded write bursts, queued timeout/exit behavior, early completion, swallowed
  append failure, abort ordering and unacknowledged settlement. Additional tests
  demonstrated early terminal events and `completed` after `endTurn.ok: false`.
- Host-runtime suite: 187 passed, three existing platform skips. Targeted suites
  cover 36 concurrent 1-MiB prompts, delayed checkpoint/append completion, abort,
  permanent append failure, host-unavailable retry exhaustion, stale old-turn
  failures, explicit overload retries, byte/count capacity, queued timeout,
  active timeout permit retention and process closure.
- Harness: 14 Node tests passed, including exact 1-MiB ASCII/UTF-8 ingress and
  rejection of a truncated context. Related Desktop checkpoint/boot tests:
  15 passed. These tests do not launch the user's Desktop.
- Shared source build and host-runtime source typecheck passed. Because reused
  dependency junctions point to missing/stale package builds, validation mapped
  workspace imports to current source, loaded Pi's existing message-augmentation
  declaration, and mapped the real-child test's shared import to this worktree's
  newly built `shared/dist`. These are validation configuration adaptations;
  no production type casts or dependency changes were used to hide errors.
- Targeted Biome checks passed for 22 production/test/harness files. The source
  diff was reviewed and `git diff --check` passed. All four reports were recomputed
  from raw samples; all 3,554 manifest hashes matched current inputs; retained
  artifacts matched the original run files byte-for-byte; all 120 reopen content
  hashes matched independently regenerated expectations. The remote-base check,
  622-page documentation check and VitePress build passed (44.78 seconds).

## Limits

1. **Bytes are not tokens.** The payload excludes the routing prefix, system
   prompt, tools and history. Token count is `NOT_MEASURED`. The deterministic
   fixture advertises a 1,048,576-token window so transport/persistence testing is
   not accidentally replaced by compaction. This is fixture configuration only.
   Real providers have their own tokenizer, context/output window, request size,
   rate/concurrency quota and timeout constraints. This does not prove model
   reasoning quality over 1 MiB.
2. **Bounded workload only.** There are 36 independent main sessions, no native
   children/Workers, mixed tools, plugins, attachments, long histories or repeated
   turns in one session. The extended run is about 36 seconds, not an hours-long
   soak or a leak qualification. More output, tools and histories can exceed the
   observed memory envelope or queue limits. Upstream per-session event queues
   are not converted into a disk-backed outbox by this fix.
3. **Memory is sampled.** Process readings are sequential and the 100-ms cadence
   target was missed. Startup before the ready barrier, renderer, native views,
   plugins, browser edge and external applications are excluded. Coordinator
   fixture overhead is included. There is no OS allocation trace or absolute
   peak guarantee; the full proposed AC-07 remains open.
4. **Failure is explicit, not impossible.** Disk full, Host loss, exhausted
   deadlines, queue limits or enough non-write RPC traffic can still fail a turn.
   They cannot produce confirmed success through this persistence path. A
   timed-out write may have landed and is not automatically replayed. Headless
   queues remain in memory; hard-kill/power-loss durability extends only to
   acknowledged transcript writes and saved checkpoints. Reopen tests cover
   normal shutdown, not power interruption or storage-device failure.
5. **Platform and scope.** Validation used one Windows machine, a debug Host,
   a loopback model and current-source bundles. Full Desktop build/typecheck,
   Rust unit suites, UI/RDP/browser/mobile journeys, real providers and other OSes
   were not rerun: this change touches shared Node transport/headless lifecycle,
   and the actual Rust boundary was exercised by the isolated E2E. `verify:ui:*`
   was not requested. No remote publication, deployment or commit was performed.
