# Requirements and acceptance

The integration owns project memory automation, not the upstream database, CLI installations, code graph, identity provider, server migration, or paid consolidation. Only host-confirmed project/session/runtime/turn facts determine scope. No operation falls back to `default/scratch`.

| ID | Observable requirement | Implementation / executed evidence | Scope and limits |
| --- | --- | --- | --- |
| R1 | Install, configure, detect live host/server support | Actual Rust package install/grants and Desktop native settings + panel E2E passed | Requires owner v1 / connection v1 candidate Host |
| R2 | Explicit identity, worktrees, concurrent projects, conflict pause | Binding/TOML tests, owner-file worktree/remote contracts, concurrent real Runner project isolation, Windows native panel path | Live SSH server and multi-machine deployment not exercised |
| R3 | Opted-in Agent capture with error/cancel state and privacy | Both official binaries; actual plugin process/Runner and bundled sidecar capture prompt/tool/outcome/cancellation | All body categories default off; compaction uses extension observations |
| R4 | Durable receipts, ordering, capacity and uncertain delivery | Real-server delayed admission, response loss/dedup, full-process offline/plugin/server restart, bounded Windows lock retries | No exactly-once promise; uncertain writes remain retained |
| R5 | Bounded non-consuming recall in model request | Both real servers under repository Node and installed Electron sidecar; actual Desktop model receives one sourced packet, absent from transcript | 1.5 s default is a budget, not a latency SLA |
| R6 | Exact handoff acceptance only after confirmation | Real native confirm bridge, exact accept/local recovery after same-session runtime recreation; server tests prove non-consuming POST start | Multi-user authorization is not claimed; no automatic GET handoff |
| R7 | Scoped query/read/write and version preconditions | Real managed write/create/read and stale UUID conflict; both binaries prove guarded delete and explicit begin/accept/cancel | No unconditional writes, paid consolidation or arbitrary imported tools |
| R8 | Runtime generation and recovery isolation | Owner broker/runtime/process tests; same-ID recreation, cancellation, bounded end notification, plugin/server/Desktop restart | Model variation is covered at generic owner lifecycle boundary |
| R9 | Host-only credentials, pre-persistence filtering | Connection/TLS/route/permission/revision tests, runtime preview audits, actual model/token exclusion and privacy tests | Local queue inherits Host ACLs and is not plugin-encrypted |
| R10 | Bilingual diagnostics, pause, retry, reconciliation | Chinese/English Electron panel interaction + exit cleanup; service/operator-worker tests | Diagnostic export excludes bodies and credentials |
| R11 | Reviewed adapters and state format boundary | Schema drift/unknown-version tests, explicit answer:false capability gate, state-version refusal, official binary fixture hashes | Future migrations and non-Windows releases require new validation |
| R12 | Coexist default, disposal cancels, remote memory retained | Actual Desktop disable/uninstall E2E, owner unload cancellation, uninstall credential cleanup IPC/service tests | Uninstall removes local private state/connection credentials; remote pages remain |

## Authorization

A project binding authorizes read-only recall to one named connection/workspace/project. Capture is separately enabled and Agent-only. Each content category is separately selectable; all default off. Plan and Goal perform reads only. Managed writes require Agent mode, the exact mutation intent, affirmative native confirmation and a reviewed release. Shared handoff creation needs an additional affirmative shared flag. Cross-operator claiming and cross-project sends are not exposed.

Page creation uses `create_only=true`; revisions and deletes require the exact `expected_page_id` previously read. No unconditional overwrite path is exposed. Maintenance deliberately exposes one bounded operation, exact-page deletion; automatic LLM consolidation, server migration, global sweeps, and arbitrary upstream tools are excluded.

## Marker behavior

The plugin reads `.ai-memory.toml` only at the authoritative workspace root through host filesystem preview. It uses the full TOML parser. Root scope declarations must agree with the explicit binding; capture exclusions add to local policy. It never walks outside the host-authorized root, guesses a remote filesystem from local cwd, or silently enables capture from repository text. A partial marker is allowed when its fields agree with an explicit complete binding. The pure git-remote candidate helper produces suggestions only; it is not an authorization path.

## Acceptance scenarios

1. Configure two synthetic projects; recall the same query in both. Every MCP request includes its own workspace/project. Switch runtime generation and repeat without duplicate session-start or context accumulation.
2. Opt in to capture, submit a prompt, invoke a failing tool, complete/cancel, compact, rebuild the runtime and close. Local receipts precede upload; outcomes remain accurate; no runtime retirement creates a final handoff.
3. Lose a mutation response after the simulated server commits. The queue and mutation ledger show uncertainty after restart; retry cannot replay it. Explicit reconciliation affects only local state.
4. Preview handoffs without a claim, accept one exact ID with confirmation, rebuild the model request and recover the accepted content from the journal without another claim.
5. Introduce a conflicting marker, credential revision, unknown version, renamed tool, changed required field, SSE session, 401, 429, oversized response and cancellation. Only affected capabilities degrade and chat remains usable.
6. Inspect English/Chinese panel controls, save a binding, pause/resume, export diagnostics and verify no body/credential is exported.

The final plugin suite passes 51 tests with no skips, including four official-binary scenarios. The full production process path passes against both releases under repository Node and installed Electron/Node with the candidate bundled sidecar. The actual isolated Desktop journey passes 23/23 checks. See the repository's `docs/validation/ai-memory-implementation.md` and `ai-memory-desktop-e2e.md` for exact candidate identity, commands and evidence; counts cover different levels and must not be summed as independent requirements.
