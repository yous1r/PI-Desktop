# Unreleased changes

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
