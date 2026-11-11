# scripts

Repository automation. Every script here is invoked from a `package.json`
script, from a GitHub workflow, or by hand during a release; the alias column
gives the invocation the rest of the documentation quotes.

## Release gates

These are the checks that block a release. `release.mjs` runs the
release-documentation gate itself and refuses to tag while any version surface
disagrees, so a green `check:release-docs` is a precondition, not a substitute.

| Script | Alias | Purpose |
|---|---|---|
| `release.mjs` | `node scripts/release.mjs <version> [--tag]` | Bump every workspace version surface, commit, and optionally create the `vX.Y.Z` tag the Release workflow builds from |
| `check-release-docs.mjs` | `pnpm check:release-docs` | Verify the models.dev catalog, changelog and test list, `APP_VERSION`, workspace versions, Cargo versions, and both README release lines agree |
| `check-agent-policy-sync.mjs` | `pnpm check:agent-policy` | Verify `AGENTS.md` and `CLAUDE.md` share the same `Policy-Sync` token, cross-references, and non-negotiable policy anchors |
| `check-marketplace-catalog.mjs` | `pnpm check:marketplace -- --url <url> --plugin <id>` | Marketplace catalog preflight; rejects a version record missing a checksum, package URL, size, or permissions, and a catalog `author` that is not a string |
| `check-style-tokens.mjs` | run by the desktop `lint` script | Fail renderer styles that hardcode values instead of design-system tokens |

## Packaging

| Script | Alias | Purpose |
|---|---|---|
| `notarize-and-staple-macos-release-dmg.sh` | `scripts/notarize-and-staple-macos-release-dmg.sh [release-dir]` | Submit the single DMG a native macOS job produced to Apple's notary service (`xcrun notarytool submit --wait`), require `status: Accepted`, then attach and validate the ticket (`xcrun stapler staple` / `validate`); run by the Release workflow when `sign_macos` is set. electron-builder only notarizes the `.app`, so the DMG needs this separate submission |
| `macos-stapler-retry-shim.sh` | injected by `macos-signing-watchdog.mjs` when `PI_STAPLER_MAX_ATTEMPTS` is set; also called by the DMG notarization and release verification scripts | Retry `xcrun stapler staple` and `xcrun stapler validate` up to the configured bound; all other `xcrun` commands pass through unchanged |
| `verify-macos-release.sh` | `scripts/verify-macos-release.sh [release-dir]` | Fail unless the one `PI-Desktop.app` and DMG under the release directory are Developer ID-signed, notarized, and stapled; run by the Release workflow after stapling |
| `macos-signing-diagnostics.sh` | `scripts/macos-signing-diagnostics.sh [--require-identity]` | Print the non-secret signing baseline before packaging (system, `codesign`, keychain identities/list/default, Xcode notary tools, Apple timestamp reachability). Informational by default, because the Developer ID identity is imported from `CSC_LINK` during packaging; `--require-identity` makes a missing Developer ID fatal |
| `macos-bundle-inventory.mjs` | `node scripts/macos-bundle-inventory.mjs <app-or-release-dir>` | Count what the signing phase has to touch: entries, Mach-O binaries, `.dylib`/`.node`/frameworks/nested bundles, per-directory cost, and the largest binaries (`signing-candidates`). Informational; run after every macOS package build |
| `macos-signing-watchdog.mjs` | `node scripts/macos-signing-watchdog.mjs [options] -- <command>` | Run a long silent phase (`electron-builder` signing, `notarytool submit --wait`) with a heartbeat, phase tracking, stall diagnostics (last file, `ps` state, codesign log tail), per-file codesign timings, optional bounded app stapler retries, and a hard timeout that fails instead of hanging; it forwards the child output and exit code unchanged and redacts `CSC_KEY_PASSWORD`/`APPLE_APP_SPECIFIC_PASSWORD`/`CSC_LINK` values plus `--password` arguments |
| `macos-codesign-shim.sh` | used by `macos-signing-watchdog.mjs` | PATH shim that timestamps every `codesign` invocation and then executes the real `codesign`; inert unless `PI_CODESIGN_LOG` is set |
| `export-linux-asar.mjs` | `node scripts/export-linux-asar.mjs` | Copy the Linux `linux-unpacked/resources/app.asar` into the versioned release asset used for system-Electron repackaging |
| `build-desktop-release.mjs` | called by the desktop `dist` / `dist:win` scripts | Build the native runner target without publishing; Windows runs separate NSIS and ZIP passes and stamps their updater distribution metadata |
| `check-linux-host-glibc.mjs` | `node scripts/check-linux-host-glibc.mjs [bin]` | Fail a Linux host-core binary whose needed glibc is above 2.35 |
| `make-icon.py` | `python3 scripts/make-icon.py` | Derive the package PNG, the macOS tray template, and the iconset/ICNS from the canonical PNG |
| `publish-screenshots.py` | `python3 scripts/publish-screenshots.py` | Publish documentation screenshots |

## Development

| Script | Alias | Purpose |
|---|---|---|
| `dev-electron.mjs` | `pnpm dev`, through `predev` | Launch Electron against the dev server. On macOS it builds and reuses the fingerprinted branded host bundle under `.cache/electron-dev/` |

## End-to-end

Run relevant task-candidate E2E from the dedicated request worktree, reusing
the provisioned host environment as required by `AGENTS.md`. `verify:ui:*`,
live providers, paid APIs, and the user's running desktop require explicit
request authorization. Use isolated profiles and deterministic local fixtures.
The scenarios are specified in
[the E2E test plan](../docs/spec/06-delivery/04-e2e-test-plan.md).

| Script | Alias | Purpose |
|---|---|---|
| `e2e-tool-admission.mjs` | `node scripts/e2e-tool-admission.mjs` | Isolated real-host tool admission: queued Bash burst leaves capacity for another session's Read/Write and recovers all counters |
| `e2e-host-data-owner.mjs` | `pnpm test:e2e:host-data-owner` | Real HostProcess/Rust contention, directory alias, relocation exclusion, graceful/crash release and simultaneous startup in `PI_SCRATCH_DIR`; requires `PI_DESKTOP_HOST_BIN` |
| `e2e-command-center-control.mjs` | `pnpm test:e2e:command-center-control` | Real Rust SQLite, HostProcess and authenticated loopback WebSocket: workspace/membership, transactional 12/36 quotas, duplicate/lost-reply receipts, consumed revision, scope-bound monitoring and populated reopen/epoch fencing; requires built JS packages, `PI_DESKTOP_HOST_BIN` and isolated `PI_SCRATCH_DIR`; only the external runtime acknowledgement is deterministic |
| `e2e-relocation-capability-keys.mjs` | `pnpm test:e2e:relocation-capability-keys` | Real offline Rust relocation of normalized project capability keys, source/global/external preservation, idempotence and collision refusal in `PI_SCRATCH_DIR`; requires `PI_DESKTOP_HOST_BIN` |
| `e2e-background-task-stop.mjs` | `pnpm test:e2e:background-task-stop` | Windows quoted cmd paths/arguments, Unicode, streams/exit status, real hidden-runner Stop, descendant exit and unrelated-process preservation; requires `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN` and built shared output |
| `e2e-process-exit-confirmation.mjs` | `pnpm test:e2e:process-exit-confirmation` | Production HostProcess / AgentSidecar wrappers confirm actual Rust Host and fixture-sidecar exit; live-process refusal and owned-process cleanup; requires `PI_SCRATCH_DIR` and `PI_DESKTOP_HOST_BIN` |
| `e2e-remote-path-permissions.mjs` | `pnpm test:e2e:remote-path-permissions` | Real Host RPC authorization and relay for POSIX paths on any controller, denied writes and cancellation; deterministic remote-result boundary, no remote machine/provider; requires `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN` and built shared output |
| `e2e-owner-local-control.mjs` | `pnpm test:e2e:owner-local-control` | Windows owner discovery through real Host CLI, aliases, stale epochs, counterpart executable authentication and graceful/crash cleanup; requires `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN` and built shared output |
| `e2e-execution-fence.mjs` | `pnpm test:e2e:execution-fence` | Windows Rust-owned startup barrier, strict registration, detached descendant Stop, Host/coordinator crashes and production HostProcess/AgentSidecar path; original-handle observers, temporary profiles; requires `PI_SCRATCH_DIR` and `PI_DESKTOP_HOST_BIN` |
| `e2e-owner-handoff.mjs` | `pnpm test:e2e:owner-handoff` | Windows durable registration before Node effects, injected journal-phase crashes, restricted claim/recover, native identity refusal, no early turn recovery and bounded stdio cleanup; temporary profiles only; requires `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN` and Node with `node:sqlite` |
| `e2e-owner-handoff-client.mjs` | `pnpm test:e2e:owner-handoff-client` | Production Node consumer against real restricted Rust bootstrap: profile binding, lock competition, recover/claim/rotation, exact receipts and original-child cleanup; isolated phase injection, no full ready/transfer claim; requires `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN`, Node `node:sqlite` |
| `e2e-owner-inspection.mjs` | `pnpm test:e2e:owner-inspection` | Production Rust queries/inspection, fenced Desktop factory/backend owner, descendant closure and Host restart recovery, inventory/persistence/admission reader and journal mismatch refusal; remaining Desktop owners are fixtures; explicit scratch data directory in final child env; requires Windows, `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN`, Node `node:sqlite`; no Electron launch or full handoff qualification |
| `e2e-owner-source.mjs` | `pnpm test:e2e:owner-source` | Authenticated Windows running-source preflight/status, unchanged journal, stale build/epoch and unexpected executable refusal, malformed mutation envelopes, endpoint cleanup/restart; test-only terminal record injection; requires Windows, `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN`, Node `node:sqlite`; explicit isolated profiles, no full transfer |
| `e2e-owner-source-mutations.mjs` | `pnpm test:e2e:owner-source-mutations` | Windows negative original-source path: framed `--owner-source` requests through the real Rust source, real Rust exchange and the production Desktop coordinator/inventory. Drifted build, all ten declared gaps refusing the hold, identical retry, stale epoch, unowned cancel/fence/release and a lost waiter commit nothing; every other Desktop owner is an idle fixture. Requires Windows, `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN`, Node `node:sqlite`; no completed handoff, native closure or Sidecar acquire |
| `e2e-owner-idle-admission.mjs` | `pnpm test:e2e:owner-idle-admission` | Windows non-expiring handoff admission through production AgentHost, runtime, transports and native fence; deterministic sidecar, exact durable history after independent reopen; fixture resource declarations do not qualify full application handoff; requires `PI_SCRATCH_DIR` and `PI_DESKTOP_HOST_BIN` |
| `e2e-sidecar-handoff.mjs` | `pnpm test:e2e:sidecar-handoff` | Real contained Node runtime quiescence, initialization/reverse-RPC races, local deterministic provider streaming, strict hold/cancel/seal and unqualified native-service refusal; requires `PI_SCRATCH_DIR` and `PI_DESKTOP_HOST_BIN`; optional `PI_COMMAND_CENTER_DEPENDENCIES` reuses a provisioned compatible Pi dependency tree |
| `e2e-desktop-plan-handoff.mjs` | `pnpm test:e2e:desktop-plan-handoff` | Desktop plan admission, production launch resolution, real Rust claim/settlement and late begin-turn cleanup; contained deterministic sidecar, isolated global capability directory, independent reopen and native exit confirmation; requires Windows, `PI_SCRATCH_DIR`, `PI_DESKTOP_HOST_BIN`; optional provisioned `PI_COMMAND_CENTER_DEPENDENCIES`; not full Desktop transfer |
| `e2e-browser-handoff.mjs` | `pnpm test:e2e:browser-handoff` | Isolated Electron browser admission, visible native screenshot, background session input, pending evaluation and retained resource refusal; source manifest and original-child exit; requires `PI_SCRATCH_DIR`, provisioned Electron/esbuild; optional `E2E_DEPENDENCY_ROOT` and `PI_COMMAND_CENTER_DEPENDENCIES`; no native-family closure or never-presented background screenshot qualification |
| `e2e-smoke.mjs` | `pnpm test:e2e` | Protocol-level E2E against host-core, plus an optional live model |
| `e2e-plan.mjs` | `pnpm test:e2e:plan` | Plan state, checkpoint artifact, and approval transitions |
| `e2e-transcript-cache.mjs` | `pnpm test:e2e:transcript-cache` | Isolated Host RPC regression for large transcript cache creation, append plus middle Task rewrite, legacy cache recovery, paging, message navigation, invalid UTF-8 recovery, and process restart |
| `e2e-plan-ui.mjs` | `pnpm test:e2e:plan-ui` | Plan approval through the rendered UI |
| `e2e-electron-boot.mjs` | `pnpm test:e2e:boot` | Electron boot probe |
| `e2e-provider-client-certificate.mjs` | `pnpm test:e2e:provider-client-certificate` | Isolated Electron 43 model discovery with optional client certificates, authenticated proxy routing, redirects and cancellation |
| `e2e-provider-recovery.mjs` | `node scripts/e2e-provider-recovery.mjs` | Isolated desktop with a localhost fault-injection provider: socket failures, interrupted streams, Responses recovery, exhausted retries, Continue, and recovery across eleven real Read calls. Requires a built desktop/runtime and host binary (`PI_DESKTOP_HOST_BIN` when outside the checkout); retains screenshots and JSON under `.artifacts/issue-699/` |
| `e2e-settings-scroll.mjs` | `pnpm test:e2e:settings-scroll` | Production Settings component navigation, search anchoring, focus-on-mount, and scroll behavior |
| `e2e-transcript-render.mjs` | `pnpm test:e2e:transcript` | Production transcript render boundaries, runtime status geometry, and deterministic smooth-text cadence |
| `e2e-gen-ui.mjs` | `pnpm test:e2e:gen-ui` | Offline production GenUI card/protocol journey: slider, theme, expand/Escape, viewport cleanup, global frame quota, and response-level cross-session sandbox |
| `e2e-renderer-responsiveness.mjs` | `pnpm test:e2e:renderer-responsiveness` | Native Electron click, typing, session switching, disclosure, and scroll while an isolated child process streams large transcript deltas |
| `e2e-config-sync-multidevice.mjs` | `pnpm test:e2e:config-sync` | Four isolated host-core processes against a SigV4-validating local S3 fixture; covers credential opt-out, approvals, concurrent edits/conflict resolution, mapped skill resources, deletion, sync/backup restore, restart, password rewrap, encrypted storage and cleanup |
| `e2e-supervision.mjs` | `pnpm test:e2e:supervision` | Process supervision and restart behavior |
| `e2e-subagents.mjs` | `pnpm test:e2e:subagents` | Subagent registry over RPC, then through the real loader (D202) |
| `e2e-send-now-subagents.mjs` | `pnpm test:e2e:send-now-subagents` | Production Composer queue and Main IPC with real Rust Host/agent sidecar and a local SSE fixture; Send now wakes TaskWait, preserves two live delegates and reports, and retains ordinary FIFO input. Uses temporary HOME/data and accepts `PI_DESKTOP_HOST_BIN` for a reused Host binary. |
| `e2e-agent-live.mjs` | `node scripts/e2e-agent-live.mjs` | Live streaming chat through agent-runtime + host-core. Requires `PI_DESKTOP_TEST_API_KEY`, `PI_DESKTOP_TEST_BASE_URL`, and `PI_DESKTOP_TEST_MODEL` (no defaults), so it has no `pnpm` alias |

### Configuration-sync live S3 opt-in

Build the task's Host binary and shared package first, reusing the existing
development toolchain. Set `PI_DESKTOP_HOST_BIN` if the binary is outside the
worktree. The default command uses only local S3 and temporary Host profiles.
With explicit authorization, run:

```bash
node scripts/e2e-config-sync-multidevice.mjs --live-s3 --env-file /authorized/path/.env
```

Live administration needs an existing Python 3 + boto3 environment. The file
must provide `S3_HOST`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_DOMAIN_MODE` (`false` = path-style), and optionally
`S3_SESSION_TOKEN`. Credentials stay in memory/stdin, never arguments or logs.
The harness creates its own UUID prefix under `pi-desktop-tests/`, checks
initial emptiness, then runs the same actual Host journey. It needs scoped
list/get/put/delete and bucket-versioning read permission; versioned buckets
also need version listing/deletion. It stops every Host before deleting only
the exact test-prefix inventory, including versions/delete markers, and checks
final emptiness. Failed preflight never grants cleanup ownership. No production
Desktop profile, model call or executable capability is used. Output records
the candidate/base and Host binary hash; uncommitted task changes are explicit.

## Continuous integration

`.github/workflows/ci.yml` runs two jobs on pushes to `main`, on pull requests,
and on manual dispatch, skipping both when a change touches only `docs/**` or
`**/*.md`:

- **JS build / typecheck / lint / test** — `pnpm install --frozen-lockfile`,
  `pnpm build:js`, `pnpm --filter @pi-desktop/desktop typecheck`, `pnpm lint`,
  `pnpm -r --if-present test`
- **Rust host-core test** — `cargo test -p host-core --locked`

`.github/workflows/docs-check.yml` covers the paths `ci.yml` ignores: it runs
`pnpm docs:check` (the docs locale pair check) when `docs/**`, the READMEs, the
shared changelog sources, or the check scripts change. `check:release-docs` is
deliberately not in CI because release branches must pass it with the stable
version explicitly supplied for a prerelease preview.

`.github/workflows/release.yml` builds on a `v*.*.*` tag. A `verify` job first
repeats the `ci.yml` checks (a tag push does not trigger `ci.yml`), and the
build matrix waits for it. Each platform runner then
validates the tag against `apps/desktop/package.json` before packaging, then
runs the native `dist:mac`, `dist:win`, or `dist:linux` command. The Linux
job uses Ubuntu 22.04 so host-core stays on glibc 2.35, then
`scripts/check-linux-host-glibc.mjs` refuses a binary that needs a newer
glibc. Each Linux runner (native x64 and arm64) also exports the exact
app.asar from its own unpacked tree as a versioned release asset; the macOS
matrix covers arm64 and Intel x64 and
the publish job assembles the GitHub Release. Tag builds Developer ID-sign,
notarize, and staple macOS artifacts; `workflow_dispatch` may set
`sign_macos: false` only for unsigned debug artifacts. See the [release
runbook](../docs/spec/06-delivery/06-release-runbook.md).

### Provider certificate regression

- `node scripts/e2e-provider-certificates.mjs`: real desktop launcher and
  bundled sidecar against a loopback TLS model; tests trust, terminal failure,
  inherited extra CA, and hostname validation. Requires installed Electron.
- `node scripts/e2e-provider-certificate-ui.mjs`: production transcript error
  component, localized guidance and detail disclosure. Requires built desktop
  styles. Optional `PI_CERTIFICATE_EVIDENCE_DIR` saves a review screenshot;
  `--baseline` renders the `origin/main` error component for comparison.

### Command-center observation foundations

- `node scripts/check-command-center-foundations.mjs`: bundles the current-source
  Agent Host and command-center client entries, joins the real snapshot store to
  the browser-target reader, and exercises receipts, live change application,
  connection health and the composed monitor session in an isolated JavaScript
  realm. No Desktop, profile, provider or network is used.
- `node scripts/check-command-center-foundations.mjs --built`: the same checks
  against emitted package entries after building shared, Agent Host and the
  client with their TypeScript projects.
- `scripts/e2e/command-center/connection-health-consumer.mjs` and
  `monitor-session-consumer.mjs`: reusable deterministic consumers with a
  controlled clock and held ping replies, imported by the check above.
- `node --test scripts/e2e/command-center/*.test.mjs
  scripts/e2e-command-center-curve.test.mjs`: the command-center baseline
  script (`pnpm test:command-center-baseline`). It includes the Q0 qualification
  manifest/validation harness and the pre-existing curve export test; the latter
  requires `PI_SCRATCH_DIR` to name an isolated scratch directory.
