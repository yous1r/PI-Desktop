# Command-center client models

Browser-safe, in-memory observation of one immutable C1 intervention attempt.
This package uses the strict shared request/receipt parsers, canonical UTF-8
payload and Web Crypto SHA-256. It does not submit commands, open connections,
retry mutations, persist server data, infer authorization, or advertise a
capability. C3 must supply authenticated, authorized adapters before any control
operation becomes available. Creating a model is not evidence of dispatch.

## API and lifetime

```ts
const context = createCommandCenterObservationContext();
const attempt = await createCommandCenterInterventionAttempt(context, request);
// A future trusted adapter captures `context` before its asynchronous receipt read.
const result = attempt.observeReceipt(context, receipt);
const state = attempt.getState();
attempt.markDisconnected(context);
// Before changing principal, permissions, Host identity, or Host owner generation:
invalidateCommandCenterObservationContext(context);
```

Contexts are opaque local identities, not credentials or wire fields. The adapter
must establish a context for one authenticated Host/owner scope and revoke it
before that scope changes. The first validated request synchronously pins the
context's Host ID and expected owner epoch, before hashing; creation with a
different owner fails even if the original hashing failed. This is a consistency
check, not authentication. Observations require the original token; a structurally
similar object or a new context cannot replace it. Revocation clears all owned
models, prevents late receipts from repopulating them, and rejects creation that
was still awaiting hashing. `dispose()` clears one attempt and releases its context
registration without affecting Host execution. Callers must also discard earlier
snapshots on scope change; references already returned cannot be revoked.

The request, target, request ID, expected Host epoch, workspace/membership/goal
fences and fingerprint never change. Inputs are copied before asynchronous work
and snapshots are deeply frozen. The receipt must match the exact request ID,
operation, execution generation and SHA-256 fingerprint; that fingerprint also
binds the Host/owner fences absent from the receipt's wire shape. The trusted
adapter remains responsible for authenticated provenance and receipt access.

`observeReceipt` returns `applied`, `duplicate`, `ignored_stale`, or `rejected`
with a local reason. Parsing, identity and fingerprint checks precede revision
comparison. Lower revisions cannot roll back state. Equal revisions must have
identical canonical content. Higher revisions cannot regress desired/effective
goals and must follow a reachable C1 transition, allowing missed intermediate
observations. Same-status higher revisions are rejected, including terminal ones.
These result reasons are local model values, not new protocol error codes.

`observation: "outcome_unknown"` means local connection/response uncertainty;
it never rewrites the authoritative `receipt.status`. A current receipt can
resolve that local uncertainty, including an identical same-revision lookup.
Authoritative `outcome_unknown` is unresolved and absorbing under current C1;
this model does not invent reconciliation transitions. Only `completed`,
`rejected`, `conflicted`, and `interrupted` are `settled`. Accepted Stop is not
settled, and completed goal delivery does not prove model obedience or task
success. Desired and effective goal revisions remain distinct authoritative
values; acceptance alone never advances the effective revision.

## Monitor snapshot reader

A read-only client does not need to fabricate an intervention to establish its
owner. The trusted adapter can bind the two existing C1 identity fields directly:

```ts
const context = createCommandCenterObservationContext();
bindCommandCenterObservationOwner(context, { hostId, expectedHostEpoch });
const reader = createCommandCenterMonitorReader(context, loadAuthorizedPage);
const result = await reader.refresh();
const state = reader.getState();
reader.cancel();
invalidateCommandCenterObservationContext(context);
reader.dispose();
```

`loadAuthorizedPage(token, signal)` receives `undefined` for the first page and
an opaque continuation for later pages, and returns an unknown value validated
as a C1 page. It is an injected read-only port, not a named RPC operation. The
adapter must establish authorization, page provenance and scope before returning
data. Binding validates `hostId`/`expectedHostEpoch` and pins the context, without
a workspace, execution, role or invented credential. A later intervention in the
same context must use that owner.

The reader publishes only complete, frozen `{ cursor, generatedAt, rows }`
projections. This all-pages result is not a C1 wire page and may contain more
than 100 rows. Every page must carry the same cursor and timestamp, and every
stable task must occur once across the entire result. Invalid pages, duplicate
tasks, token cycles, changed generations and exceeded limits fail explicitly.
The previous complete projection remains during loading, failure or cancellation;
its state is not `ready`, so callers must display it as stale. Revocation and
disposal clear it. Previously returned snapshots remain the caller's responsibility.

Default hard ceilings are 10,000 rows, 16 MiB of cumulative canonical page JSON,
1,025 pages (the Host's 1,024 continuation tokens plus the initial page) and two original unsettled loader calls; options may lower them.
Cancellation/supersession resolves the local refresh and signals abort immediately,
but an uncooperative original loader remains counted until its promise settles.
Exhausted capacity returns `busy` without a queued or automatic retry. Late
results cannot replace the newer refresh. `refresh` reports `published`, `failed`
or `cancelled`; inconsistent generations additionally set `resync_required`.
A failed page never silently restarts at a different snapshot. This model adds
no live-summary stream or heartbeat and never starts/stops Agent execution.

## Live summary application

`createCommandCenterMonitorSummary(context, projection)` keeps an already
published projection current by applying ordered change envelopes supplied by the
trusted adapter:

```ts
const summary = createCommandCenterMonitorSummary(context, projection);
summary.apply({ version: 1, epoch, sequence: next, type: "upsert", row });
summary.apply({ version: 1, epoch, sequence: next, type: "remove", target });
summary.apply({ version: 1, epoch, sequence: next, type: "resync" });
```

The envelope is a **local adapter port shape**, not a registered RACP/IPC message
or capability. The envelope must match exactly (`version: 1`, epoch, integer
sequence, one of `upsert`/`remove`/`resync`); rows and targets are validated by
the shared C1 parsers and copied before retention. Epochs must equal the initial
projection; a sequence at or below the cursor is a duplicate no-op; a gap, epoch
change, explicit `resync` envelope, bound violation or explicit `resync()` marks
`resync_required` and is absorbing. The last consistent projection is retained
for stale display and a new reader snapshot is required to recover.

Bounds are 10,000 rows and 16 MiB of summed canonical row JSON, with lower
overrides allowed; accounting is incremental. Removing an unknown stable task is
an idempotent no-op that still consumes the contiguous sequence. Rejected inputs
never change state, `generatedAt` stays the original snapshot cut timestamp, and
context revocation/disposal clears retained rows. Returned projections are frozen
and stable until a real change. This model adds no stream, transport, heartbeat,
execution control or capability advertisement; the C3 adapter still owns
authorization, ordering and delivery.

## Connection health and resumed observation

`createCommandCenterConnectionHealth(context, options)` owns one connection's
observation health. It uses an injected monotonic clock, single-shot scheduler
and authenticated read-only `ping(signal)` adapter for the existing RACP
`connection/ping` reply. It opens no socket and never infers Agent/task progress.
The adapter must create one controller per actual connection, not per task.

`connect()` and `resume()` rotate a local cycle and return an opaque sync token.
After the full snapshot for that cycle is applied, call `completeResync(token)`.
Freshness requires both that current synchronization marker and a valid reply
received within six seconds. An old cycle's token or late reply cannot restore
freshness. `suspend()`/`disconnect()` immediately mark stale, cancel the timer and
abort pending probes. Resumption performs a new synchronization; background timer
cadence is not trusted. `dispose()` and context revocation close the controller.

The first foreground ping is immediate; later probes run every two seconds while
the original unsettled-call budget allows. At six seconds without a valid reply,
the timer marks stale; a delayed callback checks actual elapsed time and sends no
catch-up burst. At most two original ping promises remain outstanding, including
aborted promises that ignore the signal. A full budget reports `pending_limit`
and queues no retry. Server timestamps are validated but never drive elapsed time.
Invalid/backward clocks or scheduler failures halt the cycle stale until an
explicit new connection cycle.

The optional single `onState` observer receives actual primitive state changes,
including timeout and closure, without polling. Returned state objects remain
stable until a value changes. Reentrant observers cannot clear newer timers or
publish old replies. A throwing observer is detached with the sticky diagnostic
`observerFailed: true`; the adapter must handle that diagnostic rather than assume
its UI continued to receive updates. No callbacks remain after final closure.

## Monitor session composition

`createCommandCenterMonitorSession(context, { loadPage, ping, clock, scheduler,
limits? })` composes the reader, live summary and connection health for one
authenticated connection without adding transport or authorization:

```ts
const session = createCommandCenterMonitorSession(context, { loadPage, ping, clock, scheduler });
session.connect();
const result = await session.refresh();   // publishes a complete projection
session.apply(change);                    // validated ordered change envelope
session.suspend();
session.resume();                          // requires a new refresh before fresh
session.dispose();
```

A published refresh recreates the summary from the new projection and completes
health resynchronization only for the cycle captured before that read; a read
started before connect/resume cannot satisfy a later cycle. `fresh` requires a
ready reader projection, a summary built from exactly that cut, and a recent valid
ping. Reader failure/resync marks the summary resync-required; suspend/disconnect
retain data but force `stale`; context revocation and disposal clear everything
without notifications or timers. Independently lower summary limits reject an
otherwise valid reader projection (`summary_rejected`) with the prior summary
marked stale. This is a local composition of the existing models; capability,
authorization, real events and UI remain outside this package.

## Validation

`pnpm --filter @pi-desktop/command-center-client test` uses the package Vitest
config's alias to current shared source, without a stale shared build. The public
API tests use the committed C1 golden fixtures and deterministic receipt/hash
barriers. Production compilation has no Node ambient types or Node imports;
`build` and `typecheck` follow the shared/agent-host TypeScript project-reference
conventions and require current shared declarations. After building shared,
Agent Host and this package, run `node scripts/check-command-center-foundations.mjs --built`
from the repository root to validate the emitted package consumers without
source aliases. The same command without `--built` checks current source. Neither
mode qualifies actual browser/mobile timing or a production network endpoint.
