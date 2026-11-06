# MCP private CA restoration and independent memory plugin

## Candidate

- Request branch: `fix/mcp-certificates-plugin-repo`.
- Current base and HEAD before uncommitted task changes:
  `9110b7ec8657c8b86485315c385d733af91a498a`.
- Refreshed from `f51ecb00499533011907d2ca01fadf978843e4d5` after fetching
  the two new terminal commits. The ancestry gate passed on the updated base.
- Changes remain uncommitted by request scope. Tests below apply to the working
  candidate, not to the base commit alone. No release or installed app was changed.
- Environment: Windows x64, Node 24.12.0, existing Electron 43.6.0, reused host
  dependency packages and Cargo target cache; isolated test profiles and services.

## Result

The HTTP MCP editor exposes a public CA PEM field and retains it across edits.
The optional `caCertificate` field is persisted by Rust; absent input preserves,
null/empty clears, and transfers including ID collisions retain the certificate.
The shared MCP client uses additive, origin-scoped trust, validates hostnames,
streams SSE responses, and follows Desktop's configured proxy tunnel. Clearing
or changing the CA closes the old connection. No global trust bypass is added.

The independent `PI-AI-Memory` repository owns the former plugin sources,
domain tests, compatibility CI, packaging and validation history. Desktop's
PR packaging no longer builds or uploads the memory plugin. Generic owner-call,
connection and lifecycle APIs and their synthetic host tests remain here.
The 64 original plugin files were compared before removal: only README and
package metadata changed for standalone operation; production sources match.

Cross-repository validation exposed an existing service-lifecycle regression:
the shared plugin runner inherited the finished `service.start` parent-call
identity into resident background work, rejecting later SDK calls with
`PLUGIN_CALL_EXPIRED`. A generic regression test failed before the scoped fix.
Resident service startup now establishes work under the loaded plugin lifetime;
ordinary panel descendants still expire, and unload/permission guards remain.
The independent plugin's complete process flows then passed against this candidate.

## Initial verification on f51ecb004

| Check | Result |
| --- | --- |
| New MCP certificate tests on old code | Failed on ignored CA and missing editor field |
| New Rust CA tests on old code | Failed on discarded CA and missing validation |
| New resident-service test on old runner | Failed with `PLUGIN_CALL_EXPIRED` |
| MCP/client/editor/transport/CI regression group | 88 passed |
| Generic owner-file, owner-process and connection form/user-path group | 18 passed |
| Service/owner/workspace file regression group | 29 passed, 2 external Git-plugin cases skipped |
| Rust MCP registry suite | 16 passed |
| `node scripts/e2e-mcp-timeout-clear.mjs` | Passed real Electron editor timeout and all five CA interaction assertions |
| Independent plugin `tests/desktop/ai-memory-plugin-flow.test.mjs` against this worktree | 2 passed, isolated ai-memory 3.3.2 and 3.3.3 |
| Independent plugin offline suite | 47 passed, 4 real-server scenarios skipped without binary input |
| Independent plugin typecheck, fixture integrity and beta.6 DevKit package check | Passed |
| Independent plugin panel suite | Chinese and English passed using host Electron |
| Relevant TypeScript package builds and Desktop typecheck | Passed |
| Desktop `electron-vite build` from `apps/desktop` | Passed; existing large-chunk warnings |
| Biome lint, style-token check, `cargo fmt --check` | Passed |
| `cargo clippy -p host-core --all-targets --locked` | Passed with four warnings outside changed code |
| Documentation checks | 88 locale pairs and 608 pages passed |
| PR base gate and `git diff --check` | Passed |

Representative paths are covered by the rendered MCP editor, the actual TLS
MCP client (discovery and tool call over open SSE), Rust persistence/transfer,
and the independent plugin's real subprocess plus Runner flow. The latter
uses synthetic model HTTP responses and isolated checksum-pinned upstream
binaries, never the user's memory service or a paid model.

## Independent artifact

- Repository: `D:/Packages/PI-AI-Memory`, branch `feat/standalone-plugin`.
- Package: `release/local.ai-memory-0.1.0.piplug`.
- Size: 431,603 bytes; 24 archive entries verified against built `dist/`.
- SHA-256: `13586914990921af966c87b043850409591ec8776a3014638ccf700c5415d114`.
- No commits, remote publication or plugin installation were performed.
- Packaging uses explicit `PI_DESKTOP_REPO` because the SDK/devkit is private;
  ordinary plugin build/tests have their own locked dependencies.

## Limits and recovered environment issues

The installed beta.6 application and the live `https://dev/mcp` endpoint were
not tested or replaced. Full Desktop-app installation E2E, native macOS/Linux,
and real SSH are not claimed. No `verify:ui:*` command ran.

The independent upstream-only test suite has a pre-existing intermittent
`session.cwd` assertion, reproduced on unchanged source by the extraction
worker. Offline tests and both complete process-flow cases passed. The two
external Git-plugin scenarios were skipped because `PI_GIT_PLUGIN_PATH` was
not provided.

pnpm attempted an unnecessary native rebuild during its typecheck task setup;
that failed because the host lacks MSVC Spectre libraries. Direct existing
TypeScript and electron-vite executables completed the required checks without
installing another Desktop environment. Rebuilding the current RACP dependency
removed initial stale-declaration errors. The workspace file suite's Windows
short/long temporary-path mismatch was resolved by running with TEMP/TMP set
to the session scratch directory; no unrelated source was changed.

## Latest-main compatibility validation on 9110b7ec8

The request branch was fast-forwarded to
`9110b7ec8657c8b86485315c385d733af91a498a` without creating a task commit.
All 113 uncommitted task paths were backed up and verified after integration.
Thirteen files overlapped: nine locale catalogs, three changelogs and the E2E
plan. Only the plan's simultaneous end-of-file additions conflicted; both
the MCP certificate scenario and the upstream terminal scenarios were retained.
There were no executable-code merge conflicts and no dependency/lockfile changes.

Checks rerun against latest main plus the complete uncommitted task changes:

| Check | Result |
| --- | --- |
| Shared/i18n/host-runtime TypeScript builds and Desktop typecheck | Passed |
| MCP, plugin service/owner and terminal/path regression group | 146 passed, no skips |
| Production MCP editor in isolated Electron | Timeout and all five CA assertions passed |
| Multiple-terminal UI and real terminal IPC user paths | 3 passed, no skips |
| Standalone ai-memory process/Runner flow against this candidate | 2 passed, upstream 3.3.2 and 3.3.3 |
| Desktop `electron-vite build` | Passed; large-chunk warnings only |
| Biome lint, style tokens, locale/docs checks and `git diff --check` | Passed |
| PR-base check | Passed; HEAD equals fetched origin/main |

The real terminal assertions covered create, commands, resize, replay, project
switch and close. During teardown, node-pty's auxiliary console process printed
`AttachConsole failed`; both native-shell tests and the test runner exited
successfully. This diagnostic is recorded without claiming silent cleanup.
No installed app, live SSH or live memory endpoint was used.

Rust tests/Clippy were not repeated in this compatibility pass: neither Rust
code nor dependencies changed upstream, and the task's Rust bytes are unchanged
from the initial verified candidate. The earlier results above remain separate
from this latest-main rerun. Task changes remain unstaged and uncommitted.
