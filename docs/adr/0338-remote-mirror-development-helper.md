# ADR 0338: Remote mirror development through a bundled helper service

- Status: M0 helper skeleton and the file data plane implemented; project UI,
  watcher, adapter lifecycle, and DAP remain unimplemented (spec 23).
- Date: 2026-10-28
- Deciders: PI-Desktop maintainers (user-authorized remote mirror development plan)
- Related: [ADR 0326](0326-verified-ssh-host-installation.md) ·
  [ADR 0292](0292-ssh-remote-host-bootstrap.md) ·
  [ADR 0293](0293-ssh-password-authentication.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [local-agent-remote-workspace-tools](local-agent-remote-workspace-tools.md) ·
  [05-remote-agent-control](../spec/02-architecture/05-remote-agent-control.md) ·
  [02-remote-control-security](../spec/05-security/02-remote-control-security.md) ·
  [23-remote-mirror-development](../spec/03-runtime/23-remote-mirror-development.md)

## Context

Remote projects today follow the VS Code Remote-SSH model: the source tree exists
only on the remote machine, the project group carries a `{hostKey, path}` binding
whose primary root is an opaque `remote-project:<groupId>` identity, and the
locally owned Agent relays admitted workspace tools to the paired `pi-host` over
RACP-WS. There is no local copy, so the user cannot edit with local tooling and
cannot keep a second, authoritative checkout.

Users asked for the PyCharm model instead: a local working copy that stays the
source of truth, a remote mirror that is kept up to date, and debugging through a
debug server that runs on the remote machine. The requirements recorded for this
work are:

- per-file transfer over a reused connection, never an archive or bundle;
- one fixed helper directory holding everything mirror development needs;
- environment initialization as part of creating a mirror project, covering both
  the Agent environment and the remote debug environment, including debugger
  download;
- debug adapters pinned by a manifest recorded on the local machine and installed
  by remote execution;
- manual conflict handling only;
- a 50 MB per-file ceiling;
- breakpoints persisted in Rust host-core;
- no bidirectional synchronization, no remote deletion, and no general
  non-interactive remote execution surface;
- no AI agent on the remote machine.

The remote side still needs a real, controllable service: file transfer with
containment, change notification, and debug-adapter supervision cannot be
expressed as one-shot shell invocations without either a fragile prompt protocol
or an unbounded command channel.

## Decision

1. **Add a mirror project source.** A mirror project keeps an ordinary local
   primary root and adds an additive `mirror {hostKey, remotePath, mode}`
   binding. It is mutually exclusive with the existing `remote` binding: a group
   is either remote-owned (files live on the host) or mirror-owned (files live
   locally and are copied). Neither binding is inferred from the other, and no
   existing project is converted.

2. **Ship a helper service, `pi-helper`.** A static Rust binary built for
   `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`, bundled with the
   Desktop application, uploaded from the application bundle over the existing
   system-`ssh` transport, SHA-256 verified before execution, and installed under
   the fixed per-user directory `$HOME/.pi-desktop-helper`. The binary version is
   bound to the Desktop version; a mismatch redeploys the binary from the bundle.

3. **Reach the helper the same way `pi-host` is reached.** The helper binds
   loopback only, prints a single ready line carrying its port, authenticates
   with a `0600` token file inside the helper directory, and is consumed through
   an SSH loopback port forward. No public listener, no SSH stdio RPC, no systemd
   unit, and no elevated privileges. This keeps ADR 0326 §1 intact.

4. **The helper owns both the control plane and the data plane.** It exposes
   environment verification, per-file `put`/`get`, `stat`, `hash`, `mkdir`, file
   change events, and debug-adapter `install`/`probe`/`start`/`stop`. It exposes
   no shell, no arbitrary argv, no archive extraction, and no delete operation.
   Every frame has a one-byte type, a four-byte big-endian payload length, and a bounded payload; file bytes stream on a dedicated data frame rather than being encoded.

5. **Initialization is a blocking, idempotent, resumable step of creating a
   mirror project.** A project that has not completed initialization is
   `needs-init` and cannot synchronize or debug. Each completed step leaves a
   receipt so a retry does not repeat downloads, and a failure never leaves a
   partial manifest.

6. **Debug adapters are pinned locally and installed remotely.** A
   Desktop-bundled manifest fixes the adapter version for each supported
   language; the helper installs into an isolated virtual environment or `GOBIN`
   inside the helper directory. A version mismatch is a typed error, never a
   silent upgrade, and no adapter binary is uploaded from the local machine.

7. **Synchronization is upload plus explicit pull.** `auto` and `manual` upload
   modes push local changes; `pull` copies remote content back on explicit user
   action. There is no bidirectional mode, no merge, and no `rsync` dependency.
   Divergence is detected against a per-file baseline and resolved manually.

8. **Durable state stays in Rust host-core.** The synchronization baseline and
   the breakpoint set are persisted there; the renderer and the editor plugin
   hold no authoritative copy.

## Non-goals

- An AI agent, model request, session, or tool relay on the remote machine for
  mirror projects.
- An interactive remote terminal or any general non-interactive remote command
  surface (ADR 0108 stands).
- Remote file deletion, including delete propagation for local renames/removals.
- Bidirectional synchronization, `rsync`, or automatic conflict resolution.
- Windows or macOS remote targets.
- Model-generated code or scripts executing on the remote machine.

## Alternatives

- **Archive/bundle transfer.** Rejected: the requirement is direct per-file push
  over a reused connection, and a bundle gives coarse failure granularity and
  re-transfers unchanged files.
- **SFTP batch channel as the data plane.** Rejected as the primary mechanism: a
  long-lived SFTP session must be framed by prompt parsing, which is the most
  fragile part of the design. A helper is required anyway for adapters and
  events, so one protocol carries both planes.
- **stdio JSON-RPC over a single SSH session.** Rejected: ADR 0326 §1 forbids
  introducing SSH stdio RPC. The loopback-plus-forward topology is already
  accepted and already operated for `pi-host`.
- **Reuse `pi-host`/RACP for mirror projects.** Rejected: mirror projects have no
  remote Agent, no model, and no remote session. Mixing ownership would give one
  service two unrelated authority models.
- **Require `rsync`.** Rejected together with bidirectional synchronization; it
  would add a second toolchain requirement and a Windows-local gap.
- **Install adapters globally on the host.** Rejected: it pollutes the user's
  environment and makes uninstall impossible. The helper directory is removable.
- **Upload adapter binaries from the local machine.** Rejected: cross-platform
  artifacts and a second distribution channel; remote installation of a pinned
  version keeps one source of truth.

## Trust and compatibility

The helper binary is release content, not user or model content: it is bundled,
digest-verified before execution, and version-bound. The helper directory is
`0700`, the token is `0600`, the listener is loopback, and the token never
appears in a URL, log, or error payload. Every path is resolved against an
allowlist of registered mirror roots and the helper root, with `..` and symlink
escapes refused, and credential-shaped paths (`.env*`, `.ssh/`, `*.pem`, `*.key`)
denied. The helper never executes a shell string; adapter launches come from the
bundled manifest only.

Existing remote projects, `pi-host` pairing, RACP, and their persisted data are
unchanged. A build that does not know the `mirror` binding ignores it. The
synchronization baseline and breakpoint tables arrive in storage schema v28,
with upgrade compatibility and migration tests; no existing row is rewritten.

## Consequences

- A new build and packaging artifact per Linux architecture, including musl
  static linking and its dependency constraints.
- Helper and Desktop versions move together; a Desktop upgrade redeploys the
  binary on first connection to each host.
- Qualification needs a real Linux host. Loopback-only behavior, process
  detachment, and musl binaries cannot be accepted on a mocked boundary.
- Two remote services now exist with different purposes: `pi-host` serves remote
  Agent workspaces over RACP; `pi-helper` serves mirror development. Names, logs,
  specs, and UI copy must keep them distinct.
- Removing `$HOME/.pi-desktop-helper` removes the entire remote mirror
  environment, which is the intended uninstall story.
- Known accepted cost: because remote deletion is out of scope, a local rename or
  deletion leaves a stale remote file that the UI reports but never removes.
