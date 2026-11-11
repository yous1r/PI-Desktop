import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

/**
 * The command-center data-provider port.
 *
 * The route's default path stays the deterministic fixture preview with an
 * explicit offline Host. The injected path is driven by a real
 * `@pi-desktop/command-center-client` monitor session (observation context,
 * reader, health) plus bounded collection loaders. No transport is opened and
 * no turn is started: every external edge is an injected port in this test.
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
const dataSource = await readFile(
  new URL("../src/features/command-center/command-center-data.ts", import.meta.url),
  "utf8",
);

const server = await createServer({
  root: `${root}/apps/desktop`,
  configFile: false,
  logLevel: "silent",
  resolve: {
    alias: [
      ...currentSourceAliases(root),
      {
        find: /^@pi-desktop\/command-center-client$/,
        replacement: resolve(root, "packages/command-center-client/src/index.ts"),
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
const data = await server.ssrLoadModule("/src/features/command-center/command-center-data.ts");
const fixtures = await server.ssrLoadModule("/src/features/command-center/command-center-fixtures.ts");
const view = await server.ssrLoadModule("/src/components/command-center/view/command-center-view.ts");
const client = await server.ssrLoadModule("@pi-desktop/command-center-client");

const i18n = createInstance();
await i18n.init({
  lng: "en",
  ns: ["commandCenter"],
  defaultNS: "commandCenter",
  resources: { en: { commandCenter: enFragment } },
  interpolation: { escapeValue: false },
});

const OWNER = { hostId: "host-provider-1", expectedHostEpoch: "22222222-2222-4222-8222-222222222222" };

function page(provider) {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(pageModule.CommandCenterPage, provider === undefined ? {} : { provider }),
    ),
  );
}

/** Build a real client session whose every external edge is an injected port. */
async function clientSession({ connect = true, snapshot = fixtures.COMMAND_CENTER_PREVIEW_SNAPSHOT } = {}) {
  const context = client.createCommandCenterObservationContext();
  client.bindCommandCenterObservationOwner(context, OWNER);
  const timers = [];
  const scheduler = {
    schedule(delayMs, callback) {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  let now = 1_000;
  let pingCalls = 0;
  let pageCalls = 0;
  const session = client.createCommandCenterMonitorSession(context, {
    clock: { now: () => now },
    scheduler,
    ping: async () => {
      pingCalls += 1;
      return { ok: true, serverTime: "2026-01-01T00:00:00.000Z" };
    },
    loadPage: async (token) => {
      pageCalls += 1;
      assert.equal(token, undefined, "the fixture session publishes a single page");
      return structuredClone(snapshot);
    },
  });
  if (connect) {
    session.connect();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    session,
    timers,
    counts: () => ({ pingCalls, pageCalls }),
    dispose() {
      session.dispose();
      client.invalidateCommandCenterObservationContext(context);
    },
  };
}

function sessionProvider(session, overrides = {}) {
  return data.createCommandCenterSessionProvider({
    session,
    loadWorkspaces: async () => structuredClone(summaryFixture.workspaces.workspaces),
    loadReceipts: async () => structuredClone([controlFixture.receipts.accepted, controlFixture.receipts.completed]),
    ...overrides,
  });
}

test("the route default stays the fixture preview with an explicit offline Host", () => {
  const state = data.COMMAND_CENTER_FIXTURE_PROVIDER.getState();
  assert.equal(state.source, "fixture");
  assert.deepEqual(state.workspaces, fixtures.COMMAND_CENTER_PREVIEW_WORKSPACES);
  assert.equal(state.snapshot, fixtures.COMMAND_CENTER_PREVIEW_SNAPSHOT);
  assert.deepEqual(state.receipts, fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS);
  assert.deepEqual(state.host, { state: "offline" });

  const html = page(undefined);
  assert.match(html, /data-route="command-center"/);
  assert.equal((html.match(/data-command-center="workspace-entry"/g) ?? []).length, 3);
  assert.match(html, /A \/ Delivery/);
  assert.match(html, /role="status"[^>]*aria-label="Host Local Host, status offline"/);
  assert.match(html, /data-command-center="preview-notice"/);
  assert.match(html, /Preview data only/);
  assert.doesNotMatch(html, /status connected/, "the fixture path never fakes a connection");
});

test("the injected client provider drives workspaces, task pages, receipts and connected health", async () => {
  const harness = await clientSession();
  const provider = sessionProvider(harness.session);
  let notifications = 0;
  const unsubscribe = provider.subscribe(() => { notifications += 1; });
  const result = await provider.refresh();
  assert.deepEqual(result, { kind: "published" });
  assert.equal(notifications, 1);
  const state = provider.getState();
  assert.equal(state.source, "session");
  assert.equal(state.workspaces.length, 4);
  assert.equal(state.snapshot.rows.length, 3);
  assert.equal(state.receipts.length, 2);
  assert.deepEqual(state.host, { state: "connected" });
  assert.deepEqual(state.staleCollections, []);

  const html = page(provider);
  assert.match(html, /data-command-center="surface"/);
  assert.equal((html.match(/data-command-center="workspace-entry"/g) ?? []).length, 3);
  assert.match(html, /role="status"[^>]*aria-label="Host Local Host, status connected"/);
  assert.match(html, /Review child fixtures/);
  assert.doesNotMatch(html, /data-command-center="preview-notice"/, "a live provider must not claim preview data");

  // Navigation still runs on the injected read model: workspace focus and task
  // recall use the same pure view functions as the fixture path.
  let viewState = view.createCommandCenterViewState();
  viewState = view.reduceCommandCenterView(viewState, {
    type: "open-workspace", workspaceId: state.workspaces[0].id,
  });
  assert.deepEqual(viewState.destination, { kind: "workspace", workspaceId: state.workspaces[0].id });
  const workspaceView = view.selectWorkspaceView({
    workspaceId: state.workspaces[0].id, workspaces: state.workspaces, snapshot: state.snapshot,
  });
  assert.equal(workspaceView.rows.length, 2);
  const entry = view.commandCenterVisitEntry({
    target: workspaceView.rows[0].target, rows: view.selectTaskRows(state.snapshot), workspaces: state.workspaces,
  });
  assert.ok(entry);
  viewState = view.reduceCommandCenterView(viewState, { type: "record-visit", entry });
  assert.equal(viewState.history.length, 1);
  assert.equal(viewState.history[0].workspaceName, "Delivery");

  assert.deepEqual(harness.counts(), { pingCalls: 1, pageCalls: 1 });
  unsubscribe();
  provider.dispose();
  harness.dispose();
});

test("an unconnected Host stays explicitly offline while showing only received rows", async () => {
  const harness = await clientSession({ connect: false });
  const provider = sessionProvider(harness.session);
  const result = await provider.refresh();
  assert.equal(result.kind, "published");
  const state = provider.getState();
  assert.deepEqual(state.host, { state: "offline" });
  assert.equal(state.snapshot.rows.length, 3, "received task rows are still rendered");
  const html = page(provider);
  assert.match(html, /role="status"[^>]*aria-label="Host Local Host, status offline"/);
  assert.doesNotMatch(html, /status connected/);
  provider.dispose();
  harness.dispose();
});

test("a failed collection read retains the last known value and marks the slot stale", async () => {
  const harness = await clientSession();
  let failWorkspaces = false;
  const provider = sessionProvider(harness.session, {
    loadWorkspaces: async () => {
      if (failWorkspaces) throw new Error("workspace read failed");
      return structuredClone(summaryFixture.workspaces.workspaces);
    },
    loadReceipts: async () => structuredClone([controlFixture.receipts.accepted]),
  });
  await provider.refresh();
  const before = provider.getState();
  failWorkspaces = true;
  const result = await provider.refresh();
  assert.deepEqual(result, { kind: "partial", staleCollections: ["workspaces"] });
  const after = provider.getState();
  assert.deepEqual(after.workspaces, before.workspaces, "the previous workspaces are retained, never invented");
  assert.deepEqual(after.staleCollections, ["workspaces"]);
  assert.equal(after.snapshot.rows.length, 3);

  // Invalid shared-contract data is refused the same way as a failed read.
  const invalid = sessionProvider(harness.session, { loadWorkspaces: async () => [{ id: "not-a-uuid" }] });
  await invalid.refresh();
  assert.deepEqual(invalid.getState().staleCollections, ["workspaces"]);
  assert.deepEqual(invalid.getState().workspaces, []);
  provider.dispose();
  invalid.dispose();
  harness.dispose();
});

test("the provider opens no transport and starts no turn", () => {
  assert.doesNotMatch(dataSource, /new WebSocket|RacpClient|turn\/start|turn\.start|startTurn/);
  assert.match(dataSource, /import type \{[^}]*CommandCenterMonitorSession/, "the runtime dependency is a type-only client contract");
  assert.match(dataSource, /COMMAND_CENTER_FIXTURE_PROVIDER/, "the fixture default is part of the port");
});
