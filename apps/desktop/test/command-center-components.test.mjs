import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

/**
 * V3 command-center pages rendered server-side with the real components.
 *
 * Server rendering runs no user input, so these assertions cover accessible
 * names, roles, disabled controls and localized copy. Interaction is covered by
 * the user-path test; real Electron acceptance belongs to the integration lane.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const summaryFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const controlFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const enFragment = JSON.parse(
  await readFile(new URL("../src/components/command-center/locales/en.json", import.meta.url), "utf8"),
);
const zhFragment = JSON.parse(
  await readFile(new URL("../src/components/command-center/locales/zh-CN.json", import.meta.url), "utf8"),
);

const workspaces = summaryFixture.workspaces.workspaces;
const snapshot = summaryFixture.snapshot;
const delivery = workspaces[0];
const focusedTask = snapshot.rows.find((row) => row.status === "waiting_human");
const lifecycle = controlFixture.receipts;

async function translator(locale, fragment) {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: locale,
    resources: { [locale]: { translation: fragment } },
    interpolation: { escapeValue: false },
  });
  return i18n.getFixedT(locale, "translation");
}

const i18nEn = await translator("en", enFragment);
const i18nZh = await translator("zh-CN", zhFragment);

const surfaceI18n = createInstance();
await surfaceI18n.init({
  lng: "en",
  ns: ["commandCenter"],
  defaultNS: "commandCenter",
  resources: { en: { commandCenter: enFragment } },
  interpolation: { escapeValue: false },
});

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
const { CommandCenterToolbar } = await server.ssrLoadModule("/src/components/command-center/CommandCenterToolbar.tsx");
const { CommandCenterSurface } = await server.ssrLoadModule("/src/components/command-center/CommandCenterSurface.tsx");
const strings = await server.ssrLoadModule("/src/components/command-center/strings.ts");

const render = (element) => renderToStaticMarkup(element);
const count = (html, pattern) => (html.match(pattern) ?? []).length;

/** The opening tag of the button with this accessible name, whatever the attribute order. */
function tagOf(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<button[^>]*aria-label="${escaped}"[^>]*>`));
  assert.ok(match, `a control named "${label}" must be rendered`);
  return match[0];
}

/** The opening tag of the button whose visible text is exactly this label. */
function textButtonOf(html, label) {
  const match = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  assert.ok(match, `a button labelled "${label}" must be rendered`);
  return match[0];
}

function firstReservedRegion(html) {
  const marker = 'data-command-center="reserved-region"';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, "the reserved regions must be rendered");
  const next = html.indexOf(marker, start + marker.length);
  return html.slice(start, next === -1 ? undefined : next);
}

test("the overview previews the three real workspaces and leaves both lower regions inert", () => {
  const html = render(createElement(CommandCenterOverview, { t: i18nEn, workspaces, snapshot, onOpenWorkspace() {} }));
  assert.match(html, /<h1[^>]*>Monitoring overview<\/h1>/);
  assert.match(html, /A \/ Delivery/);
  assert.match(html, /B \/ Research/);
  assert.match(html, /C \/ Operations/);
  assert.match(html, /2 \/ 12 agents/, "the preview shows the live agent count from the snapshot");
  assert.match(html, /aria-label="Open workspace A: Delivery, 2 of 12 agents running"/);
  assert.doesNotMatch(html, /Payments|Auth|Research brief/, "the review board's sample projects must not ship");

  assert.equal(count(html, /data-command-center="workspace-entry"/g), 3);
  assert.equal(count(html, /data-command-center="reserved-region"/g), 2);
  assert.equal(count(html, /<button/g), 3, "only workspace entries are interactive on the overview");

  const reserved = firstReservedRegion(html);
  assert.match(reserved, /aria-label="Reserved area 1"/);
  assert.match(reserved, /To be decided/);
  assert.match(reserved, /No function assigned/);
  assert.doesNotMatch(reserved, /<button|<a |tabindex|role="link"/, "the undecided regions stay non-interactive");
  assert.match(html, /Needs input 1/);
  assert.match(html, /All tasks 3/);
  assert.match(html, /Review child fixtures/, "attention rows lead the monitor list");
});

test("the overview and workspace labels are localized while data stays as reported", () => {
  const overview = render(
    createElement(CommandCenterOverview, { t: i18nZh, workspaces, snapshot, onOpenWorkspace() {} }),
  );
  assert.match(overview, /监控总览/);
  assert.match(overview, /A \/ Delivery/);
  assert.match(overview, /2 \/ 12 个智能体/);
  assert.match(overview, /待定区域 1/);
  assert.match(overview, /需要输入 1/);
  assert.match(overview, /尚未确定/);
});

test("the toolbar names its icon destinations and keeps Settings honest", () => {
  const html = render(
    createElement(CommandCenterToolbar, {
      t: i18nEn,
      destination: "overview",
      onOpenOverview() {},
      onOpenHistory() {},
      hostStatus: { label: "Local Host", state: "connected" },
    }),
  );
  assert.match(html, /<nav[^>]*aria-label="Main navigation"/);
  assert.match(tagOf(html, "Overview"), /aria-current="page"/);
  assert.doesNotMatch(tagOf(html, "History"), /aria-current/);
  assert.match(tagOf(html, "Settings"), /disabled/, "Settings needs the shell's navigation port");
  assert.match(html, /role="status"[^>]*aria-label="Host Local Host, status connected"/);
  assert.match(html, />Local Host</);

  const withSettings = render(
    createElement(CommandCenterToolbar, {
      t: i18nEn,
      destination: "history",
      onOpenOverview() {},
      onOpenHistory() {},
      onOpenSettings() {},
      hostStatus: { label: "Local Host", state: "offline" },
    }),
  );
  assert.doesNotMatch(tagOf(withSettings, "Settings"), /disabled/);
  assert.match(tagOf(withSettings, "History"), /aria-current="page"/);
  assert.match(withSettings, /status offline/);
});

test("a focused workspace shows its tabs, its local draft and why Send is unavailable", () => {
  const workspaceView = view.selectWorkspaceView({ workspaceId: delivery.id, workspaces, snapshot });
  const receipts = ["recorded", "accepted", "consumed", "completed"].map((status, index) => ({
    ...lifecycle.accepted,
    requestId: `request-${index}`,
    status,
    revision: index + 1,
  }));
  const html = render(
    createElement(CommandCenterWorkspacePage, {
      t: i18nEn,
      view: workspaceView,
      focusedTask,
      receipts,
      draft: "Keep the public API unchanged.",
      draftKey: view.commandCenterDraftKey(delivery.id),
      onDraftChange() {},
      onSubmitDraft() {},
      onOpenWorkspace() {},
    }),
  );
  assert.match(html, /<h1[^>]*>Delivery<\/h1>/);
  assert.equal(count(html, /data-command-center="workspace-tab"/g), 3, "tabs stay at the top right");
  assert.match(tagOf(html, "Open workspace A: Delivery"), /aria-current="page"/);
  assert.doesNotMatch(tagOf(html, "Open workspace B: Research"), /aria-current/, "only the opened workspace is current");
  assert.match(html, /data-command-center="send-unavailable"/);
  assert.match(html, />Sending guidance is not available in this build\.</);
  assert.match(textButtonOf(html, "Send"), /disabled/, "controls stay unavailable while the capability is absent");
  assert.match(html, /Keep the public API unchanged\.<\/textarea>/, "the local draft survives the render");
  assert.match(html, /Goal revision 2 committed, 2 confirmed/);

  for (const status of ["recorded", "accepted", "consumed", "completed"]) {
    assert.match(html, new RegExp(`data-receipt-status="${status}"`), `receipt state ${status} is separate`);
  }

  assert.doesNotMatch(html, /Back to overview/i, "V3 removed the duplicated return button");
  assert.match(html, /Leaving this view does not stop background work\./);
  assert.equal(count(html, /<button/g), 4, "without a selection port the task rows are not buttons (3 tabs + Send)");
});

test("task rows become buttons only when a selection port exists", () => {
  const workspaceView = view.selectWorkspaceView({ workspaceId: delivery.id, workspaces, snapshot });
  const html = render(
    createElement(CommandCenterWorkspacePage, {
      t: i18nZh,
      view: workspaceView,
      receipts: [],
      draft: "",
      draftKey: view.commandCenterDraftKey(delivery.id),
      onDraftChange() {},
      onSubmitDraft() {},
      onOpenWorkspace() {},
      onSelectTask() {},
      selectedTaskKey: view.selectTaskRows(snapshot)[0].key,
    }),
  );
  assert.equal(count(html, /data-command-center="task-open"/g), 2);
  assert.match(tagOf(html, "打开任务 Review child fixtures"), /aria-current="true"/);
  assert.match(html, /此版本尚不支持发送指引。/);
  assert.match(html, /还没有控制回执。/);
  assert.match(html, /为 Delivery 添加指引/);
});

test("history lists local entries with names, workspace and state", () => {
  const entries = view.mergeCommandCenterHistory(
    [],
    [
      {
        target: { kind: "session", sessionId: "sess-main-1" },
        label: "Deliver control contracts",
        workspaceId: delivery.id,
        workspaceName: "Delivery",
        status: "running",
        visitedAt: 1,
      },
      {
        target: { kind: "session", sessionId: "sess-other" },
        label: "Settled audit",
        workspaceId: workspaces[1].id,
        workspaceName: "Research",
        status: "completed",
        visitedAt: 2,
      },
    ],
  );
  const html = render(createElement(CommandCenterHistoryPage, { t: i18nEn, entries, onOpenEntry() {} }));
  assert.equal(count(html, /data-command-center="history-entry"/g), 2);
  assert.ok(tagOf(html, "Open Settled audit"));
  assert.equal(count(html, /data-task-key=/g), 2, "rows are keyed by the C1 task-key tuple");
  assert.match(html, /Workspace: Research/);
  assert.match(html, /Completed/);
  assert.match(html, /History on this device only/);
  const empty = render(createElement(CommandCenterHistoryPage, { t: i18nEn, entries: [], onOpenEntry() {} }));
  assert.match(empty, /No conversations opened yet\./);
});

test("every translated key exists in both locale fragments", async () => {
  const keys = new Set([
    ...Object.values(strings.COMMAND_CENTER_STATUS_LABEL_KEYS),
    ...Object.values(strings.COMMAND_CENTER_RECEIPT_LABEL_KEYS),
    ...Object.values(strings.COMMAND_CENTER_OPERATION_LABEL_KEYS),
  ]);
  const directory = new URL("../src/components/command-center/", import.meta.url);
  const files = (await readdir(directory, { recursive: true })).filter((name) => /\.tsx?$/.test(name));
  for (const name of files) {
    const source = await readFile(new URL(name.replaceAll("\\", "/"), directory), "utf8");
    for (const [, key] of source.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(key);
  }
  assert.ok(keys.size > 30, `the label scan found ${keys.size} keys`);

  const flatten = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) =>
      typeof value === "string" ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`),
    );
  const enKeys = new Set(flatten(enFragment));
  const zhKeys = new Set(flatten(zhFragment));
  assert.deepEqual([...enKeys].sort(), [...zhKeys].sort(), "both locales carry the same fragment shape");
  for (const key of keys) {
    assert.ok(enKeys.has(key), `missing English label for ${key}`);
    assert.ok(zhKeys.has(key), `missing Chinese label for ${key}`);
  }
  assert.equal(strings.COMMAND_CENTER_I18N_NAMESPACE, "commandCenter");
});

test("the surface mounts the toolbar with the page its local view selects", () => {
  const surface = (props) =>
    render(createElement(I18nextProvider, { i18n: surfaceI18n }, createElement(CommandCenterSurface, props)));

  const overview = surface({ workspaces, snapshot, hostStatus: { label: "Local Host", state: "connected" } });
  assert.match(overview, /data-command-center="surface"/);
  assert.match(overview, /data-command-center="toolbar"/);
  assert.match(overview, /Monitoring overview/);
  assert.match(overview, /A \/ Delivery/);
  assert.match(tagOf(overview, "Settings"), /disabled/);

  const focused = surface({
    workspaces,
    snapshot,
    initialView: { destination: { kind: "workspace", workspaceId: delivery.id }, lastWorkspaceId: delivery.id },
  });
  assert.match(focused, /data-command-center="workspace"/);
  assert.match(focused, new RegExp(`data-workspace-id="${delivery.id}"`));
  assert.doesNotMatch(focused, /Monitoring overview/, "the overview is not rendered behind the focused page");
  assert.match(tagOf(focused, "Open workspace A: Delivery"), /aria-current="page"/);

  const missing = surface({
    workspaces,
    snapshot,
    initialView: { destination: { kind: "workspace", workspaceId: "removed-workspace" } },
  });
  assert.match(missing, /data-command-center="workspace-unavailable"/);
  assert.match(missing, /This workspace is not available\./);
});
