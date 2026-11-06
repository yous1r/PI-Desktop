# Remote Host on-demand preparation: candidate validation

## Candidate

- Branch: `feat/remote-host-demand-update`
- Worktree: `worktrees/remote-host-demand-update`
- Base/current HEAD: `8069856b59d2ea3a57b77247dd83eb4f4fd37f31`
- Candidate changes are uncommitted. No commit, push, PR, publication or production
  SSH deployment was performed. The branch was fast-forwarded from its original
  `9110b7ec8657c8b86485315c385d733af91a498a` base after fetching remote main;
  upstream changes and task documentation were preserved.
- Environment: Windows, Node 24.12.0, Git Bash, provisioned Electron/TypeScript.
  No Linux WSL distribution or Docker runtime was available.

## Behavior covered

Explicit folder browsing and ordinary saved remote-project activation enter one
Host preparation facade. Consent/retry resumes the original action; cancellation
or a changed navigation intent prevents late activation. Passive startup,
hydration, project reveal and inventory refresh do not install. Downloads use the
applied Desktop-global proxy before verified SSH upload. No remote mutation is
replayed and no remote operation falls back to a local workspace.

Preparation checks exact versions, identity and required capabilities. Upgrades
keep enrolled credentials. Offline repair additionally verifies durable identity,
an unrevoked owner-token hash and previous-version evidence. Missing evidence or
a live/unidentified process refuses repair. New work/client admission is fenced
by an idle maintenance lease. First installation requires an empty Host identity
boundary; repair never requests a new pairing token.

The worker stages verified bytes before activation, owns its Node executable and
helpers in the transaction directory, and records durable recovery phases. Main
confirms completion only after RACP authentication/capability verification. A live
`awaiting-racp` transaction may be verified on reconnect; unsafe startup states
remain recovery-required. No uncertain post-start failure triggers automatic
binary/database rollback.

## Executed checks

| Check | Result |
| --- | --- |
| Combined Desktop preparation/bootstrap/tunnel/supervisor/installer/recovery/UI and release-gate tests (17 files) | 143 passed, 19 platform skips, 0 failures |
| Final deployment/recovery/confirmation rerun after integration fixes | 20 passed, 13 Linux installer skips |
| Final preparation UI, saved-project activation and IPC rerun | 23 passed |
| Electron remote project dialog user path, including hidden-overlay regression | Passed |
| Agent Host full suite, including maintenance disposal/admission | 74 passed |
| RACP full suite, including maintenance connection admission | 29 passed |
| pi-host maintenance/workspace tools/process/terminal tests | 12 passed; 5 Unix socket tests skipped on Windows |
| Host runtime process/terminal/plugin focused suites | 9 passed |
| Release gate tests | 18 passed (also included in combined count) |
| Desktop production build with installed electron-vite | Passed; existing large-chunk warnings remain |
| Desktop, pi-host, Agent Host and RACP TypeScript checks | Passed |
| Shared/plugin SDK/Agent Host/RACP/i18n/Agent runtime/Host runtime dependency compilation | Passed |
| Real Electron HTTPS through HTTP, authenticated HTTP, SOCKS5, authenticated SOCKS5, Direct and controlled PAC | Passed |
| Release-version consistency, architecture guard, style tokens, git diff whitespace | Passed |
| Biome lint | Passed; test-artifact symlink warnings removed with task artifact cleanup |
| Local Markdown link scan across changed docs | 74 resolved; four existing E2E-document report/example references unresolved by the simple scanner |

The proxy runner uses a private Electron profile, a pinned local test certificate
and loopback fixture servers. Its PAC is configured only in that test Chromium
session. It does not change Windows proxy settings or qualify operating-system
PAC discovery.

## Dependency recovery

The primary checkout's installed Pi 1.4.0 dependencies lacked the repository's
current hosted-search patches. This first blocked Agent runtime compilation and
Desktop bundling. Existing package caches lacked offline resolution metadata.
An isolated scratch package-manager workspace installed only the affected public
Pi dependencies with the repository's exact patches; task package links reference
those compatible copies. The primary checkout's dependencies, task manifests and
lockfiles were not rewritten. After this repair, compilation and production build
passed. The task's dependency links need re-provisioning if session scratch is
removed before further development.

## Remaining qualification

- Run the authored Linux installer/repair/activation fixtures and real owner-only
  Unix socket tests on Linux. Windows cannot exercise Linux `flock`, `/proc`
  process ownership or POSIX executable semantics.
- Run `E2E-REMOTE-HOST-PREPARATION` and `E2E-REMOTE-SSH-OPTIMIZATION` with isolated
  Linux SSH x64/arm64 targets and controlled release assets, including SSH loss
  during stop/activation/start, other clients and active workspace resources.
- A live Host whose installation is damaged is deliberately not stopped by repair;
  an operator must arrange an idle stopped state. Legacy Hosts require explicit
  idle-window confirmation because they cannot provide atomic maintenance checks.
- Full real Linux release acceptance, PR integration-candidate validation and
  publication remain unperformed. Local fixture results do not satisfy those gates.

See [decision](../adr/remote-host-on-demand-preparation.md),
[Host operations](../../apps/pi-host/README.md) and
[unreleased changes](../../apps/pi-host/CHANGELOG.md).
