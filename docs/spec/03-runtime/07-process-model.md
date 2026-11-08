# 07. Process Model

## 1. Processes

MVP target topology:

```text
PI-Desktop.app
├── Electron Main
│   ├── Renderer (React UI)
│   ├── Rust host-core sidecar
│   └── Node pi agent sidecar
```

## 2. Ownership

| Process | Owns |
|---|---|
| Electron Main | window lifecycle, cross-platform tray integration, IPC fan-in/out, child process supervision, fixed-feed app update lifecycle |
| Renderer | UI only |
| Rust host-core | DB, tools, permissions, immutable Plan/Goal artifacts/`plan_approvals` execution fields, shell catalog, plugin host services, secrets adapters |
| Node pi sidecar | pi agent loop, provider streaming, tool-call planning |

## 3. Boot order

Boot begins with a single-instance lock. One data directory admits exactly one
app process: host-core owns `pi.sqlite` exclusively (D002), Electron main owns
the persistence outbox and the log tree beside it, and the tray, the global
launcher shortcut, and the updater are singletons of the running desktop. A
launch that does not take the lock quits before it creates a window, a tray, a
log line, or a child process; the instance that holds the lock restores and
focuses its main window from `second-instance`, recreating a window that was
closed or hidden into the tray, exactly as the tray's Show action does. The lock
is Electron's, so its scope is `userData` — derived from the application name,
which is therefore set before the request — rather than the data directory: a
run pointed at its own `PI_DESKTOP_DATA_DIR` (E2E harnesses, the capture rig, a
side-by-side profile) shares no database, outbox, or logs with the default
installation and stays launchable while one is running (D236, ADR 0094).

A development build is its own installation rather than a second process of
the same one: it runs under `PI-Desktop Dev` in the OS application-data root
and reads `~/.pi-desktop-dev`. `pnpm dev` therefore starts while a packaged app
holds its lock, and the two never share a database, an outbox, or a log tree
(D599, ADR 0094). An explicit `--user-data-dir` is honored instead, because the
E2E harnesses point a build at a throwaway profile with it.

1. Electron main starts
2. Load English locale defaults
3. Spawn Rust host-core
4. `app.handshake` with host-core
5. Spawn Node pi agent sidecar
6. Connect agent sidecar tool-bridge to host-core via main
7. Create main window / renderer
8. Renderer performs `app/getVersion` healthcheck through main

If step 3–4 fails: block app with recovery message. Before a successful host
boot serves RPC, host-core transactionally marks prior pending approvals and
queued/running `plan_approvals` execution states interrupted and aborts their
running turns. This internal process-epoch fence is not serialized or sent over
the protocol.

The renderer bootstrap has no timeout of its own, so the renderer watches its own
wait for the first state. At `STARTUP_SLOW_HINT_MS` (30s) the boot surface adds
logs, diagnostics, and quit without calling the boot a failure; at
`STARTUP_STALLED_MS` (180s) it becomes the recovery surface, which also offers a
retry. Both bounds sit above the main↔host RPC ceiling
(`DEFAULT_RPC_TIMEOUT_MS`, 130s), so a slow but successful boot is never reported
as a failure. The watchdog never cancels the startup it watches: a boot that
finishes replaces the surface with the shell, and the recovery surface replaces
the splash. The renderer-drawn window controls stay above that surface, so a
frameless Windows/Linux window can always be closed, and quitting from it goes
through the renderer quit channel (`pi-desktop/app/quit`), which runs the same
ordered shutdown as the Quit menu item.

After host-core is up, Electron main reads `AppSettings.networkProxy` and
applies it before spawning the agent sidecar (D340). Chromium sessions use
`session.setProxy`; main-process `fetch` is `net.fetch`. In System mode, the
sidecar provider dispatcher and host-core marketplace `curl` use an
authenticated, loopback-only SOCKS5 relay. Electron resolves each destination
with `session.defaultSession.resolveProxy`, including PAC rules and their
ordered fallbacks. The relay's random credential is runtime-only and is sent
over sidecar configuration / host RPC, never through process environment.
Custom URLs with userinfo keep credentials for Node and curl; Chromium is
pointed at a loopback SOCKS5 relay that injects them, because `proxyRules`
cannot carry userinfo (issue #490). host-core marketplace `curl` gets explicit
proxy arguments and does **not** inherit proxy env, so workspace Bash cannot
see proxy credentials. Direct mode bypasses the System relay. TLS certificate
verification remains enabled on every route.

Provider model-list and connection probes recover from Electron 43's exact
`net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED` failure with one Node HTTPS metadata
attempt through the same authenticated relay and active Chromium proxy route.
The retry supplies no client certificate, retains the original cancellation
budget and manual redirect/origin checks, and validates the server certificate
and hostname with default plus OS CA roots. Mandatory client authentication
continues to fail. Other TLS errors, HTTP responses and cancelled requests do
not trigger this retry; agent turns and plugin requests are unaffected. See
[the metadata transport decision](../../adr/provider-metadata-client-certificate-retry.md).

Marketplace curl diagnostics prefer UTF-8 and fall back to the active Windows
ANSI code page before crossing the UTF-8 RPC boundary, so localized Schannel
errors remain readable instead of becoming replacement characters.

## 4. Crash policy

| Crash | Policy |
|---|---|
| Renderer crash | reload the current window after an unexpected renderer exit, unless the window is closing or the app is quitting; keep host/agent processes; same-host reload restores only live pending Plan/Goal approvals and their deadlines, not terminal cards |
| Rust host crash | mark app degraded, interrupt pending/queued/running approval work, keep pending sessions in their contract mode (Plan or Goal) and already-approved sessions in Agent, attempt restart host, and fail active sessions closed |
| Node agent crash | abort active turns and live approval waiters/queue entries, keep pending sessions in their contract mode, preserve already-approved Agent mode in Rust, restart sidecar, and never replay an execution; the sidecar's stderr tail is classified at exit — a V8 heap-exhaustion banner settles the owning turn as `AGENT_SIDECAR_OOM`, any other unexpected exit as `AGENT_SIDECAR_CRASHED` (issue #1077) |
| Electron main crash | full app exit |

Crashpad is started local-only (`uploadToServer: false`) before `ready`, and
dumps are stored under `<data_dir>/crash-dumps` (D602) so a
`PI_DESKTOP_DATA_DIR` profile does not share dumps with another installation.
An unexpected renderer exit records its reason and exit code, then reloads the
current main window when it is still live. A clean renderer exit and an accepted
window close do not trigger recovery.
The next launch that holds the single-instance lock writes one diagnostics
line for dumps newer than `crash-dumps.json`. Crashpad records
Chromium-process crashes (main, renderer, GPU, utility); a renderer crash the
app already recovered still leaves a dump and is logged at warn. Host-core and
sidecar crashes stay on the supervisor path in this section and the `host` /
`agent` log channels.

Broken stdout/stderr (`EPIPE`/`EIO`) is not a main-process crash. Main ignores
those writes so a Linux AppImage or GUI launch without a live TTY keeps
supervising host/sidecar instead of showing Electron's uncaught exception
dialog.

A main-process JavaScript `uncaughtException` is also not an Electron main
crash (only a native main abort exits the app). Main installs its own
`uncaughtException` / `unhandledRejection` handlers, writes `app/runtime`
records, and keeps running. That suppresses Electron's default
"A JavaScript error occurred in the main process" dialog. Recoverable
network-stack throws include Chromium copying a non-Latin-1 HTTP header into
`Headers.set` (`TypeError: Cannot convert argument to a ByteString`), which
appears on Windows behind a system proxy or gateway that injects Unicode
header values. The next `net.fetch` or updater request must not re-open that
native dialog.

Linux packaged host-core is built on Ubuntu 22.04 and needs glibc 2.35 or newer
(Ubuntu 22.04, Debian 12, Fedora 36+). A lower glibc is a fatal host status,
not a restart loop: the UI names those releases instead of "Can't reach the
local service". The Linux tag job must not use a newer runner that would raise
the needed glibc.

The `pi-host` bundle a desktop installs on a remote machine is not subject to
that floor: it carries a statically linked musl `host-core` (ADR 0338), so
`host-core` itself needs no glibc there. Only the bundle's Node runtime keeps
Node 24's own requirement, and a machine below that fails inside the bootstrap
instead of at `host-core` startup. `scripts/check-linux-host-static.mjs` refuses
a dynamically linked build in both the release lane and CI.

Two more boot outcomes are named rather than left as a generic outage (D380):

- **Downgraded build.** host-core refuses a data directory whose SQLite schema
  is newer than the build supports (`database schema version N is newer than
  supported M` on stderr). Electron parses that line from the last stderr
  before exit, stops the restart loop on the first failure, and pushes
  `hostStatus` with `message: "DB_SCHEMA_TOO_NEW"` and both numbers. The banner
  tells the user to install the newer PI-Desktop that last opened this data.
  No data is migrated down.
- **Non-native build.** At boot Electron compares `process.arch` with the CPU
  (on macOS via `sysctl.proc_translated`, which is `1` only under Rosetta 2;
  elsewhere via `os.machine()`). A mismatch rides on the boot `hostStatus` as
  `archMismatch` even when boot succeeded, and the renderer shows a dismissible
  hint naming the build (Intel / Apple Silicon on macOS) and the matching
  download. An arm64 build on an Intel Mac never launches, so only the
  Intel-on-Apple-Silicon direction is detectable.

Windows packages target x64. The Windows host-core build uses the
`x86_64-pc-windows-msvc` target with `target-feature=+crt-static`, so the NSIS
package does not require a separately installed Visual C++ Redistributable to
start its local service. Windows 11 ARM64 systems run this x64 package through
the operating system's x64 emulation; native Windows ARM64 artifacts are not
currently published.

Supervision parameters (the transports, restart policy, and turn lifecycle are
`packages/host-runtime`, ADR 0284; Electron main adapts them and owns the
renderer-facing status):

- A cooperating Rust Host acquires the OS lock on `<dataDir>/host-core.lock`
  before AppState/database opening, migration, recovery or startup sweeps. The
  handle remains held through serving/shutdown. A concurrent startup exits with
  `HOST_DATA_DIR_IN_USE` before touching existing turns. Shared HostProcess maps
  the exact native boot marker to that error code only before handshake; ordinary
  post-handshake exits keep their previous classification. The lock file is
  neither truncated nor deleted, and process exit releases the OS lock without
  PID-file cleanup. Offline relocation holds the same lock on its destination.
  Old binaries that ignore the lock must be stopped first; this does not implement
  orphan-sidecar fencing or automatic service handoff. See the
  [ownership ADR](../../adr/host-data-directory-ownership.md).
- Windows Rust Host can explicitly enable a local owner-discovery pipe with
  `--owner-control`. `--owner-status [expected-owner-epoch]` queries the configured
  data directory without creating it or opening AppState. The native channel is
  current-user-only, rejects remote clients and requires the same canonical Host
  executable on both ends. Directory volume/file identity makes aliases share
  one discovery name. Unknown operations/fields, oversized frames and stale
  epochs fail closed. Version 1 advertises only `status`; process discovery does
  not prove native execution fencing or transfer readiness. See the
  [local discovery ADR](../../adr/windows-owner-discovery.md).
- Child exit rejects all in-flight RPCs for that child immediately (no 130s timeout wait).
- Every RPC carries a finite transport deadline. Bash and desktop-dispatched
  (`plugin_*` / `mcp_*`) tools add the waits host-core can spend before it
  reports an outcome, and `agent.compact` adds the sidecar's own summary budget
  — its stream watchdog per attempt plus its retry backoff (**D614**, issue
  #795); everything else uses the 130s default. Never widen the default to cover
  a slow method: that also hides a genuinely lost reply on every other call.
- An NDJSON request line over 64 MiB is drained and answered with `LIMIT_EXCEEDED`; it does not end the stdin reader (ADR 0216). Electron rejects the same size before writing stdin (ADR 0217).
- The Windows Alt+Space hook retains only a weak stdout sender. After stdin EOF, serve drops the last strong sender and host-core exits. A leaked sender cannot block shutdown for more than 5 s (ADR 0217).

- Auto-restart with exponential backoff `0.5s → 1s → 2s` (cap 4s).
- At most **3 restarts per 2-minute window** per child; beyond that the app
  stays degraded and emits `hostStatus { ok: false, component, fatal: true }`.
- Restart supervision is single-flight per child. A host process has a unique
  generation; stale generation requests and notifications are rejected before
  they reach the current bridge.
- Host persistence appends are buffered in an Electron-main-owned outbox while
  the host is unavailable and flushed sequentially after a new handshake. A
  missing sessions row is restored from the live transcript (or created as a
  stub) before those appends apply; deleting a session drops its outbox
  entries (D318).
- The headless `RuntimeService` keeps per-session append order and waits for
  queued final messages and usage before `session.endTurn`. The final reply
  checkpoint finishes before its transcript append, preventing a late checkpoint
  from racing finalization. Root terminal events are published from the single
  claimed finalization, after persistence and settlement; an unconfirmed success
  becomes an error event instead of an early `agent_end`. A failed append or
  unacknowledged end is reported with `settled: false`, never successful completion.
  Previously locked abort reasons remain aborted. A failed row does not discard
  later rows, and a late old-turn failure cannot poison a new turn. Shutdown
  drains event writes and already-claimed finalizations before removing listeners.
  The queue remains in memory; process/power-loss recovery is limited to the
  acknowledged transcript and in-flight checkpoints, not a durable outbox.
- Before replacing or activating a session transcript, Electron main fences
  persistence callbacks for that session and drains appends already queued for
  the old transcript. If the rewrite succeeds, events from turns that existed
  before the fence are discarded, including callbacks delivered while the
  rewrite was running. If the rewrite fails, callbacks buffered by the fence
  are replayed against the unchanged transcript.
- Host-core's stdin/stdout control path uses one dedicated OS thread per
  direction rather than Tokio's dynamic blocking pool. Transient pipe resource
  errors are retried; control-thread creation failures are surfaced as a boot
  error, so OS thread pressure cannot become an unhandled host panic. The
  login-shell PATH probe is best effort and falls back to the inherited PATH if
  its helper thread cannot be created.
- Renderer is notified on every transition via the `hostStatus` event:
  `{ ok, component?: "host" | "sidecar", restarting?, restarted?, fatal?, message? }`.
- Renderer notifications are best-effort. A disposed render frame — window
  closed while the app keeps running in the tray/Dock, or a teardown race where
  the frame dies before `webContents.isDestroyed()` flips — is dropped, never
  raised: supervision and restart proceed with no window attached.
- An unexpected sidecar exit is logged together with the sidecar's last stderr
  lines (ring-buffered in main), so a crash without a stack trace still leaves
  its final output in the report.
- Every rejection that only reports a gone transport — refused before it was
  sent, or in flight when the transport closed — carries
  `errorCode: HOST_UNAVAILABLE`, so a caller classifies routine teardown by code
  rather than by matching message text.
- Reads of host-owned registries that only add optional context to a launch or a
  panel (MCP servers, user skills, user subagents) check transport availability
  first and drop a `HOST_UNAVAILABLE` rejection quietly, degrading to empty. A
  dead transport during shutdown or between restarts is routine; logging it at
  `warn` files it under the same line as a registry that genuinely cannot be
  read.
- A renderer panel backed by a host-owned registry reloads on
  `hostStatus { ok: true }`, so a call that lost a race with teardown or a
  restart does not leave the panel showing a transport error for a registry that
  is fine.
- Intentional shutdown (quit/dispose) never triggers restart.

## 5. Shutdown order

After a confirmed quit, Electron Main synchronously records `app shutdown`
before the first awaited teardown step. A force-terminated process therefore
retains the lifecycle boundary whenever the local log write succeeds.

1. Reject new prompts
2. Flush the in-flight reply checkpoints, then abort active turns through the
   sidecar and wait, bounded (2 s total), for their aborted final rows to
   drain through the persistence outbox while host-core is still alive (D299).
   An idle quit still awaits the outbox. The next handshake awaits any
   leftover drain before the renderer can `session.get` (D327).
3. Interrupt pending/queued/running Plan and Goal work and reject late responses
4. Unload plugins
5. Stop Node agent sidecar
6. Drain terminal event writes (turn finalization and regenerate archival),
   checkpoints and the outbox while Rust host-core remains available, then
   flush/close its DB. Terminal writes use a bounded wait of 2 s; a timeout logs
   `quit before event persistence settled` and allows quit to proceed.
7. Stop Rust host
8. Dispose update polling
9. Close windows / exit

`HostProcess.confirmExit(timeoutMs)` and `AgentSidecar.confirmExit(timeoutMs)`
provide an explicit, bounded observation of their original Node `ChildProcess`.
They never signal a process. A live child, transport failure, failed spawn or
unconfirmed timeout returns `false`; a known child with exit code/signal returns
`true`. The default is 2,000 ms; zero checks current state, and invalid or
out-of-range integer budgets reject. Confirmation listeners are removed on
completion. Existing `dispose()` remains bounded and does not itself promise
exit. This additional primitive proves neither descendant cleanup nor durable
execution-owner fencing, and does not enable ownership handoff.

A quit that runs out of its budget logs `quit before streaming replies settled`
and proceeds; the next host boot promotes whatever checkpoint remains. An
unexpected sidecar exit takes the same recovery path immediately: the last
checkpoint of every running session is flushed and `session.endTurn` is asked
to `recoverInflight`, so the streamed text becomes the turn's `aborted` row
instead of vanishing with the process.

Minimizing the main window is a resident-shell action, not an application
shutdown. On Windows/Linux, explicit application minimize actions use the
native taskbar transition and keep the process alive; clicking the Windows
focused taskbar button uses the same transition and keeps the taskbar entry,
while clicking it again restores/focuses the same window. macOS native
minimize remains tray-resident. The tray owns restore/focus for tray-hidden
windows and an explicit Quit action. Quit from the tray, the existing close
path, or an update install still enters the normal shutdown sequence above;
destroying the tray happens during `before-quit` so shutdown cannot be
intercepted by a stale shell affordance.

On macOS the app runs under the regular (foreground) activation policy for its
whole lifetime, so it is always listed in the Dock and Cmd+Tab: Main never
transforms the process type, and the always-on-top plugin launcher joins every
Space with `skipTransformProcessType` rather than by becoming an accessory app.
Because macOS only emits Electron's `activate` for a Dock reopen, Main also
restores a tray-hidden window from `did-become-active` when no window is
visible, which covers Cmd+Tab and App Exposé without pulling the main window in
front of the launcher or a plugin panel (ADR 0086).

`updates/install` invokes Electron's quit-and-install path only after an update
reaches `downloaded`. Electron still emits `before-quit`, so the normal
sidecar/host shutdown sequence runs before the updater replaces the app.

For Windows NSIS installs, `PI_DESKTOP_UPDATE_CACHE_DIR` may override the
electron-updater cache base with an absolute, writable directory. The packaged
`app-update.yml` remains authoritative for the cache subdirectory name. On first
startup after relocation, Main adopts the differential installer and block map
from the legacy `%LOCALAPPDATA%` cache, preserves any staged update, then removes
the old cache directory only when empty. Unknown files and an already-populated
destination are preserved rather than overwritten or recursively deleted. When
the update feed confirms the running version is current, Main removes only the
`pending/` download staging directory; differential baselines stay available for
the next small update. Do not point the override at an installation directory
that requires elevation to write.

The download-and-install path remains owned by Electron Main. The installer itself
still creates `installer.exe` in `%LOCALAPPDATA%`; relocation adopts that copy on
the next launch rather than changing the NSIS installer or writing into
`Program Files` (issue #1098).

## 6. Dev vs release

### Dev
- Electron via electron-vite
- Rust via `cargo run` binary path
- Node via system Node (`>= 22.19`)
- `desktop` `predev` rebuilds every workspace dependency in topological order
  (`shared`, `i18n`, `plugin-sdk`, and `agent-runtime`) before host-core and
  Electron startup; Electron must never compile against or load stale ignored
  package artifacts from an earlier source revision
- Electron 43+ no longer installs its binary during `pnpm install`;
  `scripts/dev-electron.mjs` resolves the development host through the
  `electron` package entry, which downloads and extracts the binary on demand
  at first dev boot
- On macOS, `scripts/dev-electron.mjs` copies both tray icon assets into the
  branded bundle's `Contents/Resources`, matching Electron's packaged resource
  lookup used by the development process.

### Release
- package Electron app
- ship Rust host binary in resources (`Resources/bin/pi-desktop-host-core`)
- agent sidecar runs the bundled `agent-runtime/sidecar.js` on the Electron
  binary itself with `ELECTRON_RUN_AS_NODE=1` — no separate Node runtime is
  shipped (resolves **D008**)
- `Resources/agent-runtime/sidecar.js` is the sidecar's only independent
  release entry. ASAR does not carry a second complete
  `@pi-desktop/agent-runtime` package tree; Electron Main may inline the
  pure-JS helpers it calls without changing process or protocol ownership
- renderer dependencies ship through Vite output rather than duplicate raw
  package trees; no interactive PTY native module is packaged
- packaged builds use the Main-owned update controller and a persisted
  per-install `updatePreference`. Automatic mode keeps the existing in-app
  download/install flow on supported packages; Manual mode checks the fixed
  stable feed without starting downloads or installing on quit, and reminds
  once per available version. Defaults are Automatic for Windows NSIS,
  packaged macOS, and Linux AppImage; Windows ZIP/portable and packages without
  automatic-install support default to Manual. Windows ZIP/portable users can
  explicitly opt into Automatic after a warning that the NSIS installer may
  replace the extracted copy. Preference and last-reminded version use the
  existing host-owned app settings JSON; neither is included in portable
  configuration sync.

## 7. Remote target topology (post-MVP)

Remote control does not add a public listener to Rust host-core or the current
renderer IPC surface. The target Agent Host is a headless module
(`packages/agent-host`) that owns session and turn admission, the turn queue,
the approval broker, and the event log, supervised beside the Node pi sidecar
and Rust host-core, with an authenticated RACP server above it (D374). The
first remote deployment (D375) runs that module as a headless `pi-host` on a
remote machine, bound to loopback and reached from the desktop through an SSH
port forward. The unscheduled Gateway topology would add an outbound Host
link; the Gateway routes authenticated clients and never owns workspace
state.

The detailed topology, ownership, and migration boundary are specified in
[`02-architecture/05-remote-agent-control.md`](../02-architecture/05-remote-agent-control.md).
The current four-process local topology and shutdown order remain unchanged
until a post-MVP implementation milestone explicitly amends this section.

## 8. Acceptance

1. Clean boot path documented and scriptable
2. Host crash does not silently continue tool execution
3. Agent crash does not corrupt SQLite
4. A host crash does not create a persistence error storm or replay a completed
   message twice.
5. Host/sidecar crash never turns a pending Plan or Goal approval into Agent
   execution;
   restart recovery leaves it interrupted and the durable session in its
   contract mode
6. A queued/running execution that was already approved is interrupted without
   replay and its durable session remains Agent
7. Bash timeout/abort shuts down the complete child process tree


### Native tray session projection

The tray service keeps Running, Unread, and Pinned groups current independently
of renderer visibility or lifetime. Host remains authoritative for sessions and
notifications; root agent events describe running state. Renderer mirrors only
organization preferences through a main-window-only IPC. Read requests are
coalesced; obsolete Host results cannot repopulate the menu, failures clear
shortcuts, and quitting prevents further publication. A closed window retains
only the last organization copy, which is replaced after renderer bootstrap.
Menu command readiness is acknowledged after bootstrap's initial navigation,
so a tray click cannot be overwritten by the startup draft or pending-plan
selection. See [ADR tray-session-shortcuts](/adr/tray-session-shortcuts).

## Global floating personal todos

Main owns one separate personal-todo BrowserWindow and an in-memory draft writer.
After normal startup it shows a compact strip docked to the display work area's
top edge, initially pinned; explicit open actions expand it. It is not parented
to the main window and survives main minimize/close-to-tray. Its close action
collapses to the strip. Tray/titlebar open reuses it without resizing an already
expanded editor. Only expanded bounds and pin preference survive restart; compact
bounds never overwrite editor placement. Native DIP rounding is kept separate from
requested bounds so repeated collapse/expand cycles cannot accumulate size drift.
Screen changes clamp expanded bounds or redock the compact strip.

Drafts are handed to Main immediately. The Main timer flushes after 500ms idle
or 2s oldest-dirty age; a 5s acknowledgement deadline surfaces failure. Blur,
collapse and quit request immediate flush. The confirmed quit path drains editor
messages and saves while Host is alive, before disposing any application resources.
A failed save keeps the app alive for Retry or Cancel. The window, timers and
screen listeners are disposed on application quit. Stacking uses native pin state,
not focus/raise polling. See [ADR](../../adr/global-floating-personal-todos.md).

## Opt-in Windows sidecar execution containment

`HostProcess({ executionFence: true })` starts Rust with `--execution-fence`.
The embedding coordinator calls `AgentSidecar.createFenced` to prepare a private
one-use registration, then starts the same Rust executable as a stateless
launcher. Rust authenticates its original process identity and captured parent,
assigns it to a non-inheritable kill-on-close Job with no breakaway, and only then
admits Node startup. Preloads, initialization and detached descendants inherit
containment. The capability is not forwarded to Node.

Host death, coordinator death and launcher exit terminate the owned family.
`fenceExecution(0..2000)` explicitly requests termination and confirms only after
registration has ended, the original launcher has exited when assigned, and the
Job has zero active processes. A timeout is unconfirmed; ordinary `dispose()` and
single-child `confirmExit()` are not equivalent proofs. Unknown identities and
failed registration never fall back to an ordinary sidecar launch.

This additive path is available to coordinators; default Desktop/headless launch
is unchanged. It does not adopt unrelated applications or other process families.
All-resource idle handoff and readiness remain separate prerequisites. Other
platforms refuse this mode. See [the execution-fence ADR](../../adr/windows-execution-fence.md).

## Durable owner registration and restricted recovery

Schema v28 stores each opt-in owner's epoch, native profile identity, Host and
coordinator identities before serving execution RPC. A protected current-SID
`Global\\pi-execution-v1-{profile}-{owner}-{generation}` Job is registered before
returning a startup ticket; the authenticated launcher identity commits before
native assignment and acknowledgement. Registration rechecks both active-owner
state and unfinished transfers. Job-name collisions refuse without modifying the
existing Job. Discovery and journal use the same owner epoch.

After taking the data-directory lock, ordinary startup performs read-only journal
inspection before AppState, migration, maintenance, turn recovery or scheduling.
Any unfinished transfer blocks ordinary startup, including metadata copied from
another native profile. Unsupported schemas, downgraded journal metadata,
identity mismatch, access denial, live owners or active containment fail closed.
Without an unfinished transfer, every retained generation of the previous owner
must pass native proof, even if its durable flag says closed. Retirement commits
only after any requested discovery endpoint is acquired successfully.

Explicit Windows `--owner-handoff` is an existing-profile-only restricted mode.
It accepts bounded private stdio status/claim/recover frames, captures the current
Host and parent identity natively, and never opens AppState. Claim validates the
reserved epoch, capability hash and exact executable SHA-256/schema/protocol;
source retirement, target identity, phase and receipt commit atomically. Recover
proves the source and any previously claimed target plus retained generations
ended, then atomically retires them and rotates the reserved target/capability.
It never adopts or terminates a process by a persisted PID or Job name.

The restricted mode holds the OS lock until exit. Its operations do not publish
`ready`, admit execution, replay turns/tools or change permission modes. A receipt
is a historical operation result, not execution authorization. Complete idle
inventory, source prepare/cancel/fencing, successor readiness and client
reattachment remain the next integration slice. Default app launch is unchanged.
The [private transport contract](06-host-rpc-protocol.md#restricted-owner-handoff-bootstrap-windows)
defines framing and timeout behavior.

## Handoff admission prerequisites

`MaintenanceAdmission` owns both ordinary maintenance and process-local handoff
admission. Ordinary maintenance retains its 120-second lease. `acquireHandoff`
closes the same gate synchronously before asynchronous owner inspection and
requires explicit nonnegative safe-integer counts for every resource family:
clients, turns, queued turns, plans, tools, processes, terminals, plugins,
admissions, finalizations, writes, children, Workers, schedules, approvals,
inputs, native sessions, MCP and uncontained resources. Any activity refuses as
busy; missing or invalid counts refuse as unavailable. Loaded application-owned
resources outside qualified containment prevent transfer even when not busy.

A successful handoff hold has no expiry. Its local identity-bound handle can
cancel only before fencing, after source orchestration confirms durable
cancellation. `beginFencing` permanently seals that handle before native effects;
timer expiry, connection loss, a maintenance release or a stale handle cannot
reopen it. Disposal remains closed. This is local admission authority, not a
second durable journal or a client-supplied idle proof.

AgentHost reports pending approvals/inputs independently of active turns.
RuntimeService reports pending session operations, turn finalizations, writes and
tools from their existing owners. Terminal persistence completion can precede
AgentHost's asynchronous queue inspection, so coordinators must inspect all
owners rather than infer idle from one terminal event.

Headless approved-plan admission is counted before waiting on the session lock
and rechecked inside it before durable claim. Claimed work stays counted through
launch and settlement; a concurrent idle request refuses instead of stranding a
claimed row. Failed finalization and deferred retries remain busy. Disposal
cancels retry timers and prevents later claims; a claimed execution whose launch
has not begun is finalized as interrupted. These prerequisites do not yet enable
Desktop transfer, successor readiness or complete application resource inventory.

### Desktop admission composition

Electron Main owns one `DesktopHandoffAdmission` around the existing maintenance
gate. Local renderer invokes, internal invokes and event-bearing IPC handlers
share it; admitted setup remains counted until the original operation settles.
Renderer calls route to their remote owner before local admission. A delayed
local routing result rechecks the gate. Event-bearing handlers remain unavailable
to internal invokers and retain their existing sender authorization.

Only application quit and its authenticated lifecycle-dialog callbacks bypass a
closed gate. Names such as `get` or `list` do not imply safe observation because
some handlers initialize resources. AgentHost queue admission and scheduled
poll/dispatch share the same gate. Confirmed shutdown permanently closes it;
cancelling the quit confirmation or an unsaved-todo prompt does not close it.

Boot and restart setup, including restart backoff, retain admission until their
asynchronous work settles. Closure prevents subsequent startup effects, plan
draining and restart-ready announcements. Normal Host restart still rebinds the
sidecar and restores display locale; both child restart kinds still drain plans.
Boot verifies its original Host after asynchronous work before using later results.

Approved-plan direct dispatch, proposal lookup and recovery drain share this
admission. Dispatch registers before waiting for the session lock. Each claimed
execution retains its original Host generation, sidecar and bridge through
launch and cleanup; late replies cannot use replacement owners or overwrite a
newer active turn. A locally interrupted execution cannot resume when launch
setup returns. Deferred retries have one owner and are cancelled on disposal.

Launch resolution binds Host reads and checks the same owners around awaited
catalog, instruction, MCP and plugin initialization. A stale result cannot
publish MCP records or vendor bindings to a replacement. Already-started setup
remains counted until its original promise settles; a rejected or cancelled
promise does not establish native resource closure.

Execution finalization requires a matching durable terminal descriptor. Turn
cleanup requires an acknowledged `session.endTurn`. Lost claim, begin-turn or
sidecar-acceptance replies, failed cleanup and pending execution finalization
remain busy, including after disposal. They are never resolved by borrowing a
replacement Host or replaying execution. The existing idempotent terminal-write
retry uses its original Host and frozen outcome. These local bindings do not
replace Rust ownership or provide native exit proof.

User-configured MCP uses the same application gate for discovery, connection
tests, tool calls and status probes. Admitted work remains counted through OAuth,
handshake and original operation completion, including after cache replacement,
cancellation or disposal. Parallel discovery waits for all admitted setup to
settle. Delayed setup rechecks admission and current configuration; a tool call
cannot dispatch through a client that its owner has retired.

`UserMcpRuntime.getHandoffActivity()` reports pending operations plus cached
connections as `mcp`. Every client construction attempt also increments a
saturating safe-integer `uncontainedResources` count before invoking the factory.
Ordinary MCP transports have no qualified native-family closure contract, so
failure, timeout, `close()`, invalidation and disposal never decrement that count.
Retired client objects need not be retained for this refusal evidence. Saved but
never initialized records alone do not imply a live resource. Disposal blocks
all later work and prevents pending OAuth/handshake work from resurrecting clients.

Workspace terminal entries require that same gate. Their router captures the
original Host generation and remote connection object/generation, rechecking
after binding and action awaits. Local PTY requests also recheck the caller's
binding after directory I/O and before spawn or input. Only explicit replay may
admit a new remote connection; input is never replayed. Late creation and
reattachment cleanup addresses the captured connection, never its replacement.
Concurrent replay on an unchanged owner remains valid.

Terminal inventory includes admitted router/service operations, live handles,
pending output delivery and disposal. Window retirement seals immediately and
waits for the original work. Settled routers reduce to saturating scalar refusal
evidence; removing a window or clearing handles cannot erase it. Every local
PTY spawn attempt and remote create/legacy-attach request remains unqualified
after errors, ordinary exit or close acknowledgements. Cleanup failures are
observable and also retain refusal evidence. These counts describe activity
and missing containment proof, not execution capacity or native-family closure.
Filesystem-only shell discovery does not launch a process or invent a PTY.
The shared remote connection itself remains owned by its existing remote-host
service and requires separate inventory composition.

Browser execution uses the application admission gate and an original-page
scope. Navigation roots and link preferences capture the original Host object
and generation across RPC awaits. CDP initialization is shared by concurrent
callers, but every command retains its original debugger binding; stale timeout
cleanup and element uids cannot act through a replacement connection.

`BrowserHost.getHandoffActivity()` reports `operations`, `pages` and
`uncontainedResources`. Original native `loadURL` promises, queued viewport work,
CDP commands, reveal waits, link opening and console setup remain counted through
their actual settlement, including after caller timeout or page/plugin removal.
These are activity counts, not execution-capacity counts. Creating a WebContents,
hidden backing window, file watcher or external application increments bounded
refusal evidence before the attempt. Failure, ordinary destruction and debugger
detach cannot decrement it without a qualified native-family closure contract.
Deleting page maps therefore neither certifies idle nor loses unsettled work.

Temporary guest disposal invalidates old scopes while permitting later plugin
reload; permanent BrowserHost disposal seals new entry. Accepted native results
may complete their callers, but retired scopes cannot launch more commands or
write a late screenshot file. Native navigation, popup and live-reload callbacks
also recheck their owner before dispatch. The existing page partition, file/URL
rules, background routing, presentation ownership and public CDP allowlist remain
unchanged.

Plugin loading and shutdown share the same admission source. Original load
identities survive asynchronous spawn and initialization; unload/replacement
invalidates them, and permanent shutdown seals entry synchronously. Concurrent
cleanup joins its original promise, which remains counted after the caller's
shutdown budget expires. Original callbacks, workspace setup/context lookup,
MCP transport work and managed-connection operations also remain counted after
caller cancellation or owner removal. Ordinary entrypoints and broadcasts close
with admission; active teardown calls retain their original authorization.
Unknown child completion and unqualified native/network attempts remain refusal
evidence after ordinary exit, timeout or late reply. The
[plugin lifecycle contract](../07-plugins/05-plugin-lifecycle.md#idle-handoff-lifecycle-admission)
defines this accounting. Plugin sockets and workspace resource/forward leases
now join the runtime snapshot, including original HTTP reads and response/close
work after owner retirement. Shared admission is mandatory at these resource
boundaries, and missing configured resource statistics retain refusal evidence.
Plugin panel/view and shortcut owners also join that snapshot. They capture
original installations/registrations before asynchronous boundaries, retain
original page loads, bridge work and retiring pages after cache removal, and
seal native creation synchronously during shutdown. Temporary admission closure
does not discard a page's completed load state. Original page destruction,
shortcut removal and plugin child exit retain unqualified native evidence.
Other external owners and qualified native-family closure must still join before
connecting a complete inventory to the coordinator.

This composition does not enable a transfer request. Complete owner inventory,
bounded source journal transport, native/coordinator integration and target
readiness remain separate H1-H5 acceptance work.
