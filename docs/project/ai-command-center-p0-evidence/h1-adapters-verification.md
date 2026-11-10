# H1 non-Voice Desktop adapter acceptance

- Status: `PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES`.
- Tested candidate: `a360fc5050e8cb751386819dbee9f1cb20b364d1`.
- Base: `e977efc96b6b735aeef5066a0b66c6565ad5691f` (ancestor of candidate).
- Execution: `2026-11-10T09:05:45.551Z` to `2026-11-10T09:08:34.338Z`.
- Clean before/after; all 4,514 tracked regular files unchanged, including SQL,
  configuration, tests and documentation; 23 distinct acceptance artifacts rehashed.
- Scope: [H1-R01–R09](../ai-command-center-h1-remaining.md), excluding user-paused
  Voice/LiveVoice and the H2 source-transaction dependency. No full-transfer claim.

## Results

The exact candidate passed **792 tests across 51 files**, with zero failures,
cancellations or skips. This total is one candidate run, not the sum of overlapping
development runs. Current-source Desktop TypeScript, lint (463 selected files),
architecture, agent-policy synchronization, documentation (637 pages), direct
repository base and whitespace checks all exited successfully.

| Task | Verified behavior and representative paths |
| --- | --- |
| R01 model catalog | Local/remote shared flights, closed fresh ingress, retained fetch/body/cancel work and no stale publication; real catalog feeds inventory. |
| R02 updater | Immutable operation owner, queued settings writes, retained timeout/dispose work, ambiguous emitter refusal; production factory and transport feed inventory. |
| R03 vendor OAuth | Login/respond/cancel, owner-bound installation/credential writes, plugin runtime changes, refresh and browser/model publication; production factory handles Host replacement, generation change, gate closure and disposal. Model-discovery IPC refusal starts no fallback effect. |
| R04 inbound MCP | Real authenticated loopback requests, partial-body and startup-manifest races, original instance retention, live listener/socket counts and bounded stop. |
| R05 todos | Edit/debounce/save/quit, draft and mutation identity retention, missing/replaced Host through window/editor waits, explicit retry and unconfirmed window cleanup. Actual draft/writer activity feeds inventory. |
| R06 Worker | Original Host/generation/bridge/Sidecar dispatch, queued `HOST_BUSY` recovery, settlement during closure and new-drain receipt replay; actual service feeds inventory. |
| R07 surfaces | Window/load/bounds ownership, tray/listeners/accelerators, prewarm-to-show reuse and Windows keyboard refusal without unhandled rejection; shared owner feeds inventory. |
| R08 coverage | Existing backend/plugin/browser/terminal/remote/extension ownership checks and the explicit [evidence-or-refusal map](../ai-command-center-h1-native-coverage.md). |
| R09 integration | All 19 inventory fields, required exact-shape sources, cross-await identity checks, original resource retention and unchanged ten fixed gaps. |

An independent subagent built a fresh offline `host-core v0.22.4` executable using
the provisioned Cargo target. The old executable was not reused: release Cargo
inputs changed at the new base. Build exit was zero with existing non-fatal
unused/dead-code warnings. This H1 change adds no Rust implementation; no new full
Rust unit suite or clippy run is claimed.

The fresh binary passed **10 isolated process scenarios with four Hosts and
confirmed cleanup**. These cover original Rust identity, stdio refusal, real
Desktop Sidecar/backend startup and restart, inspection, checkpoint recovery,
Desktop inventory/coordinator refusal, durable Worker count transitions, stale
journal roots and native generation closure. Other Desktop families in this
process harness are controlled fixtures; their adapter user paths are tested
separately above. This does not certify all native families or a successful source
handoff. No live Desktop, default profile, real vendor account/provider, microphone,
model download, installer or SSH session was used for these tests.

## Artifact binding

Raw artifacts remain in session scratch:
`C:/Users/Administrator/.pi-desktop/scratch/233744ff-b9c5-46dd-9a91-5169100d5569`.
The compact [machine-readable record](./h1-adapters-verification.json) is retained
in the repository. Scratch artifacts are session-scoped, not a release package.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `h1-adapters-candidate01-verified.json` | 9405 | `ecfcb02a2fb0f01514ce104ede25f5cdea308f63381963f422310fd7ef57374c` |
| `h1-adapters-candidate01.json` | 23555 | `7de4c8cbd48fd621897dee413a1a5af061bc0978536503b64e797a0b98e9b394` |
| `h1-adapters-candidate01-inputs.json` | 780827 | `13e9fc66985319a67e06a69a910cb94ee279f9c56127ee4801e1c68514f64afd` |
| `h1-adapters-native01.json` | 6996 | `0ad357686efb2740a3f48c8a5d8959a778c6193713437625881f909f74797d2c` |
| `h1-adapters-native01-host.exe` | 35436032 | `154d1ce66c882338ca00e9048a25d2c6a60057577efb5a1c3e6815c26e28f530` |
| `owner-inspection-yNWu7o/report.json` | 2249 | `e4a372dea4e12d218a335f2de628427b8096efcfc58ea15a0f1d4fd6aa961d8e` |
| `h1-adapters-development-evidence.json` | 6608 | `c88db7cb40dc0c50f82047618e2e2b604d627a0242fb20fb5de4ee3d312f2a18` |
| `h1-adapters-verify.mjs` | 3970 | `56015427f8a78263abbee563afbe9a5c648c374d7843c106fd588a22c572c39a` |

## Failed attempts and verification limits

The development index binds 27 logs/probes, including discriminating failures for
MCP body admission, Worker ownership, todo missing-owner recovery, launcher reuse,
OAuth continuations and IPC refusal. It also records temporary reads during active
editing and loader/toolchain failures separately from product regressions. The todo
delegate reused its development log filename; the retained file is the final
42-case result, not immutable evidence of every earlier attempt.

- The old wiring test parsed only line-leading properties. Its corrected parser
  checks actual top-level TypeScript object members, including negative tests for
  nested substitutes and explicit `undefined`.
- Standalone model-discovery SSR initially resolved stale shared dist. The test
  now uses the repository's current-source Vite aliases; its independent three
  cases and the final integrated selection passed.
- Direct package type/build commands may use stale linked dist. Current-source
  project TypeScript was the acceptance gate. The standalone OAuth bundle test
  had a dependency-resolution failure also reported in the primary checkout;
  no successful standalone bundle build is claimed.
- Expanding lint to the unchanged model-catalog body found its two pre-existing
  unused helpers. That body remains outside the pre-existing lint selection;
  the new loading owner, all other adapter changes, types and catalog tests were
  checked. No unrelated dead-code cleanup was performed.
- Two pre-existing Windows-separator update-cache assertions and the existing
  safe-open-external allowlist source-regex failure remain outside this candidate
  selection. They are not reported as passing.
- `pnpm check:pr-base` attempted automatic dependency synchronization and failed
  because the task's `node_modules` is a link. No completed installation is
  claimed. The link still resolved to the provisioned dependency tree; no further
  installation was attempted. The same repository check ran directly with Node
  and passed. The final candidate tests then passed with the available toolchain.

All ten fixed native/source qualification gaps remain. Voice/LiveVoice is still
user-paused. Authenticated source prepare/cancel/fence/release belongs to H2;
successor readiness, reattachment and complete transfer are H3–H5. These results
change neither those boundaries nor persisted data/protocol contracts.

The [earlier default-profile isolation incident](./rust-inspection-isolation-incident.json)
remains unresolved: owner registration was confirmed, but data/recovery effects
are unknown. Later isolated success does not prove that earlier data was unaffected.
No push, PR, remote merge or deployment was performed.
