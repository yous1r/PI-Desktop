# 23. Remote Mirror Development

> Scope: local-primary projects mirrored to a remote Linux host, the bundled
> `pi-helper` service, environment initialization, file synchronization, and
> remote debugging.
> Status: implemented are the helper service (framing, auth, `env.verify`,
> `fs.*`, `adapter.install/probe/start/stop`), host-core mirror storage and
> `mirror.*` RPC, the per-file sync engine with baseline drift detection, mirror
> project creation, the DAP client, and remote build/run. Not implemented yet:
> the helper `watch.*` operations, the mirror initialization state machine, the
> debug UI, and the `pull` mode.
> Cross-references: [05-remote-agent-control](../02-architecture/05-remote-agent-control.md) ·
> [02-remote-control-security](../05-security/02-remote-control-security.md) ·
> [08-error-codes](08-error-codes.md) ·
> [ADR 0338](../../adr/0338-remote-mirror-development-helper.md) ·
> [ADR 0326](../../adr/0326-verified-ssh-host-installation.md) ·
> [ADR 0108](../../adr/0108-remove-built-in-interactive-terminal.md)

---

## 1. Purpose and non-goals

A mirror project keeps a **local working copy as the source of truth** and a
**remote mirror** used to build, run, and debug with the remote environment. The
local copy is what the Agent edits and what the editor plugin saves; the remote
copy is a projection.

In scope:

- creating a mirror project and initializing its remote environment;
- per-file synchronization in both directions, driven by explicit user modes;
- remote debugging through a debug adapter running on the host;
- breakpoints and synchronization state persisted locally.

Out of scope (deliberate, not deferred):

- an AI agent, model request, session, or tool relay on the remote machine;
- an interactive remote terminal or a general remote command runner;
- remote deletion, delete propagation, bidirectional merge, or `rsync`;
- Windows or macOS remote targets.

## 2. Project model

A project group gains one additive, optional binding:

```text
mirror = { hostKey: string, remotePath: string, mode: "auto" | "manual" }
```

Rules:

1. `mirror` and `remote` are mutually exclusive. A group with either binding is
   never converted into the other.
2. The group's primary root stays an ordinary local directory. The opaque
   `remote-project:<groupId>` identity is not used by mirror projects.
3. `remotePath` is display and execution data. It is never resolved as a local
   filesystem path, and the local root is never resolved on the host.
4. An absent binding means an ordinary local project; older builds ignore the
   field and keep working.

## 3. The helper service

### 3.1 Artifact and deployment

`pi-helper` is a static Rust binary built for `x86_64-unknown-linux-musl` and
`aarch64-unknown-linux-musl`, shipped in the Desktop application bundle under
`resources/pi-helper/<arch>/pi-helper` with a generated manifest carrying the
version and SHA-256.

Deployment:

1. Resolve the architecture on the host (`uname -m`) and select the matching
   bundled binary; an unsupported architecture fails before any transfer.
2. `mkdir -p "$HOME/.pi-desktop-helper"` and `chmod 700`.
3. Upload the binary with the existing SSH file transport and verify its SHA-256
   on the host. A digest mismatch deletes the partial file and fails closed.
4. Install atomically: write to a temporary name inside the helper directory,
   `chmod 750`, then rename into place.
5. Start detached (`setsid`, no controlling terminal), redirecting output to
   `logs/helper.log` inside the helper directory.

The helper directory is fixed and per-user:

```text
$HOME/.pi-desktop-helper/       0700
  env.json                      environment manifest, written atomically
  token                         0600, helper authentication secret
  bin/pi-helper                 installed binary
  adapters/<kind>/<version>/    installed adapter bundle plus its receipt
  pids/<id>.pid                 adapter pid files
  logs/helper.log               helper log, no credentials
```

The fixed name is `$HOME/.pi-desktop-helper`; the absolute path is resolved once
during initialization and recorded in `env.json`. A host-specific hard-coded
path is never embedded in the application.

### 3.2 Lifecycle

| Situation | Behavior |
|---|---|
| Initialization | Deploy (if absent or version-mismatched), start, wait for the ready line, open the forward, handshake |
| Already running, version matches | Reuse the running instance; no redeploy |
| Version mismatch | Replace the binary atomically, stop the old process, start, handshake |
| SSH drop | The helper is detached and keeps running; adapters keep running; the desktop reopens the forward and reconnects |
| Desktop upgrade | Redeploy `bin/pi-helper` and rewrite `env.json`; `adapters/` is preserved |
| Uninstall | Stop adapters, stop the helper, remove `$HOME/.pi-desktop-helper` |
| Stale pid file | `kill -0` plus executable-path check before any kill; a reused PID is never killed |

Startup contract: the helper binds `127.0.0.1:0`, then prints exactly one line

```text
PI_HELPER_READY {"port":<n>,"version":"<semver>","protocol":1}
```

and the desktop waits for it with a bounded timeout before opening the forward.
The ready line carries no secret; the token is read from the helper directory
over the same SSH channel.

### 3.3 Framing and operations

One TCP connection carries three frame types. Every frame has a 1-byte type,
a 4-byte unsigned big-endian payload length, and exactly that many payload
bytes; the header length is excluded from the payload length. Payloads are at
most 1 MiB, and control payloads are at most 64 KiB.

| Byte | Type | Payload |
|---|---|---|
| `0x01` | control | UTF-8 JSON object `{ "id": string, "op": string, ... }` |
| `0x02` | data | `streamId` (u32 big-endian) + raw bytes |
| `0x03` | end-of-stream | exactly `streamId` (u32 big-endian) |

Responses are control frames `{ "id": string, "ok": boolean, "result"?: object,
"error"?: { "code": string } }`. The first control frame must be `auth` with
the token; any other first frame, a wrong token, or a second `auth` closes the
connection. No data operation is accepted before its operation has opened a
stream.

Operation set (v1):

| Operation | Purpose |
|---|---|
| `auth` | Token authentication |
| `version` | Protocol and helper version handshake |
| `health` | Liveness, disk space, writable helper root |
| `env.verify` | Directory, permissions, toolchains, disk budget |
| `fs.stat` | Batch `{path, size, mtimeMs, mode}` |
| `fs.hash` | SHA-256 of one file |
| `fs.mkdirs` | Batch directory creation |
| `fs.put.begin` / `fs.put.chunk` / `fs.put.end` | Per-file upload, atomic replace |
| `fs.get.begin` / `fs.get.chunk` / `fs.get.end` | Per-file download |
| `watch.start` / `watch.stop` | Project-root change notification |
| `adapter.install` | Install a manifest-pinned adapter |
| `adapter.probe` | Report the installed adapter version |
| `adapter.start` / `adapter.stop` | Adapter process supervision |

Implemented today: `auth`, `version`, `health`, `env.verify`, `fs.stat`, `fs.hash`, `fs.mkdirs`, `fs.put.*`, `fs.get.*`, `adapter.install`, `adapter.probe`, `adapter.start`, and `adapter.stop`. `watch.start` and `watch.stop` are not implemented and report `HELPER_OPERATION_UNAVAILABLE`; the desktop compares against its baseline instead of subscribing. Any other operation is reserved.

Not present in the protocol: shell execution, arbitrary argv, archive
extraction, recursive delete, file move across project roots, and any operation
that accepts a path outside the allowlist.

Every operation is bounded: a per-request deadline, a maximum frame size, a
maximum concurrent stream count, and a maximum request rate.

## 4. Environment initialization

Initialization runs as a blocking step of creating a mirror project. It is
idempotent and resumable, and each step records a receipt.

| # | Step | Passes when | Failure code |
|---|---|---|---|
| 1 | SSH reachability and host key | One `exec` returns 0 | `REMOTE_CONNECTION_FAILED` |
| 2 | Helper root | Directory exists, `0700`, writable, at least 500 MB free | `HELPER_DIR_UNWRITABLE` |
| 3 | Helper deployment | Binary installed and digest verified | `HELPER_DEPLOY_FAILED` |
| 4 | Helper start and handshake | Ready line received, `version` matches, forward open | `HELPER_START_FAILED` |
| 5 | `env.verify` | Directory, permissions, disk, toolchains reported | `MIRROR_INIT_FAILED` |
| 6 | Adapter installation | The pinned bundle installs and its digest matches the manifest | `DEBUG_ADAPTER_INSTALL_FAILED` |
| 7 | Adapter probe | Installed version equals the manifest version | `DEBUG_ADAPTER_VERSION_MISMATCH` |
| 8 | Forward self-test | One loopback forward connects and closes | `REMOTE_FORWARD_FAILED` |
| 9 | Local environment | Project registered, `workspace.get` returns the local root, local toolchain usable | `MIRROR_INIT_FAILED` |
| 10 | Manifest and baseline | `env.json` written atomically; baseline scan stored in host-core | `MIRROR_INIT_FAILED` |

Step 9 checks the **local** environment only. Mirror projects have no remote
Agent, so there is nothing remote to verify for the Agent.

Project states: `needs-init` → `initializing` → `ready`, plus `init-failed` with
the failed step and reason. Only `ready` permits synchronization or debugging.
A failed initialization never writes a partial `env.json`; a retry skips steps
whose receipts are still valid.

## 5. Debug adapter manifest

The Desktop bundle carries a versioned manifest together with the adapter
payloads it names. The manifest is the only source of adapter identity, version,
digest and install eligibility. The helper is the only component that decides
how an installed adapter is started.

```json
{
  "schemaVersion": 2,
  "adapters": [
    {
      "id": "python-debugpy",
      "kind": "python-debugpy",
      "version": "1.8.5",
      "sha256": "<64 hex characters>",
      "bundle": "resources/pi-helper/adapters/python-debugpy-1.8.5",
      "hosts": ["x86_64-unknown-linux-musl"]
    }
  ]
}
```

Rules:

1. Installation is a byte stream from the Desktop bundle to the helper
   (`adapter.install`). Nothing is fetched from PyPI, a Go module proxy or any
   other network location, and no shell command runs on the host.
2. The payload is a single opaque executable file. The helper never extracts an
   archive, never interprets the payload's contents, and never accepts a target
   path from the caller: the request path must be exactly
   `adapters/<kind>/<version>`.
3. The helper verifies the streamed bytes against the manifest `sha256` before
   anything durable is written. A mismatch removes the staging file and reports
   `DEBUG_ADAPTER_INSTALL_FAILED`. A verified install lands atomically in the
   install directory `adapters/<kind>/<version>/`, and its receipt is written
   last.
4. The launch argv belongs to the helper's kind allowlist, not to the manifest.
   `python-debugpy` launches as `<bundle> --listen 127.0.0.1:<port>`. Adding a
   kind is a code change plus a manifest entry, never a configuration edit.
5. `adapter.probe` reports the installed version, digest and install time, and
   reports the adapter as absent when a directory has no receipt. Asking for a
   version that is absent, or whose digest differs from the manifest, is
   `DEBUG_ADAPTER_VERSION_MISMATCH`; there is no silent upgrade.
6. Several versions of one kind may be installed side by side. A request without
   an explicit version resolves to the most recently installed receipt.
7. A host without a pinned payload for its target does not offer that adapter.
   The manifest `hosts` list is authoritative, and an unsupported target is a
   reported initialization gap rather than a silent skip.

## 6. File synchronization

### 6.1 Modes

| Mode | Behavior |
|---|---|
| `auto` | Local changes upload automatically after a debounce and coalescing window |
| `manual` | Upload runs only on explicit user action |
| `pull` | Explicit user action copies remote content into the local root |

`pull` is available regardless of the upload mode. There is no bidirectional
mode, no automatic merge, and no remote deletion in any mode.

### 6.2 Baseline and drift

The baseline stores `(relativePath, size, mtimeMs, sha256)` per project in
host-core. Before a file is uploaded:

1. `fs.stat` the remote file (batched with siblings);
2. compare it with the baseline entry;
3. if the remote `(size, mtimeMs)` changed since the baseline, the file is a
   **conflict**, not a silent overwrite.

A conflict is always resolved by the user: keep local, keep remote, or skip.
Nothing is resolved automatically, and no conflict decision is remembered for
other files.

A failed transfer is never retried automatically. It is reported as an uncertain
outcome that requires inspection, consistent with the existing
`REMOTE_MUTATION_OUTCOME_UNKNOWN` semantics for remote mutations.

### 6.3 Exclusions and caps

Default exclusions (each individually visible and disableable in the UI):

| Group | Paths |
|---|---|
| Python | `.venv`, `venv`, `__pycache__`, `*.pyc`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox`, `*.egg-info` |
| Node | `node_modules`, `dist`, `build`, `.next`, `.nuxt`, `.turbo`, `.cache`, `coverage` |
| Rust / Go | `target`, `bin` (`vendor` stays: it is source) |
| JVM | `build`, `.gradle`, `target` |
| Always | `.git`, `.DS_Store`, `*.log`, `tmp`, `temp` |

Project configuration adds `.pi-desktopignore` patterns and per-project
`include` exceptions, because `build/` and `bin/` are source directories in some
projects. A first-sync preview lists included and excluded counts and lets the
user adjust them before any transfer.

Per-file ceiling: **50 MB**, enforced on both sides. A larger file is skipped,
listed in an "over limit" section, and never blocks other files.

### 6.4 Transfer guarantees

- One connection serves every file; a batch of uploads uses one round trip per
  batch rather than one connection per file.
- Writes are atomic: content goes to a sibling `<name>.<nonce>.pi-part` staged
  with an exclusive create, then rename over the target. A crash leaves either
  the old file or the new one, and a staging path another request already owns
  is never reused.
- Bytes are copied verbatim: no newline translation. The target keeps its
  existing permissions, so an executable script stays executable.
- A batch whose reply would not fit one control frame is refused with
  `INVALID_ARGUMENT` before any directory is created, rather than dropping the
  connection after the work was done.
- Transfers are cancellable; cancellation leaves no partial target file.

## 7. Debug sessions

### 7.1 Topology

```text
Renderer (Debug view)
   │ typed IPC events
Electron Main (DAP client)
   │ 127.0.0.1:<forwarded>
   ▼
ssh -L  ─────────────────▶  pi-helper (host)
                              └─ adapter process on 127.0.0.1:<adapterPort>
```

The helper allocates the adapter port, starts the adapter, and reports
`{port, pid}`. The desktop opens the forward for that port and connects a DAP
client to the local end. The adapter is bound to loopback on the host and is
never exposed publicly.

### 7.2 Path mapping and breakpoints

- The session carries `pathMappings: [{localRoot, remoteRoot}]`. Stack-frame
  `source.path` values are translated back to local paths for display and file
  opening.
- A frame whose path has no mapping is shown read-only as a remote source.
- Breakpoints are stored in host-core per `(projectId, relativePath, line,
  column, condition, enabled)`. The editor plugin renders the gutter from those
  records and toggles them through the host; it never holds the authoritative
  set.
- On session start the desktop sends the breakpoint set translated to remote
  paths. Breakpoint additions and removals during a session are sent as
  incremental updates.

### 7.3 Failure handling

| Failure | Behavior |
|---|---|
| Adapter missing or version mismatch | Session refuses to start; typed error with the install command |
| Forward failure | `REMOTE_FORWARD_FAILED`; session does not start |
| SSH drop | The adapter keeps running; the desktop reopens the forward and reconnects; if the adapter exited, the session is reported as terminated, never silently restarted |
| Adapter crash | Reported with its exit status and the tail of its log; no automatic relaunch |
| Cancellation | Desktop stops the adapter through the helper and closes the forward |

## 8. Persistence

New durable state, owned by Rust host-core:

| Data | Shape |
|---|---|
| Mirror binding | Additive optional field on the project group record |
| Sync baseline | Per project and relative path: size, mtime, sha256, syncedAt |
| Breakpoints | Per project, file, line: condition, enabled |
| Initialization receipts | Per project and step: version, completedAt |
| Adapter install receipts | Per host and adapter: version, installedAt |

Schema v28 adds the baseline and breakpoint storage with upgrade
compatibility and migration tests. The project-group binding is additive and
backward compatible; a build without mirror support ignores it.

## 9. Error codes

| Code | Retriable | Meaning |
|---|---|---|
| `HELPER_DEPLOY_FAILED` | yes | The helper binary could not be installed or its digest did not match |
| `HELPER_DIR_UNWRITABLE` | no | The helper directory is missing, not writable, or below the disk budget |
| `HELPER_START_FAILED` | yes | The helper did not print a ready line or the handshake failed |
| `HELPER_VERSION_MISMATCH` | yes | The running helper version differs from the desktop; redeployment is required |
| `HELPER_PROTOCOL_ERROR` | no | An invalid frame, an unauthenticated request, or an unknown operation |
| `HELPER_OPERATION_UNAVAILABLE` | no | the helper build does not implement the requested protocol operation |
| `HELPER_AUTH_FAILED` | no | the helper rejected its token or received an unauthenticated operation |
| `HELPER_INTERNAL_ERROR` | yes | an unexpected helper filesystem or runtime failure; sensitive diagnostics are not returned |
| `MIRROR_INIT_FAILED` | yes | A non-transfer initialization step failed; `details.step` names it |
| `MIRROR_CONFLICT` | no | The remote file changed since the baseline; a user decision is required |
| `MIRROR_FILE_TOO_LARGE` | no | The file exceeds the 50 MB ceiling and was skipped |
| `REMOTE_TRANSFER_FAILED` | yes | A per-file transfer failed; the target file is unchanged |
| `REMOTE_PATH_ESCAPE` | no | A path resolved outside the permitted roots |
| `DEBUG_ADAPTER_INSTALL_FAILED` | yes | The bundled adapter payload failed digest verification or the install could not complete |
| `DEBUG_ADAPTER_VERSION_MISMATCH` | no | The installed adapter version differs from the pinned manifest |
| `DEBUG_SESSION_DISCONNECTED` | yes | The debug transport dropped; the session state is preserved |

Existing codes are reused where they already fit: `REMOTE_CONNECTION_FAILED`,
`REMOTE_AUTH_FAILED`, `REMOTE_FORWARD_FAILED`, `REMOTE_PATH_NOT_FOUND`.

## 10. Security boundaries

1. The helper binary is release content: bundled, digest-verified before
   execution, version-bound. Model-generated or user-supplied code never runs on
   the host through this path.
2. Loopback-only listener, `0600` token, no public bind, no stdio RPC, no
   systemd unit, no elevation.
3. Path allowlist: registered mirror roots plus the helper root. A project root
   that overlaps the helper directory is refused at startup, and any resolution
   that lands inside the helper directory from another root is refused, so the
   token and the installed binary stay unreachable even through a symlink. `..`,
   symlink, and junction escapes are refused after `realpath`.
4. Credential-shaped paths (`.env`, `.env.*`, `.ssh/`, `*.pem`, `*.key`) are
   refused in both directions.
5. No shell and no arbitrary argv: adapter commands come from the bundled
   manifest; every other operation takes structured data.
6. No delete operation exists in the protocol, so a misdirected client cannot
   remove remote files. An upload may remove only the staging file it created
   itself, which is named with a random nonce and opened with an exclusive
   create, so a pre-existing file or symlink at a staging path is neither
   truncated nor written through.
7. Tokens, SSH diagnostics, and remote stderr never reach the renderer, logs, or
   error payloads.
8. Remote commands are subject to the same local permission policy as any other
   remote operation; being remote never widens authority.

## 11. Validation

| Level | Coverage |
|---|---|
| Rust unit | Framing, token auth, path containment (including symlink escape), atomic write, 50 MB boundary, pid-file validation, manifest digest and kind-allowlist rejection |
| Rust contract | In-process client against the full operation set, including malformed frames, half-frames, and cancellation |
| Electron unit | Helper client reconnect, timeout, and error mapping against a fake helper |
| Electron unit (remote run) | Path and command validation, ordered stdout and stderr, the 1 MiB output cap with truncation, single-settle cancellation, the one-run-per-project rule, and transport errors that leak nothing |
| Integration | Deploy, handshake, upload, download, and adapter start over loopback with no real SSH |
| Qualification gate | Real Linux x64 and aarch64 hosts over SSH: deployment, detached survival across an SSH drop, adapter install, debug session, baseline accuracy. Mocked boundaries do not satisfy this gate |

## 12. Remote build and run

A mirror project can run one explicit build or run command on the host inside
the remote mirror directory. This is not a general remote shell: the command and
its working directory are the only inputs, and both are validated first.

1. The working directory is always the project's `remotePath`. A value that is
   not an absolute POSIX path, or that contains `..`, `//`, a backslash or a
   control character, is refused with `REMOTE_PATH_ESCAPE`.
2. The command is one user-configured string of at most 4096 characters without
   control characters. It runs through the same remote execution mode the app
   already uses for host commands, so quoting has exactly one implementation.
3. At most one live run per project. A second start is refused with `CONFLICT`
   rather than queued, so two builds never interleave in one mirror directory.
4. Output is streamed as ordered stdout and stderr chunks, decoded per stream so
   a multi-byte character split across chunks survives. Unconsumed output is
   capped at 1 MiB; past the cap the run keeps executing but its remaining
   output is dropped and the outcome is marked truncated, while the byte count
   still reports everything the host wrote.
5. Cancelling terminates the remote process and settles the handle exactly once.
   Disposal on shutdown cancels every live run and refuses new starts with
   `HOST_SHUTTING_DOWN`.
6. A transport failure surfaces a typed error with a fixed message: neither the
   command line nor any credential reaches the error text.
7. Nothing is written to the local root. The local copy stays the source of
   truth, and a build never mutates it.
8. Files a build writes on the host — `dist`, `build`, `target`, and anything
   else the local exclusion rules already ignore — are never pulled back and
   never removed by the application. Host-side build output belongs to the user,
   so a mirror directory can hold artifacts the local copy does not.
