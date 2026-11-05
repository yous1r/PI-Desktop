import {
  isTerminalOfflineCode,
  terminalErrorCodeOf,
  type TerminalErrorCode,
} from "@pi-desktop/shared";

/**
 * Renderer-side derivation for one work-panel terminal.
 *
 * Everything here is pure: the component owns effects and the xterm instance,
 * while these helpers decide what the user is told. Keeping the mapping out of
 * the component is what lets a failure be tested — an offline host, an
 * unsupported shell, and a closed process must not all read as "the terminal
 * broke".
 */

/** What the terminal pane shows in its status line. */
export type TerminalPaneStatus = "loading" | "ready" | "exited" | "offline" | "failed";

export type TerminalPaneFailure = {
  /** Offline keeps the tab re-attachable; failed needs a restart. */
  status: "offline" | "failed";
  code?: TerminalErrorCode;
  /** Raw message from main, shown under the translated title. */
  detail?: string;
};

function failureDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message.trim() || undefined;
  if (typeof error === "string") return error.trim() || undefined;
  return undefined;
}

/**
 * Map a rejected terminal call to a stated state.
 *
 * `TERMINAL_HOST_OFFLINE` is the one failure the user can act on by
 * reconnecting the host, so it stays its own state instead of collapsing into
 * a generic error message.
 */
export function terminalFailureState(error: unknown): TerminalPaneFailure {
  const code = terminalErrorCodeOf(error);
  const detail = failureDetail(error);
  const withDetail = detail ? { detail } : {};
  if (isTerminalOfflineCode(code)) {
    return { status: "offline", code, ...withDetail };
  }
  return { status: "failed", ...(code ? { code } : {}), ...withDetail };
}

/**
 * Decode one base64 output chunk into the bytes xterm writes.
 *
 * A malformed chunk is dropped rather than thrown: an exception inside the data
 * listener would kill the subscription and freeze the pane mid-session.
 */
export function decodeTerminalChunk(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/** The host a terminal runs on, as the pane and the tab strip present it. */
export type TerminalHostIdentity = {
  label: string;
  /** Workspace root on that host, when one was bound. */
  detail?: string;
  remote: boolean;
};

/**
 * Name the host that owns a terminal.
 *
 * Local and remote terminals are the same UI, so the identity line is the only
 * place the difference is visible: a remote terminal must never look like it
 * runs on this machine.
 */
export function terminalHostIdentity(input: {
  hostLabel?: string;
  hostKey?: string;
  workspacePath?: string;
  localLabel: string;
}): TerminalHostIdentity {
  const remote = Boolean(input.hostLabel || input.hostKey);
  const label = input.hostLabel || input.hostKey || input.localLabel;
  return {
    label,
    ...(input.workspacePath ? { detail: input.workspacePath } : {}),
    remote,
  };
}

/** Reads one computed CSS custom property, with a literal fallback. */
export type TokenReader = (name: string, fallback: string) => string;

export type TerminalPalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

/**
 * Fixed ANSI colors for a shell. Only the surface, text, and cursor follow the
 * app theme: a shell's own palette must not drift with an app theme, or a
 * "red" error stops being red.
 */
const TERMINAL_ANSI_PALETTE = {
  black: "#1b1c1f",
  red: "#e5534b",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#4f8cff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#e6e6e6",
  brightBlack: "#8b949e",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
} as const;

/**
 * Build the xterm palette from the active theme tokens.
 *
 * xterm paints into a canvas, so it needs concrete colors rather than CSS
 * variables; reading the computed values keeps the terminal on the same
 * surface as the panel it sits in, in either app theme.
 */
export function terminalPalette(read: TokenReader): TerminalPalette {
  const background = read("--ds-bg-elevated-opaque", "#1b1c1f");
  const foreground = read("--ds-text-primary", "#e6e6e6");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: read("--ds-border-subtle", "rgba(150, 160, 175, 0.3)"),
    ...TERMINAL_ANSI_PALETTE,
  };
}
