# ADR: Authenticated local owner discovery on Windows

- Status: Implemented candidate; Windows protocol and real CLI validation passed
- Context: [Idle handoff design](../project/ai-command-center-idle-handoff.md)
- Scope: S03b-1 owner discovery, not execution transfer

## Context

A data-directory lock prevents a cooperating second Rust writer but does not
identify a live owner to a future handoff client. The headless admin channel is
Unix-only. A Windows local binding must not expose arbitrary Host RPC, accept a
claimed PID/SID as authority, or confuse an unavailable owner with permission to
start another executor.

## Decision

Add opt-in `--owner-control` to the Rust Host and standalone
`--owner-status [expected-owner-epoch]` query mode. Query resolves
`PI_DESKTOP_DATA_DIR` through the ordinary bootstrap path but does not create a
directory, open AppState or start recovery. Normal launches without the flag
keep their existing behavior.

The pipe name hashes the current Windows token SID and directory volume/file
identity. Junctions resolve to the same identity. Use a protected DACL granting
only that SID, non-inheritable handles, first-instance ownership and remote-client
rejection. Authenticate both pipe peers using kernel-provided process IDs, query
handles, token SID, original process creation time and canonical image path.
The first slice requires the same Host executable path on both sides; Node and
other same-user executables are refused. A privileged actor or same-user code
that can replace/inject the trusted executable remains outside this boundary.

The server signals readiness before request transmission. Only connection setup
may retry a pipe that is busy/closing, within the overall deadline; no request is
replayed after transmission. Frames are little-endian u32 length + strict UTF-8
JSON, nonempty and at most 16 KiB. The caller acknowledges response consumption.
The listener owns a bounded exchange with a two-second deadline and closes on
Host shutdown. Invalid clients cannot create unbounded tasks or retained state.

Version 1 advertises only `status`: request ID, optional expected owner epoch,
and response metadata with a fresh process epoch, opaque profile ID, PID and
creation FILETIME. FILETIME is a decimal string for exact JavaScript transport.
Unknown fields/operations are rejected; stale epochs and unsupported versions
return classified failures. Rust and shared TypeScript validate golden fixtures.

## Alternatives

- Loopback TCP adds discovery and credential lifecycle without a first-slice need.
- Reusing the Unix socket implementation assumes permissions Windows does not
  provide through that API.
- A PID marker cannot authenticate a peer and is vulnerable to stale identity.
- Publishing mutation operations before fencing/journaling would claim a safety
  guarantee the implementation does not yet provide.

## Consequences

This is additive and opt-in: no schema migration, session relocation, permission
change, service installation or automatic execution occurs. An opted-in Host
fails visibly if its control listener fails. Other platforms explicitly refuse
the new modes until their bindings are qualified. Existing stdio RPC remains the
internal execution interface. No transfer readiness is inferred from discovery.

Tests cover native pipe lifecycle, duplicate owners, aliases, framing limits,
stale epochs, restricted-token ACL refusal, counterfeit executables, normal/crash
cleanup and shared wire fixtures. A separate-account login, remote Windows
network transport and full handoff remain separate qualification boundaries.
