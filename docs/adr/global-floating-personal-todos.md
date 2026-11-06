# ADR: Global floating personal todos

- Status: Accepted for implementation
- Related: [Implementation plan](../project/global-floating-todo.md),
  [Session todos](0312-session-scoped-todo-checklist.md),
  [Native widget precedent](0316-live-voice-docked-widget.md)

## Context

Users need their own checklist with per-item notes while working in other apps.
The session TodoWrite contract belongs to an active Agent turn and cannot safely
share an editable list with a person. An in-window overlay cannot float over other
applications or remain visible when the main window hides.

## Decision

Create one native personal-todo window per local Desktop profile. It opens on
startup, defaults to pinned, remembers geometry/pin preference, and collapses to
a global titlebar icon. Collapse lasts only for this process. A tray action also
opens the window. Main-window visibility does not own the widget's visibility.
The widget's close action collapses it; app quit still follows ordered shutdown.

The Host stores one versioned document and last-mutation fingerprint atomically
in a dedicated `kv` namespace. CAS revision checks and an idempotency token make
lost-response retries safe. FULL synchronization applies to this transaction
under the existing Host lock and the prior synchronous setting is restored. No
session, Agent tool, remote-host or configuration-sync contract is reused.

Main owns the draft and serial 500ms-idle / 2s-max-wait save scheduler. Only a
committed response marks edits saved. A 5s deadline produces a visible error if
storage does not acknowledge; failures retain drafts. Quit drains renderer edits
and flushes Main before tearing down Host; a failed flush permits retry/cancel.

A dedicated sandboxed preload exposes only personal-todo invokes/events. Content
mutations require the widget's exact webContents, main frame and renderer URL.
Main-shell reads/open are separately authorized. Clipboard is write-only and
triggered by Copy. Popups and navigation outside the exact renderer URL are denied.

## Alternatives and consequences

- Reuse session TodoWrite: rejected; Agent changes and session deletion would
  interfere with personal data and its running-turn authorization.
- Use a normal React overlay: rejected; it cannot satisfy native cross-app pinning.
- Add database tables: unnecessary for one bounded ordered document; the existing
  kv extension boundary preserves the DB schema and the document versions itself.
- Save only after typing stops: rejected; continuous typing would violate 5s.
- Expose the general main preload: rejected; the widget needs a small capability set.

One additional renderer remains allocated while collapsed. Platform secure
surfaces and compositor stacking restrictions remain OS-owned. A process or OS
failure before a durable acknowledgement can lose the unacknowledged interval.
The board is local to the selected data directory and does not migrate with chats.
