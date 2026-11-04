# ai-memory for PI-Desktop

Independent `local.ai-memory` plugin for explicit project bindings, bounded historical recall, durable capture, exact handoff acceptance and memory maintenance. The default mode coexists with an existing `mem` MCP configuration. Nothing changes that configuration, installs upstream hooks, or consumes a handoff automatically.

The production adapter supports **ai-memory 3.3.2 and 3.3.3** with guarded writes and durable observation reconciliation. Official binary tests exercise the actual adapter and outbox; see [verified contract](compatibility/verified-contract.md). Unknown releases allow validated reads only. Candidate Desktop and packaged sidecar validation are tracked separately by the parent integration task.

## Host requirements

The manifest minimum is `0.22.1-beta.5`, the first version carrying the required host additions. Runtime admission still probes capabilities: the host must expose owner context v1, `pi.connections.getCapabilities().version === 1`, effective permission queries, session-bound filesystem preview, and resident services. Missing capabilities fail closed. Released 0.22.1-beta.4 continues to support the existing `mem` integration only.

The plugin requires `agent.extension`, `agent.prompt.inject` for its bundled skill, `net.connection`, `fs.read` for `.ai-memory.toml`, `background.service`, and `ui.panel`. The current host uses `agent.prompt.inject` as the exact skill grant; there is no `agent.skills` permission. All credentials stay in native host connection settings. No plugin token field exists.

## Build and validate

Reuse the repository's existing dependencies. The only runtime library is **smol-toml 1.4.2**, bundled into main. If it is not resolvable, set `AI_MEMORY_TOML_ENTRY` to the reviewed package's `dist/index.js`; scripts verify its package name and exact version. They never install packages or download code.

```sh
cd examples/plugins/ai-memory
node scripts/typecheck.mjs
node scripts/test.mjs
node scripts/check-compatibility.mjs
node scripts/build.mjs
```

Run true-server tests using the existing reviewed binaries: `AI_MEMORY_TEST_BINARIES=<binary-root> node scripts/test.mjs real-server`. The root contains `bin-v3.3.2/ai-memory.exe` and `bin-v3.3.3/ai-memory.exe`. Omit `real-server` to run all suites including those tests. Without the environment variable, the four binary scenarios are explicitly skipped.

`dist/` is the packaging root: `main.cjs`, `agent-extension.js`, its identical `.mjs` artifact, panel assets, manifest, documentation and licenses. The manifest uses `.js` because the host manifest validator admits `.ts`/`.js`; `dist/package.json` declares ESM. There are no Desktop implementation imports or unbundled npm runtime imports.

Use the repository plugin devkit to **check `dist/` and pack `dist/`**, not the TypeScript source directory: `node ../../../packages/plugin-devkit/dist/cli.js check dist`, then `node ../../../packages/plugin-devkit/dist/cli.js pack dist --out release`. Parent integration owns the final `.piplug` and isolated Desktop installation validation. Packaging does not install or deploy the plugin.

Run `node scripts/test-panel.mjs` after building, optionally passing the existing Electron executable as its first argument. It creates hidden windows and isolated profiles for Chinese and English synthetic IPC interactions, covering binding confirmation, privacy controls, pause and reconciliation. The Node launcher deletes each profile only after Electron exits, with bounded retries for Windows file locks; it verifies cleanup. Direct `tests/e2e/panel.cjs` runs retain their scratch profile. Neither test attaches to an existing Desktop instance.

## Configure

1. Load the candidate bundle and approve its declared permissions.
2. In native plugin settings create an ai-memory connection. Allow POST `/mcp` and `/hook` only. Enter the credential there. Keep TLS verification enabled; private CA and explicit LAN HTTP approval are native settings.
3. Open **Memory: settings and diagnostics**. Bind the current Desktop project to a connection, workspace and project. Optional root `.ai-memory.toml` must agree. A marker alone never opts a project into capture.
4. Choose the content categories that may leave the project. All body categories start disabled. Check the server compatibility report before enabling capture.
5. POST session-start does not consume handoffs in either supported release. No remote server-setting change is required. The plugin never calls GET `/handoff`.
6. Keep coexist mode until migration is verified. Managed mode activates fixed `aim_*` tools; reopen/reload the conversation runtime after changing modes.

See [requirements](docs/requirements.md), [architecture](docs/architecture.md), [compatibility](docs/compatibility.md), and [operations](docs/operations.md). Offline tests simulate the connection boundary; optional real-server tests launch checksum-pinned binaries with synthetic content and isolated state. Neither uses an existing memory service or paid model.
