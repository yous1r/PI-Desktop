# ai-memory actual Desktop integration evidence

The final isolated Windows Electron journey passed **23/23 checks** with no reported limitations. It exercised the normal native settings and plugin panel path. Earlier object/string IPC and Windows path separator mismatches were reproduced, corrected, and covered by targeted regressions; the diagnostic settings workaround was removed before this successful run.

## Reproduction

From the request worktree after building Desktop, shared/runtime, plugin-devkit and the plugin:

```sh
PI_DESKTOP_HOST_BIN='<primary-checkout>/target/debug/pi-desktop-host-core.exe' \
AI_MEMORY_TEST_BINARIES='<scratch>/aim' \
node apps/desktop/test/ai-memory-desktop.e2e.mjs
```

`PI_SCRATCH_DIR` must be set. The runner packages the actual plugin dist, installs it and grants manifest permissions through an isolated real Rust Host, then launches the built Desktop with separate profile/data/global-agent directories. It opens the native settings sheet and plugin WebContentsView using CDP. Credential save uses real preload IPC; the project binding uses the actual form and confirmation dialog. Session creation and prompting use the production control surface with a deterministic loopback model. The official hash-checked ai-memory 3.3.3 server uses synthetic authentication and no LLM credentials.

## Executed user path

| Surface | Verified result |
| --- | --- |
| Package installation | Rust package install, installed registry source and exact permission grant |
| Native connections | Settings opened, `{pluginId}` list envelope accepted, credential saved without readback, exact POST routes |
| Plugin configuration | Real panel displayed project/connection; confirmed form saved coexist mode and capture policy |
| Recall | Actual model request contained the seeded upstream page and one source packet |
| Persistence/privacy | Source packet absent from transcript; bearer absent from response/model; no external mem tools imported |
| Capture | Actual owner/connection path produced persisted upstream observations |
| Restart | Desktop and upstream restarted on the same isolated state; connection and recall restored |
| Disable | Subsequent prompt had no recall packet and no additional upstream observations |
| Uninstall | Installed row removed; upstream page remained readable |

Native credential save is exercised through production preload IPC. The separate connection-settings interaction suite covers the form's typing/save/CAS/clear behavior. Restart uses owned process termination and recovery; bounded graceful shutdown ordering is covered by dedicated Host tests. Managed writes, exact handoff, concurrent project isolation, cancellation and offline recovery run in the separate full-process suite against both upstream releases.

## Isolation and cleanup

The fixture explicitly sets `PI_DESKTOP_AGENTS_DIR`; HOME/USERPROFILE alone do not redirect Windows Known Folder capability discovery. An early exploratory run loaded existing global MCP definitions and attempted discovery. It emitted no real memory write or paid model call and is excluded from acceptance evidence. Final runs use an allowlisted child environment, a new empty agent directory, an empty native MCP-list assertion, no external memory tools in model requests, and an offline plugin catalog URL.

All spawned services/processes have fixture cleanup. No user Desktop is attached and no `verify:ui:*` is run. Full sanitized evidence remains in the task scratch directories printed by the runner. The committed-source-oriented summary and final build/package identities are in [ai-memory-implementation.md](ai-memory-implementation.md).

The first successful final-candidate run was `ai-memory-desktop-ZbCihO` (23/23, three actual local model requests). After the 0.22.1-beta.5 version bump, the rebuilt candidate and package passed the same journey again (`ai-memory-desktop-2EEasP`, 23/23, package `b2afd34e…`).
