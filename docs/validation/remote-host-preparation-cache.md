# Remote Host preparation follow-up validation

## Candidate and scope

- Branch: `fix/remote-host-preparation-cache`.
- Base: `554ff9712` (`v0.22.2`), refreshed against `origin/main` before validation.
- Desktop environment: Windows, provisioned Node/Electron, an isolated encrypted
  Host registry and Electron profile. The user's running Desktop was not used.
- Authorized real targets: SSH aliases `dev` and `paas`, both Linux x64.
- No model requests, provider imports, data rollback or forced termination.

The fixes cover persistent verified artifact reuse, legacy-maintenance consent
in Add SSH Host, forward prerelease-to-stable promotion, ISO pairing expiry,
and deployment CLI execution through the installed `current` directory link.

## Artifact provenance

The official `pi-host-0.22.2-linux-x64.tar.gz` was downloaded once by Desktop's
applied global System proxy fetch and verified against its release checksum:

`fc1c5b9e9137ce711383f9f2082a2c0f226d3cb4223e3b3d8479fe95448239f0`

Its published worker falsely rejected the Host's ISO pairing expiry after a
successful start. Its completion entry guard also silently skipped execution
when invoked through `current`. Those defects are in the published artifact;
local source changes do not alter that artifact.

A separate local validation archive was derived from those verified bytes by
replacing only `deploy.mjs`, `deploy-recovery.mjs` and their `SHA256SUMS` entries:

`131f54d38f0b3eaf30b693db54a6b747500ea8aa26e3d7b801f7dcd75020729a`

It retains the 0.22.2 Host executable and uses a separate candidate cache with
an injected local artifact provider. It was not published or put into the
verified official-release cache. Both machines currently run this explicitly
identified candidate. This is source validation, not qualification of a newly
published release.

## Real SSH results

| Check | dev | paas |
| --- | --- | --- |
| Initial version | 0.22.1-beta.6 | 0.22.1-beta.6 |
| Final executable version | 0.22.2 | 0.22.2 |
| Original Host identity retained | Yes | Yes |
| Original device records retained | 1 of 1 | 2 of 2 |
| Authenticated workspace tools/files capabilities | Passed | Passed |
| Real `/root` directory browse | 14 entries | 6 entries |
| Repeat saved-Host preparation and browse | Passed | Passed |
| Remaining deployment journal | None | None |
| Candidate checksum/archive reads | 0 / 0, fetch disabled | 1 / 1, local candidate source |

On `paas`, an isolated saved record was first authenticated to the old Host.
Explicit preparation stopped for legacy maintenance confirmation. Confirming
continued the same preparation, uploaded the cached archive, preserved that
record's device token, upgraded to 0.22.2, and resumed authenticated browsing.
The retry made no checksum/archive request.

A new Desktop validation process then installed the same candidate on `dev`
with all artifact requests configured to fail. It reused the persistent cache,
acquired the modern idle-maintenance lease, preserved the enrolled device token,
completed deployment, and browsed successfully. No release request occurred.

The earlier official-artifact failure on `dev` was recovered under an idle
maintenance lease. Original identity/device records were compared with private
pre-upgrade backups. A fresh validation pairing authenticated the running Host
and verified capabilities and directory access before the exact failed journal
was advanced and completed. No database or binary rollback was used.

## Automated checks

Focused tests cover cache hits/misses/corruption/cancellation, bootstrap consent,
version admission, pairing output from the real issuer, linked deployment entry,
post-authentication completion, preparation cancellation, saved-project activation
and the actual Add SSH Host / remote-folder UI.

- Focused Desktop regression set: 116 passed, 3 Windows platform skips.
- Shared compilation and Desktop/pi-host TypeScript checks: passed.
- Desktop production build: passed (existing chunk-size warnings).
- Agent policy, PR base, architecture, style tokens, Biome and whitespace: passed.
- Documentation: 88 locale pairs, 613 pages, full VitePress build passed. The
  page checker used a copy of current Git-managed docs plus this report to avoid
  recursively traversing the provisioned dependency links before filtering them.
- Real Electron proxy suite: HTTP, authenticated HTTP, SOCKS5, authenticated
  SOCKS5, Direct, System/PAC and proxy-settings barrier passed.

The UI harness uses its own profile and bounded frame waits because hidden
Chromium windows can throttle animation frames. It retains assertions for
maintenance confirmation, consent invalidation after editing, duplicate-submit
prevention, focus restoration and resumption of the requested action.

## Limits

- Real-host validation covers Linux x64. It does not qualify Linux arm64 or the
  entire disconnect/failure/active-work E2E matrix.
- The official release fetch used the System policy. Authenticated HTTP/SOCKS/PAC
  paths are separately covered by the existing controlled Electron proxy suite.
- The actual user Desktop was not driven. Saved-project activation has component
  coverage; the same preparation service, SSH transfer and RACP connections were
  exercised against both real hosts with isolated local records.
- A release containing these fixes is still needed. No release or PR merge was
  performed by this task.
