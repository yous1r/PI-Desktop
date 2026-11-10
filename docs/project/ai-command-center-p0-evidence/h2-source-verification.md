# H2 original-source operation acceptance

Candidate `011a7dd592b3becba928fe29dd0d6a3fa6026e01` includes base `e977efc96b6b735aeef5066a0b66c6565ad5691f`.
Implementation is `9ff740d168b21b54a882b649f23ce8e1eeaaaa48`; the candidate
adds the isolated bundle-output correction. [Machine-readable evidence](h2-source-verification.json)
records all commands, process reports, input manifests and artifact hashes.

## Result and scope

Authenticated source Prepare/Cancel/Fence/Release now retain the original
Desktop exchange, Rust admission capability, requester and native generation.
Phase and receipt progress commit together; cancellation commits before
reopening, fencing intent precedes native effects, and release intent enters
ordinary RPC cleanup. Caller disconnect does not abandon accepted work.

H2 is accepted within this boundary. All ten qualification gaps remain and
`nativeCoverage` stays `execution_generation_only`. Controlled positive
controller/native-object tests and the real negative source chain do not
qualify full Desktop transfer, H3 readiness, H4 reattachment or H5 integration.
Voice implementation/integration remains the final stage.

## Verification

- 141 distinct Rust tests passed: 118 handoff, 9 execution-fence, 8 owner-control,
  and 6 RPC-lifetime. The candidate rebuilt the exact test executable.
- 23 isolated process checks passed: 5 source-query, 8 source-mutation negative
  cases and 10 inspection/startup/restart cases. Every report confirms cleanup.
- The unchanged JavaScript boundary passed 70 shared tests (47 are C1) and
  80 coordinator/exchange/query tests; current-source shared/Desktop types pass.
- Rust format, Clippy, architecture, policy, docs, selected lint, whitespace
  and direct base checks passed. Two existing ToolPolicy warnings remain.
- 4551 tracked regular inputs were compared before/after;
  29 acceptance artifacts were rehashed. Concurrent unregistered
  work is explicitly listed; the worktree is not described as globally clean.

Production binary SHA-256: `af68af31045dcc92f7534e3dbb5eec80e0fe824ad903534034d6284eea297d80`.
Test binary SHA-256: `01232a682cea5ae9d6e50a8304dbeb3fab1183c867837280c2acb6d5cde03319`.
Input aggregate SHA-256: `0516b17a80c3d452e4edf7bb2376d9bf67563e05588f115339f29b5134b71fd7`.

## Retained failures and limits

Earlier 60/90-second combined runs were interrupted. A timed complete run
passed in 81.16 seconds and observed existing AppState cases taking about
29 and 25 seconds; a subsequent rebuilt run passed in 64.59 seconds. No
source-close defect was established and no speculative lifecycle fix was made.
Both ambiguous-hold and Desktop retained-Busy regressions have retained failing
baselines. Native fixture uniqueness errors and wrong-filename invocations
remain development failures, not successful tests.

Candidate01/02 failed before process scenarios: esbuild could not write its
output in scratch. Node could write there, and esbuild memory output succeeded.
The three harnesses now write their one verified output from Node. Candidate03
passed without permission changes, shared dependency changes or elevation.

No full Rust rerun, live Desktop, real provider, microphone, minimum-hardware,
nominated native-program or mobile qualification is claimed. Locale parity
retains pre-existing error-code/E2E table differences. The historical
[default-profile incident](rust-inspection-isolation-incident.json) is unresolved;
these isolated results do not prove the earlier user data was unaffected.
