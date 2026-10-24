import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TerminalShellProfile } from "@pi-desktop/shared";

import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { TooltipButton } from "../ui";
import { IconRefresh } from "../icons";
/**
 * One work-panel terminal. The PTY lives in the main process; this component
 * owns the xterm view, forwards keystrokes, and reports its size.
 *
 * Every await is followed by a liveness check: a session switch, a tab close,
 * or a renderer reload can land between creating the PTY and subscribing to it,
 * and a terminal created for a gone component would never be closed.
 */
export function TerminalTab({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const showToast = useAppStore((s) => s.showToast);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const [shells, setShells] = useState<TerminalShellProfile[]>([]);
  const [shellId, setShellId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "exited" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  // Load the shell catalog once. A failure here means no terminal at all, so it
  // is surfaced instead of leaving an empty pane.
  useEffect(() => {
    let cancelled = false;
    void api
      .terminalListShells()
      .then(({ shells: list }) => {
        if (cancelled) return;
        setShells(list);
        setShellId((current) => current ?? list.find((s) => s.isDefault)?.id ?? list[0]?.id ?? null);
        if (list.length === 0) {
          setState("failed");
          setError(t("panel.terminal.noShells"));
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState("failed");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const closeTerminal = useCallback(() => {
    const terminalId = terminalIdRef.current;
    terminalIdRef.current = null;
    if (!terminalId) return;
    void api.terminalClose(terminalId).catch(() => undefined);
  }, []);

  // Own the PTY for this tab. Re-running on `generation` restarts a dead shell.
  useEffect(() => {
    if (!shellId) return;
    let cancelled = false;
    disposedRef.current = false;
    setState("loading");
    setError(null);

    void (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const host = hostRef.current;
      if (cancelled || !host) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 12,
        theme: { background: "#00000000" },
        scrollback: 5000,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;
      try {
        fit.fit();
      } catch {
        // The pane can be zero-sized while the panel animates open.
      }

      let opened;
      try {
        opened = await api.terminalCreate({
          shellId,
          cwd: workspacePath ?? undefined,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (cause) {
        if (cancelled) return;
        setState("failed");
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      // The tab may have closed while the PTY was being spawned: close it now
      // rather than leaking a shell nobody can reach.
      if (cancelled || disposedRef.current) {
        void api.terminalClose(opened.terminalId).catch(() => undefined);
        return;
      }
      terminalIdRef.current = opened.terminalId;
      setState("ready");

      const unsubData = api.onTerminalData((event) => {
        if (event.terminalId !== terminalIdRef.current) return;
        const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
        term.write(bytes);
      });
      const unsubExit = api.onTerminalExit((event) => {
        if (event.terminalId !== terminalIdRef.current) return;
        terminalIdRef.current = null;
        setState("exited");
      });

      const inputDisposable = term.onData((data) => {
        const terminalId = terminalIdRef.current;
        if (!terminalId) return;
        void api.terminalWrite(terminalId, data).catch(() => undefined);
      });
      const resizeDisposable = term.onResize(({ cols, rows }) => {
        const terminalId = terminalIdRef.current;
        if (!terminalId) return;
        void api.terminalResize(terminalId, cols, rows).catch(() => undefined);
      });

      // Fit on container changes, throttled to one animation frame: a drag of
      // the panel divider fires far more events than a PTY resize can absorb.
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

      cleanupRef.current = () => {
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect();
        inputDisposable.dispose();
        resizeDisposable.dispose();
        unsubData();
        unsubExit();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      disposedRef.current = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      closeTerminal();
    };
  }, [shellId, workspacePath, generation, closeTerminal]);

  const restart = () => {
    closeTerminal();
    setGeneration((value) => value + 1);
  };

  return (
    <div className="terminal-tab" data-testid={`terminal-tab-${tabId}`}>
      <div className="terminal-tab__bar">
        <label className="terminal-tab__shell">
          <span className="sr-only">{t("panel.terminal.shell")}</span>
          <select
            value={shellId ?? ""}
            onChange={(event) => setShellId(event.target.value)}
            disabled={shells.length === 0}
          >
            {shells.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
        <span className="terminal-tab__status">
          {state === "exited" ? t("panel.terminal.exited") : null}
          {state === "failed" ? (error ?? t("panel.terminal.failed")) : null}
        </span>
        <TooltipButton
          tooltip={t("panel.terminal.restart")}
          ariaLabel={t("panel.terminal.restart")}
          onClick={restart}
          disabled={state === "loading"}
        >
          <IconRefresh size={14} />
        </TooltipButton>
      </div>
      <div className="terminal-tab__surface" ref={hostRef} />
    </div>
  );
}
