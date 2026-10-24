import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TerminalShellProfile } from "@pi-desktop/shared";
import { resolveTerminalAppearance } from "@pi-desktop/shared";

import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { TooltipButton } from "../ui";
import { IconRefresh } from "../icons";
import { SettingsMenuSelect } from "../settings/SettingsMenuSelect";

/**
 * One work-panel terminal. The PTY lives in the main process; this component
 * owns the xterm view, forwards keystrokes, and reports its size.
 *
 * Every await is followed by a liveness check: a session switch, a tab close,
 * or a renderer reload can land between creating the PTY and subscribing to it,
 * and a terminal created for a gone component would never be closed.
 *
 * Appearance comes from `AppSettings.terminal` and is applied as a concrete CSS
 * stack, never a `var(--token)`: xterm measures glyphs through a canvas context
 * that cannot resolve custom properties, so a token string silently renders the
 * browser default face — the "bad font" a token stack produces here.
 */
export function TerminalTab({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const terminalSettings = useAppStore((s) => s.settings?.terminal);
  const appearance = useMemo(
    () => resolveTerminalAppearance(terminalSettings),
    [terminalSettings],
  );

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
  // Appearance is applied at construction only, so the effect also re-runs when
  // it changes and the shell is restarted in place.
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
        fontFamily: appearance.fontFamily,
        fontSize: appearance.fontSize,
        lineHeight: appearance.lineHeight,
        letterSpacing: appearance.letterSpacing,
        fontWeight: 400,
        fontWeightBold: 600,
        theme: readTerminalTheme(host),
        scrollback: 5000,
        convertEol: true,
        allowTransparency: true,
        drawBoldTextInBrightColors: true,
        minimumContrastRatio: 1,
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
  }, [shellId, workspacePath, generation, closeTerminal, appearance]);

  const restart = () => {
    closeTerminal();
    setGeneration((value) => value + 1);
  };

  const shellOptions = useMemo(
    () => shells.map((profile) => ({ id: profile.id, label: profile.label })),
    [shells],
  );

  return (
    <div className="terminal-tab" data-testid={`terminal-tab-${tabId}`}>
      <div className="terminal-tab__bar">
        <SettingsMenuSelect
          className="terminal-tab__shell"
          triggerClassName="terminal-tab__shell-trigger"
          label={t("panel.terminal.shell")}
          value={shellId ?? ""}
          options={shellOptions}
          disabled={shells.length === 0}
          onChange={(next) => {
            if (next === shellId) return;
            setShellId(next);
          }}
        />
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

/**
 * Resolve the xterm palette from the active theme tokens.
 *
 * xterm paints into a canvas, so it needs concrete colors rather than CSS
 * variables. Reading the computed custom properties keeps the terminal on the
 * same surface, text, and accent colors as the rest of the panel instead of a
 * hard-coded black background.
 */
function readTerminalTheme(host: HTMLElement): import("@xterm/xterm").ITheme {
  const styles = getComputedStyle(host);
  const token = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };
  const background = token("--ds-bg-elevated-opaque", "#1b1c1f");
  const foreground = token("--ds-text-primary", "#e6e6e6");
  const accent = token("--ds-accent", "#4f8cff");
  return {
    background: "#00000000",
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: colorMix(accent, 34, "transparent"),
    black: "#1b1c1f",
    red: token("--ds-danger", "#e5534b"),
    green: token("--ds-success", "#3fb950"),
    yellow: token("--ds-warning", "#d29922"),
    blue: accent,
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: foreground,
    brightBlack: token("--ds-text-muted", "#8b949e"),
    brightRed: "#ff7b72",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  };
}

/** `color-mix` keeps the selection tinted by the accent in either theme. */
function colorMix(color: string, percent: number, target: string): string {
  return `color-mix(in oklab, ${color} ${percent}%, ${target})`;
}
