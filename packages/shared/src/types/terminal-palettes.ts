/**
 * Built-in terminal color schemes for the work-panel terminal.
 *
 * A scheme is pure data: the renderer maps it onto xterm's `ITheme`, the
 * Settings preview draws it as swatches, and Electron main never sees it. The
 * values are the upstream palettes of the editors and shells users already
 * know (VS Code defaults, One Dark, Solarized, GitHub, Dracula, Nord), so a
 * terminal opened here matches the editor the project is written in.
 *
 * `theme: "app"` is deliberately *not* a scheme: it derives the palette from
 * the active application theme tokens, which is the pre-existing behavior.
 * Every other id is a fixed palette that ignores the app theme.
 */

/** The scheme ids the renderer accepts in `AppSettings.terminal.theme`. */
export const TERMINAL_COLOR_SCHEMES = [
  "app",
  "one-dark",
  "vscode-dark",
  "vscode-light",
  "github-dark",
  "github-light",
  "solarized-dark",
  "solarized-light",
  "dracula",
  "nord",
  "monokai",
  "gruvbox-dark",
  "tokyo-night",
  "catppuccin-mocha",
] as const;

export type TerminalColorSchemeId = (typeof TERMINAL_COLOR_SCHEMES)[number];

/** Default scheme: keeps following the application theme. */
export const DEFAULT_TERMINAL_COLOR_SCHEME: TerminalColorSchemeId = "app";

export function isTerminalColorSchemeId(value: unknown): value is TerminalColorSchemeId {
  return (
    typeof value === "string" &&
    (TERMINAL_COLOR_SCHEMES as readonly string[]).includes(value)
  );
}

/**
 * A fixed ANSI palette. All sixteen ANSI slots are required: a shell paints
 * arbitrary combinations of them (PowerShell uses blue as a *background* under
 * bright-white text), so a partially specified scheme would leave some cells
 * unreadable.
 */
export type TerminalColorPalette = {
  /** Pane background. `#rrggbb`, never transparent. */
  background: string;
  /** Default text color. */
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

export type TerminalColorScheme = {
  id: Exclude<TerminalColorSchemeId, "app">;
  /** English display name; localized labels live in i18n. */
  label: string;
  /** Whether the scheme is light or dark, for the settings swatch frame. */
  appearance: "light" | "dark";
  palette: TerminalColorPalette;
};

/** VS Code's built-in dark terminal palette, minus the transparent default. */
const VSCODE_DARK: TerminalColorPalette = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const VSCODE_LIGHT: TerminalColorPalette = {
  background: "#ffffff",
  foreground: "#333333",
  cursor: "#333333",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

/** One Dark (Atom / VS Code One Dark Pro). */
const ONE_DARK: TerminalColorPalette = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  cursorAccent: "#282c34",
  selectionBackground: "#3e4451",
  black: "#1e2127",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#d19a66",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e6c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

/** GitHub's dark theme terminal colors. */
const GITHUB_DARK: TerminalColorPalette = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/** GitHub's light theme terminal colors. */
const GITHUB_LIGHT: TerminalColorPalette = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#24292f",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d7ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/** Solarized (Ethan Schoonover), dark background. */
const SOLARIZED_DARK: TerminalColorPalette = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#839496",
  cursorAccent: "#002b36",
  selectionBackground: "#073642",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

/** Solarized, light background. */
const SOLARIZED_LIGHT: TerminalColorPalette = {
  background: "#fdf6e3",
  // base01 rather than base00: upstream Solarized Light body text (base00
  // `#657b83`) reaches only ~4.1:1 on base3, which a terminal full of small
  // monospaced glyphs cannot afford. base01 is still Solarized's own
  // emphasized body tone and clears 4.5:1.
  foreground: "#586e75",
  cursor: "#586e75",
  cursorAccent: "#fdf6e3",
  selectionBackground: "#eee8d5",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const DRACULA: TerminalColorPalette = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

const NORD: TerminalColorPalette = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  cursorAccent: "#2e3440",
  selectionBackground: "#434c5e",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

const MONOKAI: TerminalColorPalette = {
  background: "#272822",
  foreground: "#f8f8f2",
  cursor: "#f8f8f0",
  cursorAccent: "#272822",
  selectionBackground: "#49483e",
  black: "#272822",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
};

const GRUVBOX_DARK: TerminalColorPalette = {
  background: "#282828",
  foreground: "#ebdbb2",
  cursor: "#ebdbb2",
  cursorAccent: "#282828",
  selectionBackground: "#504945",
  black: "#282828",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  magenta: "#b16286",
  cyan: "#689d6a",
  white: "#a89984",
  brightBlack: "#928374",
  brightRed: "#fb4934",
  brightGreen: "#b8bb26",
  brightYellow: "#fabd2f",
  brightBlue: "#83a598",
  brightMagenta: "#d3869b",
  brightCyan: "#8ec07c",
  brightWhite: "#ebdbb2",
};

const TOKYO_NIGHT: TerminalColorPalette = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#1a1b26",
  selectionBackground: "#33467c",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

const CATPPUCCIN_MOCHA: TerminalColorPalette = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b70",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

/** Every fixed scheme, in the order the Settings picker lists them. */
export const TERMINAL_COLOR_SCHEME_TABLE: readonly TerminalColorScheme[] = [
  { id: "one-dark", label: "One Dark", appearance: "dark", palette: ONE_DARK },
  { id: "vscode-dark", label: "VS Code Dark", appearance: "dark", palette: VSCODE_DARK },
  { id: "vscode-light", label: "VS Code Light", appearance: "light", palette: VSCODE_LIGHT },
  { id: "github-dark", label: "GitHub Dark", appearance: "dark", palette: GITHUB_DARK },
  { id: "github-light", label: "GitHub Light", appearance: "light", palette: GITHUB_LIGHT },
  { id: "solarized-dark", label: "Solarized Dark", appearance: "dark", palette: SOLARIZED_DARK },
  { id: "solarized-light", label: "Solarized Light", appearance: "light", palette: SOLARIZED_LIGHT },
  { id: "dracula", label: "Dracula", appearance: "dark", palette: DRACULA },
  { id: "nord", label: "Nord", appearance: "dark", palette: NORD },
  { id: "monokai", label: "Monokai", appearance: "dark", palette: MONOKAI },
  { id: "gruvbox-dark", label: "Gruvbox Dark", appearance: "dark", palette: GRUVBOX_DARK },
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark", palette: TOKYO_NIGHT },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    appearance: "dark",
    palette: CATPPUCCIN_MOCHA,
  },
];

/** The eight ANSI hues, in slot order, for swatch strips. */
export const TERMINAL_ANSI_HUE_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

/** Look up a fixed scheme; `undefined` for `app` or an unknown id. */
export function findTerminalColorScheme(
  id: string | null | undefined,
): TerminalColorScheme | undefined {
  if (!id) return undefined;
  return TERMINAL_COLOR_SCHEME_TABLE.find((scheme) => scheme.id === id);
}
