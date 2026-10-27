/**
 * xterm palette for the work-panel terminal.
 *
 * Two constraints shape this module:
 *
 * 1. xterm paints cells into a canvas, so it needs concrete CSS colors. A
 *    `color-mix()` expression is not resolved by the canvas color parser and
 *    falls back to the browser default, which is why a mixed value here
 *    produced an opaque white block instead of a tinted selection.
 * 2. The ANSI palette is what a shell actually paints with. PowerShell renders
 *    directories as `ESC[44m` (blue background) over `ESC[97m` (bright white
 *    text), so `blue` must stay a saturated, dark-enough blue in every scheme.
 *    Mapping it to the UI accent turned it near-white on the dark theme and the
 *    directory names became unreadable until a selection covered them.
 *
 * Two sources feed the palette:
 *
 * - `theme: "app"` derives colors from the active application theme tokens, so
 *   the terminal keeps matching the surrounding panel (the original behavior).
 * - Every other scheme id is a fixed upstream palette (`terminal-palettes.ts`),
 *   so a terminal can match the editor the project is written in.
 */
import type { ITheme } from "@xterm/xterm";
import {
  TERMINAL_COLOR_SCHEME_TABLE,
  findTerminalColorScheme,
  resolveTerminalColorScheme,
  type TerminalColorSchemeId,
  type TerminalColorPalette,
  type TerminalSettings,
} from "@pi-desktop/shared";

/** Concrete colors for the shell palette, independent of the app accent. */
export type TerminalPaletteSource = {
  /** Pane background, used for the cursor's contrasting block. */
  background: string;
  foreground: string;
  muted: string;
  danger: string;
  success: string;
  warning: string;
};

/**
 * ANSI blue and bright blue. These are deliberately not theme accents: a shell
 * uses blue as a *background* for directory names, so it has to keep enough
 * saturation for white text to stay legible on top of it.
 */
export const TERMINAL_ANSI_BLUE = "#2b5f9e";
export const TERMINAL_ANSI_BRIGHT_BLUE = "#4d8fd6";

/**
 * Selection tint. A flat rgba value keeps the highlight readable on both
 * themes and, unlike `color-mix()`, survives xterm's canvas color parsing.
 */
export const TERMINAL_SELECTION_BACKGROUND = "rgba(120, 160, 255, 0.35)";

/**
 * Build the xterm theme from resolved palette colors.
 *
 * `minimumContrastRatio` is set by the caller; this function only produces
 * colors so it stays a pure mapping that a test can assert on.
 */
export function buildTerminalTheme(source: TerminalPaletteSource): ITheme {
  return {
    // Transparent so the panel's own elevated surface shows through; the
    // surrounding `.terminal-tab__surface` owns the real background.
    background: "#00000000",
    foreground: source.foreground,
    cursor: source.foreground,
    cursorAccent: source.background,
    selectionBackground: TERMINAL_SELECTION_BACKGROUND,
    selectionForeground: undefined,
    black: "#1b1c1f",
    red: source.danger,
    green: source.success,
    yellow: source.warning,
    blue: TERMINAL_ANSI_BLUE,
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: source.foreground,
    brightBlack: source.muted,
    brightRed: "#ff7b72",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: TERMINAL_ANSI_BRIGHT_BLUE,
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  };
}

/**
 * Map a fixed scheme palette onto xterm's theme shape.
 *
 * Unlike `buildTerminalTheme` this keeps a real background: a fixed scheme is
 * an explicit choice to look like that editor, so the pane paints its own
 * surface instead of inheriting the app panel color.
 */
export function buildSchemeTerminalTheme(palette: TerminalColorPalette): ITheme {
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    cursorAccent: palette.cursorAccent,
    selectionBackground: palette.selectionBackground,
    selectionForeground: undefined,
    black: palette.black,
    red: palette.red,
    green: palette.green,
    yellow: palette.yellow,
    blue: palette.blue,
    magenta: palette.magenta,
    cyan: palette.cyan,
    white: palette.white,
    brightBlack: palette.brightBlack,
    brightRed: palette.brightRed,
    brightGreen: palette.brightGreen,
    brightYellow: palette.brightYellow,
    brightBlue: palette.brightBlue,
    brightMagenta: palette.brightMagenta,
    brightCyan: palette.brightCyan,
    brightWhite: palette.brightWhite,
  };
}

/**
 * Read the palette tokens off a live element.
 *
 * Kept separate from `buildTerminalTheme` so the color mapping is testable
 * without a DOM, and so the token names live in exactly one place.
 */
export function readTerminalPaletteSource(styles: {
  getPropertyValue(name: string): string;
}): TerminalPaletteSource {
  const token = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    background: token("--ds-bg-elevated-opaque", "#1b1c1f"),
    foreground: token("--ds-text-primary", "#e6e6e6"),
    muted: token("--ds-text-muted", "#8b949e"),
    danger: token("--ds-danger", "#e5534b"),
    success: token("--ds-success", "#3fb950"),
    warning: token("--ds-warning", "#d29922"),
  };
}

/** Resolve the xterm theme for a persisted terminal setting. */
export function resolveTerminalTheme(
  settings: TerminalSettings | null | undefined,
  styles: { getPropertyValue(name: string): string },
): ITheme {
  const scheme = findTerminalColorScheme(resolveTerminalColorScheme(settings));
  if (scheme) return buildSchemeTerminalTheme(scheme.palette);
  return buildTerminalTheme(readTerminalPaletteSource(styles));
}

/**
 * The concrete pane background for a scheme, or `null` when the scheme follows
 * the application theme (the panel surface already owns that color).
 *
 * The terminal host needs this as a CSS background: a light scheme drawn on the
 * dark panel surface would otherwise show the panel through every cell the
 * shell leaves unpainted.
 */
export function terminalSchemeBackground(
  settings: TerminalSettings | null | undefined,
): string | null {
  const scheme = findTerminalColorScheme(resolveTerminalColorScheme(settings));
  return scheme ? scheme.palette.background : null;
}

/** Options for the Settings color-scheme picker, `app` first. */
export function buildTerminalSchemeOptions(
  labelFor: (id: TerminalColorSchemeId, fallback: string) => string,
): { id: string; label: string }[] {
  return [
    { id: "app", label: labelFor("app", "Match application theme") },
    ...TERMINAL_COLOR_SCHEME_TABLE.map((scheme) => ({
      id: scheme.id,
      label: labelFor(scheme.id, scheme.label),
    })),
  ];
}
/** ANSI hue strip for a scheme preview; `null` means "follow the app theme". */
export function terminalSchemeSwatches(
  id: TerminalColorSchemeId,
  styles?: { getPropertyValue(name: string): string },
): { background: string; swatches: string[] } | null {
  const scheme = findTerminalColorScheme(id);
  if (scheme) {
    const { palette } = scheme;
    return {
      background: palette.background,
      swatches: [
        palette.red,
        palette.green,
        palette.yellow,
        palette.blue,
        palette.magenta,
        palette.cyan,
      ],
    };
  }
  if (!styles) return null;
  const source = readTerminalPaletteSource(styles);
  return {
    background: source.background,
    swatches: [
      source.danger,
      source.success,
      source.warning,
      TERMINAL_ANSI_BLUE,
      "#bc8cff",
      "#39c5cf",
    ],
  };
}
