# Offline SSH re-enrollment validation

Base: `4bc352996816c20254598928a4397ec1ee27603d`.
Candidate: the commit containing this report on `fix/fnos-offline-reenrollment`.

## Reproduction

An intact pi-host 0.21.0 installation had exited because its host-core supports
schema 24 while the existing database uses schema 27. Its readiness log contained
only `PI_HOST_FAILED`, and Desktop had no saved pairing record. Add SSH staged the
verified 0.22.2 archive, then failed safely with `HOST_AUTH_FAILED` before activation.

The new pure regression failed on the old helper. The generated-bootstrap Linux
regression also failed against the original main scripts with `HOST_AUTH_FAILED`
and passed with the candidate scripts.

## Executed checks

- Windows deployment-focused suites: 36 passed, 15 platform skips.
- Windows SSH/bootstrap/cache regression suites: 43 passed, 1 platform skip.
- Linux deployment admission, client-worker and offline enrollment suites:
  25 passed, no skips, in a private temporary directory on fnOS.
- Desktop production build, Desktop typecheck, repository Biome/style checks,
  version surfaces, agent policy, locale pairs and 614-page documentation check.
- Parsed the production Desktop output and compared both embedded deployment
  worker strings to their exact source files.

The host pnpm launcher rejected linked dependencies. Validation used the existing
TypeScript/electron-vite executables and previously provisioned repository-patched
Pi dependencies, whose patches and lockfile matched the task base. No second
dependency environment was installed.

## Real bundle and transport acceptance

Used the unchanged published `pi-host-0.22.2-linux-x64.tar.gz`, SHA-256
`c5283121baec98df5227d082e08e720d16643acce7784eca5955e98a31706a53`.
The fixture supplied these verified local bytes at the download boundary; this
run does not claim to retest the global proxy or release CDN.

On fnOS, all mutable state lived under a randomly created `/tmp` directory with
an isolated HOME and data directory. Copied executable bundles were read-only
inputs; no production database, device token or project was copied. A new empty
schema-27 database and synthetic identity/device/workspace records reproduced
the old binary's schema refusal. The candidate Desktop bootstrap then used real
SSH upload, detached deployment, port forwarding, one-time pairing, authenticated
RACP and directory browsing. Completion cleared only the fixture journal.

Assertions verified the original fixture identity/device, database sentinel and
workspace file remained. Before/after digests of the production database/WAL,
Host identity/credentials, deployment/PID/log files and `current` target matched.
Only fixture processes were terminated and their temporary data removed.

## Operator acceptance

The user's existing fnOS installation was not upgraded or repaired. Acceptance
of that environment is reserved for the user after installing the corrected
Desktop build. The client-carried worker fixes enrollment using the existing
published Host archive; no manual production symlink or database edit is needed.
