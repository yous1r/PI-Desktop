import assert from "node:assert/strict";
import test from "node:test";

const {
  buildTerminalTheme,
  buildSchemeTerminalTheme,
  buildTerminalSchemeOptions,
  readTerminalPaletteSource,
  resolveTerminalTheme,
  terminalSchemeBackground,
  terminalSchemeSwatches,
  TERMINAL_ANSI_BLUE,
  TERMINAL_ANSI_BRIGHT_BLUE,
  TERMINAL_SELECTION_BACKGROUND,
} = await import("../src/lib/terminal-theme.ts");

const {
  TERMINAL_COLOR_SCHEMES,
  TERMINAL_COLOR_SCHEME_TABLE,
  findTerminalColorScheme,
  resolveTerminalColorScheme,
} = await import("@pi-desktop/shared");

/**
 * The terminal palette is the fix for two concrete rendering defects:
 *
 * 1. PowerShell paints directory names as `ESC[44m` (blue background) over
 *    `ESC[97m` (bright white text). When ANSI blue was mapped to the UI accent,
 *    that accent was near-white on the dark theme, so the names were invisible
 *    until a text selection covered them.
 * 2. The selection tint used `color-mix()`, which xterm's canvas color parser
 *    does not resolve; it fell back to an opaque white block.
 */

/** WCAG relative luminance for a `#rrggbb` color. */
function luminance(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two `#rrggbb` colors. */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

const DARK_PALETTE = {
  background: "#1b1c1f",
  foreground: "#ffffff",
  muted: "#8b949e",
  danger: "#e5534b",
  success: "#3fb950",
  warning: "#d29922",
};

const LIGHT_PALETTE = {
  background: "#ffffff",
  foreground: "#1a1c1f",
  muted: "#5d5d5d",
  danger: "#e5534b",
  success: "#3fb950",
  warning: "#d29922",
};

test("ANSI blue stays dark enough for white directory names to read on it", () => {
  // PowerShell's `ESC[44m` background carries `ESC[97m` bright-white text.
  assert.ok(
    contrast(TERMINAL_ANSI_BLUE, "#ffffff") >= 4.5,
    `blue ${TERMINAL_ANSI_BLUE} must reach 4.5:1 against white text`,
  );
  // It also has to stay distinguishable from the dark pane it sits on.
  assert.ok(contrast(TERMINAL_ANSI_BLUE, DARK_PALETTE.background) >= 1.5);
});

test("ANSI blue is a saturated blue rather than a near-white accent", () => {
  // Guards the original defect: a light accent reused as `blue` made the
  // directory cells a white block with white text on it.
  assert.ok(luminance(TERMINAL_ANSI_BLUE) < 0.2);
  assert.ok(luminance(TERMINAL_ANSI_BRIGHT_BLUE) < 0.4);
});

test("the theme keeps blue independent of the theme accent", () => {
  const dark = buildTerminalTheme(DARK_PALETTE);
  const light = buildTerminalTheme(LIGHT_PALETTE);
  assert.equal(dark.blue, TERMINAL_ANSI_BLUE);
  assert.equal(light.blue, TERMINAL_ANSI_BLUE);
  assert.equal(dark.brightBlue, TERMINAL_ANSI_BRIGHT_BLUE);
  assert.equal(light.brightBlue, TERMINAL_ANSI_BRIGHT_BLUE);
  // Foreground and cursor still follow the theme, so the pane keeps its look.
  assert.equal(dark.foreground, DARK_PALETTE.foreground);
  assert.equal(light.foreground, LIGHT_PALETTE.foreground);
  assert.equal(dark.cursor, DARK_PALETTE.foreground);
  assert.equal(dark.cursorAccent, DARK_PALETTE.background);
});

test("the selection tint is a concrete color xterm can parse", () => {
  // `color-mix()` is not a canvas color, so xterm ignored it and painted the
  // selection with the browser default (opaque white).
  assert.doesNotMatch(TERMINAL_SELECTION_BACKGROUND, /color-mix|var\(/);
  assert.match(TERMINAL_SELECTION_BACKGROUND, /^rgba?\(/);
  const theme = buildTerminalTheme(DARK_PALETTE);
  assert.equal(theme.selectionBackground, TERMINAL_SELECTION_BACKGROUND);
  // Translucent, so the cell's own background still shows through the tint.
  assert.match(TERMINAL_SELECTION_BACKGROUND, /^rgba\(/);
});

test("palette tokens fall back when a theme defines none", () => {
  const source = readTerminalPaletteSource({ getPropertyValue: () => "" });
  assert.equal(source.background, "#1b1c1f");
  assert.equal(source.foreground, "#e6e6e6");
  assert.equal(source.muted, "#8b949e");
  const theme = buildTerminalTheme(source);
  // The pane stays transparent so the panel surface owns the background.
  assert.equal(theme.background, "#00000000");
  assert.equal(theme.foreground, "#e6e6e6");
});

test("palette tokens are read from the live theme when present", () => {
  const tokens = {
    "--ds-bg-elevated-opaque": "#101010",
    "--ds-text-primary": "#f0f0f0",
    "--ds-text-muted": "#777777",
    "--ds-danger": "#aa0000",
    "--ds-success": "#00aa00",
    "--ds-warning": "#aaaa00",
  };
  const source = readTerminalPaletteSource({
    getPropertyValue: (name) => tokens[name] ?? "",
  });
  assert.deepEqual(source, {
    background: "#101010",
    foreground: "#f0f0f0",
    muted: "#777777",
    danger: "#aa0000",
    success: "#00aa00",
    warning: "#aaaa00",
  });
  const theme = buildTerminalTheme(source);
  assert.equal(theme.foreground, "#f0f0f0");
  assert.equal(theme.brightBlack, "#777777");
  assert.equal(theme.red, "#aa0000");
});

/**
 * Fixed color schemes. These assertions guard the two ways a scheme can go
 * wrong: a palette that is incomplete (xterm then falls back to its own
 * defaults and the pane looks half-themed), and a scheme id that is accepted by
 * the picker but rejected by the settings validator.
 */
test("every fixed scheme defines all sixteen ANSI slots", () => {
  assert.ok(TERMINAL_COLOR_SCHEME_TABLE.length >= 10);
  const slots = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ];
  for (const scheme of TERMINAL_COLOR_SCHEME_TABLE) {
    for (const slot of slots) {
      assert.match(
        scheme.palette[slot],
        /^#[0-9a-f]{6}$/i,
        `${scheme.id}.${slot} must be a concrete #rrggbb color`,
      );
    }
    assert.match(scheme.palette.background, /^#[0-9a-f]{6}$/i);
    assert.match(scheme.palette.foreground, /^#[0-9a-f]{6}$/i);
    assert.match(scheme.palette.selectionBackground, /^#[0-9a-f]{6}$/i);
  }
});

test("scheme ids are unique and resolvable from the settings value", () => {
  const ids = TERMINAL_COLOR_SCHEME_TABLE.map((scheme) => scheme.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.ok(TERMINAL_COLOR_SCHEMES.includes(id), `${id} must be accepted by settings`);
    assert.equal(findTerminalColorScheme(id)?.id, id);
  }
  // `app` is a mode, not a table entry.
  assert.equal(findTerminalColorScheme("app"), undefined);
  assert.equal(findTerminalColorScheme("nope"), undefined);
  assert.equal(findTerminalColorScheme(undefined), undefined);
});

test("an unknown or absent scheme falls back to following the app theme", () => {
  assert.equal(resolveTerminalColorScheme(undefined), "app");
  assert.equal(resolveTerminalColorScheme({}), "app");
  assert.equal(resolveTerminalColorScheme({ theme: "one-dark" }), "one-dark");
  // A settings file from a newer build must not leave the pane unthemed.
  assert.equal(resolveTerminalColorScheme({ theme: "not-a-scheme" }), "app");
});

test("a fixed scheme keeps its own background instead of the panel color", () => {
  const oneDark = findTerminalColorScheme("one-dark");
  const theme = buildSchemeTerminalTheme(oneDark.palette);
  assert.equal(theme.background, oneDark.palette.background);
  assert.equal(theme.foreground, oneDark.palette.foreground);
  assert.equal(theme.blue, oneDark.palette.blue);
  assert.equal(theme.brightCyan, oneDark.palette.brightCyan);
  // The host paints this color; `app` returns null so the panel keeps painting.
  assert.equal(terminalSchemeBackground({ theme: "one-dark" }), oneDark.palette.background);
  assert.equal(terminalSchemeBackground({ theme: "app" }), null);
  assert.equal(terminalSchemeBackground(undefined), null);
});

test("resolving a theme honours the selected scheme over the app tokens", () => {
  const tokens = { getPropertyValue: () => "#123456" };
  const fixed = resolveTerminalTheme({ theme: "dracula" }, tokens);
  assert.equal(fixed.background, findTerminalColorScheme("dracula").palette.background);
  // `app` still derives from the live tokens.
  const app = resolveTerminalTheme({ theme: "app" }, tokens);
  assert.equal(app.background, "#00000000");
  assert.equal(app.foreground, "#123456");
});

test("the picker lists every scheme after the app-theme entry", () => {
  const options = buildTerminalSchemeOptions((id, fallback) => `${id}:${fallback}`);
  assert.equal(options.length, TERMINAL_COLOR_SCHEME_TABLE.length + 1);
  assert.equal(options[0].id, "app");
  assert.match(options[0].label, /^app:/);
  assert.deepEqual(
    options.slice(1).map((option) => option.id),
    TERMINAL_COLOR_SCHEME_TABLE.map((scheme) => scheme.id),
  );
});

test("preview swatches use the scheme colors and need tokens for app", () => {
  const oneDark = findTerminalColorScheme("one-dark");
  const fixed = terminalSchemeSwatches("one-dark");
  assert.equal(fixed.background, oneDark.palette.background);
  assert.deepEqual(fixed.swatches, [
    oneDark.palette.red,
    oneDark.palette.green,
    oneDark.palette.yellow,
    oneDark.palette.blue,
    oneDark.palette.magenta,
    oneDark.palette.cyan,
  ]);
  // Without live tokens there is nothing honest to draw for `app`.
  assert.equal(terminalSchemeSwatches("app"), null);
  const tokens = { getPropertyValue: (name) => (name === "--ds-danger" ? "#ff0000" : "") };
  assert.equal(terminalSchemeSwatches("app", tokens).swatches[0], "#ff0000");
});

test("every scheme keeps body text readable on its own background", () => {
  for (const scheme of TERMINAL_COLOR_SCHEME_TABLE) {
    assert.ok(
      contrast(scheme.palette.foreground, scheme.palette.background) >= 4.5,
      `${scheme.id} foreground must reach 4.5:1 on its background`,
    );
  }
});
