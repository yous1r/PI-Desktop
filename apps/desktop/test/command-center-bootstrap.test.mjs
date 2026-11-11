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
 * Desktop command-center live-provider bootstrap.
 *
 * The renderer registers a provider only when the authenticated connection
 * advertises the optional `commandCenter` capability. Without one the app shell
 * passes `undefined` and the route keeps the fixture preview. The session and
 * collection loaders here are explicit ports: no transport is opened and no
 * turn is started.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const pageSource = await readFile(
  new URL("../src/features/command-center/CommandCenterPage.tsx", import.meta.url),
  "utf8",
);
const bootstrapSource = await readFile(
  new URL("../src/features/command-center/command-center-bootstrap.ts", import.meta.url),
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

const bootstrap = await server.ssrLoadModule("/src/features/command-center/command-center-bootstrap.ts");
const fixtures = await server.ssrLoadModule("/src/features/command-center/command-center-fixtures.ts");
const pageModule = await server.ssrLoadModule("/src/features/command-center/CommandCenterPage.tsx");
const enFragment = JSON.parse(
  await readFile(new URL("../src/components/command-center/locales/en.json", import.meta.url), "utf8"),
);
const i18n = createInstance();
await i18n.init({
  lng: "en",
  ns: ["commandCenter"],
  defaultNS: "commandCenter",
  resources: { en: { commandCenter: enFragment } },
  interpolation: { escapeValue: false },
});

function fakeSession() {
  const snapshot = fixtures.COMMAND_CENTER_PREVIEW_SNAPSHOT;
  const projection = { cursor: snapshot.cursor, generatedAt: snapshot.generatedAt, rows: snapshot.rows };
  return {
    refreshCalls: 0,
    async refresh() {
      this.refreshCalls += 1;
      return { kind: "published", projection };
    },
    getState() {
      return {
        status: "active",
        health: {
          status: "foreground", freshness: "fresh", resynchronized: true,
          lastReplyAtMs: 1_000, failure: null, observerFailed: false,
        },
        monitor: { status: "ready", projection },
        summary: { status: "ready", projection },
        snapshotReady: true,
        summaryReady: true,
        fresh: true,
        stale: false,
      };
    },
    dispose() {},
  };
}

test("no live provider is created without an advertised commandCenter capability", () => {
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
  assert.equal(bootstrap.createCommandCenterLiveProvider(null), undefined);
  assert.equal(bootstrap.createCommandCenterLiveProvider(undefined), undefined);

  let loads = 0;
  const ports = {
    capabilities: {},
    session: fakeSession(),
    loadWorkspaces: async () => { loads += 1; return []; },
    loadReceipts: async () => { loads += 1; return []; },
  };
  assert.equal(bootstrap.createCommandCenterLiveProvider(ports), undefined);
  assert.equal(bootstrap.createCommandCenterLiveProvider({ ...ports, capabilities: { commandCenter: false } }), undefined);
  assert.equal(loads, 0, "a non-capable connection must not trigger collection reads");
});

test("an advertised capability constructs the live provider from the client session and loaders", async () => {
  const session = fakeSession();
  const provider = bootstrap.createCommandCenterLiveProvider({
    capabilities: { commandCenter: true },
    session,
    loadWorkspaces: async () => structuredClone(fixtures.COMMAND_CENTER_PREVIEW_WORKSPACES),
    loadReceipts: async () => structuredClone(fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS),
  });
  assert.ok(provider, "a commandCenter-capable connection must yield a provider");
  const refreshed = await provider.refresh();
  assert.equal(refreshed.kind, "published");
  assert.equal(session.refreshCalls, 1);
  const state = provider.getState();
  assert.equal(state.source, "session");
  assert.equal(state.host.state, "connected");
  assert.equal(state.workspaces.length, 3);
  assert.equal(state.snapshot.rows.length, 3);
  assert.equal(state.receipts.length, 2);
  provider.dispose();
});

test("the mounted page subscribes to the registry and leaves the fixture default when empty", () => {
  assert.match(
    pageSource,
    /const registeredProvider = useCommandCenterLiveProvider\(\);/,
    "the route reads the live-provider registry",
  );
  assert.match(
    pageSource,
    /provider \?\? registeredProvider \?\? COMMAND_CENTER_FIXTURE_PROVIDER/,
    "an empty registry keeps the fixture default",
  );
  assert.match(pageSource, /useCommandCenterTransportBootstrap\(\);/, "the route mounts the transport bootstrap");

  const first = bootstrap.createCommandCenterLiveProvider({
    capabilities: { commandCenter: true },
    session: fakeSession(),
    loadWorkspaces: async () => [],
    loadReceipts: async () => [],
  });
  const second = bootstrap.createCommandCenterLiveProvider({
    capabilities: { commandCenter: true },
    session: fakeSession(),
    loadWorkspaces: async () => [],
    loadReceipts: async () => [],
  });
  let notifications = 0;
  const unsubscribe = bootstrap.subscribeCommandCenterLiveProvider(() => { notifications += 1; });
  const clearFirst = bootstrap.setCommandCenterLiveProvider(first);
  assert.equal(bootstrap.getCommandCenterLiveProvider(), first);
  assert.equal(notifications, 1);
  const clearSecond = bootstrap.setCommandCenterLiveProvider(second);
  assert.equal(bootstrap.getCommandCenterLiveProvider(), second);
  assert.equal(notifications, 2);
  clearFirst();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), second, "a stale cleanup must not clear a newer provider");
  clearSecond();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
  assert.equal(notifications, 3);
  unsubscribe();
  first.dispose();
  second.dispose();
});

test("the mounted route uses the registered live provider and falls back to the fixture preview", () => {
  const provider = {
    getState: () => ({
      source: "session",
      workspaces: fixtures.COMMAND_CENTER_PREVIEW_WORKSPACES,
      snapshot: fixtures.COMMAND_CENTER_PREVIEW_SNAPSHOT,
      receipts: fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS,
      host: { state: "connected" },
      staleCollections: [],
    }),
    subscribe: () => () => {},
    refresh: async () => ({ kind: "published" }),
    dispose() {},
  };
  const clear = bootstrap.setCommandCenterLiveProvider(provider);
  const render = () => renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(pageModule.CommandCenterPage)),
  );
  const live = render();
  assert.match(live, /role="status"[^>]*aria-label="Host Local Host, status connected"/);
  assert.doesNotMatch(live, /data-command-center="preview-notice"/);
  clear();
  const fallback = render();
  assert.match(fallback, /role="status"[^>]*aria-label="Host Local Host, status offline"/);
  assert.match(fallback, /data-command-center="preview-notice"/);
});

function fakeTransport(overrides = {}) {
  const calls = [];
  const transport = {
    hosts: async () => [{
      hostKey: "remote:one", label: "One", hostId: "host_1",
      expectedHostEpoch: "55555555-5555-4555-8555-555555555555", commandCenter: true,
    }],
    monitorPage: async (hostKey, request) => {
      calls.push(["page", hostKey, request]);
      return structuredClone(fixtures.COMMAND_CENTER_PREVIEW_SNAPSHOT);
    },
    ping: async (hostKey) => {
      calls.push(["ping", hostKey]);
      return { ok: true, serverTime: "2026-01-01T00:00:00.000Z" };
    },
    workspaceList: async (hostKey) => {
      calls.push(["workspaces", hostKey]);
      return { workspaces: structuredClone(fixtures.COMMAND_CENTER_PREVIEW_WORKSPACES) };
    },
    receiptList: async (hostKey, request) => {
      calls.push(["receipts", hostKey, request]);
      return { receipts: structuredClone(fixtures.COMMAND_CENTER_PREVIEW_RECEIPTS), nextAfterSequence: null };
    },
    ...overrides,
  };
  return { transport, calls };
}

test("the transport bootstrap builds the live provider only for a capable host", async () => {
  const { transport, calls } = fakeTransport();
  const cleanup = await bootstrap.bootstrapCommandCenterFromTransport(transport);
  const provider = bootstrap.getCommandCenterLiveProvider();
  assert.ok(provider, "a commandCenter-capable connected Host must register a provider");
  await new Promise((done) => setImmediate(done));
  const refreshed = await provider.refresh();
  assert.equal(refreshed.kind, "published");
  const state = provider.getState();
  assert.equal(state.source, "session");
  assert.equal(state.host.state, "connected");
  assert.equal(state.workspaces.length, 3);
  assert.equal(state.snapshot.rows.length, 3);
  assert.equal(state.receipts.length, 2);

  const kinds = calls.map((call) => call[0]);
  assert.ok(kinds.includes("ping"), "health pings through the existing connection channel");
  assert.ok(kinds.includes("page"));
  assert.ok(kinds.includes("workspaces"));
  assert.ok(kinds.includes("receipts"));
  const pageCall = calls.find((call) => call[0] === "page");
  assert.deepEqual(pageCall.slice(1), ["remote:one", { version: 1 }]);

  cleanup();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
});

test("a missing capability or unavailable bridge keeps the fixture default without fetching pages", async () => {
  const noCapability = fakeTransport({ hosts: async () => [] });
  const cleanup = await bootstrap.bootstrapCommandCenterFromTransport(noCapability.transport);
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
  assert.deepEqual(noCapability.calls, []);
  cleanup();

  const failing = fakeTransport({ hosts: async () => { throw new Error("bridge offline"); } });
  const failingCleanup = await bootstrap.bootstrapCommandCenterFromTransport(failing.transport);
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
  assert.deepEqual(failing.calls, []);
  failingCleanup();
});

test("the one-call bootstrap registers a capable provider and cleans it up", () => {
  const noop = bootstrap.bootstrapCommandCenterLiveProvider({
    capabilities: { commandCenter: false },
    session: fakeSession(),
    loadWorkspaces: async () => [],
    loadReceipts: async () => [],
  });
  noop();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);

  const cleanup = bootstrap.bootstrapCommandCenterLiveProvider({
    capabilities: { commandCenter: true },
    session: fakeSession(),
    loadWorkspaces: async () => [],
    loadReceipts: async () => [],
  });
  assert.ok(bootstrap.getCommandCenterLiveProvider());
  cleanup();
  assert.equal(bootstrap.getCommandCenterLiveProvider(), undefined);
});

test("the bootstrap opens no transport and starts no turn", () => {
  assert.doesNotMatch(bootstrapSource, /new WebSocket|RacpClient|turn\/start|turn\.start|startTurn/);
  assert.match(bootstrapSource, /capabilities\?\.commandCenter !== true/, "the capability gate is explicit");
});
