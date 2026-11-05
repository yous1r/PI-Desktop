import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import * as workPanelResize from "../src/lib/work-panel-resize.ts";
import * as workPanelTabs from "../src/lib/work-panel-tabs.ts";

/**
 * Closing a tab is the only renderer-initiated end for a terminal.
 *
 * Every close path in the store — one tab, other tabs, all tabs — must end the
 * shell of each tab it drops, or a user who closes three terminals keeps three
 * processes running with no view that can ever reach them.
 */

const closedTabs = [];
const imports = {
  "../../lib/api": { api: { pluginViewClose: async () => undefined } },
  "../../lib/remote-session-safety": { isRemoteSession: () => false },
  "../../lib/work-panel-tabs": workPanelTabs,
  "../../lib/work-panel-resize": workPanelResize,
  "../../lib/terminal-sessions": {
    closeTerminalForTab: (tabId) => closedTabs.push(tabId),
    closeTerminalForTabs: (tabIds) => {
      for (const tabId of tabIds) closedTabs.push(tabId);
    },
  },
};

const { outputText } = ts.transpileModule(
  readFileSync(new URL("../src/stores/slices/work-panel-slice.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
);
const module = { exports: {} };
new Function("require", "exports", "module", outputText)(
  (id) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
    return imports[id];
  },
  module.exports,
  module,
);

function store() {
  let state = {
    activeSessionId: "A",
    sessions: [],
    workPanelOpen: true,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelFileRequest: null,
    workPanelContexts: {},
  };
  const get = () => state;
  const set = (value) => {
    state = { ...state, ...(typeof value === "function" ? value(state) : value) };
  };
  Object.assign(
    state,
    module.exports.createWorkPanelSlice({ get, set, isSessionSelectionPending: () => false }),
  );
  return { get, set };
}

function openTerminals(handle, count) {
  const tabs = [];
  for (let index = 0; index < count; index += 1) {
    const tab = workPanelTabs.terminalWorkPanelTab({
      sessionId: "A",
      workspaceId: `local:/work/app-${index}`,
    });
    tabs.push(tab);
    handle.get().openWorkPanelTab(tab);
  }
  return tabs;
}

test("closing one terminal tab ends exactly that shell", () => {
  closedTabs.length = 0;
  const handle = store();
  const [first, second] = openTerminals(handle, 2);

  handle.get().closeWorkPanelTab(first.id);

  assert.deepEqual(closedTabs, [first.id]);
  assert.deepEqual(handle.get().workPanelTabs.map((tab) => tab.id), [second.id]);
});

test("close-others keeps the kept terminal and ends the rest", () => {
  closedTabs.length = 0;
  const handle = store();
  const [first, second, third] = openTerminals(handle, 3);

  handle.get().closeOtherWorkPanelTabs(second.id);

  assert.deepEqual(closedTabs, [first.id, third.id]);
  assert.deepEqual(handle.get().workPanelTabs.map((tab) => tab.id), [second.id]);
});

test("close-all ends every terminal in the strip", () => {
  closedTabs.length = 0;
  const handle = store();
  const tabs = openTerminals(handle, 3);

  handle.get().closeAllWorkPanelTabs();

  assert.deepEqual(closedTabs, tabs.map((tab) => tab.id));
  assert.deepEqual(handle.get().workPanelTabs, []);
});

test("close-others on a single terminal tab closes nothing", () => {
  closedTabs.length = 0;
  const handle = store();
  const [only] = openTerminals(handle, 1);

  handle.get().closeOtherWorkPanelTabs(only.id);

  assert.deepEqual(closedTabs, []);
  assert.deepEqual(handle.get().workPanelTabs.map((tab) => tab.id), [only.id]);
});

test("opening a terminal tab does not end any shell", () => {
  closedTabs.length = 0;
  const handle = store();
  const tabs = openTerminals(handle, 2);

  assert.deepEqual(closedTabs, []);
  // The target captured at open time survives in the store, so a re-mount can
  // re-attach to the same shell after a project switch.
  assert.deepEqual(
    handle.get().workPanelTabs.map((tab) => tab.terminal?.workspaceId),
    tabs.map((tab) => tab.terminal?.workspaceId),
  );
  assert.equal(handle.get().activeWorkPanelTabId, tabs[1].id);
});

test("remote sessions keep independent terminal tabs and reject unrelated panel targets", () => {
  const handle = store();
  const sessionId = "remote:host:session";
  handle.set({ activeSessionId: sessionId });
  const first = workPanelTabs.terminalWorkPanelTab({ sessionId, workspaceId: "ssh:host:/repo" });
  const second = workPanelTabs.terminalWorkPanelTab({ sessionId, workspaceId: "ssh:host:/repo" });
  handle.get().openWorkPanelTab(first);
  handle.get().openWorkPanelTab(second);
  assert.deepEqual(handle.get().workPanelTabs.map(tab => tab.id), [first.id, second.id]);
  handle.get().openWorkPanelTab(workPanelTabs.newWorkPanelTab());
  handle.get().openWorkPanelTab(workPanelTabs.terminalWorkPanelTab({ sessionId: "other" }));
  assert.equal(handle.get().workPanelTabs.length, 2);
  closedTabs.length = 0;
  handle.get().closeWorkPanelTab(first.id);
  assert.deepEqual(closedTabs, [first.id]);
  assert.equal(handle.get().activeWorkPanelTabId, second.id);
  assert.deepEqual(handle.get().workPanelContexts[sessionId].tabs.map(tab => tab.id), [second.id]);
});
