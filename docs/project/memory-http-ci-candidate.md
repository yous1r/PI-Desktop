# Memory HTTP candidate: SDK and CI packaging

## Scope

Continue the approved Desktop-direct memory MCP implementation on
`feat/memory-http-config`, based on `origin/main`
`3cb4710cf95db2b80a8fdca8ac8bc55ab3135433`. This delivery prepares and pushes a
candidate branch for GitHub Actions packaging, not a tag, public Release,
production memory-center deployment or live-center write.

## SDK completion

The existing development installation was Pi 1.3.0, while the checked-in
manifests, lockfile and patches require Pi 1.4.0. A frozen pnpm 12.8.1 install
was performed in the isolated candidate worktree, after safely detaching only
its task-owned dependency wrappers. All 825 packages came from the existing
content-addressable store; no lockfile or dependency pins were changed. The
primary checkout and its installed 1.3.0 dependencies remain untouched.

Actual `pi-ai`, `pi-agent-core` and `pi-coding-agent` instances are patched
1.4.0. Both `check:pi-dependencies` and `check:pi-patches` pass. The complete
`build:js`, including Runtime, Desktop and VitePress, and the Runtime bundle
pass. Runtime tests pass with 1563 cases and one existing skip after isolating
TEMP/TMP and removing inherited `PI_CACHE_RETENTION` for the test process.
The earlier 26 failures were an 8.3 temporary-path/global-resource identity
interaction and ambient cache-retention state, not a Pi API incompatibility;
production trust and provider policy were not weakened.

The absent Rust dev dependencies `fastrand 2.5.0` and `tempfile 3.27.0` were
fetched through the locked Cargo manifest. All 29 MCP registry/security tests
pass. Security cases were extracted to `mcp_servers/tests/security.rs` rather
than exempting an oversized module from the architecture gate. A legacy HTTP
fixture now has its own label, avoiding the intentional same-label shadow rule.

## CI boundary

The existing Release workflow additionally accepts **only** the exact candidate
branch `feat/memory-http-config` as a push trigger. It retains the tag trigger
for normal releases. Candidate pushes build unsigned macOS arm64/Intel, Windows
x64, Linux x64/arm64 and headless Linux bundles as Actions artifacts. Signing
requires a version tag or an explicitly signed manual run; publication still
requires a version tag. No credentials or new write permissions are added.

Both clean JS CI and Release verification build a real native Host before
Desktop tests, because the new native credential lifecycle test must not skip
on a missing executable. `scripts/memory-candidate-ci.test.mjs` checks trigger,
signing/publication guards and that prerequisite ordering. Existing approvals,
project grants and local/remote execution boundaries remain unchanged.

## Validation limits

The Windows whole-repository suites also contain pre-existing POSIX packaging,
Git line-ending, path and process-tree assumptions. Their failures are not
suppressed or converted to skips. The candidate's Ubuntu GitHub verification is
the authoritative whole-workspace build/test gate before packaging; inspect the
run for the exact pushed commit, not another branch or cached result.

Focused native MCP/editor/TLS/async tests, OAuth/control compatibility,
standard HTTPS center interoperability and normal local stdio remain covered.
The center interoperability test uses temporary synthetic authorization and
SQLite only. No online memory write, GUI installation, physical SSH acceptance
or remote graphical CBM collection is included.

CI results and artifacts are available under the repository's
[Release candidate runs](https://github.com/yous1r/PI-Desktop/actions/workflows/release.yml?query=branch%3Afeat%2Fmemory-http-config).
Unsigned candidate installers are testing artifacts, not notarized or certified
release packages. The plugin package alone cannot update the native Host or
provide the new center endpoint on an undeployed server.
