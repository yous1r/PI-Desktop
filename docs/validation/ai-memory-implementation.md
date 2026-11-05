# ai-memory implementation and acceptance

The approved independent `local.ai-memory` plugin plus generic Host capability implementation is complete for the measured Windows candidate. The final local package passed devkit validation, archive inspection and actual isolated Desktop installation/use/restart/disable/uninstall. Production installation, release publication and replacement of existing `mem` were not performed.

## Candidate and artifacts

- Request branch: `feat/ai-memory-plugin`, dedicated worktree `worktrees/ai-memory-plugin`.
- Base and latest fetched `origin/main`: `3cb4710cf95db2b80a8fdca8ac8bc55ab3135433`.
- No task commit was created because none was requested. Results identify executable bytes and a source inventory, not an invented commit.
- Package: `examples/plugins/ai-memory/release/local.ai-memory-0.1.0.piplug` (local build output, not committed; pull requests also upload it as the `ai-memory-plugin` artifact of `.github/workflows/pr-package.yml`), 417,585 bytes, 24 files.
- Package SHA-256: `b2afd34eec8ed52b2d8b4a63d0fa75d0bc61f2dcea40dd017298de10f0daef63`.
- [Package file inventory and executable hashes](ai-memory-package.json).
- [Source inventory](ai-memory-source-inventory.json).

The package hash exactly matches the package installed by the final beta.5 Desktop E2E run `ai-memory-desktop-2EEasP`. The archive contains bundled entrypoints, panel, manifest, documentation/license, skills and sanitized compatibility fixtures. It contains no temporary state/profile, database, credential file, private key, task scratch path or temporary diagnostic instrumentation. Every archive entry was compared with the built dist file.

## Behavior and ownership

The plugin owns explicit project scope, full TOML marker validation, Windows project identity normalization, per-session durable sequencing, pre-persistence privacy filtering, retained uncertain writes, bounded sourced recall, explicit exact-ID handoff, versioned page mutation and bilingual diagnostics. Coexist mode preserves existing manual MCP tools; managed mode requires an explicit choice.

Host additions are generic: declared owner-operation routing with live session/project/mode/generation checks, bounded cancellation/retirement/end notification, authoritative worktree/remote file previews and audit, and encrypted Host-managed connections with native configuration. Tokens never become a plugin getter. Route/revision checks, redirect refusal, connection-local CA and application proxy routing stay enforced. Uninstall revokes stored connections; disable/reload retains them. Rust keeps exclusive SQLite ownership; no Rust source/schema or secret-format change was needed.

See the plugin repository docs `examples/plugins/ai-memory/docs/requirements.md` (R1–R12) and `examples/plugins/ai-memory/docs/architecture.md`, the [Host interface specification](../spec/07-plugins/17-owned-extension-services.md), [owner ADR](../adr/plugin-agent-extension-owner-calls.md), and [connection ADR](../adr/plugin-managed-remote-connections.md).

## Executed verification

Counts below overlap responsibility boundaries; they are not a summed coverage score.

| Verification | Result |
| --- | --- |
| Plugin unit/contract/integration and checksum-pinned real 3.3.2/3.3.3 server suites | 51 passed, no skips |
| Actual plugin child + Main owner/connection/file bridge + Runner + local model + real upstream | 2/2 full scenarios, one per release |
| Same full scenarios under installed Electron 43.6.0 / Node 24.20.0 and candidate bundled sidecar | 2/2 passed |
| Actual isolated Desktop installed-package journey | 23/23 passed; exact final package hash |
| Existing trusted extension full Electron E2E on final candidate | 57/57 passed |
| Final connection/TLS/form/IPC/owner child/file/shutdown targeted Node suites | 37 passed |
| Final Runner/runtime lifecycle/owner unit suites | 48 passed |
| Chinese and English standalone panel interactions and post-exit profile cleanup | Both passed with exit 0 and verified profile removal |
| Earlier SDK, host-runtime, owner broker/integration, settings user-path and i18n checks | Passed; separate reports retained in session evidence |
| Plugin, agent-runtime and Desktop typecheck; sidecar bundle; Desktop Main/preload/renderer build | Passed |
| Configured Biome lint (133 files), style tokens, architecture budget, policy synchronization, latest-base and whitespace checks | Passed |
| Plugin devkit check/pack and fixture checksums | Passed; normal explicit high-risk grant warning |
| Compatibility CI workflow | YAML/job configuration validated; remote GitHub Actions execution not performed |

The process scenarios assert real model recall once, no transcript/token injection, on-demand managed-tool activation, actual confirmation, page readback and stale UUID conflict, non-consuming handoff preview/exact accept/recovery, same-session runtime recreation, Plan read-only, concurrent project isolation, cancellation outcome, offline local admission, plugin/server restart delivery and explicit close boundary without automatic handoff.

A direct-source test harness emits one refused stale owner-call notification during runtime replacement; the broker rejects it and no stale data is accepted. The candidate bundled sidecar and native Desktop paths do not emit that notification. Deliberate offline probes report `TRANSPORT_FAILURE` while chat continues and queued data survives. Those expected diagnostics are not hidden or counted as successful remote delivery.

## Reproduction

Use the provisioned toolchain/dependencies. For real-server suites, place the reviewed binaries under `<binary-root>/bin-v3.3.2/ai-memory.exe` and `bin-v3.3.3/ai-memory.exe`. Executable hashes are checked before launch. Build/test scripts never download runtime code.

```sh
cd examples/plugins/ai-memory
export AI_MEMORY_TOML_ENTRY='<reviewed-smol-toml-1.4.2>/dist/index.js'
export AI_MEMORY_TEST_BINARIES='<binary-root>'
node scripts/typecheck.mjs
node scripts/test.mjs
node scripts/check-compatibility.mjs
node scripts/build.mjs
node scripts/test-panel.mjs
node ../../../packages/plugin-devkit/dist/cli.js check dist
node ../../../packages/plugin-devkit/dist/cli.js pack dist --out release
```

From the task worktree:

```sh
AI_MEMORY_TEST_BINARIES='<binary-root>' node --test apps/desktop/test/ai-memory-plugin-flow.test.mjs

AI_MEMORY_TEST_BINARIES='<binary-root>' \
AI_MEMORY_TEST_SIDECAR='<worktree>/packages/agent-runtime/dist-bundle/sidecar.js' \
AI_MEMORY_TEST_NODE='<installed-Electron-executable>' ELECTRON_RUN_AS_NODE=1 \
'<installed-Electron-executable>' --test apps/desktop/test/ai-memory-plugin-flow.test.mjs

PI_DESKTOP_HOST_BIN='<provisioned-host-executable>' node apps/desktop/test/ai-memory-desktop.e2e.mjs
PI_DESKTOP_HOST_BIN='<provisioned-host-executable>' node scripts/e2e-trusted-extensions.mjs
```

[Desktop evidence and isolation details](ai-memory-desktop-e2e.md) describe the actual UI path. `.github/workflows/ai-memory-compatibility.yml` adds Windows PR/manual/weekly validation with checksum-pinned releases and TOML dependency. New upstream release detection writes a job summary only; it cannot authorize a version, publish a plugin or touch a production server.

## Corrections established during final integration

- Electron profile deletion in `will-quit` raised the user-observed Windows `EPERM` dialog. Cleanup now belongs to the external test launcher after process exit; both locales passed.
- Windows transient rename locks interrupted atomic queue updates. Bounded retries preserve the canonical snapshot and expose persistent failure.
- Stateful MCP session IDs expired on server restart. Reads reinitialize once; mutations never automatically replay.
- Immediate runtime retirement could cancel an asynchronous `agent_end` receipt. Owned end notifications now settle within a two-second budget, with status busy until settled; cancellation outcomes persist.
- Native connection-list envelope and Windows project-path representation mismatches were fixed and retested through the actual Desktop path.
- The security pass identified uninstall credential lifetime and missing owner-preview auditing; both now have production-path regressions.

## Deployment requirements and limits

The released PI-Desktop 0.22.1-beta.4 lacks the new interfaces. This candidate is versioned 0.22.1-beta.5 and the plugin manifest requires `>=0.22.1-beta.5`. Installability alone is not compatibility: full operation still requires owner v1 and connection v1, probed at runtime. The beta.5 tag/release is not created by this change and the user's running installation is not upgraded.

Windows x64 with ai-memory 3.3.2/3.3.3 is measured. macOS/Linux, live SSH deployment, multi-machine/multi-user authorization, paid consolidation and cross-version server database migration are not claimed. No Rust checks were rerun because there are no Rust changes; the provisioned Host executable was reused in actual Desktop E2E. No `verify:ui:*`, paid model call, production memory write or user-profile installation was performed. The candidate is delivered as a pull request; review packages are built by `.github/workflows/pr-package.yml` without publishing a release. Early E2E discovery accidentally read global MCP definitions; this was corrected with isolated `PI_DESKTOP_AGENTS_DIR`, and those exploratory runs were excluded.

Native upstream session-end can create an automatic handoff. Explicit Desktop closure therefore records a local closed state and remote boundary observation while leaving the upstream native session unended; handoff creation stays explicitly confirmed. HTTP 202 remains admission, not persistence. Retained uncertainty, local queue privacy/retention, credential rotation, upgrade and rollback steps are documented in `examples/plugins/ai-memory/docs/operations.md`.

No implementation blocker remains for the measured candidate. Deployment requires a Host containing these changes and the user's chosen coexist/managed configuration. Existing `mem`, remote server settings and unrelated primary-checkout changes remain unchanged.
