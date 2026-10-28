import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readSettingsSource } from "./helpers/source-contracts.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * Source contracts for the terminal color-scheme surface.
 *
 * The palette data itself is unit-tested in `terminal-theme.test.mjs`. What is
 * asserted here is the wiring that a data test cannot see: the Settings card
 * must offer the picker, the terminal must apply a scheme without tearing down
 * the PTY, and the pane must paint a fixed scheme's own background.
 */

const terminalTabSource = await readFile(
  new URL("../src/components/workpanel/TerminalTab.tsx", import.meta.url),
  "utf8",
);
const settingsCardSource = await readFile(
  new URL("../src/components/settings/TerminalSettingsCard.tsx", import.meta.url),
  "utf8",
);
const previewSource = await readFile(
  new URL("../src/components/settings/TerminalSchemePreview.tsx", import.meta.url),
  "utf8",
);
const settingsPageSource = await readSettingsSource();
const styles = await loadStyles();

test("the terminal settings card offers the scheme picker and a preview", () => {
  // The list comes from the shared table, so the picker cannot drift from the
  // ids main and the renderer resolve.
  assert.match(settingsCardSource, /buildTerminalSchemeOptions\(/);
  assert.doesNotMatch(settingsCardSource, /TERMINAL_COLOR_SCHEME_TABLE\s*=\s*\[/);
  assert.match(settingsCardSource, /value=\{colorScheme\}/);
  assert.match(settingsCardSource, /save\(\{ theme: /);
  // A preview next to the picker is what makes "preview" true rather than a
  // label change that only takes effect after the terminal is reopened.
  assert.match(settingsCardSource, /<TerminalSchemePreview/);
  assert.match(settingsPageSource, /<TerminalSettingsCard /);
});

test("a scheme change repaints the live terminal instead of restarting it", () => {
  // `term.options.theme` is the in-place path; assigning a new Terminal would
  // drop scrollback and kill any running command for a color change.
  assert.match(terminalTabSource, /term\.options\.theme = resolveTerminalTheme\(/);
  // The PTY effect must not depend on `terminalSettings`, or every color change
  // would close and respawn the shell. It keeps its own explicit dependency
  // list: `workspacePath` is read once at creation (a project switch must not
  // tear down a running shell) and `appearance` stays because font metrics
  // still need a restart.
  const effectDeps = terminalTabSource.match(
    /\}, \[shellId, generation, appearance, tabId\]\);/,
  );
  assert.ok(effectDeps, "the PTY effect keeps its own dependency list");
  assert.doesNotMatch(
    terminalTabSource,
    /\[shellId, generation, appearance, tabId, terminalSettings\]/,
  );
  assert.doesNotMatch(
    terminalTabSource,
    /\[shellId, workspacePath, generation, closeTerminal, appearance, terminalSettings\]/,
  );
});

test("a fixed scheme paints its own pane background", () => {
  // A light scheme on the dark panel surface would show the panel through every
  // cell the shell leaves unpainted.
  assert.match(terminalTabSource, /terminalSchemeBackground\(/);
  assert.match(terminalTabSource, /style=\{schemeBackground \? \{ background: schemeBackground \}/);
});

test("the preview reads live theme tokens for the app-theme scheme", () => {
  // `app` has no fixed palette, so the preview has to follow the UI theme
  // instead of showing a hard-coded dark block.
  assert.match(previewSource, /terminalSchemeSwatches\(/);
  assert.match(previewSource, /getComputedStyle\(document\.documentElement\)/);
  assert.match(previewSource, /MutationObserver/);
  // The preview must not mount xterm or spawn a PTY.
  assert.doesNotMatch(previewSource, /new Terminal\(|terminalCreate\(/);
});

test("the scheme preview is styled from tokens and cannot overflow the card", () => {
  assert.match(styles, /\.terminal-scheme-preview\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.settings-row:has\(\.settings-terminal-theme\)\s*\.settings-row-control/);
});
