# 05. Plugin Lifecycle

## 1. Goals

Define the complete state machine from discovery to uninstall, guaranteeing:

- Predictable behavior
- Recoverable failures
- Auditable start/stop
- Consistency with command palette / AgentTool registration

## 2. State machine

```text
discovered
 → validated
 → installed
 → enabled
 → loaded
 → running
 → load_error
 → disabled
 → install_error
 → invalid
```

### State descriptions

| State | Meaning |
|---|---|
| discovered | Plugin directory or package scanned |
| validated | manifest / file integrity passed |
| installed | Written to the installed directory and registered |
| enabled | Enabled by the user, allowed to load |
| loaded | Runtime loaded, contribution points registered |
| running | Has an active panel / background logic |
| disabled | Installed but turned off by the user |
| load_error | Load failed after enabling |
| install_error | Install failed |
| invalid | Validation failed, unusable |

## 3. Lifecycle hooks

**Implemented today:** the runtime (`apps/desktop/electron/main/plugin-runtime.ts`) invokes `onLoad` (when a plugin is loaded on load/enable) and `onUnload` (dispatched into the plugin process on unload/disable/reload/app quit, 5s budget — 1.5s on quit — then the process is stopped); unloading tears down the plugin's registered commands and tools. The other lifecycle names below are proposals, not members of the current `PluginModule` type.

`onProviderOAuth` is a provider operation callback, not a lifecycle hook. The
host invokes it only for an enabled plugin's declared OAuth provider during
user sign-in or token refresh; it receives an abort signal for cancellation,
unload, and timeout.

`onAgentExtensionCall` is another operation callback, bound to an active owning
extension invocation and limited to manifest-declared operations. Descendant SDK
calls expire when it completes or is cancelled. Runtime retirement identifies
`reconfigure`, `session-close`, or `app-quit`; it does not assert user-task
completion. App quit gives extensions bounded graceful shutdown while their
owner services and Host records remain available, before plugin teardown.
Managed connection requests abort on unload, disable and credential revision
change. See [spec 17](17-owned-extension-services.md).

**Planned:** once the full lifecycle lands, hooks fire in this order:

1. `onInstall` (once, only after a successful install)
2. `onEnable`
3. `onLoad`
4. runtime events
5. `onUnload`
6. `onDisable`
7. `onUninstall`

### Invocation constraints
- Module evaluation plus `onLoad`: 15s; `onUnload`: 5s, shortened to 1.5s on quit.
  These are host budgets, not manifest-configurable timeouts
- A hook exception must not crash the host
- If `onLoad` fails, enter `load_error` and automatically roll back the contribution points already registered
- After a successful package/directory install, enable, explicit reload, development
  load, or marketplace install/update, Main re-reads user MCP records before
  emitting `pluginChanged`. This happens after `onLoad` completes, so a record
  provisioned there is immediately visible without restarting MCP. Connections
  remain lazy at Test connection or the next Agent turn; no active Agent runtime
  is forcibly restarted. Startup retains its existing restore-then-refresh pass.

A plugin that maintains its own managed global instruction block must check
`pi.plugin.getPermissions()` for the effective `agent.prompt.inject` grant, not
its manifest declaration. The SuperClaude Workflow example synchronizes only
its pristine marked region in `~/.pi/agent/AGENTS.md` on load and withdraws that
region on unload, including clean app shutdown. User-edited blocks and text
outside them are retained; an enabled next load reinstalls the pristine block.
Older hosts without the permission query skip this optional provisioning.

## 3.1 Resident services

A service declared in `contributes.services` is driven by the host, not by the
plugin's own hooks, so its window is strictly inside the plugin's lifetime:

1. `onLoad` completes and contribution points are registered
2. For each declared service (at most 4 per plugin, gated on
   `background.service`), the broker calls `service.start` in the plugin process
   with a 5s budget. A start failure marks that one service `failed` and leaves
   the rest of the plugin loaded.
3. On unload / disable / reload, `service.stop` runs **before** `onUnload`, so
   the service is quiet while the plugin still has its API

Status per service is `starting` | `running` | `stopped` | `failed` plus a
restart count, readable over the plugin IPC surface and shown on the Plugins
page.

### Restart policy

The service lives in the plugin's host process, so a crash takes it with the
process. The supervisor then restarts the whole plugin:

- Backoff `1s, 2s, 4s, 8s, 16s`, capped at 30s
- At most 5 restarts; after that the plugin stays down in `failed` so the user
  sees the failure instead of a silent crash loop
- A process that survives 60s is considered healthy and the backoff resets to
  zero
- `autoRestart: false` on a service opts its plugin out of restarts entirely
- Restarts are skipped when the user re-enabled or removed the plugin while the
  backoff timer was pending

Manual enable / disable always wins over the supervisor: an explicit action
clears the pending timer and the attempt counter.

### App quit

Quitting stops every plugin host **as a shutdown**, not as a crash. Each plugin
is marked as disposing and its pending restarts are cancelled before anything
else, then services stop and `onUnload` runs, in parallel across plugins.

This is what separates the two exits: a host process that dies without being
marked is reported as a crash, which means an error log, a "stopped
unexpectedly" toast, and a supervisor scheduling restarts into an app that is
closing. None of that may happen on a clean quit.

**A crash report carries the diagnosis.** The crash path reports the host
process's exit code because on Windows a hard fault (`0xC0000005` and friends,
which Electron hands over as a negative signed int) and a plugin's own
`process.exit(1)` are different bugs. The exit code reaches the load error, the
`failed` service state, the `plugin.crash` audit record and the `plugin` log
channel. Plugin stdout/stderr is not copied into the crash report because it
may contain workspace data or secrets. Nothing new is persisted, and no new
permission or API surface is involved.

The sequence is bounded — `onUnload` gets 1.5s per plugin and teardown 3s in
total, after which the children are killed outright. A plugin's cleanup must
never be the reason the app appears to hang on quit.

### Idle-handoff lifecycle admission

The Desktop plugin runtime requires the application's shared admission callback.
Loading and development-watch registration refuse closed admission. A load owns
one request identity through prior-instance cleanup, settings migration, native
process creation, initialization, contribution registration and service startup.
Unload, replacement or permanent shutdown invalidates that identity. A process
returned after retirement is stopped through its original handle before init;
it cannot replace or unload a newer instance. Default utility-process creation
rechecks after importing Electron and before forking.

Concurrent unloads join the same original cleanup, including pre-load panel
cleanup. Service-start replies recheck the original instance before publishing
state or starting another service. Crash supervision captures its restart record;
manual loading/unloading resets the old record, and late failure cannot overwrite
the replacement's state. Closing admission prevents new restart processes while
preserving crash reporting. The existing backoff and hook budgets are unchanged.

Shutdown seals new loads and marks loaded children synchronously, then performs
bounded cleanup. A caller's three-second shutdown budget does not erase original
cleanup promises still running. `getHandoffActivity()` includes original lifecycle,
panel/child callbacks, workspace resolution/creation, MCP transport operations,
managed-connection storage/network work, loaded entries and supervision timers.
It also retains a saturating count of unqualified native/network attempts and
child requests whose completion is unknown. Ordinary exit, kill, timeout,
unload and map clearing do not clear that evidence. These counts are neither
execution capacity nor native-family closure proof.

Ordinary panel, command, tool and child API entrypoints reject closed admission.
Child callbacks recheck their original installation, parent call and tool
authorization after workspace awaits. An active unload/service-stop request
continues to authorize its own teardown callbacks while admission is closed.
Cancelling the caller does not release a still-running host callback. A child
error response is a known result; timeout, cancellation and transport loss retain
uncertainty even if a late reply subsequently arrives. Old command handles never
dispatch through a reloaded installation. Ordinary one-way event broadcasts stop
when admission closes.

Workspace startup and lookup retain their original operations after retirement.
A late child is stopped before init, and an old instance exit cannot remove a
new instance's pending registration. The existing 64-instance limit also counts
unfinished retired startups. MCP discovery rechecks admission between settings,
handshake, publication and sibling servers. Optional host-only client hooks track
the original transport send, including HTTP response-body reading, independently
of the cancellable JSON-RPC result. Existing embeddings retain their default
behavior. Cancellation notifications remain available for cleanup. Managed
connection configuration uses its captured lifecycle generation through queued
storage operations; configuration cannot borrow a reloaded plugin's grant.

External-resource owner aggregation and qualified native containment must still
join the Desktop coordinator. This work does not enable ownership transfer or
change Plugin SDK permissions, message serialization or durable storage formats.

## 4. Enable / disable semantics

### enable
- Set state to enabled
- Attempt load
- Success: register commands / tools / skills / themes / MCP servers, then start
  resident services
- Failure: automatically fall back to disabled and surface the error to the user. This is frozen by D017 (enable→load failure auto-disables the plugin).

### disable
- Unregister commands / tools
- Close panel
- Stop resident services and disconnect MCP servers
- Cancel any pending restart backoff
- Call `onUnload`; `onDisable` is not invoked
- Persist as disabled

## 5. Startup recovery

On app startup:

1. Scan installed plugins
2. Read the enabled state
3. Load only enabled plugins
4. Skip a single failed plugin without affecting other plugins or the main app
5. Emit `pluginChanged` (`reason: "restore"`) once the pass is done, so the
   renderer re-reads a plugin list it may have fetched before the restore

## 6. Developer mode

`dev-loaded` plugins:

- Not copied to `installed`
- Reference the local path directly
- Can watch and hot reload
- Reload flow: `unload → validate → load`

On hot reload:
- Preserve plugin settings as much as possible
- Panel in-memory state is not guaranteed to be preserved

## 7. Contribution-point register/unregister transaction

Each plugin's load process should be approximately transactional:

```text
begin
 register commands
 register tools
 register skills
 register themes
 register MCP servers (lazy connect)
commit
 start resident services
```

On mid-way failure:
```text
rollback all registrations from this plugin
```

Avoid a half-loaded state where "the command exists but the tool does not".

## 8. Audit events

Record at least:

- plugin.install
- plugin.uninstall
- plugin.enable
- plugin.disable
- plugin.load.success
- plugin.load.error
- plugin.unload
- plugin.crash
- plugin.service.start / plugin.service.stop
- plugin.service.restart / plugin.service.restart.scheduled
- plugin.services.skipped (missing permission or over the per-plugin cap)

Fields:
- pluginId
- version
- source (`installed` | `dev` | `marketplace`)
- ts
- errorCode?
- attempt? / delayMs? (service restarts)
- exitCode? (crash), exitCodeHex? (Windows hard fault)

## 9. Uninstall strategy

Before uninstall:
1. disable + unload
2. No `onUninstall` callback is invoked in the current runtime
3. Delete installed files
4. Delete plugin-private data by default; no keep-data option is implemented

Default recommendation:
- Clean up settings/data on uninstall (D016: uninstall deletes plugin data by default)
- A keep-data option is a future proposal, not a current uninstall guarantee.
  Development source directories are not deleted; bundled plugin ids cannot be
  uninstalled and may be disabled instead

## Workspace execution amendment (ADR 0340)

[Workspace execution](18-workspace-execution.md) is the implemented candidate
contract for optional backend placement, captured workspace/session ownership,
SDK processes/terminals, MCP placement, resources and disconnect behavior.
It amends Desktop-only backend assumptions in this document. Omitted execution
metadata retains legacy behavior. Model/device/renderer integrations and local
Agent persistence remain on Desktop; native remote execution requires separate
Host/package consent and is not an OS sandbox. See
[ADR 0340](../../adr/0340-workspace-plugin-execution.md) for the decision and
spec 18 for migration, limits and release acceptance requirements.
