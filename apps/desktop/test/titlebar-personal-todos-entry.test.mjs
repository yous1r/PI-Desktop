/**
 * The personal board's titlebar entry is a top-toolbar action.
 *
 * It used to be a viewport-fixed control parked one gap left of the
 * viewport-fixed work-panel toggle. That reads as an orphan: opening the work
 * panel narrows the pane, the toolbar's action cluster slides left with it, and
 * the board entry stayed nailed to the window edge. The entry now renders inside
 * whichever titlebar row owns the toolbar — the conversation topbar's action
 * cluster, the route band's right cluster, and the maximized panel's chrome row
 * — so it is laid out on the same flex line as New Task and Search and moves
 * with them.
 *
 * These tests cover the user-visible consequence (the chat cluster renders the
 * board as one of its own buttons), the single-implementation rule (one shared
 * component owns the bridge call), and the layout rule that no container keeps a
 * lane for an entry that no longer floats.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();
const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const chrome = await readFile(
  new URL("../src/features/app/chrome.tsx", import.meta.url),
  "utf8",
);
const topbar = await readFile(
  new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
  "utf8",
);

const WITHOUT_COMMENTS = styles.replace(/\/\*[\s\S]*?\*\//g, "");
const ALL_RULES = WITHOUT_COMMENTS.match(/[^{}]+\{[^{}]*\}/g) ?? [];

/** The last rule whose selector list contains one of these exact selectors. */
function ruleFor(...selectors) {
  const rules = ALL_RULES.filter((text) =>
    text
      .slice(0, text.indexOf("{"))
      .split(",")
      .map((member) => member.trim())
      .some((member) => selectors.includes(member)),
  );
  assert.ok(rules.length > 0, `rule for ${selectors.join(", ")} is missing`);
  return rules[rules.length - 1];
}

/** One declaration's value inside a rule body. */
function declaration(ruleText, property) {
  const body = ruleText.slice(ruleText.indexOf("{") + 1);
  const match = body.match(new RegExp(`(?:^|\\s)${property}:\\s*([^;]+);`));
  assert.ok(match, `${property} is missing from ${ruleText}`);
  return match[1].trim();
}

/** Every rule whose selector list names `selector`. */
function rulesNaming(selector) {
  return ALL_RULES.filter((text) =>
    text.slice(0, text.indexOf("{")).includes(selector),
  );
}

/** Whitespace-insensitive CSS text comparison. */
function css(value) {
  return value.replace(/\s+/g, " ").trim();
}

const TOGGLE_LANE = css(`calc(
  var(--ds-work-panel-toggle-size) + var(--ds-work-panel-toggle-inset) +
    var(--ds-work-panel-control-gap)
)`);

/** Render the real conversation topbar with an English catalog, as chat does. */
async function withTopbar(work) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ConversationTopbar } = await server.ssrLoadModule(
      "/src/components/ConversationTopbar.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const { remoteEn } = await server.ssrLoadModule("/src/locales/remote.ts");
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en, remote: remoteEn } },
    });

    const render = ({ sidebarCollapsed = false, workPanelOpen = false } = {}) => {
      Object.assign(useAppStore.getInitialState(), {
        activeSessionId: "todo-entry",
        sessions: [{ id: "todo-entry", title: "Toolbar ownership", projectPath: "/work" }],
        projectMeta: { "/work": { name: "Work" } },
        workspace: { path: "/work", name: "Work" },
      });
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ConversationTopbar, {
            sidebarCollapsed,
            workPanelOpen,
            onToggleSidebar() {},
            onNewTask() {},
            onOpenSearch() {},
          }),
        ),
      );
    };

    return await work({ render });
  } finally {
    await server.close();
  }
}

/** The markup of the chat topbar's action cluster. */
function actionCluster(html) {
  const start = html.indexOf('<div class="ct-actions">');
  assert.ok(start > 0, "the topbar has no .ct-actions cluster");
  return html.slice(start, html.indexOf("</div>", start));
}

test("the chat toolbar renders the board entry as one of its own actions", async () => {
  await withTopbar(async ({ render }) => {
    for (const { sidebarCollapsed, workPanelOpen } of [
      { sidebarCollapsed: false, workPanelOpen: false },
      { sidebarCollapsed: true, workPanelOpen: false },
      { sidebarCollapsed: false, workPanelOpen: true },
    ]) {
      const state = JSON.stringify({ sidebarCollapsed, workPanelOpen });
      const cluster = actionCluster(render({ sidebarCollapsed, workPanelOpen }));
      assert.equal(
        (cluster.match(/class="[^"]*app-personal-todos-toggle[^"]*"/g) ?? []).length,
        1,
        `${state}: the board entry must be inside the topbar's action cluster`,
      );
      // It is the last member of the cluster, beside Search: the toolbar's own
      // flex line carries it, so a pane that narrows takes it along. Its class
      // list is the marker the entry has always carried, and the shared
      // chrome-control family styles it by that same class name.
      const search = cluster.indexOf('aria-label="Search"');
      const entry = cluster.indexOf("app-personal-todos-toggle");
      assert.ok(search > 0 && entry > search, `${state}: the entry follows Search`);
      assert.match(
        cluster,
        new RegExp(
          `class="app-personal-todos-toggle no-drag" aria-label="${catalogs.en.personalTodos.open}"`,
        ),
      );
      assert.match(cluster, /<button[^>]*data-nav="personal-todos"/);
    }
  });
});

test("one shared component owns the bridge call", () => {
  assert.match(chrome, /export function PersonalTodosTitlebarAction\(\)/);
  assert.match(chrome, /IPC\.invoke\.personalTodosWindow, \{ action: "open" \}/);
  assert.match(chrome, /console\.error\("Failed to open personal todos", error\)/);
  assert.match(chrome, /t\("personalTodos\.open"\)/);

  // Every surface renders that component; none of them repeats the invoke.
  assert.match(topbar, /<PersonalTodosTitlebarAction \/>/);
  assert.match(
    topbar,
    /import \{ PersonalTodosTitlebarAction \} from "\.\.\/features\/app\/chrome"/,
  );
  assert.equal((appShell.match(/<PersonalTodosTitlebarAction \/>/g) ?? []).length, 2);
  for (const [name, source] of [
    ["AppShell", appShell],
    ["ConversationTopbar", topbar],
  ]) {
    assert.doesNotMatch(
      source,
      /personalTodosWindow/,
      `${name} must not repeat the bridge call`,
    );
  }
});

test("the shell's own titlebar rows carry the entry", () => {
  // Route band (Plugins/Scheduled) and the maximized panel's chrome row.
  const routeBand = appShell.match(
    /<div\s+className="main-titlebar-right no-drag"[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(routeBand, "the route band needs its own action cluster");
  assert.match(routeBand, /<PersonalTodosTitlebarAction \/>/);
  const chromeRow = appShell.match(/window-chrome-row[\s\S]*?<\/div>\s*\)\}/)?.[0];
  assert.ok(chromeRow, "the preview chrome row is missing");
  assert.match(chromeRow, /<PersonalTodosTitlebarAction \/>/);

  // The overlay root is gone: no shell-level entry, and no route conditional
  // that special-cases Settings — the entry is wherever the toolbar is.
  assert.doesNotMatch(appShell, /page === "settings" \? null : \(/);
  assert.equal((appShell.match(/app-personal-todos-toggle/g) ?? []).length, 0);
});

test("the entry owns no position, seat, or lane of its own", () => {
  const naming = rulesNaming(".app-personal-todos-toggle");
  assert.ok(naming.length > 0, "the entry must be styled as a chrome control");
  for (const text of naming) {
    for (const property of ["position", "top", "right", "left", "z-index"]) {
      assert.doesNotMatch(
        text,
        new RegExp(`(^|[\\s{;])${property}:`),
        `the entry restates ${property}; the toolbar row owns its place`,
      );
    }
    // One seat, one geometry: every rule naming the entry is the shared family.
    assert.match(
      text,
      /\.conversation-topbar \.ct-icon-btn/,
      "the entry has a rule outside the shared chrome-control family",
    );
  }

  const family = ruleFor(".conversation-topbar .ct-icon-btn");
  assert.match(family, /height:\s*var\(--ds-work-panel-toggle-size\);/);
  assert.match(family, /width:\s*var\(--ds-work-panel-toggle-size\);/);
  assert.match(family, /background:\s*transparent;/);
  const hover = ruleFor(
    ".conversation-topbar .ct-icon-btn:hover:not(:disabled)",
    ".app-personal-todos-toggle:hover:not(:disabled)",
  );
  assert.match(hover, /background:\s*var\(--ds-bg-hover\);/);
});

test("no container reserves a lane for the entry", () => {
  // The viewport-fixed work-panel toggle keeps its lane; the entry is content.
  const header = ruleFor(".work-panel-header");
  assert.equal(
    css(declaration(header, "padding")),
    css(`0 ${TOGGLE_LANE} 0 12px`),
  );
  assert.equal(
    css(declaration(ruleFor(".main-titlebar"), "padding-right")),
    TOGGLE_LANE,
  );

  // Preview actions occupy the leading toolbar group, before its spacer,
  // and the panel header starts after that group instead of underneath it.
  assert.match(appShell, /<PersonalTodosTitlebarAction \/>\s*<div className="window-chrome-drag"/);
  for (const selector of [".app-shell.work-panel-maximized", ".app-shell.work-panel-maximized.sidebar-collapsed"]) {
    const lane = declaration(ruleFor(selector), "--preview-chrome-action-lane");
    assert.match(lane, /var\(--ds-work-panel-toggle-size\)/);
    assert.match(lane, /var\(--ds-work-panel-control-gap\)/);
  }

  // Open, the lane has left the pane for the panel header, so the pane keeps no
  // unused gap for controls that are not over it.
  assert.equal(
    declaration(ruleFor(".main-titlebar.work-panel-open"), "padding-right"),
    "12px",
  );
  assert.equal(
    declaration(
      ruleFor(".conversation-topbar.ct-work-panel-open .ct-right"),
      "padding-right",
    ),
    "0",
  );
});
