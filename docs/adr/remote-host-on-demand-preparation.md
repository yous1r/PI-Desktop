# ADR: On-demand remote Host preparation

- Status: Accepted
- Supersedes: the automatic reinstall/re-pair policy in [ADR 0327](0327-remote-host-version-realignment.md) and the remote-first download choice in [ADR 0326](0326-verified-ssh-host-installation.md)
- Related: [global proxy policy](0177-user-configurable-outbound-proxy.md), [remote architecture](../spec/02-architecture/05-remote-agent-control.md#52-remote-host-over-an-ssh-tunnel-first-remote-topology)

## Context

A Desktop update can leave an enrolled SSH Host behind. Asking the user to remove
and pair it again loses the useful distinction between version preparation and
identity enrollment. Remote release access is also unreliable when the user's
working proxy listens only on the Desktop machine's loopback interface.

A remote Host may serve several Desktop clients and own active turns, workspace
processes, terminals, plans and plugin resources. Restarting it merely because a
client starts is unsafe. Replacing binaries cannot prove that a database already
opened by a newer release can be reopened by an older one.

## Decision

Use the existing Host readiness facade as the entry point for explicit remote
project use. Passive startup and host-list refresh may reconnect installed Hosts
but never install or upgrade them. The first download requires a visible action;
subsequent upgrades reuse that Host's saved download consent. Each attempt still
checks the live Host's exact normalized release, enrolled identity and required
workspace capabilities. A previous success is not a permanent exemption.

Download both the checksum and archive on Desktop after the current global
System / Direct / Custom proxy application completes. Electron's network stack
provides the existing HTTP, SOCKS5, authenticated-proxy and system/PAC behavior.
Verify locally, upload over authenticated SSH, then verify remotely. There is no
per-Host proxy setting, reverse proxy tunnel or remote-download fallback. Release
selection uses the client's exact version and published Linux architecture,
including prerelease identifiers; unavailable releases fail explicitly.

Retain verified archives in Desktop's private `cache/pi-host` directory, keyed
by exact release and platform URL and addressed by SHA-256. Rehash a cache hit
before upload; it performs no checksum/archive request and survives Host removal
and Desktop restart. Keep at most eight release entries and 1 GiB of archives.
Invalid or incomplete entries are discarded and fetched through the same proxy
policy. A lease prevents eviction while an upload is using the archive.

Share one preparation job per Host with independently cancellable caller IDs.
Cancelling a view removes only its waiter. The last waiter aborts pending local
work and SSH observation. A detached deployment that has entered its remote
transaction finishes or records recovery state within a bounded lifetime; local
cancellation never promises rollback. Late results cannot open an abandoned
project. A failed mutation is never replayed, nor routed to local execution.

Preserve the Host ID, enrolled device token, SSH credentials and data directory.
Authenticate an existing running Host before upgrade and verify it again over
RACP before completing preparation. New pairing is restricted to initial
enrollment. Direct-URL hosts and unusable SSH credentials are not taken over.
Newer remote releases, stable-to-prerelease changes, different prerelease tracks
and ambiguous version ordering are not automatically replaced. An older
prerelease may advance to a newer stable Desktop release, including
`0.22.1-beta.6` to `0.22.2`.

Stage and verify the candidate before activation. The remote owner-only
maintenance interface admits deployment only while the Host is idle, then fences
new work for a short lease. Clients and active work make the Host busy; the
Desktop closes its own connection before acquiring the lease. Legacy Hosts
without maintenance admission require explicit confirmation of an idle
maintenance window. No timeout escalates to forced process termination.

The deployment journal distinguishes safe pre-activation failure from a failure
after new code may have opened persistent data. The latter requires recovery;
automatically repointing `current` does not authorize a database downgrade.

Deployment control workers are carried by the Desktop transaction script and
are independent of similarly named files in a published Host archive. The
archive remains authenticated by its published SHA-256 and supplies the Host
runtime/install files; the Desktop worker supplies orchestration and recovery.
An interrupted post-start transaction may resume only when its transaction id,
archive digest, installed directory, process, Host ID, version evidence and
owner credentials all match. An expired pairing may be reissued only after an
idle maintenance lease; recovery returns to the authenticated completion
boundary and never clears the journal early. A busy or ambiguous Host remains
in recovery-required.

## Consequences

Preparation is visible as phases with explicit download, maintenance, retry and
cancel actions. Failed attempts have a ten-minute cooldown; explicit retry can
bypass it. Error categories remain actionable without exposing SSH diagnostics
or proxy credentials. Installation needs local bandwidth and temporary disk
space, but remote internet access is unnecessary.

Publishing a Desktop now requires matching versioned Host artifacts for both
Linux architectures, their SHA-256 sidecars and aligned updater-feed versions.
The release gates validate those properties before publication. Local fixture
results remain distinct from real Linux SSH release acceptance.
