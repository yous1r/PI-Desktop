/**
 * Interactive terminal profiles for the work-panel terminal (spec: terminal
 * panel in the side work panel). A profile is one launchable shell program;
 * availability is probed by Electron main, never asserted by the renderer.
 */

export const TERMINAL_SHELL_FAMILIES = [
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "zsh",
  "fish",
  "wsl",
  "custom",
] as const;

export type TerminalShellFamily = (typeof TERMINAL_SHELL_FAMILIES)[number];

export function isTerminalShellFamily(value: unknown): value is TerminalShellFamily {
  return (
    typeof value === "string" &&
    (TERMINAL_SHELL_FAMILIES as readonly string[]).includes(value)
  );
}

/** One launchable shell discovered on this machine. */
export type TerminalShellProfile = {
  /** Stable id, e.g. `pwsh`, `git-bash`, `wsl`. */
  id: string;
  /** Display name, e.g. `PowerShell 7`. */
  label: string;
  /** Absolute executable path resolved by main. */
  path: string;
  /** Extra argv entries between the program and the interactive session. */
  args?: string[];
  family: TerminalShellFamily;
  /** Marks the profile the terminal opens when no shell is chosen. */
  isDefault?: boolean;
};

export function isTerminalShellProfile(value: unknown): value is TerminalShellProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    typeof profile.label === "string" &&
    profile.label.length > 0 &&
    typeof profile.path === "string" &&
    profile.path.length > 0 &&
    isTerminalShellFamily(profile.family) &&
    (profile.args === undefined ||
      (Array.isArray(profile.args) &&
        profile.args.every((arg) => typeof arg === "string")))
  );
}

/** Result of `terminalCreate`: the handle the renderer drives afterwards. */
export type TerminalOpenResult = {
  terminalId: string;
  /** Profile id that produced this terminal, for tab labels and restart. */
  shellId: string;
  cols: number;
  rows: number;
};

export function isTerminalOpenResult(value: unknown): value is TerminalOpenResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.terminalId === "string" &&
    result.terminalId.length > 0 &&
    typeof result.shellId === "string" &&
    typeof result.cols === "number" &&
    typeof result.rows === "number"
  );
}

/** Payload of the `terminalData` event: one base64 PTY output chunk. */
export type TerminalDataEvent = {
  terminalId: string;
  data: string;
};

/** Payload of the `terminalExit` event. */
export type TerminalExitEvent = {
  terminalId: string;
  exitCode: number | null;
};

export function isTerminalDataEvent(value: unknown): value is TerminalDataEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.terminalId === "string" && typeof event.data === "string";
}

export function isTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.terminalId === "string" &&
    (event.exitCode === null || typeof event.exitCode === "number")
  );
}

/**
 * Work-panel terminal appearance. `fontFamily` is a concrete CSS stack, never
 * a `var(--token)`: xterm measures glyphs in a canvas context, so a token
 * string would silently fall back to the browser default face.
 */
export type TerminalAppearance = {
  /** CSS font-family stack for the terminal grid. */
  fontFamily: string;
  /** Terminal cell size in CSS px. */
  fontSize: number;
  /** Extra letter spacing in CSS px; 0 keeps the font's own metrics. */
  letterSpacing: number;
  /** Line height multiplier applied to the cell height. */
  lineHeight: number;
};

export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_LINE_HEIGHT_MIN = 0.9;
export const TERMINAL_LINE_HEIGHT_MAX = 2;
export const TERMINAL_LETTER_SPACING_MIN = -2;
export const TERMINAL_LETTER_SPACING_MAX = 4;
export const TERMINAL_MAX_LAUNCH_ARGS_LENGTH = 2048;
export const TERMINAL_MAX_ENV_LENGTH = 4096;

/**
 * Default terminal face. A concrete monospace stack: every family here is
 * either shipped by Windows/macOS or the fallback Chromium always resolves.
 */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", "SF Mono", Menlo, "DejaVu Sans Mono", "Courier New", monospace';
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const DEFAULT_TERMINAL_LETTER_SPACING = 0;
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1.2;

/** Persisted terminal overrides (`AppSettings.terminal`). */
export type TerminalSettings = {
  /** CSS font-family stack; absent or empty means the built-in stack. */
  fontFamily?: string;
  /** Terminal cell size in CSS px; absent means `DEFAULT_TERMINAL_FONT_SIZE`. */
  fontSize?: number;
  /** Line height multiplier; absent means the default ratio. */
  lineHeight?: number;
  /** Letter spacing in CSS px; absent means 0. */
  letterSpacing?: number;
  /**
   * Extra argv appended to every shell launch, split on whitespace. Absent
   * means the shell's own interactive defaults.
   */
  launchArgs?: string;
  /**
   * Extra environment variables applied to the PTY, `KEY=value` per line.
   * Absent means the inherited process environment only.
   */
  env?: string;
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Resolve the effective appearance from persisted overrides. */
export function resolveTerminalAppearance(
  settings: TerminalSettings | null | undefined,
): TerminalAppearance {
  const fontFamily =
    typeof settings?.fontFamily === "string" && settings.fontFamily.trim()
      ? settings.fontFamily.trim()
      : DEFAULT_TERMINAL_FONT_FAMILY;
  return {
    fontFamily,
    fontSize: Math.round(
      clampNumber(
        settings?.fontSize,
        TERMINAL_FONT_SIZE_MIN,
        TERMINAL_FONT_SIZE_MAX,
        DEFAULT_TERMINAL_FONT_SIZE,
      ),
    ),
    letterSpacing: clampNumber(
      settings?.letterSpacing,
      TERMINAL_LETTER_SPACING_MIN,
      TERMINAL_LETTER_SPACING_MAX,
      DEFAULT_TERMINAL_LETTER_SPACING,
    ),
    lineHeight: clampNumber(
      settings?.lineHeight,
      TERMINAL_LINE_HEIGHT_MIN,
      TERMINAL_LINE_HEIGHT_MAX,
      DEFAULT_TERMINAL_LINE_HEIGHT,
    ),
  };
}

/**
 * Split a launch-argument string into argv entries. Quoted segments survive as
 * one entry so `--flag "a b"` reaches the shell as two arguments, not three.
 */
export function parseTerminalLaunchArgs(input: string | null | undefined): string[] {
  if (typeof input !== "string" || !input.trim()) return [];
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of input.slice(0, TERMINAL_MAX_LAUNCH_ARGS_LENGTH)) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) args.push(current);
  return args;
}

/**
 * Parse `KEY=value` lines into environment overrides. Blank lines and lines
 * without `=` are ignored, so a partially typed block never breaks a launch.
 */
export function parseTerminalEnv(input: string | null | undefined): Record<string, string> {
  if (typeof input !== "string" || !input.trim()) return {};
  const env: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = line.slice(index + 1);
  }
  return env;
}

/**
 * Validate a `terminal` settings write. Returns an error message for the first
 * invalid field, or `null` when the value is acceptable. Absent fields are
 * always valid: they mean "use the built-in default".
 */
export function terminalSettingsError(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    return "terminal must be an object";
  }
  const value = input as Record<string, unknown>;
  for (const key of ["fontFamily", "launchArgs", "env"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return `terminal.${key} must be a string`;
    }
  }
  if (typeof value.launchArgs === "string" && value.launchArgs.length > TERMINAL_MAX_LAUNCH_ARGS_LENGTH) {
    return `terminal.launchArgs must be at most ${TERMINAL_MAX_LAUNCH_ARGS_LENGTH} characters`;
  }
  if (typeof value.env === "string" && value.env.length > TERMINAL_MAX_ENV_LENGTH) {
    return `terminal.env must be at most ${TERMINAL_MAX_ENV_LENGTH} characters`;
  }
  for (const key of ["fontSize", "lineHeight", "letterSpacing"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isFinite(field)) {
      return `terminal.${key} must be a number`;
    }
  }
  if (
    typeof value.fontSize === "number" &&
    (value.fontSize < TERMINAL_FONT_SIZE_MIN || value.fontSize > TERMINAL_FONT_SIZE_MAX)
  ) {
    return `terminal.fontSize must be between ${TERMINAL_FONT_SIZE_MIN} and ${TERMINAL_FONT_SIZE_MAX}`;
  }
  if (
    typeof value.lineHeight === "number" &&
    (value.lineHeight < TERMINAL_LINE_HEIGHT_MIN || value.lineHeight > TERMINAL_LINE_HEIGHT_MAX)
  ) {
    return `terminal.lineHeight must be between ${TERMINAL_LINE_HEIGHT_MIN} and ${TERMINAL_LINE_HEIGHT_MAX}`;
  }
  if (
    typeof value.letterSpacing === "number" &&
    (value.letterSpacing < TERMINAL_LETTER_SPACING_MIN ||
      value.letterSpacing > TERMINAL_LETTER_SPACING_MAX)
  ) {
    return `terminal.letterSpacing must be between ${TERMINAL_LETTER_SPACING_MIN} and ${TERMINAL_LETTER_SPACING_MAX}`;
  }
  return null;
}
