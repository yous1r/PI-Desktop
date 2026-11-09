# Unreleased changes

- Retain paired-Host SSH tunnel creation and cleanup through late completion.
  Shared handoff admission blocks new acquisitions without interrupting live
  tunnels, disposal stays sealed, concurrent cleanup joins and old deployment
  callbacks cannot use replacement transports. Cleanup errors remain observable;
  full remote ownership transfer and native-family qualification remain pending.
- Correct local Dictation's asynchronous native streaming adapter and retain its
  original model/session through cancellation and compute completion. Duplicate
  loads join, stale loads cannot revive an unloaded model, ordered feeds own PCM,
  and structured finalization returns the native final text. Batch cancellation,
  fallback and cleanup remain observable; native-family qualification and
  download/service/microphone-lease integration remain separate work.
- Bind Dictation preparation, capture and transcription to their original recording.
  Cancelled work stays counted until completion; late frames, results and cleanup
  cannot overwrite a newer recording. Concurrent stops join once, and cancelled
  streams cannot start batch fallback. Service/lease integration remains separate
  work; native runtime ownership is covered by the entry above.
- Keep local Dictation's original recorder alive until queued native reads finish.
  Concurrent start/stop/cancel share ownership and cleanup; failed release retains
  the capture reservation. Shared admission blocks new capture without
  interrupting an admitted recording. Full Voice/handoff integration remains open.
- Bind Desktop Speech to shared admission, its original Host and plugin adapter.
  Retired callbacks cannot borrow replacement authority; original HTTP bodies,
  response cleanup and scratch writes remain counted through disposal. Confirmed
  quit aborts original HTTP without replaying or rolling back admitted writes.
  Ordinary response close and plugin exit remain insufficient for full handoff.
- Keep malformed OAuth response bodies out of login errors and refresh logs;
  JSON decoding reports a fixed error without credential-bearing fragments.
- Bind MCP OAuth login, refresh and secret changes to shared Desktop admission and
  their original Host. Cancelled HTTP bodies, browser setup and listener cleanup
  stay counted; stale callbacks cannot write through a replacement or revive
  deleted secrets. Exchange/storage failures now settle consumed callbacks, and
  temporary authorization tests preserve newer configuration. Full handoff and
  native-family qualification remain pending.
- Retain user MCP HTTP bodies, SSE streams and cancellation sends after caller
  completion or cache retirement. Old connections and delayed redirects cannot
  bypass shared admission or borrow replacement entries. Existing timeouts,
  transport security and conservative native refusal evidence remain unchanged.
- Bind trusted-extension prompts, publications, model configuration and queue work
  to shared Desktop admission and their original sidecar/Host. Retired prompt tails
  and original RPCs stay counted, stale results cannot broadcast through a new
  owner, and notification failures cannot strand prompt waiters. Host rebind and
  Sidecar disposal retain pending work and unknown completion. Full handoff remains pending.
- Bind trusted-extension workspace processes to shared handoff admission and their
  original Host/connection. Retired operations keep their process slots, concurrent
  cleanup joins, and delayed startups cannot escape cleanup. Sidecar disposal,
  session retirement and explicit Host rebind retain unfinished work and native
  uncertainty. Complete resource inventory and native-family qualification remain open.
- Restore owner-extension calls after ordinary Host restart through explicit
  sidecar rebinding. Old calls and runtime IDs are revoked while unfinished work
  stays counted; the next idle launch rebuilds only affected owner extensions.
- Keep plugin extension-owner work bound to its original Host generation and
  launch. Cancelled lookups and callbacks remain counted; replaced bridges and
  late session cleanup cannot hide work or clear newer ownership. Shared handoff
  admission blocks ordinary entry while preserving the existing authorized
  retirement window and descendant cancellation. Full transfer remains pending.
- Bind plugin panels, embedded views and global shortcuts to shared handoff
  admission and their original installation/registration. Late opens and old
  callbacks cannot use a replacement; timed-out page loads, bridge work and
  retiring pages remain counted. Temporary admission holds preserve loaded view
  state. Complete resource inventory and native-family qualification remain open.
- Bind plugin sockets and workspace previews/downloads to shared handoff admission
  and their original owners. Retired work, HTTP reads and asynchronous cleanup stay
  counted; old socket events cannot reach a reloaded plugin. Late validation,
  download choices and SSH environment setup cannot start new work after closure.
  Active forwards survive temporary idle checks, and unqualified resource
  evidence remains after ordinary close. Full ownership transfer remains pending.
- Keep plugin callbacks, workspace startup/context lookup, MCP transport and
  managed-connection work owned after cancellation or unload. Closed admission
  refuses ordinary callbacks, tools, commands and broadcasts while preserving
  active teardown hooks. Old command/configuration/instance references cannot
  borrow a replacement's authority. Native-family closure and complete Desktop
  ownership transfer remain under development.
- Keep plugin loads and cleanup bound to their original lifecycle during idle
  handoff. Late process creation cannot revive an unloaded plugin, concurrent
  cleanup joins, and an old crash restart cannot replace newer service state.
  Shutdown seals admission synchronously and retains unfinished cleanup activity.
  Complete plugin inventory and native-family closure remain under development.
- Bind browser operations to shared Desktop admission and their original page,
  Host generation and debugger connection. Timed-out or retired work stays
  counted until it settles; late screenshots cannot write new files after
  admission closes. Native creation attempts remain unqualified after ordinary
  disposal, and complete ownership transfer remains under development.
- Gate workspace terminal work during idle handoff and keep delayed operations
  bound to their original Host and connection. Window retirement retains pending
  output and unqualified PTY/remote-terminal resources; close or ordinary exit
  does not establish native-family closure. Full transfer remains in development.
- Include user MCP setup and calls in Desktop handoff activity. Closed admission
  prevents late client creation and stale-client dispatch; cancellation, timeout
  and ordinary close retain unqualified resource evidence. Complete ownership
  transfer remains under development.
- Fix Plan/Goal approval and lazy expiry failing immediately under an overlapping
  SQLite writer. Both transactions reserve the writer before reading, preserving
  the existing busy timeout and atomic state/audit updates without replaying RPCs.
- Keep approved-plan launch and cleanup bound to their original Host and sidecar.
  Lock waits, retries and unconfirmed cleanup remain visible to idle inspection;
  interrupted setup cannot start later. Launch resolution rejects stale owner
  results, and confirmed shutdown cancels plan retries. Complete ownership
  transfer remains under development.
- Share Desktop admission across local IPC, AgentHost, scheduled work and runtime
  setup. Confirmed shutdown blocks new starts, and a restart that closes while
  awaiting a child no longer drains plans or announces readiness. Complete idle
  ownership transfer remains under development.
- Add strict ownership-handoff contracts and a bounded Node consumer for the
  existing restricted Rust recovery mode. Ambiguous replies cannot be reused
  for later operations; exact identity, phase and native exit checks remain
  required. Complete Desktop transfer and readiness remain under development.
- Add private sidecar quiescence for ownership handoff, with strict identity,
  initialization/background execution counts, lost-response reconciliation and
  irreversible local sealing. Unconfirmed reverse Host calls and unqualified
  resources refuse transfer. Full application handoff remains under development.
- Keep ownership-handoff admission closed until explicit source cancellation;
  once native fencing begins, the local hold cannot reopen. Ordinary maintenance
  keeps its existing lease. Plan dispatch now counts session-lock waits and
  pending finalization, refuses late claims after closure, and cleans up retry
  timers. Complete Desktop-to-background transfer is still under development.
- Add durable Windows execution-owner registration and guarded recovery in
  schema v28. Unfinished transfers block ordinary startup; explicit private
  claim/recover validates native closure and keeps retained idempotent receipts.
  Full Desktop-to-background idle handoff is still under development.
- Add opt-in Windows native sidecar containment. The Rust Host admits the
  runtime before Node starts and can confirm closure of its owned process
  family. Default app startup is unchanged; durable handoff remains pending.
- Add opt-in Windows Host owner discovery with `--owner-control` and
  `--owner-status`. Queries authenticate both local peers and report a live
  owner without starting a second Host. Default launches remain unchanged;
  execution transfer is not yet available.
- Add OpenAI Fast mode (#1657). Allow it per model in Settings → Models for a
  ChatGPT subscription or an OpenAI Responses connection, then type `/fast` to
  turn it on for the current conversation. Requests ask for the priority
  service tier, which replies faster and spends plan limits faster or bills
  more per token; the Composer model chip shows a Fast mark while it is on.
- Fixed an older regenerated prompt appearing after the latest reply when its
  branch archive completed outside the loaded history window (#1870). Pager
  acknowledgements now update existing rows without appending historical roots.
- Generate inline visualizations faster. The visualization shell now preloads
  the bundled D3 and a `viz` chart helper layer (container sizing, resize and
  theme redraw, axes, tick overlap, legends, and a declarative `viz.render`
  for bar, line, area, point, heatmap, and donut charts), so model-written
  fragments are shorter. The `visualize` skill asks for a single write
  followed by the reply instead of reading the file back. Fragments written
  under the earlier skill keep rendering. When a fragment's script fails, the
  card now says so and shows the error instead of staying blank, and the
  model's write result flags syntax errors and missing chart containers so it
  can fix them with one edit.
