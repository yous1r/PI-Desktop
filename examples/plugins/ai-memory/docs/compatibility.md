# Upstream compatibility

## Supported releases and evidence

`compatibility/supported-versions.json` is the production allowlist. **3.3.2 and 3.3.3 support reads, guarded mutations and reconciled capture.** These flags are exercised by `tests/real-server/adapter.test.ts` using the production adapter, transport, journal, coordinator, outbox and mutation ledger against the official Windows x64 binaries, without an injected capability catalog. Unknown versions allow schema-validated reads only.

[Verified contract](../compatibility/verified-contract.md) records executable hashes, coverage and limits. `tests/fixtures/upstream/checksums.json` pins the sanitized wire fixtures, plugin observation evidence, and complete identical 25-tool descriptors. `check-compatibility.mjs` checks those bytes and evidence references. Synthetic unit tests use an injected catalog only for controlled fault scenarios; it is not configurable through settings.

## Wire contract

| Operation | MCP tool / route | Safety contract |
| --- | --- | --- |
| query | `memory_query` | Explicit workspace/project, limit 5, `answer:false`, omit `reasoning` |
| readPage | `memory_read_page` | Exact safe relative path; validate body, page ID and scope |
| briefing | `memory_briefing` | Bounded recent-page count; no synthesis |
| listHandoffs | `memory_handoff_list` | Read-only; no any-owner escalation |
| writePage | `memory_write_page` | Exact path/body; create-only or expected-page-ID |
| beginHandoff | `memory_handoff_begin` | Explicit summary; shared only after confirmation |
| acceptHandoff | `memory_handoff_accept` | Exact ID; persist confirmed body before returning |
| cancelHandoff | `memory_handoff_cancel` | Exact ID |
| maintenance | `memory_delete_page` | Exact path and expected-page-ID |
| capture | `/hook` POST | `agent=pi`, explicit scope, immutable valid query `ingest_key` per part |
| reconciliation | `memory_read_session_observations` | Exact native session; unique extension/source identifiers and complete detail bodies |

MCP initialization validates protocol independently of server version. Tools/list pagination is capped at eight cursors/500 tools. Unknown required fields, missing fields, type changes and enum changes disable the affected operation; optional unrelated additions are permitted. Capture additionally requires the observation-read contract. A schema fingerprint is diagnostic, not an equality gate. Discovery never registers arbitrary tools.

Requests accept `application/json, text/event-stream`. Initialized may return empty HTTP 202. SSE parsing skips initial empty events and matches exactly one JSON-RPC ID. Stateful transport IDs are echoed independently of business session IDs. Wrong IDs/scopes, `isError`, malformed pages and oversized responses fail closed. Page conflicts map JSON-RPC `-32600` with `data.reason=precondition_failed` to `PAGE_CONFLICT`.

An expired stateful MCP session is distinguished from a missing endpoint. Read-only operations may reinitialize and retry once, rechecking discovered capabilities; mutations are never automatically resent. Query capability requires a boolean `answer` field so `answer:false` cannot silently disappear under schema drift.

## Hook mapping and durable delivery

Native session_start/prompt/tool_call/tool_result/agent_end map to session-start/user-prompt/pre-tool-use/post-tool-use/stop. The frozen envelope contains `sessionID`, authoritative `cwd`, `occurred_at`, and Pi tool fields `tool`, `callID`, `args`, `output`, `isError`. Upstream family-normalizes native tool records and omits raw arguments. Stop does not store assistant text or close the session.

The adapter therefore also uses upstream's explicit **extension observation format**: `extension=pi-desktop-memory`, unique `source_event`, `event=other`, and a text `body`. These records truthfully label the original plugin event and hold only policy-approved content and metadata. Detail bodies split at 1,400 UTF-8 bytes with numbered framing below the upstream 2,000-byte excerpt cap. Tool arguments, unknown-tool results and assistant text are retained here; no server assistant setting is required. Compaction and retirement use extension records only. Native pre-compact is avoided because it can trigger paid consolidation. Session-end is never sent automatically because it closes the remote session and creates an automatic handoff.

Every request part has a SHA-256 hex `ingest_key` derived from the globally unique event ID and part identity. Payload, timestamp, scope and cwd remain frozen across retries. Body event IDs alone do not deduplicate. The official binaries deduplicate identical valid keys across restart; this is not a distributed exactly-once guarantee.

**HTTP 202 `queued` is admission before persistence.** The event stays `remote-queued`, retains its content, and blocks later events in the same session until every expected observation is found. Correlation uses the exact plugin extension/source identity and kind, and checks full detail bodies. It never accepts an arbitrary session-start or a reused tool call ID as evidence. Polls scan up to 2,000 recent observations; after 60 seconds without confirmation, uncertainty remains visible. Truncated, suppressed or differently sanitized detail records remain unconfirmed. Transport response-loss retries are allowed only with verified idempotency and unchanged payload. An admitted 202 is never treated as permission to replay. The panel can perform read-only reconciliation; explicit operator discard/confirmation is separately recorded.

POST session-start does **not** consume explicit or automatic handoffs in either supported release. The server's similarly named claim-on-start setting controls the separate GET `/handoff`; the plugin never uses that endpoint and has no server-setting prerequisite. Unexpected claim responses still enter visible recovery and block further uploads on that revision.

Exact accept returns `status:claimed` with a preclaim handoff snapshot whose state is still `open`. The adapter trusts status and exact identity. Reaccept returns `none_pending`; a lost accept response is uncertain and is never retried automatically. Confirmed accepted data is recovered locally without a second accept.

## Reproduction and limits

Run the commands in [verified-contract.md](../compatibility/verified-contract.md). Tests isolate profile, data, config, authentication, ports and child environment. They do not use an existing memory service, inherited provider credentials or paid models. Candidate Desktop wiring and packaged sidecar validation remain separate parent integration gates.

No runtime downloads, upstream installers, migrations or automatic updates occur. Future local state versions are refused without modifying the canonical file. Rollback must preserve pending payloads and the adapter format; do not reinterpret uncertain events under another adapter.
