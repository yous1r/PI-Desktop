# AI command center: branch handoff

- Branch: `feat/command-center-continuation-20261110` in its request worktree.
- Base: `1cdb4ce1d797ab94b024a2c478ecd01d50cb2b2f`, containing fetched `main`
  `e977efc96b6b735aeef5066a0b66c6565ad5691f`.
- State: **uncommitted, unpushed** (no commit, push, PR or deployment was made).
- Authorized takeover: the user approved copying the other request worktree's
  uncommitted work into this branch. The source worktree was only read and remains
  unchanged; provenance and per-file hashes are in the
  [takeover record](ai-command-center-takeover-provenance.md) and
  [takeover evidence](ai-command-center-takeover-evidence.json).

## What is implemented here

| Area | State |
|---|---|
| H0/H1/H2 contracts and source operations | Accepted in earlier commits; not re-run here except the H3 consumer below |
| C1 control contracts | Committed `decb07c4c`; strict schemas and fixtures reused |
| C2 persistence | Code taken over **and wired**: schema v31 migration with v30 backup, atomic upgrade, fail-closed validation; 59 command-center tests |
| C3 control service | Code taken over and **registered**: 13 `commandCenter/*` operations in the shared `RACP_OPERATIONS` catalog (profile `remote-host`; `viewer` for workspace and receipt reads, `owner` for workspace writes, `controller` for membership/intervention). No capability is advertised, so all 13 return `CAPABILITY_UNAVAILABLE`; RACP **42/5**, shared package **1616/144** |
| H3 successor bootstrap | Module taken over; **entry implemented, fail-closed**: `--owner-target` validates the exclusive argv/private stdin channel, commits the claim and then stops with `HANDOFF_TARGET_ADOPTION_UNAVAILABLE`; `owner_handoff::target` **22/22** and full `owner_handoff` **146/0** after the coordinated schema-30→31 bump. Supervisor adoption, Ready publication and same-process serving remain open |
| H4 client reattachment | `OwnerHandoffAttachment` with 29 tests (snapshot before events, replay freeze, reconnect, permissions) |
| M1 monitor foundations | Snapshot store, projection barrier, browser reader, summary, health and session composition; 363 integrated tests |
| U1 Desktop surface | **Mounted with deterministic fixtures**: full-screen `command-center` route in `AppShell`, Sidebar footer + global-search Pages entries, hidden work panel, mount retained for draft/focus/history; `commandCenter` i18n namespace registered for en/zh-CN (other locales fall back to en). Verification **27/27** route/component/user-path/view, i18n **33/33**, shell/nav/i18n **105/105**, sidebar **115/115**, renderer-only `tsc` exit 0, desktop lint OK. No live Host producer and no real Electron journey |
| Q0 qualification harness | Manifest/validation harness taken over; 24 tests; part of the existing baseline script |

## Verification snapshot (2026-11-11)

| Suite | Result |
|---|---|
| Integrated observation foundations | 363 / 30 files |
| Agent Host package | 151 / 12 |
| Shared source | 808 / 72 |
| Command-center client | 259 / 15 |
| RACP package | 33 / 4 |
| RACP package after C3 registration | 42 / 5 |
| Shared package after C3 registration (package `test` script, includes built `dist` copies) | 1,616 / 144 |
| Rust `command_center` (incl. 3 migration tests) | 59 |
| Rust `owner_handoff::target` | 16 |
| Rust `owner_handoff::target` after entry | 22 / 22 |
| Rust `owner_handoff` after schema-30→31 bump | 146 / 0 |
| Host-runtime attachment + repository adapter | 36 |
| Desktop command-center/attachment | 25 |
| Desktop command-center route/component/user-path/view | 27 / 27 |
| i18n package | 33 / 33 |
| Q0 harness | 24 |
| Command-center baseline script (needs `PI_SCRATCH_DIR`) | 48 / 48 |
| Repository consumer checks | 12 / 12 source and artifacts |
| Rust `cargo check` and `cargo fmt --check` | pass |
| TypeScript source and official builds | pass |
| Biome lint (configured set) | pass |
| Architecture and agent-policy gates | pass |
| Documentation | 645 pages, 88 pairs |

Evidence: [foundations JSON](ai-command-center-foundations-evidence.json) (58 files,
digest `af583e9a4bc685c027b73d0b3f2e88af980d65af824c7b21d76683d3d44dfa98`) and
[takeover JSON](ai-command-center-takeover-evidence.json) (58 files + 9 ignored-path
supplements + explicit boundary-test hashes). Exact commands are in the
[continuation record](ai-command-center-continuation.md#reproduce-this-verification).

## Not wired — required before claiming product acceptance

1. **H3 supervisor adoption (open)**: `--owner-target` is implemented and
   fail-closed: it validates the exclusive argv/private-stdin channel, commits the
   claim and stops with `HANDOFF_TARGET_ADOPTION_UNAVAILABLE` because no supervisor
   adopts the captured owner/coordinator and no Ready resources exist. Target tests
   are **22/22** and the full `owner_handoff` suite **146/0**; supervisor adoption,
   Ready publication and same-process restricted serving remain open, so admission
   must stay closed.
2. **C3 capability**: the RACP catalog now has the thirteen `commandCenter/*`
   operations with roles and mutation flags, but `RacpServerCapabilitiesSchema`
   deliberately has no command-center field. `requireCommandCenter` therefore
   rejects every call with `CAPABILITY_UNAVAILABLE` before dispatch; capability
   advertisement and the authorized producer/consumer path remain open.
3. **C4**: dispatch claims, uncertainty reconciliation and ACK persistence are not
   implemented; the control service only gates on the runtime handoff predicate.
4. **U1 live producer (open)**: the route is mounted and the `commandCenter`
   namespace is registered for en/zh-CN (other locales fall back to en), with
   **27/27** route/component/user-path/view tests, i18n **33/33**, shell/nav/i18n
   **105/105**, sidebar **115/115**, renderer-only `tsc` exit 0 and desktop lint OK.
   It renders deterministic fixtures only and the Host is explicitly offline; a
   real Host producer and an Electron journey remain open.
5. **H5/W/N/Q/R/X1/Voice**: cross-process transfer acceptance, browser edge,
   native association, device/soak qualification, release readiness, native lanes
   and Voice remain blocked on the items above plus nominated hardware and
   deployment scope.

## Environment limitations

- `host-runtime` and `agent-runtime` package builds fail because the provisioned
  Pi dependency copy lacks this branch's patches (pre-existing, recorded).
- This managed host denies OS-temp directory creation to test processes; affected
  suites use repository scratch space, and the pre-existing curve test requires
  `PI_SCRATCH_DIR`.
- `cargo clippy` cannot run here: compiling `ring` in the MSVC environment fails
  before project code is linted.
- No real user profile, provider, paid service, browser/device deployment or running
  Desktop instance was used.

## Suggested next request

Either (a) commit this branch after review and open a PR for the observable parts
(C2 migration, H3 module tests, C3 catalog registration and boundary tests, docs),
or (b) continue with the remaining unwired items under a new explicit scope:
advertise the command-center capability only after the full producer/consumer path
and C4 claims pass, and add H3 supervisor adoption so the private path becomes
exercisable end to end.
