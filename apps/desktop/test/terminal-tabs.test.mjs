import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  activateWorkPanelTabState,
  closeAllWorkPanelTabsState,
  closeOtherWorkPanelTabsState,
  closeWorkPanelTabState,
  emptyWorkPanelContext,
  isKnownWorkPanelTab,
  isToolWorkPanelTab,
  openWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  switchWorkPanelContextState,
  terminalWorkPanelTab,
} from "../src/lib/work-panel-tabs.ts";

/**
 * A terminal tab is a real work-panel tab: it must open, close, sanitize, and
 * survive a session switch like any other tab, while carrying the target it was
 * created for. These are the invariants the panel and the store rely on.
 */

const TERMINAL_TARGET = { sessionId: "session-a", workspaceId: "local:/work/app" };

test("each terminal click opens an independent tab bound to its own target", () => {
  const first = terminalWorkPanelTab(TERMINAL_TARGET);
  const second = terminalWorkPanelTab(TERMINAL_TARGET);

  assert.equal(first.kind, "terminal");
  assert.notEqual(first.id, second.id, "two terminals must not share a tab id");
  assert.match(first.id, /^terminal:/);
  assert.deepEqual(first.terminal, {
    sessionId: "session-a",
    workspaceId: "local:/work/app",
    tabId: first.id,
  });
  assert.equal(first.terminal?.tabId, first.id, "the target names the tab that owns it");
});

test("a remote terminal tab is labelled with the host it runs on", () => {
  const local = terminalWorkPanelTab(TERMINAL_TARGET);
  const remote = terminalWorkPanelTab({
    sessionId: "remote:host-a:s1",
    workspaceId: "ssh:host-a:/srv/app",
    hostLabel: "Build box",
  });

  assert.equal(local.label, undefined);
  assert.equal(remote.label, "Build box");
  assert.equal(remote.terminal?.workspaceId, "ssh:host-a:/srv/app");
});

test("a terminal tab with no workspace keeps only the session and tab", () => {
  const tab = terminalWorkPanelTab({ sessionId: "session-a" });
  assert.deepEqual(tab.terminal, { sessionId: "session-a", tabId: tab.id });
});

test("the tab model accepts terminal tabs and rejects unknown kinds", () => {
  const tab = terminalWorkPanelTab(TERMINAL_TARGET);
  assert.equal(isKnownWorkPanelTab(tab), true);
  // Terminal is a host-owned tool, so it stays out of the plugin tool section.
  assert.equal(isToolWorkPanelTab(tab), false);
  assert.equal(isKnownWorkPanelTab({ id: "x", kind: "hologram" }), false);
});

test("sanitizing keeps a terminal tab and its active selection", () => {
  const terminal = terminalWorkPanelTab(TERMINAL_TARGET);
  const review = { id: "review", kind: "review" };
  const sanitized = sanitizeWorkPanelTabsState({
    tabs: [review, terminal, { id: "broken", kind: "hologram" }],
    activeTabId: terminal.id,
  });

  assert.deepEqual(sanitized.tabs.map((tab) => tab.id), [review.id, terminal.id]);
  assert.equal(sanitized.activeTabId, terminal.id);
});

test("opening and closing terminal tabs follows the shared tab rules", () => {
  const first = terminalWorkPanelTab(TERMINAL_TARGET);
  const second = terminalWorkPanelTab(TERMINAL_TARGET);
  const opened = openWorkPanelTabState({ tabs: [], activeTabId: null }, first);
  const withBoth = openWorkPanelTabState(opened, second);

  assert.deepEqual(withBoth.tabs.map((tab) => tab.id), [first.id, second.id]);
  assert.equal(withBoth.activeTabId, second.id);

  const activated = activateWorkPanelTabState(withBoth, first.id);
  assert.equal(activated.activeTabId, first.id);

  const closedOthers = closeOtherWorkPanelTabsState(withBoth, first.id);
  assert.deepEqual(closedOthers.tabs.map((tab) => tab.id), [first.id]);

  const closedAll = closeAllWorkPanelTabsState(withBoth);
  assert.deepEqual(closedAll, { tabs: [], activeTabId: null });

  const closedOne = closeWorkPanelTabState(withBoth, first.id);
  assert.deepEqual(closedOne.tabs.map((tab) => tab.id), [second.id]);
});

test("a terminal keeps its own workspace after the visible session switches", () => {
  const terminal = terminalWorkPanelTab(TERMINAL_TARGET);
  const sessionA = {
    open: true,
    tabs: [terminal],
    activeTabId: terminal.id,
    fileRequest: null,
  };

  // Switch away to a session that has no tabs at all.
  const away = switchWorkPanelContextState(
    { "session-a": sessionA },
    "session-a",
    sessionA,
    "session-b",
  );
  assert.deepEqual(away.visible, emptyWorkPanelContext());

  // Switch back: the tab returns with its creation-time target intact, which is
  // what lets the view re-attach to the same shell instead of a new one.
  const back = switchWorkPanelContextState(
    away.contexts,
    "session-b",
    away.visible,
    "session-a",
  );
  assert.equal(back.visible.tabs.length, 1);
  assert.deepEqual(back.visible.tabs[0].terminal, terminal.terminal);
  assert.equal(back.visible.tabs[0].terminal?.workspaceId, "local:/work/app");
});

test("opening a terminal tab does not disturb other tab kinds", () => {
  const file = { id: "file:/work/app/a.ts", kind: "file", resource: "/work/app/a.ts" };
  const terminal = terminalWorkPanelTab(TERMINAL_TARGET);
  const opened = openWorkPanelTabState(
    openWorkPanelTabState({ tabs: [], activeTabId: null }, file),
    terminal,
  );
  assert.deepEqual(opened.tabs.map((tab) => tab.kind), ["file", "terminal"]);
  assert.equal(opened.tabs[0].resource, "/work/app/a.ts");
});

test("the work panel renders the terminal tab with the shared pane component", () => {
  const panel = readFileSync(
    new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
    "utf8",
  );
  const tabs = readFileSync(
    new URL("../src/lib/work-panel-tabs.ts", import.meta.url),
    "utf8",
  );

  // A launcher entry that opens a new tab per click, not a shared singleton.
  assert.match(panel, /function terminalTool\(/);
  assert.match(panel, /createTab: \(\) => terminalWorkPanelTab\(target\)/);
  assert.match(panel, /\.\.\.workPanelTools\(t, pluginViews\),\n\s+terminalTool\(t, \{/);
  assert.match(panel, /const tab = item\.tab \?\? item\.createTab\?\.\(\)/);
  // The launcher icon map covers every tab kind the strip can display.
  assert.match(panel, /terminal: IconTerminal,/);
  // The pane is mounted through the tabpanel contract the other kinds use.
  assert.match(panel, /activeTab\?\.kind === "terminal"/);
  assert.match(panel, /<TerminalTab\n {20}tabId=\{activeTab\.id\}/);
  // The target is captured at open time, never re-read from the store later.
  assert.match(panel, /terminalWorkspaceId\(\{ hostKey: workspace\.remote\?\.hostKey, path: workspace\.path \}\)/);
  assert.match(panel, /parseTerminalWorkspaceId\(activeTab\.terminal\.workspaceId\)/);
  assert.match(tabs, /export function terminalWorkPanelTab/);
});

test("the remote workspace offers the same terminal pane for a remote host", () => {
  const remote = readFileSync(
    new URL("../src/components/remote/RemoteWorkspace.tsx", import.meta.url),
    "utf8",
  );
  const terminals = readFileSync(new URL("../src/components/remote/RemoteTerminalTabs.tsx", import.meta.url), "utf8");
  assert.match(remote, /<RemoteTerminalTabs session=\{session\}/);
  assert.match(terminals, /import \{ TerminalTab \} from "\.\.\/workpanel\/TerminalTab"/);
  assert.match(remote, /value: "terminal", label: tRoot\("panel\.tabs\.terminal"\)/);
  assert.match(terminals, /session\.remoteWorkspace\?\.hostKey \?\? session\.remoteHostKey/);
  assert.doesNotMatch(terminals, /terminalWorkspaceId\(\{ hostKey: useAppStore/);
});
