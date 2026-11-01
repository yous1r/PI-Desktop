# ADR 0339: The remote bundle comes from the repository that builds the desktop

- Status: Accepted
- Date: 2026-11-01
- Deciders: PI-Desktop maintainers
- Amends: [ADR 0326](0326-verified-ssh-host-installation.md) decision 2 — where
  the published bundle is resolved
- Related: [ADR 0338](0338-static-host-core-for-remote-bundles.md) ·
  [ADR 0289](0289-signed-macos-github-releases.md) ·
  [02-architecture/05-remote-agent-control](../spec/02-architecture/05-remote-agent-control.md) ·
  [06-delivery/06-release-runbook](../spec/06-delivery/06-release-runbook.md)

## Context

The SSH bootstrap derives the `pi-host` bundle URL from the desktop's own
version and a fixed repository. That repository was `vastsa/PI-Desktop`, while
the desktop that carries the static host-core of ADR 0338 is built and released
from `yous1r/PI-Desktop`. A build from that repository at version `0.21.0`
therefore installed the upstream `pi-host-0.21.0-linux-x64.tar.gz`: its
host-core is dynamically linked (interpreter `/lib64/ld-linux-x86-64.so.2`,
`GLIBC_2.34` symbols), not the static binary this repository ships. On an older
glibc the remote failed exactly as ADR 0338 describes:

```
{"level":"error","channel":"pi-host","message":"host-core exited unexpectedly"}
Error: write EPIPE
```

The installed directory name `sha256-f301290e…` matched the `SHA256SUMS` digest
of that upstream archive, so the bundle verified correctly: it was simply the
wrong release.

That repository also published no Release at all. Its tag builds require the
official Developer ID secrets (ADR 0289), which only `vastsa/PI-Desktop` holds;
the failing macOS rows failed `build`, so `publish` never ran and the static
bundles never reached a release.

## Decision

1. `PI_HOST_RELEASE_REPO` in `pi-host-release.ts` names the repository whose
   GitHub Release publishes the bundles: `yous1r/PI-Desktop`, the repository
   that builds this desktop. The tarball and `.sha256` URLs are derived from it
   and the desktop version exactly as before. `GITHUB_REPO` keeps naming the
   feedback issue tracker; the two are separate concerns.
2. On any repository other than `vastsa/PI-Desktop`, a tag build skips its
   macOS rows instead of failing them. `MACOS_LANE_ENABLED` is a job
   environment value because GitHub rejects a job-level `if` that reads
   `matrix`; every macOS step, package-input preparation and the artifact
   upload check it. Windows, Linux, both static host-core lanes and both
   `pi-host` bundles still run, and `publish` still waits for all of them. The
   macOS feed merge runs only on `vastsa/PI-Desktop`.
3. The official repository keeps the ADR 0289 contract unchanged: its tag
   builds sign and notarize macOS, and missing secrets still fail the job. A
   manual run on any repository still builds unsigned macOS debug artifacts.

## Consequences

- A desktop built here installs the static bundle released beside it, so a
  remote host on an older glibc starts as ADR 0338 intends. The release must
  exist before the desktop is used for SSH setup: the URL is still derived from
  the version, without an API call.
- This repository's releases carry no macOS installer or feed. macOS users of
  this distribution keep using unsigned debug builds from a manual run.
- The desktop's auto-update feed and its release-notes link still name
  `vastsa/PI-Desktop` (`apps/desktop/package.json` `build.publish`, updater
  `RELEASES_URL`). Pointing them at this repository is a separate decision.
- Bootstrap reuse is unchanged: the `.release.sha256` receipt pins the archive
  digest, so a host that installed the upstream archive is reinstalled when the
  desktop resolves this repository's different digest.
