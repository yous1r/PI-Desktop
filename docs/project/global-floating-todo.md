# Global floating personal todo: implementation plan

Status: Implementation and Windows candidate validation complete; commit/push authorized. Base: `8069856b59d2ea3a57b77247dd83eb4f4fd37f31`.
Branch: `feat/global-floating-todo`. Worktree: `D:/Packages/PI-Desktop-todo`.

## Approved product contract

One personal board per local Desktop data directory, independent of projects,
sessions and the Agent TodoWrite checklist. Each item has a stable id, editable
plain-text title, multiline note and completed flag. Blank titles are valid
drafts and must be persisted. Completed rows retain their position. Each row
has icon-only Copy and Delete actions; Copy writes the current title followed
by a blank line and its full note (only the title when the note is empty).
Copy uses the latest draft, including a collapsed note. The toolbar has icon-only
Pin and Collapse buttons. Every icon has a localized tooltip and accessible name.

The native single-instance window initially measures 360x480 DIP, is draggable
and resizable, and remembers bounds and pin preference. First launch is pinned.
Every process launch opens the board expanded without stealing keyboard focus;
an explicit second launch also opens the existing board. Collapse is runtime-only.
A global titlebar icon beside the work-panel toggle and a tray action reopen it.
Main-window minimize or close-to-tray does not hide the board. Explicit app quit
retains the app's existing lifecycle and flushes personal edits before teardown.
The board's own close action means collapse. Normal desktop windows are covered
when pinned; OS secure desktops and compositor restrictions remain OS-owned.

## Data and ownership

Renderer -> preload IPC -> Main coordinator -> local Rust Host -> SQLite.
Rust exclusively owns content. Use a dedicated versioned `kv` document with
schemaVersion=1, revision, updatedAt and ordered items. No session foreign key,
Agent tool setter, cloud sync or project binding is introduced. RPC methods are
`personalTodos.get` and `personalTodos.replace`; replacement requires
expectedRevision and mutationId. A duplicate mutation retry returns the already
committed document; a conflicting base is rejected without losing local edits.
The Host validates exact keys, unique ids, size limits and Unicode strings.
Durable acknowledgement follows an atomic transaction with FULL SQLite sync
for this write, restoring the prior mode before releasing the DB owner lock.
The database table schema remains unchanged; the document carries its own version.

Main owns the native window, local window preferences and a serial autosave
coordinator. It accepts edits immediately, waits 500ms after the latest edit,
and caps the oldest unsaved wait at 2s. Normal writable operation must acknowledge
persistence within 5s of editing; a deadline watchdog reports delays. A pending
write never allows an older response to mark newer edits saved. Blur, collapse,
and quit flush immediately. Failure retains drafts and offers Retry. Read failure
never manufactures an empty board. Main keeps drafts across widget reloads;
app crashes can lose edits not yet acknowledged. Confirmed saves survive restart.
Quit flush failure cancels shutdown before resources are disposed, shows the
board and permits retry. No provider or user-running app is used as a test host.

The window uses sandbox/context isolation and a narrow dedicated preload.
Main validates sender webContents and main-frame identity for board operations.
Main-window open/status calls are separately authorized. Clipboard writes are
explicit, bounded user actions, with no clipboard reads. New window modules stay
separate from main/index.ts and the app store. Existing entry points only wire them.

## Frozen integration interface

Shared types live in `packages/shared/src/personal-todos.ts`.
`PersonalTodoItem = { id, title, note, completed }`.
`PersonalTodoDocument = { schemaVersion: 1, revision, updatedAt, items }`.
Host replace input: `{ items, expectedRevision, mutationId }`.
IPC `personalTodosGet` returns `PersonalTodoView`; `personalTodosEdit` accepts
`{ items, expectedEditVersion }` and returns that view. Main increments editVersion
on acceptance. The widget serializes immediate edits and preserves newer local
input while earlier requests complete; it never renders late state over a draft.
`personalTodosFlush` returns a view after committing. `personalTodosWindow` accepts
`{ action: 'open' | 'collapse' }` or `{ action: 'pin', value: boolean }`.
`personalTodosCopy` accepts `{ title, note }`. All invokes use the existing Result
envelope. `personalTodosChanged` carries a view. Appearance is a safe subset of
settings, not a general settings IPC capability. See shared types for exact names.

## Delivery route, dependencies and acceptance

| Step | Owner | Depends on | Deliverables | Acceptance |
|---|---|---|---|---|
| 0 | Parent | Existing request | Latest-main dedicated branch/worktree; reusable tools | Primary user changes preserved; clean start |
| 1 | Parent | 0 | This plan, shared DTOs/IPC, ownership map | Product decisions represented; both lanes use one contract |
| 2A | opencode-go/gpt-6-luna | 1 | Rust personal todo repository/RPC + tests | Unicode/notes/empty drafts, CAS, idempotency, durable restart, invalid input all tested |
| 2B | opendesign/gpt-6-luna | 1 | Widget, app entry, CSS, all shipped locales, interaction tests | CRUD, per-item notes, latest-text copy, icons, errors, no stale response overwrite |
| 3 | Parent, concurrent with 2 | 1; integration needs 2A/2B | Main autosave, window, narrow preload, IPC, tray/startup/quit | 500ms idle/2s max, failures visible, singleton, pin persistence, reopen expanded, sender rejection |
| 4 | Parent | 2A/2B/3 | Synced ADR/spec/E2E docs, build/typechecks, focused tests, isolated Electron journey | Full edit/save/collapse/restart path, clipboard, native state, failure recovery and regressions pass |
| 5 | Parent | 4 | Diff review and validation report | Only scoped changes, actual results and OS limitations stated; no implicit commit/push |

Ownership: backend delegate exclusively edits `crates/host-core` personal-todo
modules and required Rust registration sites. Frontend delegate exclusively edits
`apps/desktop/src`, `packages/i18n`, and widget interaction tests. Parent owns
shared contracts, `apps/desktop/electron`, Main tests, scripts, docs and integration.
No recursive delegation, overlapping edits, dependency installs, commits or pushes.
Each milestone is reported in the conversation and this record is updated with
actual check results. Delegates may read other lanes but must not edit their files.

## Verification matrix

- Host tests: validation, duplicate ids/unknown fields/oversize input, revision
  conflicts, idempotent retries, empty-list revision, rollback, restart, durable sync.
- Controlled-clock Main tests: continuous typing, edits during save, timeout/error,
  retry after lost response, failed load, collapse/quit flush, no stale clean state.
- Rendered interaction: add/edit Chinese title/note, collapse note, copy newest
  draft, completion/deletion, retries, aria labels and icon-only controls.
- IPC/window tests: unauthorized window/subframe/navigation, singleton construction,
  pin toggle/persistence, geometry clamping, main hide independence, close-collapse.
- Isolated Electron + real Host: edit to disk within 5s, continuous input, immediate
  quit, reopen expanded, pin preference, notes/clipboard, main hide and restore.
- Regression: existing session TodoWrite and relevant window/quit suites.
- Build/types and relevant lint. Do not run `verify:ui:*` or contact real providers.
- Native OS restrictions cannot be proven by DOM tests; report platform coverage.

## Progress and evidence

- Step 0 complete: dedicated worktree updated to the recorded base; primary changes preserved.
- Step 1 complete: approved design and additive integration contract recorded.
- Step 2A complete: Rust repository/RPC, bounded validation, revision CAS,
  idempotent retries and full-sync transaction restoration implemented by the
  opencode-go GPT-6-Luna lane. Personal todo tests: 10 passed. Existing session
  todo tests: 26 passed; todo RPC tests: 6 passed; DB tests: 40 passed.
- Step 2B complete: standalone widget, global titlebar entry, per-item notes,
  icon controls and all nine locales implemented by the opendesign GPT-6-Luna
  lane. Parent completed integration fixes and executed rendered interaction
  coverage after repairing the task Electron runtime link.
- Step 3 complete: narrow preload, sender validation, Main autosave, startup/tray,
  placement/pin, quit drain/freeze/flush and normal-close release integrated.
  Regression tests reproduced and fixed concurrent-open early display, document
  envelope size mismatch, persistence retry, and close-to-collapse blocking quit.
- Step 4 complete: production Electron/Host Windows journey passed. It covers
  add/edit, multiline Chinese notes, clipboard, continuous saves, completion,
  delete, collapse/titlebar reopen, main hide independence, pin persistence,
  immediate quit disk verification and two further launches (restart expands).
  A disposable data/profile/agents directory was used; no provider requests ran.
  Final run did not load global MCP configuration. Earlier harness attempts
  exposed development capture behavior and global MCP discovery; the final
  harness explicitly isolates those paths.
- Step 5 complete: scoped tracked and untracked diff reviewed, specs/ADR/changelog
  updated, temporary task artifacts removed. The primary checkout's unrelated
  files remain unchanged. The user subsequently authorized a commit and push
  of this feature branch; PR creation and merge are outside this delivery.

### Executed validation

| Check | Result |
|---|---|
| Main/coordinator/preload/window + existing lifecycle suites | 39 tests passed |
| Real Electron rendered widget user path + locale/routing contract | 2 tests passed; no skips |
| Rust personal todo repository and RPC | 10 tests passed |
| Rust existing Todo/RPC/DB regression selection | 26 + 6 + 40 tests passed |
| i18n catalog/key/copy tests | 32 tests passed |
| Shared protocol and changelog tests | 20 tests passed |
| Desktop TypeScript check; internal shared/i18n builds | Passed |
| Electron/Vite production build; Host debug build | Passed |
| Host Clippy all targets | Passed with four pre-existing warnings in unrelated code |
| cargo fmt --check | Passed |
| Style tokens, architecture gate, project Biome lint | Passed |
| Explicit new-feature Biome lint with the same no-unused rule | Passed (13 files) |
| git diff --check; check:pr-base | Passed |
| scripts/e2e-personal-todos.mjs with built Host | Passed on Windows / Electron 43.6.0 |

Initial candidate base: `8069856b59d2ea3a57b77247dd83eb4f4fd37f31`, plus
this request's changes. The fetched main matched that base. The same feature
source is being committed on `feat/global-floating-todo`; rerun the focused
Electron suite against the resulting commit before pushing. A future PR still
needs its own recorded integration candidate and repository landing gates.

The architecture gate does not count untracked new TS files. They were checked
separately: the largest feature TSX module is below 500 lines and new Rust
modules are below 700 lines. No dependency or lockfile change is part of delivery.
An unintended dependency preparation during the frontend lane hit a node-pty
MSB8040 environment error; direct checks and the final Electron run passed after
reusing the host Electron runtime. No dependency reinstall is needed for this
feature's delivered source.

### Coverage limits

Native validation ran on Windows only. Secure desktops, compositor/fullscreen
precedence, native tray interaction and physical display changes were not
manually verified; window-handler/geometry tests cover the corresponding logic.
Plugin theme CSS is not exported to this narrow surface, so plugin themes use
system light/dark; language and font preference are applied. The full repository
unit suite and unrelated E2E suites were not run. `verify:ui:*` was not invoked.
A process failure before a durable acknowledgement can lose the unacknowledged
interval; failed writes retain their draft and visibly block normal quit until
saved or the user cancels quitting.


## PR #14 CI follow-up

The initial PR run had three red checks with two root causes. Both JS unit
checks and Docs checks failed because the new English IPC table was absent
from the Chinese mirror. Trusted extensions Electron E2E selected the first
CDP page and connected to the new personal-todo surface, where the Settings
navigation does not exist. The first fatal error was `cannot click
button[data-nav="settings"]: missing`; GPU/plugin errors followed runner cleanup.

The follow-up synchronizes all six personal-todo spec additions in the Chinese
mirrors. Both affected E2E connectors now share an explicit production main-page
selector: a file URL ending in `/renderer/index.html` without a `surface` query
parameter. Missing or ambiguous main pages fail before connection. Four tests
exercise the actual connectors with widgets, encoded surface parameters, plugin
pages, remote pages and ambiguous lists. The tests failed before the correction
and pass after it; the docs locale check also reproduced before the correction.

Local follow-up results:

- Main-page connector and personal-todo regression selection: 19 tests passed.
- All documentation tests: 13 passed.
- Locale check: 88 English/Chinese pairs verified; docs check: 610 pages verified.
- VitePress site build: passed using the existing host dependency environment.
- Full trusted extensions Electron/Host journey: 64/64 passed on Windows with
  a deterministic local provider and a canonical isolated run root. The default
  Windows temporary short path caused three path-comparison failures on the
  first attempt; the canonical-path rerun passed without changing app logic.
- File Manager light/dark theme user path: passed.
- Project Biome lint, explicit changed-test lint, architecture and diff checks:
  passed. No production runtime code, provider settings or dependency manifests
  changed in this follow-up.

The follow-up updates the existing feature branch and PR. Remote CI still needs
its own Linux integration result; local Windows results do not claim that result.


### Remaining source-contract assertions

PR head `46b78df4a81554b7d8351d68af272c0b34ac9776` passed Docs, Trusted
extensions Electron E2E, Rust, Windows Host, base and package checks. The now
unblocked full Linux JS run completed 4,768 Desktop tests successfully and
reported exactly two failed source assertions. Both still described behavior
from before this feature: zero titlebar padding with the work panel open, and
a shutdown guard without the todo-preparation phase. Both failures reproduced
locally. The assertions now require the approved two-control header reserve
and the todo preparation/idempotence ordering; no production code changed.

The updated contract suites, shutdown behavior suite and renderer-target suite
passed together (46 tests). Changed-test lint and diff checks passed. A full
Windows Desktop test attempt also encountered unrelated POSIX-path assumptions,
a native process/fixture failure, a GenUI protocol loader failure and an S3 UI
fixture timeout; it is not recorded as passing. The Linux PR run remains the
full-suite acceptance check for this follow-up.
