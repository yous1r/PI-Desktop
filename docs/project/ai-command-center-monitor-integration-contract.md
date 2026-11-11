# AI command center: monitor integration contract for the C3 join

- Status: **Dependency contract, not implemented production code and not a wire
  protocol.** It specifies what the committed C3/C2 authorization, query and
  change-source work must supply before the existing internal monitor foundations
  can be composed. No capability becomes available from this document.
- Foundations already implemented on this request branch:
  [bounded snapshot store](../../packages/agent-host/src/monitor/snapshot-store.ts),
  [portable monitor reader](../../packages/command-center-client/src/monitor/reader.ts),
  [connection health](../../packages/command-center-client/src/health/controller.ts).
- Executable ordering evidence:
  [projection barrier contract test](../../packages/agent-host/src/monitor/projection-barrier.test.ts).
- Basis: [development design](ai-command-center-development-design.md#a-discover-and-monitor),
  [control contracts](ai-command-center-control-contracts.md#monitoring-and-attachment-contract),
  [parallel-work M1 row](ai-command-center-parallel-work.md), and the current
  capability rules in `packages/shared/src/command-center/capabilities.ts`.

## Required producer ports (to be owned by C3/C2)

Names and signatures below are **requirements for the future adapter**, not
existing exported APIs. They deliberately avoid RACP/IPC operation names.

1. **Authorized source cut.** For an authenticated viewer principal and resolved
   workspace filter, return a consistent collection of complete C1
   `CommandCenterTaskSummary` rows plus the matching change watermark. Rows must
   contain the authoritative command workspace, desired/effective goal revisions,
   status, waiting reason and pending-human counts. Missing facts cannot be
   synthesized from session titles, project ids, status heuristics or session
   revisions.
2. **Access lease.** A trusted, non-forgeable local value identifying the
   authorization generation and filter used for the cut. It supplies the
   `scopeKey` for the snapshot store and is revalidated after every `await` and
   before every page. Any principal/role/workspace-access change rotates it.
3. **Ordered change delivery.** Committed changes after the watermark, as one of:
   `upsert` (full C1 row), `remove` (stable task key), or `resync` (the consumer
   must discard pages and restart). Sequences are scope-local and **contiguous**:
   each delivered change advances exactly one sequence from the cut watermark.
   Filtering must never create an unannounced gap; a producer that cannot deliver
   a contiguous run must emit an explicit `resync` instead. Unrelated session
   event cursors are not a monitor sequence.
4. **Bounded subscription.** Connection-owned registration with explicit
   acknowledgement and unsubscribe. Opening buffer, outstanding events and encoded
   bytes are bounded against the negotiated transport frame limit. Overflow,
   retention loss or epoch change produces an explicit resync rather than a
   silent gap.
5. **Freshness input.** The existing authenticated `connection/ping` reply for the
   health controller. Liveness is separate from snapshot synchronization and from
   Agent progress.

## Required composition sequence

1. Authenticate and negotiate capabilities. No monitor capability is advertised
   until every step below, the real adapters and their tests exist.
2. Resolve authorization; create the access lease and `scopeKey`.
3. Register the bounded change subscription **before** reading the cut.
4. Take the source cut (rows + watermark) as one consistent read.
5. Freeze the projection in one serialized operation:
   `store.capture({ scopeKey, sequence: watermark, rows })`. While this store
   write completes, further changes stay buffered.
6. Deliver the first page. The client reads all pages, verifies one cursor and
   timestamp, and publishes a complete projection only.
7. Apply buffered changes whose sequence is strictly greater than `watermark`, in
   order, before any live change. A change at or below the watermark was already
   represented by the cut and must not be replayed.
8. On client reconnect/suspend resume, rotate observation cycles: the client
   completes a new snapshot and calls `completeResync(token)`; only then does the
   projection become `fresh`.
9. On access/filter change: rotate the lease, `discardScope(oldScopeKey)`, close
   the subscription and reset health/snapshot state. On Host epoch change,
   recreate the store and require a fresh snapshot.

The client half of steps 6-9 is implemented: the portable reader publishes only
complete projections, `createCommandCenterMonitorSummary` applies ordered
`upsert`/`remove`/`resync` envelopes against that projection with duplicate
detection, gap/epoch resync, bounded rows/bytes and revocation cleanup, and
`createCommandCenterMonitorSession` composes reader, summary and health for one
connection, completing resynchronization only for the cycle captured before a
read. All are internal models over injected ports; the owning transport still maps
its real events to the local envelope and enforces authorization, ordering and
backpressure.

## Bounds and failure rules

- Snapshot store: 10,000 aggregate rows, 16 MiB encoded retention, eight
  generations, 1,024 tokens, 60-second absolute lifetime, 100 rows / 256 KiB per
  page. Lower bounds are allowed; reads never extend a lifetime.
- Client reader: 10,000 rows, 16 MiB cumulative canonical page JSON, 1,025 pages,
  two unsettled original loads. The page ceiling is the Host's 1,024 continuation
  tokens plus the initial page, so the two defaults compose; a producer that
  raises its token ceiling must keep `Host tokens <= reader pages - 1`. Over-limit, duplicate-task, token-cycle,
  inconsistent-generation and expired access are explicit failures/resyncs.
- Change buffer: bounded by count and encoded bytes. Overflow requires a new
  snapshot; partial application and silent dropping are forbidden.
- No automatic retry loop, no invented progress percentage, no transcript
  fan-out for the monitor, and no execution start/stop from observation paths.
- Slow clients are closed with a resumable cursor, never a silent eviction.

## Acceptance that must accompany the C3 join

| Case | Required observation | Lowest test level |
|---|---|---|
| CC-M-01a | Changes committed during the cut read are replayed after the frozen cursor; applying cut then changes equals the authoritative rows | Host service integration with a real repository and change source |
| CC-M-01b | Pagination while changes continue returns one cursor/timestamp and no duplicate tasks | Host service + client reader integration |
| CC-M-01c | Access revocation during a read or page load discards pages and buffers; delayed results cannot repaint | Authorization integration with controlled clock |
| CC-M-02a | 36 monitored tasks with a slow background client stay within buffer/page bounds and resync explicitly | Transport load test |
| CC-M-02b | Six seconds without a ping reply marks the projection stale; suspension requires fresh snapshot synchronization | Client health/reader composition (already executable) |
| CC-E-01 | Restart/epoch change forces a new snapshot and never mixes epochs | Restart integration |
| CC-C-01 | Capability negotiation still rejects an advertised flag until the whole path passes | Shared contract/negotiation test |

The barrier case CC-M-01a is already encoded against the real store with an
in-memory reference source; the C3 join must repeat it with the real repository
and authorization path. Client-side health and reader composition is already
covered by the repository consumer check.

## Explicit non-goals

This contract does not add RACP/IPC operations, capability flags, database
schema, persistence, events, transcript storage, execution control, browser
transport or deployment. It does not authorize consuming another request's
uncommitted source. Until the C3/C2 ports above are committed and verified, the
monitor remains an internal, non-advertised foundation.
