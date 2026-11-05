import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Renderer-side wiring for the work-panel terminal.
 *
 * The channel names and the translated strings are contracts that a build with
 * a still-correct type checker would break silently: a renamed channel makes the
 * preload bridge reject every terminal call, and a missing key renders the raw
 * `panel.terminal.*` id in the pane.
 */

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const apiSource = read("../src/lib/api.ts");
const channelSource = read("../src/lib/terminal-channels.ts");
const pane = read("../src/components/workpanel/TerminalTab.tsx");
const panel = read("../src/components/workpanel/WorkPanel.tsx");
const slice = read("../src/stores/slices/work-panel-slice.ts");
const globals = read("../src/styles/globals.css");
const styles = read("../src/styles/terminal.css");
const pkg = JSON.parse(read("../package.json"));

const LOCALES = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];

const TERMINAL_INVOKE_CHANNELS = [
  "pi-desktop/terminal/listShells",
  "pi-desktop/terminal/create",
  "pi-desktop/terminal/write",
  "pi-desktop/terminal/resize",
  "pi-desktop/terminal/close",
  "pi-desktop/terminal/replay",
  "pi-desktop/terminal/getBuffer",
];

const TERMINAL_EVENT_CHANNELS = [
  "pi-desktop/terminal/event/data",
  "pi-desktop/terminal/event/exit",
];

test("terminal channels are re-exported from the shared protocol, not copied", () => {
  // One source of truth: every name is read off `IPC`, so a renamed protocol
  // entry cannot leave the renderer calling a channel nobody serves.
  assert.match(channelSource, /import \{ IPC \} from "@pi-desktop\/shared"/);
  assert.doesNotMatch(channelSource, /"pi-desktop\/terminal/);
  assert.doesNotMatch(apiSource, /"pi-desktop\/terminal/);

  for (const [key, name] of [
    ["listShells", "terminalListShells"],
    ["create", "terminalCreate"],
    ["write", "terminalWrite"],
    ["resize", "terminalResize"],
    ["close", "terminalClose"],
    ["replay", "terminalReplay"],
    ["getBuffer", "terminalGetBuffer"],
  ]) {
    assert.ok(
      channelSource.includes(`${key}: IPC.invoke.${name},`),
      `${key} must map to IPC.invoke.${name}`,
    );
  }
  for (const [key, name] of [
    ["dataEvent", "terminalData"],
    ["exitEvent", "terminalExit"],
  ]) {
    assert.ok(
      channelSource.includes(`${key}: IPC.event.${name},`),
      `${key} must map to IPC.event.${name}`,
    );
  }
  assert.match(apiSource, /import \{ TERMINAL_IPC \} from "\.\/terminal-channels"/);
});

test("the api facade exposes the backend terminal API under its documented names", () => {
  for (const name of [
    "terminalListShells",
    "terminalCreate",
    "terminalWrite",
    "terminalResize",
    "terminalClose",
    "terminalReplay",
    "terminalGetBuffer",
  ]) {
    assert.match(apiSource, new RegExp(`\\n  ${name}: `), `${name} is missing`);
  }
  // Creation carries the target; later actions address the terminal id alone.
  assert.match(apiSource, /terminalCreate: \(input: TerminalCreateInput\)/);
  assert.match(
    apiSource,
    /terminalListShells: \(input: \{ target: TerminalTargetContext; refresh\?: boolean \}\)/,
  );
  for (const action of ["terminalWrite", "terminalResize", "terminalClose", "terminalReplay"]) {
    const call = apiSource.slice(apiSource.indexOf(`  ${action}: `));
    assert.match(call.slice(0, 200), new RegExp(`invoke[^(]*\\([^)]*${action === "terminalReplay" ? "replay" : action.replace("terminal", "").toLowerCase()}`));
  }
  assert.match(apiSource, /terminalReplay: \(terminalId: string, maxBytes\?: number\)/);
});

test("the pane only ever addresses a terminal by its id", () => {
  // Every post-create call passes the id the create returned, so a workspace
  // switch elsewhere in the app can never retarget a running shell.
  for (const call of [
    "api.terminalWrite(id, data)",
    "api.terminalResize(id, cols, rows)",
    "api.terminalReplay(existing.terminalId)",
    "api.terminalClose(opened.terminalId)",
  ]) {
    assert.ok(pane.includes(call), `${call} is missing`);
  }
  // Creation is the only place that sends the target context.
  assert.match(pane, /api\.terminalCreate\(\{\n\s+target: \{ sessionId, workspaceId, tabId \},/);
  assert.equal((pane.match(/api\.terminalCreate\(/g) ?? []).length, 1);
});

test("the pane states the host it runs on, its error state, and how to recover", () => {
  assert.match(pane, /terminalHostIdentity\(/);
  assert.match(pane, /panel\.terminal\.hostLabel/);
  assert.match(pane, /panel\.terminal\.shell/);
  assert.match(pane, /panel\.terminal\.restart/);
  assert.match(pane, /role="status"/);
  assert.match(pane, /aria-live="polite"/);
  // Offline and failed are distinct messages, not one generic error line.
  assert.match(pane, /panel\.terminal\.offline/);
  assert.match(pane, /panel\.terminal\.offlineHint/);
  assert.match(pane, /panel\.terminal\.failed/);
  assert.match(pane, /panel\.terminal\.noShells/);
  assert.match(pane, /panel\.terminal\.exitedWithCode/);
  // The shell's surface is a labelled group, not an unlabelled div.
  assert.match(pane, /className="terminal-tab__surface"[\s\S]{0,160}role="group"/);
  assert.match(pane, /aria-label=\{t\("panel\.terminal\.title"\)\}/);
});

test("closing a tab in the store ends the shell behind it", () => {
  assert.match(slice, /import \{ closeTerminalForTab, closeTerminalForTabs \} from "\.\.\/\.\.\/lib\/terminal-sessions"/);
  assert.match(slice, /closeTerminalForTab\(tabId\)/);
  assert.match(slice, /closeTerminalForTabs\(\n\s+state\.tabs\.filter\(\(tab\) => tab\.id !== tabId\)/);
  assert.match(slice, /closeTerminalForTabs\(state\.tabs\.map/);
});

test("the terminal stylesheet is loaded and stays on theme tokens", () => {
  assert.match(globals, /@import "@xterm\/xterm\/css\/xterm\.css";/);
  assert.match(globals, /@import "\.\/terminal\.css";/);
  assert.match(styles, /\.terminal-tab__surface/);
  assert.match(styles, /\.terminal-tab__surface \.xterm \{/);
  // Typography and radius come from the token scales, never raw literals.
  assert.doesNotMatch(styles, /font-size:\s*\d/);
  assert.doesNotMatch(styles, /border-radius:\s*\d/);
  assert.doesNotMatch(styles, /line-height:\s*[\d.]+/);
  // Surfaces resolve through --ds-* tokens so both themes keep the pane.
  assert.doesNotMatch(styles, /background:\s*#/);
});

test("xterm is declared as the renderer's terminal dependency", () => {
  assert.equal(pkg.devDependencies["@xterm/xterm"], "5.5.0");
  assert.equal(pkg.devDependencies["@xterm/addon-fit"], "0.10.0");
});

test("every locale translates the terminal entry and its states", () => {
  for (const locale of LOCALES) {
    const catalog = read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    // The tab strip label sits inside the `panel.tabs` block…
    assert.match(
      catalog,
      /"?tabs"?: \{[\s\S]{0,400}?"?terminal"?: "/,
      `${locale} is missing panel.tabs.terminal`,
    );
    // …and the pane's own strings sit in `panel.terminal`.
    const block = catalog.slice(catalog.indexOf('terminal: {') >= 0 ? catalog.indexOf('terminal: {') : catalog.indexOf('"terminal": {'));
    assert.ok(block.length > 0, `${locale} is missing panel.terminal`);
    for (const key of [
      "title",
      "shell",
      "hostLabel",
      "localHost",
      "connecting",
      "restart",
      "exited",
      "exitedWithCode",
      "failed",
      "noShells",
      "offline",
      "offlineHint",
      "reconnect",
      "bufferOverflow",
    ]) {
      assert.match(
        block.slice(0, 1200),
        new RegExp(`"?${key}"?: "`),
        `${locale} is missing panel.terminal.${key}`,
      );
    }
  }
});

test("the English catalog names the host and the recovery path", () => {
  const catalog = read("../../../packages/i18n/src/locales/en/index.ts");
  const block = catalog.slice(catalog.indexOf("    terminal: {"), catalog.indexOf("    pluginView: {"));
  assert.match(block, /hostLabel: "Host"/);
  assert.match(block, /localHost: "Local"/);
  assert.match(block, /offline: "Host offline"/);
  assert.match(block, /exitedWithCode: "Terminal exited \(code \{\{code\}\}\)"/);
});

test("the panel keeps its existing tabs reachable next to the terminal entry", () => {
  // Review and the plugin launchers must survive the new launcher entry.
  assert.match(panel, /id: "review",\n {6}tab: toolWorkPanelTab\("review"\)/);
  assert.match(panel, /\.\.\.pluginViews\.map\(\(view\) => \{/);
  // The empty/new launcher still lists every tool.
  assert.match(panel, /\{tools\.map\(\(item\) => \(/);
});

test("a lost host can be re-attached without killing the shell", () => {
  assert.match(pane, /const retryAttachment = useCallback/);
  assert.match(pane, /setAttempt\(/);
  assert.match(pane, /terminal-tab__reconnect/);
  assert.match(pane, /t\("panel\.terminal\.reconnect"\)/);
  // Retry attachment must not be Restart: the two are separate controls.
  const retry = pane.slice(pane.indexOf("const retryAttachment"), pane.indexOf("const busy ="));
  assert.doesNotMatch(retry, /closeTerminalForTab|terminalClose/);
  assert.match(pane, /className="terminal-tab__restart"/);
});
