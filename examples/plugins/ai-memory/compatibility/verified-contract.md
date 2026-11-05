# Verified ai-memory contract

Verified on Windows x64 / Node 24.12.0 using official release executables and synthetic data. This evidence enables the production `v3/1` adapter for 3.3.2 and 3.3.3. Candidate Desktop/sidecar end-to-end gates belong to the parent integration task and are not inferred from these results.

## Artifact identity

| Release | Official Windows ZIP SHA-256 | Extracted ai-memory.exe SHA-256 |
| --- | --- | --- |
| [3.3.2](https://github.com/akitaonrails/ai-memory/releases/tag/v3.3.2) | `7c35827430e7d1753fa420b256a059ad7104c469c263d6b0a1080bd04064cbb0` | `a20f08b9efef1f5e8635373eca44b9d59eb36d899097e3634e409c109c59414b` |
| [3.3.3](https://github.com/akitaonrails/ai-memory/releases/tag/v3.3.3) | `7febf22e0b8c0c5cf546e8597c2218598bdececc98fd375bbcd1e13e376cf87c` | `0fcf2490d707041a503b2c92876640b7706ef464156e2135a84b719688a541ff` |

ZIP checksums came from the official release API asset metadata. Test fixtures independently hash the extracted executable before each launch. ZIP and executable hashes are different artifacts.

All 25 complete `tools/list` descriptors are identical between the two binaries. SHA-256 of their serialized array is `5574bc6e9b110082862ce910b22a359ebc1248e82dce9737fffe893ed097e135`. The complete array is retained in `tests/fixtures/upstream/v3-all-tools.json`. Earlier `v3.3.x-binary.json` files retain the selected tool schemas and sanitized baseline wire responses; `v3.3.x-plugin.json` records observations actually produced by the production adapter and its verified assertions. Fixture file hashes are in `tests/fixtures/upstream/checksums.json`.

## Executed coverage

`node scripts/test.mjs` with `AI_MEMORY_TEST_BINARIES` set passed **51 tests, zero failures, zero skips**, including four actual-server scenarios:

- Both releases: production V3Adapter/McpTransport/Outbox/Journal/SessionCoordinator/Mutations, using the bundled production capability catalog; page create/read/replace/stale conflict/delete, explicit no-synthesis query, exact handoff begin/list/accept/cancel, local recovery before returning, and lost-accept uncertainty without a second mutation.
- Both releases: native Pi session/prompt/tool/Stop records, frozen cwd, native tool errors, opt-in argument/result/assistant extension records including multi-part Unicode text, all-part durable observation matching, retained 202 admission and per-session blocking, restart deduplication, and injected response loss after real admission followed by immutable idempotent retry.
- Both releases: stateful SSE initialization and actual page write/read with an independent MCP session ID, including initialized HTTP 202 with an empty body. Server restart recovers read-only calls through a fresh handshake; mutations on an expired session are sent once and are not automatically replayed.
- Offline integration/unit/contract coverage: permission/mode gates, project conflicts, retained uncertainty, process-interrupted local state, queue capacity, credential revision quarantine, 401/429, cancellation deadlines, operator/worker exclusion, extension context injection, privacy, schema drift and unknown-version read-only behavior.
- Final integration corrections: Windows path identity, bounded atomic-rename retry, no-synthesis query schema enforcement and safe Electron test-profile cleanup. Full Host/Runner/sidecar and native Desktop evidence is recorded separately under repository `docs/validation/`.

The test fixture launches each process with a fresh profile/config/data directory, loopback ephemeral port, a synthetic bearer, `embedding_provider=none`, disabled maintenance/scheduler and no watcher. Child environment is an OS-variable allowlist. No inherited model credentials, paid model, existing service, user Desktop instance or production data is used. Processes stop in test teardown. An exploratory deletion failure caused by Windows long paths was resolved by shortening the isolated test paths; it was not classified as a plugin success.

## Reproduce

From this plugin directory, reuse the existing dependencies and reviewed binaries:

```sh
export AI_MEMORY_TEST_BINARIES="<directory containing bin-v3.3.2 and bin-v3.3.3>"
# Only if smol-toml is not already resolvable:
export AI_MEMORY_TOML_ENTRY="<reviewed smol-toml 1.4.2>/dist/index.js"
node scripts/typecheck.mjs
node scripts/test.mjs
node scripts/check-compatibility.mjs
node scripts/build.mjs
```

`node scripts/test.mjs real-server` runs only the four actual-server scenarios. No binary download or dependency installation occurs. Without the binary variable those four tests explicitly skip.

To refresh reviewed sanitized evidence, set `AI_MEMORY_PLUGIN_EVIDENCE` to an existing scratch directory while running tests. Then run `scripts/import-plugin-evidence.mjs` with that directory and `AI_MEMORY_CONTRACT_EVIDENCE` pointing at the reviewed upstream baseline directory containing the discovery JSON. The importer validates descriptor identity and fixture shape before updating the pinned files. Generated test evidence contains only synthetic observations and assertion names, not credentials or host paths.

## Limits

HTTP 202 is admission, not durability. The plugin observes persistence through bounded reads; no crash-atomic or exactly-once network guarantee is made. Server-side truncation, suppression or additional sanitization that prevents complete detail matching keeps the event visible and retained for review. Multi-user authorization, non-Windows binaries, cross-release database migration, arbitrary server policy configurations and paid consolidation are not established by these tests. Neither plugin nor tests automatically changes server settings, installs hooks, calls GET `/handoff`, sends session-end, or starts paid consolidation.
