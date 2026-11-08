# ADR: Hold data-directory ownership before Host recovery

- Status: Implemented candidate for the S03 ownership foundation; integration gates and full service handoff remain pending
- Context: [command-center Host parity and handoff](../project/ai-command-center-host-parity.md)

## Context

The Desktop and headless Host share Rust persistence but could start two Rust
processes against one data directory. Both completed a handshake in the isolated
reproduction. SQLite serializes transactions, not execution ownership: a second
boot can run recovery that aborts the first owner's live turn before serving its
own requests. The headless Unix admin lock does not protect all startup paths,
and is not composed on Windows.

## Decision

Acquire a nonblocking OS lock on the stable `host-core.lock` file immediately
after creating the data directory and before opening AppState, schema migration,
turn recovery, scratch sweep or worktree reconciliation. Keep its file handle
alive outside the Tokio runtime so background/blocking tasks finish before
ownership releases. The offline relocation path acquires the same lock on its
destination before rewriting any metadata.

Use the standard library file-lock API with the existing stable Rust toolchain;
no new dependency, database schema or RPC field is introduced. The lock file is
not a PID lease and is never truncated or unlinked by an owner/contender. The OS
releases ownership when the handle closes or the process terminates. Existing
unlocked files, including a copied lock file in a profile copy, do not block
startup. Reject symlink/reparse-point and non-regular lock files; Windows denies
lock-file deletion while its handle is open.

A contention failure exits before initialization and emits the exact native
`HOST_DATA_DIR_IN_USE` marker. Shared HostProcess recognizes it only before a
successful handshake and returns a typed boot error with guidance to close the
existing owner. Existing bounded supervisor policy remains; no new retry,
forced takeover, lock-file deletion or model replay is added.

## Alternatives

- PID files with stale-file deletion are vulnerable to PID reuse and replace the
  lock inode during concurrent starts. They are not the authority.
- SQLite busy timeouts protect transactions but allow a second recovery sweep.
- Electron's single-instance lock or pi-host's Unix admin lock alone do not cover
  every cooperating Rust startup and offline relocation destination.
- A global machine lock would prevent independent data directories from running.

## Consequences and limits

Only cooperating new binaries enforce the lock. An older Host that ignores it
must be stopped before starting the protected candidate. This is a local
filesystem primitive, not a remote lease or protection against a privileged user
replacing directories/lock files. Filesystems that cannot provide a lock fail
closed; network-filesystem lease semantics are not qualified by Windows tests.

Source-profile relocation retains its existing offline/copy verification
precondition; only destination mutation is guarded here. Internal stateless tool
runner mode does not open AppState and does not claim ownership. Existing
transcripts, schema and restart recovery are unchanged.

This does not fence an orphan sidecar or implement Desktop-to-service transfer,
owner epochs, automatic reattachment or Windows service installation. S03 must
still prove those boundaries before advertising independent execution handoff.

## Verification

`test:e2e:host-data-owner` exercises the production HostProcess and real Rust
processes in fresh scratch directories: same-directory refusal before recovery,
independent directories, path aliases, occupied relocation, graceful release with
history preservation, forced termination recovery and simultaneous startup.
Rust tests cover lock lifetime, retained lock-file contents, invalid file type
and relocation refusal before mutation; Unix-specific link/FIFO tests run on Unix.
Transport tests distinguish exact boot refusal from ordinary post-handshake exit.
