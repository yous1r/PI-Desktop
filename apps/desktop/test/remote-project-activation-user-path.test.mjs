import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/**
 * User path: opening an ordinary saved remote project (a local project group
 * bound to a Host, path `remote-project:<id>`) prepares that Host first.
 *
 * Only `window.piDesktop.invoke` is mocked: every module under test is the real
 * renderer code — the store slice, the activation gate, the preparation service,
 * the dialog component and the `remote` locale catalog. Nothing asserts on
 * source strings.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-project-activation-"));
const output = join(temp, "fixture.mjs");
await build({
  stdin: { contents: `
    export { useAppStore } from './apps/desktop/src/stores/app-store';
    export { remoteProjectActivation, forgetRemoteProjectHosts } from './apps/desktop/src/lib/remote-project-activation';
    import { RemoteProjectPreparationGate } from './apps/desktop/src/components/remote/RemoteProjectPreparationGate';
    export { RemoteProjectPreparationGate };
    import { remoteEn } from './apps/desktop/src/locales/remote';
    export { remoteEn };
    export { IPC } from '@pi-desktop/shared';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import i18n from 'i18next';
    import { initReactI18next } from 'react-i18next';
    import { catalogs } from '@pi-desktop/i18n';
    export async function renderGate() {
      await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en',
        resources: { en: { remote: remoteEn, translation: catalogs.en } },
        interpolation: { escapeValue: false } });
      return renderToStaticMarkup(React.createElement(RemoteProjectPreparationGate));
    }
  `, resolveDir: root, loader: "tsx" },
  outfile: output, bundle: true, platform: "node", format: "esm", jsx: "automatic",
  alias: {
    "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    i18next: join(root, "apps/desktop/node_modules/i18next"),
  },
  loader: { ".css": "empty", ".gif": "dataurl", ".png": "dataurl" },
  plugins: [{ name: "fixture-vite-url", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "fixture-url" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, ({ path }) => ({ contents: `export default ${JSON.stringify(path)};`, loader: "js" }));
  } }],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const fixture = await import(pathToFileURL(output).href);
const { useAppStore, remoteProjectActivation, forgetRemoteProjectHosts, renderGate, IPC } = fixture;
test.after(() => rm(temp, { recursive: true, force: true }));

const storage = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  },
});

const REMOTE_PATH = "remote-project:g-build";
const OTHER_REMOTE_PATH = "remote-project:g-other";
const LOCAL_PATH = "/work/local-app";

const groupBuild = {
  id: "g-build",
  name: "Build app",
  primaryPath: REMOTE_PATH,
  roots: [{ id: "r-build", path: REMOTE_PATH, position: 0 }],
  remote: { hostKey: "ssh-build", path: "/srv/build-app" },
  createdAt: 0,
  updatedAt: 0,
  pinned: false,
  lastOpenedAt: 0,
};
const groupOther = {
  id: "g-other",
  name: "Other app",
  primaryPath: OTHER_REMOTE_PATH,
  roots: [{ id: "r-other", path: OTHER_REMOTE_PATH, position: 0 }],
  remote: { hostKey: "ssh-other", path: "/srv/other-app" },
  createdAt: 0,
  updatedAt: 0,
  pinned: false,
  lastOpenedAt: 0,
};

const readyHost = (hostKey, { currentVersion = "1.0.0", targetVersion = "2.0.0" } = {}) => ({
  hostKey,
  label: hostKey,
  url: "ws://127.0.0.1:1",
  connected: true,
  transport: "ssh",
  preparation: { hostKey, targetVersion, currentVersion, phase: "ready" },
});

function refusal(code) {
  return Object.assign(new Error(code), { code });
}

const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));
async function waitFor(predicate, message, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(message);
}

/** Mock exactly the preload bridge; `answer` models Electron main. */
function bridge(handlers) {
  const calls = [];
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    piDesktop: {
      platform: "linux",
      locale: "en",
      channels: IPC,
      on: () => () => {},
      invoke: async (channel, ...args) => {
        const input = args[0];
        calls.push({ channel, input });
        const handler = handlers[channel];
        const data = await (handler ? handler(input, calls) : {});
        return { ok: true, data };
      },
    },
  };
  return calls;
}

const channels = (calls, channel) => calls.filter((call) => call.channel === channel);
const prepareCalls = (calls) => channels(calls, IPC.invoke.remoteHostPrepare);

function initialize() {
  storage.clear();
  remoteProjectActivation.cancel();
  forgetRemoteProjectHosts();
  useAppStore.setState({
    ready: true,
    sessions: [],
    activeSessionId: undefined,
    messages: [],
    page: "chat",
    workspace: null,
    activeProjectPath: undefined,
    openProjectPaths: [],
    // Cold start: the persisted sidebar knows the paths but not their binding,
    // so the group catalog is what tells this gate which Host to prepare.
    openProjects: [],
    projectMeta: {},
    settings: { defaultMode: "agent" },
    runningSessions: {},
    pendingPlans: {},
    pendingPermissions: {},
    pendingAsks: {},
  });
}
/** A saved remote project that still needs this Desktop's release. */
function downloadRequiredBridge(extra = {}) {
  let consented = false;
  return bridge({
    ...extra,
    [IPC.invoke.projectGroupList]: () => ({ groups: [groupBuild, groupOther] }),
    [IPC.invoke.remoteHostPrepare]: (input) => {
      if (input.allowDownload === true) consented = true;
      if (!consented) throw refusal("HOST_DOWNLOAD_REQUIRED");
      return { host: readyHost(input.hostKey) };
    },
    [IPC.invoke.projectSet]: (path) => ({
      workspace: {
        path,
        name: groupBuild.name,
        remote: { hostKey: "ssh-build", path: "/srv/build-app" },
      },
    }),
  });
}

test("opening a saved remote project prepares its Host, then the same activation finishes", async () => {
  initialize();
  const calls = downloadRequiredBridge();

  const opening = useAppStore.getState().activateProject(REMOTE_PATH);
  await waitFor(() => remoteProjectActivation.getSnapshot().pending !== null, "the gate never opened");

  // Nothing was opened and nothing was installed before the user answered.
  assert.equal(channels(calls, IPC.invoke.projectSet).length, 0);
  assert.equal(useAppStore.getState().activeProjectPath, undefined);
  const pending = remoteProjectActivation.getSnapshot().pending;
  assert.equal(pending.path, REMOTE_PATH);
  assert.equal(pending.hostKey, "ssh-build");
  assert.equal(pending.label, "Build app");
  assert.equal(pending.working, false);
  assert.equal(prepareCalls(calls).length, 1);
  assert.equal(prepareCalls(calls)[0].input.allowDownload, undefined);

  // The dialog is the shared user-entry surface, not a per-menu notice.
  const html = await renderGate();
  assert.match(html, /Open Build app/);
  assert.match(html, /Download required/);
  assert.match(html, /Download and install/);
  assert.match(html, /global network proxy/);
  assert.match(html, /role="dialog"/);
  assert.doesNotMatch(html, /%/);

  // Consent is the action the dialog renders; it resumes the pending project.
  const resumed = await remoteProjectActivation.resume({ allowDownload: true });
  const workspace = await opening;

  assert.equal(resumed.status, "opened");
  assert.equal(workspace.path, REMOTE_PATH);
  assert.deepEqual(channels(calls, IPC.invoke.projectSet).map((call) => call.input), [REMOTE_PATH]);
  assert.equal(useAppStore.getState().activeProjectPath, REMOTE_PATH);
  assert.equal(useAppStore.getState().workspace.remote.hostKey, "ssh-build");
  assert.equal(remoteProjectActivation.getSnapshot().pending, null);
  assert.equal(prepareCalls(calls).length, 2);
  assert.equal(prepareCalls(calls)[1].input.allowDownload, true);
  assert.notEqual(prepareCalls(calls)[0].input.requestId, prepareCalls(calls)[1].input.requestId);
});

test("a new session in that project waits for consent and then continues the original action", async () => {
  initialize();
  const session = {
    id: "s-remote-1",
    title: "Remote work",
    projectPath: REMOTE_PATH,
    messageCount: 0,
    mode: "agent",
    permissionMode: "ask",
    thinkingLevel: "inherit",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const calls = downloadRequiredBridge({
    [IPC.invoke.sessionCreate]: () => ({ session }),
    [IPC.invoke.sessionGet]: () => ({ session: { ...session, messages: [], planHistory: [] } }),
    [IPC.invoke.plansPending]: () => ({ plans: [] }),
    [IPC.invoke.pendingInteractive]: () => ({ permissions: [], asks: [] }),
    [IPC.invoke.notificationAcknowledgeSessionOutcome]: () => ({ ok: true }),
  });

  const creating = useAppStore.getState().newSession({ projectPath: REMOTE_PATH });
  await waitFor(() => remoteProjectActivation.getSnapshot().pending !== null, "the gate never opened");
  assert.equal(channels(calls, IPC.invoke.sessionCreate).length, 0);

  await remoteProjectActivation.resume({ allowDownload: true });
  await creating;

  const create = channels(calls, IPC.invoke.sessionCreate);
  assert.equal(create.length, 1);
  assert.equal(create[0].input.projectPath, REMOTE_PATH);
  assert.equal(channels(calls, IPC.invoke.projectSet).length, 1);
  assert.equal(useAppStore.getState().activeSessionId, session.id);
});

test("closing the dialog leaves the project closed and never activates it later", async () => {
  initialize();
  const calls = bridge({
    [IPC.invoke.projectGroupList]: () => ({ groups: [groupBuild] }),
    [IPC.invoke.remoteHostPrepare]: () => { throw refusal("HOST_DOWNLOAD_REQUIRED"); },
    [IPC.invoke.projectSet]: (path) => ({ workspace: { path, name: groupBuild.name } }),
  });

  const opening = useAppStore.getState().activateProject(REMOTE_PATH);
  await waitFor(() => remoteProjectActivation.getSnapshot().pending !== null, "the gate never opened");
  assert.equal(remoteProjectActivation.stoppedFor(REMOTE_PATH), true);

  remoteProjectActivation.cancel();
  assert.equal(await opening, null);
  assert.equal(remoteProjectActivation.getSnapshot().pending, null);

  await tick();
  await tick();
  assert.equal(channels(calls, IPC.invoke.projectSet).length, 0);
  assert.equal(useAppStore.getState().activeProjectPath, undefined);
});

test("switching to another project drops the waiting one instead of opening it late", async () => {
  initialize();
  const calls = bridge({
    [IPC.invoke.projectGroupList]: () => ({ groups: [groupBuild, groupOther] }),
    [IPC.invoke.remoteHostPrepare]: (input) => {
      if (input.hostKey === "ssh-build") throw refusal("HOST_DOWNLOAD_REQUIRED");
      return { host: readyHost(input.hostKey) };
    },
    [IPC.invoke.projectSet]: (path) => ({
      workspace: {
        path,
        name: path === REMOTE_PATH ? groupBuild.name : groupOther.name,
        remote: path === REMOTE_PATH ? groupBuild.remote : groupOther.remote,
      },
    }),
  });

  const waiting = useAppStore.getState().activateProject(REMOTE_PATH);
  await waitFor(() => remoteProjectActivation.getSnapshot().pending?.path === REMOTE_PATH, "the gate never opened");

  // The user picks another remote project while the first one waits.
  const other = await useAppStore.getState().activateProject(OTHER_REMOTE_PATH);
  assert.equal(other.path, OTHER_REMOTE_PATH);
  assert.equal(await waiting, null);
  assert.equal(useAppStore.getState().activeProjectPath, OTHER_REMOTE_PATH);
  assert.deepEqual(channels(calls, IPC.invoke.projectSet).map((call) => call.input), [OTHER_REMOTE_PATH]);
  assert.equal(remoteProjectActivation.getSnapshot().pending, null);
});

test("a legacy Host is prepared only after the user confirms the idle window", async () => {
  initialize();
  let confirmed = false;
  const calls = bridge({
    [IPC.invoke.projectGroupList]: () => ({ groups: [groupBuild] }),
    [IPC.invoke.remoteHostPrepare]: (input) => {
      if (input.allowLegacyMaintenance === true && input.retry === true) confirmed = true;
      if (!confirmed) throw refusal("HOST_MAINTENANCE_REQUIRED");
      return { host: readyHost(input.hostKey) };
    },
    [IPC.invoke.projectSet]: (path) => ({
      workspace: { path, name: groupBuild.name, remote: groupBuild.remote },
    }),
  });

  const opening = useAppStore.getState().activateProject(REMOTE_PATH);
  await waitFor(() => remoteProjectActivation.getSnapshot().pending !== null, "the gate never opened");
  const html = await renderGate();
  assert.match(html, /Confirm idle window and install/);
  assert.match(html, /close other clients/);
  assert.equal(channels(calls, IPC.invoke.projectSet).length, 0);

  await remoteProjectActivation.resume({ allowLegacyMaintenance: true, retry: true });
  const workspace = await opening;
  assert.equal(workspace.path, REMOTE_PATH);
  assert.equal(prepareCalls(calls)[1].input.allowLegacyMaintenance, true);
  assert.equal(prepareCalls(calls)[1].input.retry, true);
});
test("a Host that still reports work in flight keeps the dialog without inventing progress", async () => {
  initialize();
  bridge({
    [IPC.invoke.projectGroupList]: () => ({ groups: [groupBuild] }),
    [IPC.invoke.remoteHostPrepare]: () => { throw refusal("HOST_BUSY"); },
    [IPC.invoke.projectSet]: (path) => ({ workspace: { path, name: groupBuild.name } }),
  });

  const opening = useAppStore.getState().activateProject(REMOTE_PATH);
  await waitFor(() => remoteProjectActivation.getSnapshot().pending !== null, "the gate never opened");
  const html = await renderGate();
  assert.match(html, /Waiting for remote tasks to finish/);
  assert.match(html, /idle/);
  // `waiting-idle` is a stop for the user, so Retry is offered and nothing else.
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /Download and install|%/);
  remoteProjectActivation.cancel();
  assert.equal(await opening, null);
});
test("preparation stays visible while checking and duplicate retry shares the original attempt", async () => {
  initialize();
  const calls = bridge({
    [IPC.invoke.projectGroupList]: () => ({ groups: [groupBuild] }),
    [IPC.invoke.remoteHostPrepare]: async () => new Promise(() => {}),
  });
  const opening = useAppStore.getState().activateProject(REMOTE_PATH);
  await waitFor(() => remoteProjectActivation.getSnapshot().pending !== null, "the gate never opened");
  assert.equal(remoteProjectActivation.getSnapshot().pending.working, true);
  const retry = remoteProjectActivation.resume();
  assert.equal(prepareCalls(calls).length, 1);
  assert.equal(channels(calls, IPC.invoke.projectSet).length, 0);
  remoteProjectActivation.cancel();
  assert.equal(await opening, null);
  assert.equal((await retry).status, "stopped");
});

test("a passive projectPath reveal opens the project without preparing the Host", async () => {
  initialize();
  const calls = bridge({
    [IPC.invoke.remoteHostPrepare]: () => { throw refusal("HOST_DOWNLOAD_REQUIRED"); },
    [IPC.invoke.projectSet]: (path) => ({
      workspace: { path, name: groupBuild.name, remote: groupBuild.remote },
    }),
  });

  const workspace = await useAppStore
    .getState()
    .openProjectPath(REMOTE_PATH, { prepareRemoteHost: false });

  assert.equal(workspace.path, REMOTE_PATH);
  assert.equal(prepareCalls(calls).length, 0);
  assert.equal(channels(calls, IPC.invoke.projectGroupList).length, 0);
  assert.equal(remoteProjectActivation.getSnapshot().pending, null);
});

test("a local project opens with no preparation and no group catalog read", async () => {
  initialize();
  const calls = bridge({
    [IPC.invoke.projectSet]: (path) => ({ workspace: { path, name: "local-app" } }),
  });

  const workspace = await useAppStore.getState().activateProject(LOCAL_PATH);

  assert.equal(workspace.path, LOCAL_PATH);
  assert.equal(prepareCalls(calls).length, 0);
  assert.equal(channels(calls, IPC.invoke.projectGroupList).length, 0);
  assert.equal(remoteProjectActivation.getSnapshot().pending, null);
});
