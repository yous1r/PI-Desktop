import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  TerminalExitEvent,
  TerminalReplayResult,
  TerminalShellProfile,
  TerminalTargetContext,
} from "@pi-desktop/shared";
import {
  createTerminalPendingBuffer,
  terminalBufferChunk,
  terminalChunksAfterSnapshot,
} from "@pi-desktop/shared";

import { api } from "../../lib/api";
import {
  decodeTerminalChunk,
  terminalFailureState,
  terminalHostIdentity,
  terminalPalette,
  type TerminalPaneFailure,
  type TerminalPaneStatus,
} from "../../lib/terminal-pane";
import {
  closeTerminalForTab,
  forgetTerminalHandle,
  setTerminalHandle,
  terminalHandleFor,
} from "../../lib/terminal-sessions";
import { IconPlug, IconRefresh } from "../icons";
import { Badge, Select, TooltipButton } from "../ui";

/**
 * One work-panel terminal, local or remote.
 *
 * The shell lives in Electron main: a PTY on this machine, or a shell on the
 * paired `pi-host` when the target workspace is remote. This component owns the
 * xterm view, forwards keystrokes, and reports its size — it never spawns a
 * process and never opens a connection itself.
 *
 * Unmounting detaches without ending the shell, so a background command keeps
 * running across a tab, project, or session switch; `lib/terminal-sessions`
 * holds the tab-to-terminal map that survives the unmount. Only an explicit
 * close (tab close, Restart, or the shell's own exit) ends the process.
 *
 * Ordering is the delicate part: main can emit output *before* the
 * `terminalCreate` response and around a replay, so the event stream is
 * subscribed first and every pre-attach chunk is buffered. The snapshot is then
 * painted and only chunks it does not already contain are written — see
 * `terminalChunksAfterSnapshot`. An older host has no sequence numbers; there
 * the snapshot wins and no chunk is painted twice.
 *
 * A lost host is never "worked around" by spawning a replacement shell: a
 * terminal that cannot be reached is reported as offline (handle kept, Retry
 * attachment re-reads the snapshot) or exited/failed (only an explicit Restart
 * opens a new shell). Input is never queued, so nothing is replayed later.
 */
export function TerminalTab({
  tabId,
  target,
  hostLabel,
  hostKey,
  workspacePath,
}: {
  tabId: string;
  /** Creation-time target: session, workspace identity, and owning tab. */
  target: TerminalTargetContext;
  /** Display name of the remote host; absent for a local terminal. */
  hostLabel?: string;
  hostKey?: string;
  workspacePath?: string;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** Set while the transport is known to be failing, so input is not "sent". */
  const transportDownRef = useRef(false);

  const [shells, setShells] = useState<TerminalShellProfile[]>([]);
  const [shellId, setShellId] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalPaneStatus>("loading");
  const [failure, setFailure] = useState<TerminalPaneFailure | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [overflowed, setOverflowed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const identity = useMemo(
    () =>
      terminalHostIdentity({
        hostLabel,
        hostKey,
        workspacePath,
        localLabel: t("panel.terminal.localHost"),
      }),
    [hostLabel, hostKey, workspacePath, t],
  );

  const sessionId = target.sessionId;
  const workspaceId = target.workspaceId;

  /**
   * Report a transport failure instead of swallowing it.
   *
   * The keystroke that hit it is dropped rather than queued: replaying input
   * after a reconnect would run commands the user never asked to run again.
   */
  const reportTransportFailure = useCallback(
    (cause: unknown) => {
      transportDownRef.current = true;
      const next = terminalFailureState(cause);
      if (next.code === "TERMINAL_GONE") {
        // The shell is gone, not merely unreachable: no retry can attach.
        terminalIdRef.current = null;
        forgetTerminalHandle(tabId);
        setExitCode(null);
        setFailure(null);
        setStatus("exited");
        return;
      }
      setFailure(next);
      setStatus(next.status);
    },
    [tabId],
  );

  /** Input is only sent while the view is attached and the transport is up. */
  const sendInput = useCallback(
    (data: string) => {
      const id = terminalIdRef.current;
      if (!id || transportDownRef.current) return;
      void api.terminalWrite(id, data).catch((cause) => {
        if (terminalIdRef.current !== id) return;
        reportTransportFailure(cause);
      });
    },
    [reportTransportFailure],
  );

  // Probe the shells of the target host. A failure here means no terminal at
  // all, so it is stated instead of leaving an empty pane behind.
  useEffect(() => {
    let cancelled = false;
    void api
      .terminalListShells({ target: { sessionId, workspaceId, tabId } })
      .then(({ shells: list }) => {
        if (cancelled) return;
        setShells(list);
        setShellId(
          (current) =>
            current ?? list.find((item) => item.isDefault)?.id ?? list[0]?.id ?? null,
        );
        if (list.length === 0) {
          setStatus("failed");
          setFailure({ status: "failed", code: "TERMINAL_SHELL_UNAVAILABLE" });
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const next = terminalFailureState(cause);
        setStatus(next.status);
        setFailure(next);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, workspaceId, tabId, generation, attempt]);

  // Own the terminal for this tab. `generation` restarts a shell the user asked
  // to restart; `attempt` re-attaches the *same* shell for a Retry.
  useEffect(() => {
    if (!shellId) return;
    let cancelled = false;
    disposedRef.current = false;
    transportDownRef.current = false;
    setStatus("loading");
    setFailure(null);
    setExitCode(null);
    setOverflowed(false);

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      const host = hostRef.current;
      const alive = () => !cancelled && !disposedRef.current;
      if (!alive() || !host) return;

      // xterm measures glyphs through a canvas that cannot resolve custom
      // properties, so both the font stack and the palette are read as
      // computed values rather than passed as `var(...)` strings.
      const styles = getComputedStyle(host);
      const readToken = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;
      const scale = Number.parseFloat(readToken("--font-scale", "1"));
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: readToken("--font-mono", "monospace"),
        fontSize: Number.isFinite(scale) && scale > 0 ? Math.round(12 * scale) : 12,
        scrollback: 5000,
        convertEol: true,
        theme: terminalPalette(readToken),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try {
        fit.fit();
      } catch {
        // The pane can be zero-sized while the panel animates open.
      }

      const pending = createTerminalPendingBuffer();
      const pendingExits: TerminalExitEvent[] = [];
      const applyExit = (event: TerminalExitEvent) => {
        terminalIdRef.current = null;
        forgetTerminalHandle(tabId);
        setExitCode(event.exitCode);
        setStatus("exited");
      };

      // Subscribe *before* create/replay: main may already be emitting.
      const unsubData = api.onTerminalData((event) => {
        const known = terminalIdRef.current;
        if (known) {
          if (event.terminalId === known) term.write(decodeTerminalChunk(event.data));
          return;
        }
        terminalBufferChunk(pending, event);
      });
      const unsubExit = api.onTerminalExit((event) => {
        const known = terminalIdRef.current;
        if (known) {
          if (event.terminalId === known) applyExit(event);
          return;
        }
        pendingExits.push(event);
        if (pendingExits.length > 4) pendingExits.shift();
      });

      let localCleanup: (() => void) | null = () => {
        unsubData();
        unsubExit();
        term.dispose();
      };
      const stop = () => {
        localCleanup?.();
        localCleanup = null;
      };
      /** Ends a shell this run created and never registered for a later mount. */
      let createdId: string | null = null;
      const abandonCreated = () => {
        if (!createdId) return;
        const id = createdId;
        createdId = null;
        void api.terminalClose(id).catch(() => undefined);
      };

      const existing = terminalHandleFor(tabId);
      let terminalId = "";
      let snapshot: TerminalReplayResult | null = null;

      if (existing) {
        try {
          snapshot = await api.terminalReplay(existing.terminalId);
        } catch (cause) {
          stop();
          if (!alive()) return;
          const next = terminalFailureState(cause);
          if (next.status === "offline") {
            // The handle is kept so Retry attachment replays this same shell
            // once the host answers again.
            setStatus("offline");
            setFailure(next);
            return;
          }
          // The host already dropped it. Nothing is replaced silently: the pane
          // says it exited and only the explicit Restart opens a new shell.
          forgetTerminalHandle(tabId);
          setExitCode(null);
          setStatus("exited");
          setFailure(next);
          return;
        }
        if (!alive()) {
          stop();
          return;
        }
        terminalId = existing.terminalId;
      } else {
        let opened;
        try {
          opened = await api.terminalCreate({
            target: { sessionId, workspaceId, tabId },
            shellId,
            cols: term.cols,
            rows: term.rows,
          });
        } catch (cause) {
          stop();
          if (!alive()) return;
          const next = terminalFailureState(cause);
          setStatus(next.status);
          setFailure(next);
          return;
        }
        if (!alive()) {
          // The tab closed while the shell was being spawned: end it rather
          // than leaking a terminal nobody can reach.
          void api.terminalClose(opened.terminalId).catch(() => undefined);
          stop();
          return;
        }
        terminalId = opened.terminalId;
        createdId = terminalId;
        // The create response carries no output, so a snapshot is read even for
        // a brand-new shell: whatever main emitted before this point is there,
        // including a chunk that raced the create response.
        try {
          snapshot = await api.terminalReplay(terminalId);
        } catch (cause) {
          stop();
          if (!alive()) {
            void api.terminalClose(terminalId).catch(() => undefined);
            return;
          }
          const next = terminalFailureState(cause);
          if (next.status === "offline") {
            // The shell exists on the host; keep it so Retry can resync.
            setTerminalHandle(tabId, {
              terminalId,
              target: { sessionId, workspaceId, tabId },
              cols: term.cols,
              rows: term.rows,
            });
            createdId = null;
            setStatus("offline");
            setFailure(next);
            return;
          }
          setStatus("failed");
          setFailure(next);
          return;
        }
        if (!alive()) {
          stop();
          void api.terminalClose(terminalId).catch(() => undefined);
          return;
        }
      }

      if (snapshot === null || snapshot.data === null) {
        // replay answered null: the process was already gone when the snapshot
        // was taken, so there is nothing to attach to.
        stop();
        forgetTerminalHandle(tabId);
        abandonCreated();
        if (!alive()) return;
        setExitCode(null);
        setStatus("exited");
        return;
      }

      terminalIdRef.current = terminalId;
      setTerminalHandle(tabId, {
        terminalId,
        target: { sessionId, workspaceId, tabId },
        cols: term.cols,
        rows: term.rows,
      });
      // The handle now outlives this view, so an unmount detaches instead of
      // closing it.
      createdId = null;

      // Snapshot first, then only the chunks it does not already contain.
      const { write } = terminalChunksAfterSnapshot(
        pending.chunks.filter((chunk) => chunk.terminalId === terminalId),
        snapshot.sequence,
      );
      term.write(decodeTerminalChunk(snapshot.data));
      for (const chunk of write) term.write(decodeTerminalChunk(chunk.data));

      // The shell kept the size its detached view had; restore it to this
      // viewport or it wraps output at the wrong column count.
      void api.terminalResize(terminalId, term.cols, term.rows).catch((cause) => {
        if (terminalIdRef.current !== terminalId) return;
        reportTransportFailure(cause);
      });

      if (pending.overflowed) {
        // Chunks were dropped, so the pane cannot claim the screen is complete:
        // say so and leave Retry attachment to resync from a fresh snapshot.
        setOverflowed(true);
        setStatus("failed");
        setFailure({ status: "failed" });
      } else {
        setStatus("ready");
      }

      const exit = pendingExits.find((event) => event.terminalId === terminalId);
      if (exit) applyExit(exit);

      const inputDisposable = term.onData((data) => sendInput(data));
      const resizeDisposable = term.onResize(({ cols, rows }) => {
        const id = terminalIdRef.current;
        if (!id || transportDownRef.current) return;
        void api.terminalResize(id, cols, rows).catch((cause) => {
          if (terminalIdRef.current !== id) return;
          reportTransportFailure(cause);
        });
      });

      // Fit on container changes, throttled to one animation frame: dragging
      // the panel divider fires far more events than a resize can absorb.
      let frame = 0;
      const observer = new ResizeObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          try {
            fit.fit();
          } catch {
            // Zero-sized pane.
          }
        });
      });
      observer.observe(host);

      let attachedCleanup: (() => void) | null = () => {
        localCleanup?.();
        localCleanup = null;
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect();
        inputDisposable.dispose();
        resizeDisposable.dispose();
        term.dispose();
      };
      cleanupRef.current = () => {
        attachedCleanup?.();
        attachedCleanup = null;
      };
    })();

    return () => {
      cancelled = true;
      disposedRef.current = true;
      // Detach only: the shell keeps running in main so a background command
      // survives a tab, project, or session switch. It ends when it exits on
      // its own, on `restart`, or when the tab is actually closed.
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [sessionId, workspaceId, tabId, shellId, generation, attempt, sendInput, reportTransportFailure]);

  /** Restart: an explicit end of this shell and a new one. */
  const restart = useCallback(() => {
    closeTerminalForTab(tabId);
    terminalIdRef.current = null;
    transportDownRef.current = false;
    setGeneration((value) => value + 1);
  }, [tabId]);

  /**
   * Retry attachment: re-read this terminal's snapshot and re-subscribe.
   *
   * This is not a restart — the shell is neither killed nor replaced, so a
   * dropped connection costs the scrollback gap, not the running command.
   */
  const retryAttachment = useCallback(() => {
    transportDownRef.current = false;
    setFailure(null);
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, []);

  const busy = status === "loading";
  const canRetryAttachment = status === "offline" || status === "failed";

  return (
    <div className="terminal-tab" data-testid={`terminal-tab-${tabId}`}>
      <div className="terminal-tab__bar">
        <Badge className="terminal-tab__host">
          <span className="sr-only">{t("panel.terminal.hostLabel")}: </span>
          {identity.label}
        </Badge>
        {identity.detail ? (
          <span className="terminal-tab__path" title={identity.detail}>
            {identity.detail}
          </span>
        ) : null}
        <Select
          className="terminal-tab__shell"
          aria-label={t("panel.terminal.shell")}
          value={shellId ?? ""}
          disabled={busy || shells.length === 0}
          onChange={(event) => {
            const next = event.target.value;
            if (next === shellId) return;
            // A different shell is a different process: end the old one instead
            // of detaching it with no view that could ever reach it again.
            closeTerminalForTab(tabId);
            terminalIdRef.current = null;
            setShellId(next);
          }}
        >
          {shells.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </Select>
        <span className="terminal-tab__status" role="status" aria-live="polite">
          {statusLabel(status, exitCode, failure, overflowed, t)}
        </span>
        {canRetryAttachment ? (
          <TooltipButton
            type="button"
            // Same icon-button geometry as Restart (the shared class), kept as
            // its own hook so a test or a theme can tell the two apart.
            className="terminal-tab__restart terminal-tab__reconnect"
            tooltip={t("panel.terminal.reconnect")}
            ariaLabel={t("panel.terminal.reconnect")}
            onClick={retryAttachment}
            disabled={busy}
          >
            <IconPlug size={14} />
          </TooltipButton>
        ) : null}
        <TooltipButton
          type="button"
          className="terminal-tab__restart"
          tooltip={t("panel.terminal.restart")}
          ariaLabel={t("panel.terminal.restart")}
          onClick={restart}
          disabled={busy}
        >
          <IconRefresh size={14} />
        </TooltipButton>
      </div>
      <div
        className="terminal-tab__surface"
        ref={hostRef}
        role="group"
        aria-label={t("panel.terminal.title")}
      />
    </div>
  );
}

/** One line for the status region: the shell's state, or the stated failure. */
function statusLabel(
  status: TerminalPaneStatus,
  exitCode: number | null,
  failure: TerminalPaneFailure | null,
  overflowed: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (status === "offline") {
    return [t("panel.terminal.offline"), failure?.detail, t("panel.terminal.offlineHint")]
      .filter(Boolean)
      .join(" · ");
  }
  if (status === "failed") {
    if (overflowed) return t("panel.terminal.bufferOverflow");
    const title =
      failure?.code === "TERMINAL_SHELL_UNAVAILABLE"
        ? t("panel.terminal.noShells")
        : t("panel.terminal.failed");
    return [title, failure?.detail].filter(Boolean).join(" · ");
  }
  if (status === "exited") {
    return exitCode === null
      ? t("panel.terminal.exited")
      : t("panel.terminal.exitedWithCode", { code: exitCode });
  }
  return status === "loading" ? t("panel.terminal.connecting") : "";
}
