# Unreleased changes

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
