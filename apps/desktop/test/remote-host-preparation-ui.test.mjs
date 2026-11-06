import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/**
 * Renderer behaviour of on-demand Host preparation.
 *
 * Only the external edge is mocked: `window.piDesktop.invoke` records the IPC
 * payloads and answers them, exactly like the preload bridge. Everything under
 * test — the typed API, the preparation service, the notice component, the
 * locale catalogs and the settings draft memory — is the real module.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-host-preparation-"));
const output = join(temp, "fixture.mjs");
await build({
  stdin: { contents: `
    export { api } from './apps/desktop/src/lib/api';
    export { createRemoteHostPreparationService, remoteHostPreparation } from './apps/desktop/src/lib/remote-host-preparation';
    import { preparationActionFor, RemoteHostPreparationNotice } from './apps/desktop/src/components/remote/RemoteHostPreparationNotice';
    export { preparationActionFor, RemoteHostPreparationNotice };
    export { remoteHostErrorCodeKey } from './apps/desktop/src/lib/remote-host-errors';
    import { rememberRemoteHostDraft, takeRemoteHostDraft, clearRemoteHostDraft } from './apps/desktop/src/lib/remote-host-draft';
    export { rememberRemoteHostDraft, takeRemoteHostDraft, clearRemoteHostDraft };
    import { remoteEn, remoteZh } from './apps/desktop/src/locales/remote';
    export { remoteEn, remoteZh };
    export { IPC } from '@pi-desktop/shared';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import i18n from 'i18next';
    import { initReactI18next } from 'react-i18next';
    import { catalogs } from '@pi-desktop/i18n';
    export async function renderNotice(props, lng = 'en') {
      await i18n.use(initReactI18next).init({ lng, fallbackLng: 'en',
        resources: { en: { remote: remoteEn, translation: catalogs.en },
          'zh-CN': { remote: remoteZh, translation: catalogs['zh-CN'] } },
        interpolation: { escapeValue: false } });
      return renderToStaticMarkup(React.createElement(RemoteHostPreparationNotice, props));
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
const {
  api, createRemoteHostPreparationService, preparationActionFor, RemoteHostPreparationNotice,
  remoteHostErrorCodeKey, rememberRemoteHostDraft, takeRemoteHostDraft, clearRemoteHostDraft,
  remoteEn, remoteZh, IPC,
} = fixture;
test.after(() => rm(temp, { recursive: true, force: true }));

const host = { hostKey: "ssh-build", label: "Build machine", transport: "ssh", connected: true, url: "ws://127.0.0.1:1" };

/** Mock only the preload bridge; `answer` decides what Main replies. */
function bridge(answer) {
  const calls = [];
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    piDesktop: {
      platform: "linux",
      on: () => () => {},
      invoke: async (channel, ...args) => {
        calls.push({ channel, input: args[0] });
        const reply = await answer(channel, args[0], calls.length);
        return { ok: true, data: reply };
      },
    },
  };
  return calls;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((done, fail) => { resolvePromise = done; rejectPromise = fail; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function refusal(code) {
  return Object.assign(new Error(code), { code });
}

const prepareCalls = (calls) => calls.filter((call) => call.channel === IPC.invoke.remoteHostPrepare);
const cancelCalls = (calls) => calls.filter((call) => call.channel === IPC.invoke.remoteHostPrepareCancel);

test("the typed API speaks the documented prepare channels and payload", async () => {
  const calls = bridge(() => ({ host: { ...host, preparation: { hostKey: host.hostKey, targetVersion: "2.0.0", phase: "ready" } } }));
  const result = await api.prepareRemoteHost({ hostKey: host.hostKey, requestId: "r-1", allowDownload: true });
  assert.equal(result.host.preparation.phase, "ready");
  await api.cancelRemoteHostPreparation({ hostKey: host.hostKey, requestId: "r-1" });
  assert.deepEqual(calls.map((call) => call.channel), [IPC.invoke.remoteHostPrepare, IPC.invoke.remoteHostPrepareCancel]);
  assert.deepEqual(calls[0].input, { hostKey: host.hostKey, requestId: "r-1", allowDownload: true });
  assert.deepEqual(calls[1].input, { hostKey: host.hostKey, requestId: "r-1" });
});

test("a first prepare asks without consent and stops at awaiting-download", async () => {
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostPrepare) {
      if (input.allowDownload !== true) throw refusal("HOST_DOWNLOAD_REQUIRED");
      return { host: { ...host, preparation: { hostKey: host.hostKey, targetVersion: "2.0.0", currentVersion: "1.4.0", phase: "ready" } } };
    }
    return { ok: true };
  });
  const service = createRemoteHostPreparationService();
  const first = service.prepare(host.hostKey);
  assert.equal(typeof first.requestId, "string");
  assert.ok(first.requestId.length > 0);
  assert.equal(service.getSnapshot()[host.hostKey].pending, true);
  const refused = await first.outcome;
  assert.deepEqual(refused, { ok: false, code: "HOST_DOWNLOAD_REQUIRED", cancelled: false });
  // Exactly the fields Main validates: no `undefined` optional flags invent keys.
  assert.deepEqual(Object.keys(prepareCalls(calls)[0].input).sort(), ["hostKey", "requestId"]);
  const stopped = service.getSnapshot()[host.hostKey];
  assert.equal(stopped.phase, "awaiting-download");
  assert.equal(stopped.pending, false);
  assert.equal(preparationActionFor(stopped), "download");

  // The explicit Start: the user consents, Main installs, the Host is ready.
  const consented = service.prepare(host.hostKey, { allowDownload: true });
  assert.equal(prepareCalls(calls)[1].input.allowDownload, true);
  const ready = await consented.outcome;
  assert.equal(ready.ok, true);
  const view = service.getSnapshot()[host.hostKey];
  assert.equal(view.phase, "ready");
  assert.equal(view.targetVersion, "2.0.0");
  assert.equal(view.currentVersion, "1.4.0");
  assert.equal(preparationActionFor(view), null);
});

test("legacy maintenance is offered once, then only an ordinary retry", async () => {
  const calls = bridge((channel) => {
    if (channel === IPC.invoke.remoteHostPrepare) throw refusal("HOST_MAINTENANCE_REQUIRED");
    return { ok: true };
  });
  const service = createRemoteHostPreparationService();
  const before = service.prepare(host.hostKey);
  await before.outcome;
  const stopped = service.getSnapshot()[host.hostKey];
  assert.equal(stopped.phase, "awaiting-maintenance");
  assert.equal(stopped.legacyAttempted, false);
  assert.equal(preparationActionFor(stopped), "maintenance");

  const attempt = service.prepare(host.hostKey, { allowLegacyMaintenance: true, retry: true });
  assert.equal(prepareCalls(calls)[1].input.allowLegacyMaintenance, true);
  assert.equal(prepareCalls(calls)[1].input.retry, true);
  await attempt.outcome;
  const spent = service.getSnapshot()[host.hostKey];
  assert.equal(spent.phase, "awaiting-maintenance");
  assert.equal(spent.legacyAttempted, true);
  assert.equal(preparationActionFor(spent), "retry");
});

test("cancelling one caller leaves the other waiter and its requestId alone", async () => {
  const first = deferred();
  const second = deferred();
  const calls = bridge((channel, _input, index) => {
    if (channel === IPC.invoke.remoteHostPrepareCancel) return { ok: true };
    return index === 1 ? first.promise : second.promise;
  });
  const service = createRemoteHostPreparationService();
  const a = service.prepare(host.hostKey);
  const b = service.prepare(host.hostKey);
  assert.notEqual(a.requestId, b.requestId);

  service.cancel(host.hostKey, a.requestId);
  assert.equal(cancelCalls(calls).length, 1);
  assert.deepEqual(cancelCalls(calls)[0].input, { hostKey: host.hostKey, requestId: a.requestId });
  // The other caller still owns the visible phase; nothing was cancelled for it.
  assert.equal(service.getSnapshot()[host.hostKey].phase, "checking");

  second.resolve({ host: { ...host, preparation: { hostKey: host.hostKey, targetVersion: "2.0.0", phase: "ready" } } });
  const settled = await b.outcome;
  assert.equal(settled.ok, true);
  first.resolve({ host });
  assert.deepEqual(await a.outcome, { ok: false, code: "HOST_PREPARATION_CANCELLED", cancelled: true });
  assert.equal(cancelCalls(calls).length, 1);
  assert.equal(service.getSnapshot()[host.hostKey].phase, "ready");
});

test("Main phases update a pending caller while stale terminal summaries cannot complete it", async () => {
  const pending = deferred();
  bridge(() => pending.promise);
  const service = createRemoteHostPreparationService();
  const handle = service.prepare(host.hostKey);
  service.adopt([{ ...host, preparation: { hostKey: host.hostKey, targetVersion: "2.0.0", phase: "downloading" } }]);
  assert.equal(service.getSnapshot()[host.hostKey].phase, "downloading");
  assert.equal(service.getSnapshot()[host.hostKey].pending, true);
  service.adopt([{ ...host, preparation: { hostKey: host.hostKey, targetVersion: "1.0.0", phase: "ready" } }]);
  assert.equal(service.getSnapshot()[host.hostKey].phase, "downloading");
  pending.resolve({ host: { ...host, preparation: { hostKey: host.hostKey, targetVersion: "2.0.0", phase: "connecting" } } });
  await handle.outcome;
  service.adopt([{ ...host, preparation: { hostKey: host.hostKey, targetVersion: "2.0.0", currentVersion: "1.4.0", phase: "ready" } }]);
  assert.equal(service.getSnapshot()[host.hostKey].phase, "ready");
  // A Host that reports no preparation keeps the last thing the user saw.
  service.adopt([{ ...host }]);
  assert.equal(service.getSnapshot()[host.hostKey].phase, "ready");
  service.forget(host.hostKey);
  assert.equal(service.getSnapshot()[host.hostKey], undefined);
});

test("busy Host offers an explicit retry after its preparation waiter settles", () => {
  assert.equal(preparationActionFor({ hostKey: host.hostKey, phase: "waiting-idle", errorCode: "HOST_BUSY", pending: false }), "retry");
});

test("the notice shows phase and versions and never invents a percentage", async () => {
  const html = await fixture.renderNotice({
    hostKey: host.hostKey, label: host.label,
    view: { hostKey: host.hostKey, phase: "downloading", targetVersion: "2.0.0", currentVersion: "1.4.0", pending: true, legacyAttempted: false },
    onPrepare: () => {},
  });
  assert.match(html, /Downloading the release on this computer/);
  assert.match(html, /1\.4\.0 → 2\.0\.0/);
  assert.match(html, /data-phase="downloading"/);
  assert.doesNotMatch(html, /%/);
  assert.doesNotMatch(html, /<progress/);
});

test("a stopped preparation renders exactly one recoverable action", async () => {
  const download = await fixture.renderNotice({
    hostKey: host.hostKey,
    view: { hostKey: host.hostKey, phase: "awaiting-download", targetVersion: "2.0.0", errorCode: "HOST_DOWNLOAD_REQUIRED", pending: false, legacyAttempted: false },
    onPrepare: () => {},
  });
  assert.match(download, /Download and install/);
  assert.match(download, /global network proxy/);
  assert.match(download, /role="alert"/);
  assert.match(download, /Download required/);

  const maintenance = await fixture.renderNotice({
    hostKey: host.hostKey,
    view: { hostKey: host.hostKey, phase: "awaiting-maintenance", targetVersion: "2.0.0", errorCode: "HOST_MAINTENANCE_REQUIRED", pending: false, legacyAttempted: false },
    onPrepare: () => {},
  });
  assert.match(maintenance, /Confirm idle window and install/);
  assert.doesNotMatch(maintenance, /Download and install/);

  const spent = await fixture.renderNotice({
    hostKey: host.hostKey,
    view: { hostKey: host.hostKey, phase: "awaiting-maintenance", targetVersion: "2.0.0", errorCode: "HOST_MAINTENANCE_REQUIRED", pending: false, legacyAttempted: true },
    onPrepare: () => {},
  });
  assert.match(spent, />Retry</);
  assert.doesNotMatch(spent, /Confirm idle window and install/);
});

test("a Host that needs a newer Desktop offers no action at all", async () => {
  const html = await fixture.renderNotice({
    hostKey: host.hostKey,
    view: { hostKey: host.hostKey, phase: "failed", targetVersion: "2.0.0", errorCode: "HOST_CLIENT_TOO_OLD", pending: false, legacyAttempted: false },
    onPrepare: () => {},
  });
  assert.match(html, /This Desktop is too old for the remote Host/);
  assert.doesNotMatch(html, /Download and install|>Retry</);
});

test("nothing renders for a Host that was never prepared", async () => {
  const html = await fixture.renderNotice({ hostKey: host.hostKey, onPrepare: () => {} });
  assert.equal(html, "");
});

test("both locales carry the same preparation copy and the same error keys", () => {
  const keys = (value, prefix = "") => Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object" ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`]);
  assert.deepEqual(keys(remoteEn.preparation).sort(), keys(remoteZh.preparation).sort());
  for (const code of [
    "HOST_DOWNLOAD_REQUIRED", "HOST_MAINTENANCE_REQUIRED", "HOST_BUSY", "HOST_CLIENT_TOO_OLD",
    "HOST_VERSION_UNSUPPORTED", "HOST_RELEASE_UNAVAILABLE", "HOST_DOWNLOAD_FAILED",
    "HOST_UPLOAD_FAILED", "HOST_NETWORK_NOT_READY",
    "HOST_INTEGRITY_FAILED", "HOST_START_FAILED", "HOST_RECOVERY_REQUIRED", "HOST_PREPARATION_CANCELLED",
  ]) {
    const key = remoteHostErrorCodeKey(code);
    assert.match(key, /^remote:preparation\.error\./, code);
    // The notice renders this exact key, so each catalog must carry it.
    const relative = key.replace("remote:preparation.", "");
    assert.ok(keys(remoteEn.preparation).includes(relative), `missing en copy for ${code}`);
    assert.ok(keys(remoteZh.preparation).includes(relative), `missing zh copy for ${code}`);
  }
});

test("the network shortcut keeps the SSH draft once and never the password", () => {
  rememberRemoteHostDraft({
    mode: "ssh",
    ssh: { label: "Build", host: "build-box.local", user: "pi", port: "2222", identityFile: "/home/me/.ssh/id", auth: "key" },
  });
  const restored = takeRemoteHostDraft();
  assert.equal(restored.mode, "ssh");
  assert.equal(restored.ssh.host, "build-box.local");
  assert.equal(restored.ssh.port, "2222");
  assert.equal("password" in restored.ssh, false);
  assert.equal(takeRemoteHostDraft(), null);
  rememberRemoteHostDraft({ mode: "pair", ssh: { label: "", host: "", user: "", port: "", identityFile: "", auth: "key" } });
  clearRemoteHostDraft();
  assert.equal(takeRemoteHostDraft(), null);
});
