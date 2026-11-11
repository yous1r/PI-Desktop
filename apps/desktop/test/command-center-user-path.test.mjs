import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isValidElement } from "react";
import { createInstance } from "i18next";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

/**
 * One representative local path through the V3 surface: open the overview,
 * enter a workspace from its entry preview, write a draft, switch workspace,
 * recall a task, open History and come back — without a Host.
 *
 * The pages are hook-free functions of their view props, so the test renders a
 * small tree by calling each component with the props the surface passes and
 * invokes the handlers of the elements it finds. That covers the real view
 * model, the real markup and the real ports; only the thin `useReducer` and
 * `useTranslation` wiring in `CommandCenterSurface` is exercised by the
 * Electron E2E.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const summaryFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const enFragment = JSON.parse(
  await readFile(new URL("../src/components/command-center/locales/en.json", import.meta.url), "utf8"),
);

const workspaces = summaryFixture.workspaces.workspaces;
const snapshot = summaryFixture.snapshot;
const delivery = workspaces[0];
const research = workspaces[1];

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: enFragment } }, interpolation: { escapeValue: false } });
const t = i18n.getFixedT("en", "translation");

const server = await createServer({
  root: `${root}/apps/desktop`,
  configFile: false,
  logLevel: "silent",
  resolve: { alias: currentSourceAliases(root) },
  server: { middlewareMode: true, hmr: false, ws: false },
  esbuild: { jsx: "automatic" },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
test.after(() => server.close());

const view = await server.ssrLoadModule("/src/components/command-center/view/command-center-view.ts");
const { CommandCenterOverview } = await server.ssrLoadModule("/src/components/command-center/CommandCenterOverview.tsx");
const { CommandCenterWorkspacePage } = await server.ssrLoadModule(
  "/src/components/command-center/CommandCenterWorkspacePage.tsx",
);
const { CommandCenterHistoryPage } = await server.ssrLoadModule(
  "/src/components/command-center/CommandCenterHistoryPage.tsx",
);

/**
 * Expand hook-free function components so handler props become reachable. The
 * command-center pages contain no hooks by construction; a hook here would
 * throw instead of silently returning a stale tree.
 */
function expand(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  if (typeof node.type !== "function") return node;
  return expand(node.type(node.props));
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  const expanded = expand(node);
  if (expanded !== node) return findAll(expanded, predicate, found);
  if (predicate(node)) found.push(node);
  findAll(node.props.children, predicate, found);
  return found;
}

function action(tree, name, workspaceId) {
  const [element] = findAll(
    tree,
    (node) =>
      node.props["data-command-center"] === name &&
      (workspaceId === undefined || node.props["data-workspace-id"] === workspaceId),
  );
  assert.ok(element, `expected a "${name}" control${workspaceId === undefined ? "" : ` for ${workspaceId}`}`);
  return element;
}

function textareaValue(tree) {
  const [element] = findAll(tree, (node) => node.type === "textarea");
  assert.ok(element, "the composer textarea must exist");
  return element.props.value;
}

let state = view.createCommandCenterViewState();
const dispatch = (action_) => {
  state = view.reduceCommandCenterView(state, action_);
};

const overviewTree = () =>
  CommandCenterOverview({
    t,
    workspaces,
    snapshot,
    onOpenWorkspace: (workspaceId) => dispatch({ type: "open-workspace", workspaceId }),
  });

const workspaceTree = (workspaceId) => {
  const workspaceView = view.selectWorkspaceView({ workspaceId, workspaces, snapshot });
  assert.ok(workspaceView, `workspace ${workspaceId} must resolve`);
  const draftKey = view.commandCenterDraftKey(workspaceId);
  return CommandCenterWorkspacePage({
    t,
    view: workspaceView,
    focusedTask: undefined,
    receipts: [],
    capabilities: undefined,
    draft: state.drafts[draftKey] ?? "",
    draftKey,
    onDraftChange: (key, text) => dispatch({ type: "update-draft", key, text }),
    onSubmitDraft: undefined,
    onOpenWorkspace: (next) => dispatch({ type: "open-workspace", workspaceId: next }),
    onSelectTask: (target) => {
      const entry = view.commandCenterVisitEntry({ target, rows: view.selectTaskRows(snapshot), workspaces });
      assert.ok(entry, "history may only record a row the Host reported");
      dispatch({ type: "record-visit", entry });
    },
    selectedTaskKey: undefined,
  });
};

const historyTree = () =>
  CommandCenterHistoryPage({
    t,
    entries: state.history,
    onOpenEntry: (entry) => dispatch({ type: "open-history-entry", entry }),
  });

test("a local command-center path keeps focus, drafts and history without touching execution", () => {
  // 1. The overview offers the three real workspaces and nothing else.
  const overview = overviewTree();
  assert.equal(
    findAll(overview, (node) => node.props["data-command-center"] === "workspace-entry").length,
    3,
  );
  assert.deepEqual(state.destination, { kind: "overview" });

  // 2. Entering workspace A from its preview opens the focused page.
  action(overview, "workspace-entry", delivery.id).props.onClick();
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: delivery.id });
  assert.equal(state.lastWorkspaceId, delivery.id);

  // 3. The focused page shows only that workspace's rows and its own draft.
  const deliveryPage = workspaceTree(delivery.id);
  const taskRows = findAll(deliveryPage, (node) => node.props["data-command-center"] === "task-row");
  assert.equal(taskRows.length, 2, "rows are filtered to the focused workspace");
  assert.equal(textareaValue(deliveryPage), "", "a new workspace starts with an empty draft");

  // 4. Typing is local and survives navigation.
  const textarea = findAll(deliveryPage, (node) => node.type === "textarea")[0];
  textarea.props.onChange({ target: { value: "Keep the public payment API unchanged." } });
  const deliveryDraftKey = view.commandCenterDraftKey(delivery.id);
  assert.equal(state.drafts[deliveryDraftKey], "Keep the public payment API unchanged.");
  assert.equal(textareaValue(workspaceTree(delivery.id)), "Keep the public payment API unchanged.");

  // 5. Switching workspace through the top-right tab keeps both drafts apart.
  action(deliveryPage, "workspace-tab", research.id).props.onClick();
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: research.id });
  assert.equal(textareaValue(workspaceTree(research.id)), "", "the researched workspace has its own draft");
  assert.equal(
    state.drafts[deliveryDraftKey],
    "Keep the public payment API unchanged.",
    "the first draft is preserved, not moved",
  );

  // 6. Selecting tasks records local recall by canonical identity.
  const researchPage = workspaceTree(research.id);
  const [researchRow] = findAll(researchPage, (node) => node.props["data-command-center"] === "task-open");
  assert.ok(researchRow, "a selection port turns rows into buttons");
  researchRow.props.onClick();
  assert.equal(state.history.length, 1);
  assert.deepEqual(state.history[0].workspaceName, "Research");

  action(workspaceTree(delivery.id), "workspace-tab", delivery.id).props.onClick();
  const deliveryRows = findAll(workspaceTree(delivery.id), (node) => node.props["data-command-center"] === "task-open");
  assert.equal(deliveryRows.length, 2);
  deliveryRows[0].props.onClick();
  deliveryRows[1].props.onClick();
  assert.equal(state.history.length, 3, "three distinct tasks are three entries");
  assert.equal(state.history[0].workspaceName, "Delivery", "the most recent visit leads");

  // 7. Re-opening the same task merges instead of duplicating.
  const visitsBefore = state.visitSequence;
  deliveryRows[0].props.onClick();
  assert.equal(state.history.length, 3, "re-visiting one task does not add a row");
  assert.equal(state.visitSequence, visitsBefore + 1);
  assert.equal(new Set(state.history.map((entry) => JSON.stringify(entry.target))).size, 3);

  // 8. History lists the entries and reopens one without leaving the client.
  dispatch({ type: "open-history" });
  const historyPage = historyTree();
  const entries = action(historyPage, "history-entry");
  entries.props.onClick();
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: delivery.id });
  assert.equal(state.history.length, 3, "opening an entry does not duplicate it");

  // 9. Returning to the overview keeps the focused workspace and every draft.
  dispatch({ type: "open-overview" });
  assert.deepEqual(state.destination, { kind: "overview" });
  assert.equal(state.lastWorkspaceId, delivery.id);
  assert.equal(state.drafts[deliveryDraftKey], "Keep the public payment API unchanged.");

  // 10. Nothing in this path forged or settled a task: every entry points at a
  //     reported summary target, and the surface still owns no execution state.
  const reportedTargets = new Set(snapshot.rows.map((row) => JSON.stringify(row.target)));
  for (const entry of state.history) assert.ok(reportedTargets.has(JSON.stringify(entry.target)));
  assert.deepEqual(Object.keys(state).sort(), ["destination", "drafts", "history", "lastWorkspaceId", "visitSequence"]);

  // 11. The composer never sends without an explicit port: no capability exists.
  const sendButton = findAll(workspaceTree(delivery.id), (node) => node.props.children === "Send")[0];
  assert.ok(sendButton, "Send is rendered so its unavailability is discoverable");
  assert.equal(sendButton.props.disabled, true);
  assert.equal(sendButton.props.onClick(), undefined, "no handler is wired without a submit port");
  assert.equal(
    findAll(workspaceTree(delivery.id), (node) => node.props["data-command-center"] === "send-unavailable").length,
    1,
  );
});
