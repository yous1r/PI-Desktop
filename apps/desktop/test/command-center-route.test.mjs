import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

/**
 * The mounted V3 command-center route.
 *
 * The route is a real application destination: it replaces the chat shell (no
 * global left sidebar), renders the surface from deterministic fixtures, and
 * registers its own i18next namespace. The user path below starts at the
 * overview and moves through a workspace, its tab strip and the local history
 * page using the same fixture data the route mounts.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const appShellSource = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const appStateSource = await readFile(new URL("../src/stores/app-state.ts", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
const searchSource = await readFile(new URL("../src/components/SearchDialog.tsx", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const languageSource = await readFile(new URL("../src/lib/renderer-language.ts", import.meta.url), "utf8");
const pageSource = await readFile(
  new URL("../src/features/command-center/CommandCenterPage.tsx", import.meta.url),
  "utf8",
);
const enFragment = JSON.parse(
  await readFile(new URL("../src/components/command-center/locales/en.json", import.meta.url), "utf8"),
);
const zhFragment = JSON.parse(
  await readFile(new URL("../src/components/command-center/locales/zh-CN.json", import.meta.url), "utf8"),
);

const server = await createServer({
  root: `${root}/apps/desktop`,
  configFile: false,
  logLevel: "silent",
  resolve: {
    alias: [
      ...currentSourceAliases(root),
      {
        find: /^@pi-desktop\/i18n\/locales\/([^/]+)$/,
        replacement: resolve(root, "packages/i18n/src/locales/$1/index.ts"),
      },
      {
        find: /^@pi-desktop\/i18n\/locale-info$/,
        replacement: resolve(root, "packages/i18n/src/locale-info.ts"),
      },
    ],
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  esbuild: { jsx: "automatic" },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
test.after(() => server.close());

const pageModule = await server.ssrLoadModule("/src/features/command-center/CommandCenterPage.tsx");
const fixtures = await server.ssrLoadModule("/src/features/command-center/command-center-fixtures.ts");
const catalogs = await server.ssrLoadModule("/src/lib/renderer-catalogs.ts");
const view = await server.ssrLoadModule("/src/components/command-center/view/command-center-view.ts");
const shared = await server.ssrLoadModule("@pi-desktop/shared");
const { CommandCenterOverview } = await server.ssrLoadModule(
  "/src/components/command-center/CommandCenterOverview.tsx",
);
const { CommandCenterWorkspacePage } = await server.ssrLoadModule(
  "/src/components/command-center/CommandCenterWorkspacePage.tsx",
);
const { CommandCenterSurface } = await server.ssrLoadModule(
  "/src/components/command-center/CommandCenterSurface.tsx",
);

const workspaces = fixtures.COMMAND_CENTER_PREVIEW_WORKSPACES;
const snapshot = fixtures.COMMAND_CENTER_PREVIEW_SNAPSHOT;
const delivery = workspaces[0];
const research = workspaces[1];

function translator(locale, fragment) {
  const instance = createInstance();
  return instance
    .init({
      lng: locale,
      fallbackLng: "en",
      ns: ["commandCenter"],
      defaultNS: "commandCenter",
      resources: {
        en: { commandCenter: enFragment },
        "zh-CN": { commandCenter: zhFragment },
      },
      interpolation: { escapeValue: false },
    })
    .then(() => instance);
}

const enI18n = await translator("en", enFragment);
const zhI18n = await translator("zh-CN", zhFragment);

function page(locale) {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: locale === "zh-CN" ? zhI18n : enI18n },
      createElement(pageModule.CommandCenterPage),
    ),
  );
}

function tagOf(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<button[^>]*aria-label="${escaped}"[^>]*>`));
  assert.ok(match, `a control named "${label}" must be rendered`);
  return match[0];
}

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}

/** Expand hook-free function components so their handler props stay reachable. */
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

test("the app shell mounts the command-center page as a full-window route", () => {
  assert.match(appStateSource, /page: "chat" \| "scheduled" \| "plugins" \| "settings" \| "command-center"/, "the store page union must type the new route");
  assert.match(
    appShellSource,
    /const CommandCenterPage = lazy\(\(\) =>\s*import\("\.\.\/\.\.\/pages\/CommandCenterPage"\)/,
    "the route is lazy like the other destination pages",
  );
  assert.match(
    appShellSource,
    /\{commandCenterMounted \|\| page === "command-center" \? \(\s*<div\s+className="command-center-host"\s+hidden=\{page !== "command-center"\}/,
    "the route mounts on first visit and stays mounted while the app lives",
  );
  assert.match(
    appShellSource,
    /if \(page === "command-center"\) setCommandCenterMounted\(true\)/,
    "first navigation to the route mounts it once",
  );
  assert.match(
    appShellSource,
    /page === "command-center" && ready && "command-center-mode"/,
    "the shell gets the full-window command-center mode",
  );
  assert.match(
    appShellSource,
    /hidden=\{page === "settings" \|\| page === "command-center"\}/,
    "the chat shell stays mounted but hidden on the command-center route",
  );
  assert.match(runtimeSource, /page === "settings" \|\| page === "plugins" \|\| page === "scheduled" \|\| page === "command-center"/);
  assert.doesNotMatch(pageSource, /<Sidebar|from "\.\.\/\.\.\/components\/Sidebar"/, "the command-center route must not mount the global left sidebar");
});

test("navigation reaches the route from the sidebar and the global search", () => {
  assert.match(sidebarSource, /data-nav="command-center"/);
  assert.match(sidebarSource, /tCommandCenter\("route\.entryLabel"\)/);
  assert.match(sidebarSource, /setPage\("command-center"\)/);
  assert.match(searchSource, /\{ page: "command-center", labelKey: "route\.entryLabel", icon: IconMonitor \}/);
  assert.match(searchSource, /setPage\(entry\.page\)/);
});

test("the mounted page renders the V3 surface with explicit preview state", () => {
  const html = page("en");
  assert.match(html, /data-route="command-center"/);
  assert.match(html, /data-command-center="surface"/);
  assert.match(html, /data-command-center="toolbar"/);
  assert.match(html, /<h1[^>]*>Monitoring overview<\/h1>/);
  assert.equal(count(html, /data-command-center="workspace-entry"/g), 3);
  assert.match(html, /A \/ Delivery/);
  assert.match(html, /B \/ Research/);
  assert.match(html, /C \/ Operations/);
  assert.match(html, /role="status"[^>]*aria-label="Host Local Host, status offline"/);
  assert.match(html, /data-command-center="preview-notice"/);
  assert.match(html, /Preview data only/);
  assert.doesNotMatch(html, /<aside|sidebar-surface/i, "no global sidebar is part of the surface");
  assert.equal(count(html, /data-command-center="reserved-region"/g), 2, "the undefined lower regions stay visible");
  assert.doesNotMatch(html, /data-command-center="reserved-region"[\s\S]*?<button/, "the undefined lower regions stay noninteractive");
});

test("the route follows the app language through its own namespace", () => {
  const html = page("zh-CN");
  assert.match(html, /<h1[^>]*>监控总览<\/h1>/);
  assert.match(html, /A \/ Delivery/);
  assert.match(html, /本地 Host/);
  assert.match(html, /仅预览数据/);
  assert.match(html, /aria-label="主机 本地 Host，状态：离线"/);
});

test("the route fixtures validate against the committed command-center contracts", () => {
  const list = shared.parseCommandCenterWorkspaceList({
    version: 1,
    workspaces: [...workspaces],
    quota: fixtures.COMMAND_CENTER_PREVIEW_QUOTA,
  });
  assert.equal(list.workspaces.filter((workspace) => workspace.enabled).length, 3);
  const parsedSnapshot = shared.parseCommandCenterMonitorSnapshot(snapshot);
  assert.equal(parsedSnapshot.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(parsedSnapshot.rows.length, 3);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  for (const row of parsedSnapshot.rows) {
    assert.ok(workspaceIds.has(row.commandWorkspaceId), "every row points at a previewed workspace");
  }
  for (const receipt of fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS) {
    assert.doesNotThrow(() => shared.parseCommandCenterReceipt(receipt));
  }
  assert.ok(Object.isFrozen(workspaces) && Object.isFrozen(fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS));
});

test("the fixture user path keeps workspace focus, drafts and local history", () => {
  let state = view.createCommandCenterViewState();
  const dispatch = (action) => {
    state = view.reduceCommandCenterView(state, action);
  };
  const t = enI18n.getFixedT("en", "commandCenter");

  const overview = CommandCenterOverview({
    t,
    workspaces,
    snapshot,
    onOpenWorkspace: (workspaceId) => dispatch({ type: "open-workspace", workspaceId }),
  });

  const overviewEntries = findAll(overview, (node) => node.props["data-command-center"] === "workspace-entry");
  assert.equal(overviewEntries.length, 3);
  overviewEntries[0].props.onClick();
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: delivery.id });
  assert.equal(state.lastWorkspaceId, delivery.id);

  const workspaceTree = (workspaceId) => {
    const workspaceView = view.selectWorkspaceView({ workspaceId, workspaces, snapshot });
    assert.ok(workspaceView);
    const draftKey = view.commandCenterDraftKey(workspaceId);
    return CommandCenterWorkspacePage({
      t,
      view: workspaceView,
      focusedTask: undefined,
      receipts: fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS,
      capabilities: undefined,
      draft: state.drafts[draftKey] ?? "",
      draftKey,
      onDraftChange: (key, text) => dispatch({ type: "update-draft", key, text }),
      onSubmitDraft: undefined,
      onOpenWorkspace: (next) => dispatch({ type: "open-workspace", workspaceId: next }),
      onSelectTask: (target) => {
        const entry = view.commandCenterVisitEntry({ target, rows: view.selectTaskRows(snapshot), workspaces });
        assert.ok(entry);
        dispatch({ type: "record-visit", entry });
      },
      selectedTaskKey: undefined,
    });
  };

  const deliveryPage = workspaceTree(delivery.id);
  const textarea = findAll(deliveryPage, (node) => node.type === "textarea")[0];
  textarea.props.onChange({ target: { value: "Keep the public API unchanged." } });
  const deliveryDraftKey = view.commandCenterDraftKey(delivery.id);
  assert.equal(state.drafts[deliveryDraftKey], "Keep the public API unchanged.");

  const researchTab = findAll(
    deliveryPage,
    (node) => node.props["data-command-center"] === "workspace-tab" && node.props["data-workspace-id"] === research.id,
  )[0];
  researchTab.props.onClick();
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: research.id });
  assert.equal(state.drafts[deliveryDraftKey], "Keep the public API unchanged.", "the first draft stays scoped to its workspace");

  const openTask = findAll(workspaceTree(research.id), (node) => node.props["data-command-center"] === "task-open")[0];
  assert.ok(openTask, "the fixture task rows accept local selection");
  openTask.props.onClick();
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].workspaceName, "Research");

  dispatch({ type: "open-history" });
  assert.deepEqual(state.destination, { kind: "history" });
  dispatch({ type: "open-overview" });
  assert.equal(state.lastWorkspaceId, research.id, "the focused workspace survives the history round trip");
  assert.equal(state.drafts[deliveryDraftKey], "Keep the public API unchanged.");
  assert.equal(Object.keys(state).sort().join(","), "destination,drafts,history,lastWorkspaceId,visitSequence");
});

test("the route keeps every unavailable control explicit and selects tasks locally", () => {
  assert.match(
    pageSource,
    /const activeProvider = provider \?\? registeredProvider \?\? COMMAND_CENTER_FIXTURE_PROVIDER/,
    "the route falls back to the fixture provider when no explicit or bootstrapped provider exists",
  );
  assert.match(
    pageSource,
    /hostStatus=\{\{ label: t\("route\.hostLabel"\), state: data\.host\.state \}\}/,
    "the Host status comes from the provider and defaults to offline instead of faking a connection",
  );
  assert.match(pageSource, /data\.source === "fixture" \? \(/, "the preview notice stays on the fixture path only");
  assert.doesNotMatch(pageSource, /capabilities=/, "the preview route advertises no capability");
  assert.doesNotMatch(pageSource, /onSubmitDraft=/, "the preview route invents no draft-submit port");
  assert.doesNotMatch(pageSource, /focusedTask=/, "no conversation is attached without a Host producer");
  assert.match(pageSource, /selectedTaskKey=\{selectedTaskKey\}/);
  assert.match(pageSource, /onSelectTask=\{\(target\) => setSelectedTaskKey\(commandCenterTaskKey\(target\)\)\}/);

  const focused = renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: enI18n },
      createElement(CommandCenterSurface, {
        workspaces,
        snapshot,
        receipts: fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS,
        initialView: { destination: { kind: "workspace", workspaceId: delivery.id }, lastWorkspaceId: delivery.id },
      }),
    ),
  );
  assert.match(focused, new RegExp(`data-workspace-id="${delivery.id}"`));
  assert.match(focused, /data-command-center="send-unavailable"/);
  assert.match(focused, /Sending guidance is not available in this build\./);
  assert.match(focused, /No conversation is attached\./);
  assert.match(focused, /data-command-center="receipt"/);
  assert.match(focused, /data-receipt-status="accepted"/);
});

test("the command-center namespace is registered through the renderer i18n mechanism", async () => {
  assert.deepEqual(catalogs.loadCommandCenterCatalog("en"), enFragment);
  assert.deepEqual(catalogs.loadCommandCenterCatalog("zh-CN"), zhFragment);
  const resources = await catalogs.loadRendererResources("zh-CN");
  assert.deepEqual(resources.en.commandCenter, enFragment);
  assert.deepEqual(resources["zh-CN"].commandCenter, zhFragment);
  assert.match(mainSource, /ns: \["translation", "remote", "commandCenter"\]/);
  assert.match(mainSource, /commandCenter: loadCommandCenterCatalog\("en"\)/);
  assert.match(mainSource, /commandCenter: loadCommandCenterCatalog\("zh-CN"\)/);
  assert.match(languageSource, /i18n\.addResourceBundle\(\s*target,\s*"commandCenter"/);
});

test("the route exposes accessible navigation, status and headings", () => {
  const html = page("en");
  assert.match(html, /<nav[^>]*aria-label="Main navigation">/);
  assert.match(tagOf(html, "Overview"), /aria-current="page"/);
  assert.match(tagOf(html, "Settings"), /aria-label="Settings"/);
  assert.doesNotMatch(tagOf(html, "Settings"), /disabled/, "the shell supplies the Settings port");
  assert.match(html, /<h1[^>]*>Monitoring overview<\/h1>/);
  assert.match(html, /role="note"/);
  assert.match(html, /role="status"[^>]*aria-label=/);
  const hostStatus = html.match(/role="status"[^>]*aria-label="[^"]*"/)?.[0] ?? "";
  assert.match(hostStatus, /Host Local Host, status offline/);
});
