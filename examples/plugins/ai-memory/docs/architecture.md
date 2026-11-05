# Architecture

```text
Extension factory (one runtime generation)
  ├─ supported `context` event: bounded, provenance-marked user-content injection
  ├─ lifecycle/tool events: normalize + privacy policy
  └─ owner.call(operation, payload) with host-supplied identity and AbortSignal
          │
          ▼
AiMemoryService (resident plugin process)
  ├─ binding and complete TOML marker validation
  ├─ session coordinator: durable session identity vs runtime identity
  ├─ Journal: versioned atomic JSON, writer lock, recovery ledger
  ├─ Outbox: per-scope/session order, bounded retries, uncertain state
  ├─ recall: bounded query → page reads → ContextPacket
  ├─ explicit mutations: confirmation, Agent mode, exact ID/version
  └─ v3 adapter: MCP JSON/SSE, capability and response validation
          │
          ▼
pi.connections (host-owned)
  connectionId + expected revision + relative /mcp or /hook POST
          │
          ▼
scoped ai-memory service
```

## Ownership

The host owns project identity, remote workspace paths, connection origins, credentials, CA dispatchers, HTTP policy, request cancellation, plugin grants and owner-operation admission. The plugin never receives a token and never builds an absolute URL. The host must reject arbitrary payload scope; the plugin repeats explicit scope on every MCP project operation and rejects mismatched response scopes.

The plugin owns memory semantics, upstream protocol adapters, marker interpretation, privacy policy, the private journal, bounded outbox, recall packets, mutation recovery and panel diagnostics. It does not use SQLite. `state-v1.json` is mode `0600`; temporary files are created beside the canonical state and fsynced before atomic rename. A process lock prevents concurrent plugin writers. The journal marks in-flight delivery/mutations uncertain and active sessions interrupted at startup.

## Scope and lifecycle

`projectPath` is the durable host project identity. `workspaceRoot` is the authoritative local/worktree or remote root. `sessionId` is the durable Desktop conversation identity; `runtimeId` is one sidecar generation; `turnId` is one model turn. Remote session IDs are deterministic over installation, Desktop session and bound scope. Rebuilding a runtime preserves the durable session and sequence but does not reuse runtime-local started/handoff flags. Retirement due to reconfigure is persisted without creating a final handoff. Only explicit session-close can close the durable record.

Each extension factory owns its own maps, epoch and AbortSignal. The cached module has no session state. Recall results are accepted only when the factory epoch and signal still match. Service settings changes abort prior work, increment a generation and clear adapter/cache state. The outbox does not upload until the event's captured connection revision and binding still match.

## Data flow

Events are normalized at the boundary. Protected file paths, configured globs, binary fields and secret-looking keys are removed before journal writes. Content categories are opt-in. The journal stores event payload until a verified receipt, then clears uploaded body data while retaining a digest and receipt. Queue limits decline the new event atomically and expose a diagnostic. Delivery is ordered by scope and remote session; one uncertain event blocks later events for that session.

HTTP admission is a distinct `remote-queued` state. The adapter emits native Pi records plus bounded, explicitly labelled extension details. A frozen event and each part receive globally unique deduplication keys. The outbox waits for all uniquely correlated observations and full detail bodies before clearing content and advancing that session. Uncertain events retain their content; operator review cannot race the worker. Compaction and retirement are extension observations without native consolidation/session-end side effects.

Recall is read-only and bounded to a 1.5 second default deadline and configured character budget. The adapter runs initialize, initialized and paginated tools/list before using tools. It never calls `/handoff` GET or HEAD. Handoff listing is a read operation. A packet includes scope, path/page ID, update metadata and truncation flags, with an explicit warning that historical content is untrusted. It is injected as a supported context message and does not write to the transcript or accumulate across requests.

## Mutation safety

Managed tools are fixed at factory load and do not depend on remote discovery. Default coexist mode hides them. Each mutation gets a request ID and a durable pending ledger entry before the MCP call. A successful response is sanitized and persisted before returning to the caller. A lost response is `delivery-uncertain`; it cannot be retried by the normal queue or replaced with a different handoff. The panel can inspect a retained legacy session-start response and an operator can reconcile the local record explicitly.

## Failure isolation

Protocol/version/schema errors disable only the affected capability. Unknown server versions allow no writes or capture. 401/403 pauses auth-required delivery. 429 obeys bounded Retry-After/backoff. Revision changes quarantine old scope. Malformed or oversized responses never reach model context. A recall failure clears only the current packet; ordinary chat continues. Owner cancellation, plugin unload and retirement abort network requests and reject late results.
