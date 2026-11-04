import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * Host-managed plugin connections, driven through the native plugin settings
 * sheet a user actually opens.
 *
 * The important promises are about the credential: the form never shows a
 * stored token, a blank token keeps what the host holds, a cleared token is a
 * different instruction from a blank one, and moving the endpoint demands the
 * token again. The stub below behaves like the host in exactly that respect —
 * it never returns a token — so anything that leaks it into the DOM fails.
 */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { PluginSettingsSheet } from "../../apps/desktop/src/components/plugins/PluginSettingsSheet";
import { InstalledPluginsPanel } from "../../apps/desktop/src/features/plugins/InstalledPluginsPanel";
import { PluginDialogs } from "../../apps/desktop/src/features/plugins/PluginDialogs";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key) => i18n.t("plugins.connections." + key);
// The plugins page model carries its own translator; the panel and the dialog
// host take it as a prop rather than reading the hook themselves.
const t = (key, options) => i18n.t(key, options);
const PLUGIN_ID = "local.ai-memory";
const LIST = "pi-desktop/plugins/connections/list";
const SAVE = "pi-desktop/plugins/connections/save";
const DELETE = "pi-desktop/plugins/connections/delete";

const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const wait = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > end) throw new Error(message);
    await frame();
  }
};

const calls = [];
let connections = [];
let listMode = "ok";
const clone = (value) => JSON.parse(JSON.stringify(value));
const stored = (id) => connections.find((entry) => entry.id === id);
const listCalls = () => calls.filter((call) => call.channel === LIST);
const saveCalls = () => calls.filter((call) => call.channel === SAVE);
const deleteCalls = () => calls.filter((call) => call.channel === DELETE);

window.piDesktop = {
  platform: "darwin",
  async invoke(channel, input) {
    calls.push({ channel, input: clone(input) });
    if (channel === LIST) {
      if (listMode === "unsupported") throw new Error("IPC channel not allowed: " + channel);
      if (listMode === "fail") return { ok: false, error: { code: "INTERNAL", message: "read failed" } };
      return { ok: true, data: { connections: clone(connections) } };
    }
    if (channel === SAVE) {
      const previous = input.id ? stored(input.id) : undefined;
      // Host compare-and-set: a stale revision is refused, never overwritten.
      if (previous && input.expectedRevision !== undefined && previous.revision !== input.expectedRevision) {
        return { ok: false, error: { code: "CONFLICT", message: "Connection changed; reload before saving" } };
      }
      const connection = {
        id: input.id ?? "conn-" + (connections.length + 1),
        pluginId: input.pluginId,
        label: input.label,
        baseUrl: input.baseUrl,
        revision: (previous?.revision ?? 0) + 1,
        // The host never hands a token back; only the boolean is public.
        hasCredential: input.token === undefined ? (previous?.hasCredential ?? false) : input.token !== "",
        caConfigured: input.caPem === undefined ? (previous?.caConfigured ?? false) : input.caPem !== "",
        allowHttp: input.allowHttp,
        routes: input.routes.map((route) => ({ path: route.path, methods: [...route.methods] })),
      };
      connections = [...connections.filter((entry) => entry.id !== connection.id), connection];
      return { ok: true, data: { connection: clone(connection) } };
    }
    if (channel === DELETE) {
      connections = connections.filter((entry) => entry.id !== input.connectionId);
      return { ok: true, data: { ok: true } };
    }
    throw new Error("Unexpected IPC: " + channel);
  },
};

const plugin = (overrides = {}) => ({
  id: PLUGIN_ID, name: "AI Memory", version: "0.1.0", enabled: true,
  source: "installed", status: "ready",
  permissions: ["net.connection"],
  settings: [{ key: "scope", title: "Scope", type: "string", value: "project" }],
  ...overrides,
});

let view;
let host;
const mount = (summary, onSaved = async () => {}) => {
  host = document.createElement("div");
  document.getElementById("root").append(host);
  view = createRoot(host);
  flushSync(() => view.render(React.createElement(PluginSettingsSheet, {
    plugin: summary, platform: "darwin", onClose: () => {}, onSaved,
  })));
};
const unmount = () => { flushSync(() => view.unmount()); host.remove(); };

const all = (selector) => [...document.querySelectorAll(selector)];
// The sheet renders through portalOverlay, a sibling of <body> under <html>.
const text = () => document.documentElement.textContent ?? "";
const buttonByText = (text) => all("button").find((node) => node.textContent.trim() === text);
const buttonByLabel = (text) => all("button").find((node) => node.getAttribute("aria-label") === text);
const field = (id) => document.getElementById(id);
const routeInputs = () => all('input[id^="plugin-connection-route-"]');
const methodButtons = () => all('div[role="group"][aria-label^="' + label("routeMethods").split("{{")[0] + '"] button');
const toggle = () => document.querySelector('button[role="switch"][aria-label="' + label("allowHttpTitle") + '"]');
const clearToken = () => all("input[type=checkbox]").find((node) => node.closest("label")?.textContent.trim() === label("tokenClear"));
const alertText = () => document.querySelector('[role="alert"]')?.textContent.trim() ?? "";

const click = async (node, message) => {
  check(node && !node.disabled, message);
  flushSync(() => node.click());
  await frame();
};
const fill = async (node, value) => {
  check(node, "missing field");
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const fillArea = async (node, value) => {
  check(node, "missing textarea");
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};

const ready = () => wait(() => buttonByText(label("add")), "connections section did not render");

window.pluginConnectionsProbe = async () => {
  // --- Permission gate -----------------------------------------------------
  mount(plugin({ permissions: ["fs.read"] }));
  await frame(); await frame();
  check(!buttonByText(label("add")), "a plugin without net.connection must not configure connections");
  check(listCalls().length === 0, "no IPC without the permission claim");
  unmount();

  // --- List, then add a connection ----------------------------------------
  mount(plugin());
  await ready();
  await wait(() => text().includes(label("empty")), "empty state missing");
  check(listCalls().length === 1 && listCalls()[0].input.pluginId === PLUGIN_ID, "list must ask for this plugin only");

  await click(buttonByText(label("add")), "add action missing");
  await wait(() => field("plugin-connection-label"), "the form did not open");
  await wait(() => document.activeElement === field("plugin-connection-label"), "the first field must take focus");
  const token = field("plugin-connection-token");
  check(token.type === "password" && token.value === "", "a new token field starts empty and masked");
  check(text().includes(label("tokenHint")), "write-only notice must be visible");
  check(text().includes(label("allowHttpWarning")), "plain-HTTP disclosure must be visible before opting in");
  check(buttonByText(label("routeAdd")), "route editor missing");
  check(routeInputs().length === 1, "a new connection starts with exactly one empty route");

  // Saving an incomplete form explains itself and sends nothing.
  await click(buttonByText(label("save")), "save action missing");
  check(alertText() === label("errorLabel"), "empty name must be reported first, got: " + alertText());
  check(saveCalls().length === 0, "an invalid draft must not reach IPC");
  await wait(() => document.activeElement === field("plugin-connection-label"), "the first invalid field takes focus");

  await fill(field("plugin-connection-label"), "Work memory");
  await fill(field("plugin-connection-base-url"), "https://memory.example.com");
  await fill(field("plugin-connection-token"), "secret-token-1");
  await fill(routeInputs()[0], "/mcp");
  const methods = methodButtons();
  check(methods.length === 2 && methods[0].textContent === "GET" && methods[1].textContent === "POST", "GET/POST toggles missing");
  await click(methods[1], "POST toggle missing");

  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === 1, "save never reached the host");
  const created = saveCalls()[0].input;
  check(created.pluginId === PLUGIN_ID && !("id" in created), "a new connection is created without an id");
  check(created.token === "secret-token-1", "the typed token must be sent");
  check(!("caPem" in created), "an untouched CA stays untouched");
  check(created.allowHttp === false, "HTTP consent must not be assumed");
  check(JSON.stringify(created.routes) === JSON.stringify([{ path: "/mcp", methods: ["POST"] }]), "routes must be exact");

  await wait(() => !field("plugin-connection-label"), "the form must close after saving");
  await wait(() => text().includes("Work memory"), "the saved connection is not listed");
  check(text().includes("POST /mcp"), "the row must show the exact route");
  check(text().includes(label("tokenStored")), "the row must report a stored token");
  check(!text().includes("secret-token-1"), "the token must never be rendered");

  // --- Editing: the token is write-only ------------------------------------
  await click(buttonByLabel(i18n.t("plugins.connections.editConnection", { label: "Work memory" })), "edit action missing");
  await wait(() => field("plugin-connection-token"), "edit did not open");
  check(field("plugin-connection-token").value === "", "a stored token is never read back into the field");
  check(field("plugin-connection-token").placeholder === label("tokenPlaceholderKeep"), "the blank token must promise to keep the stored one");
  check(field("plugin-connection-base-url").value === "https://memory.example.com", "the form must show the saved endpoint");
  check(routeInputs().length === 1 && routeInputs()[0].value === "/mcp", "the form must show the saved route");

  // Saving with the endpoint untouched keeps the credential without sending it.
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === 2, "an unchanged endpoint must save");
  check(!("token" in saveCalls()[1].input), "a blank token keeps the stored one instead of clearing it");
  check(saveCalls()[1].input.expectedRevision === 1, "edits must carry the displayed connection revision");
  check(stored("conn-1").hasCredential === true, "the credential must survive an unrelated edit");

  // --- Endpoint change requires the token again ---------------------------
  await click(buttonByLabel(i18n.t("plugins.connections.editConnection", { label: "Work memory" })), "edit action missing");
  await wait(() => field("plugin-connection-base-url"), "edit did not open");
  await fill(field("plugin-connection-base-url"), "https://memory.example.eu");
  await wait(() => text().includes(label("endpointChangedNote")), "a moved endpoint must say so");
  await click(buttonByText(label("save")), "save action missing");
  check(alertText() === label("errorTokenRequired"), "a moved endpoint must demand the token, got: " + alertText());
  check(saveCalls().length === 2, "the refused save must not reach IPC");
  await wait(() => document.activeElement === field("plugin-connection-token"), "the token field takes focus");
  await fill(field("plugin-connection-token"), "secret-token-2");
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === 3, "the re-entered token must save");
  check(saveCalls()[2].input.token === "secret-token-2", "the new token must be sent with the new endpoint");
  check(saveCalls()[2].input.baseUrl === "https://memory.example.eu", "the new endpoint must be sent");

  // --- Clearing the credential is explicit -------------------------------
  await click(buttonByLabel(i18n.t("plugins.connections.editConnection", { label: "Work memory" })), "edit action missing");
  await wait(() => clearToken(), "the clear-token control is missing for a stored credential");
  await fill(field("plugin-connection-base-url"), "https://memory.example.com");
  await fill(field("plugin-connection-token"), "secret-token-3");
  await click(clearToken(), "the clear-token control is not clickable");
  await wait(() => !field("plugin-connection-token").value, "clearing must empty the pending token");
  check(text().includes(label("tokenClearNote")), "clearing must explain what saving does");
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === 4, "clearing must save");
  check(saveCalls()[4 - 1].input.token === "", "clearing sends an empty token, not an absent one");

  // --- Optional custom CA ------------------------------------------------
  await click(buttonByLabel(i18n.t("plugins.connections.editConnection", { label: "Work memory" })), "edit action missing");
  await wait(() => field("plugin-connection-ca"), "CA field missing");
  await fillArea(field("plugin-connection-ca"), "-----BEGIN CERTIFICATE-----MIIB-----END CERTIFICATE-----");
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === 5, "the CA must save");
  check(saveCalls()[4].input.caPem.startsWith("-----BEGIN CERTIFICATE-----"), "the CA PEM must be sent");
  check(!("token" in saveCalls()[4].input), "saving a CA must not disturb the credential");
  await wait(() => text().includes(label("customCa")), "a configured CA must be visible on the row");

  // --- Unencrypted HTTP needs explicit consent ---------------------------
  await click(buttonByText(label("add")), "add action missing");
  await wait(() => field("plugin-connection-label"), "the form did not open");
  await fill(field("plugin-connection-label"), "Lab server");
  await fill(field("plugin-connection-base-url"), "http://memory.lan:8080");
  await fill(routeInputs()[0], "/hook");
  await click(methodButtons()[1], "POST toggle missing");
  await click(buttonByText(label("save")), "save action missing");
  check(alertText() === label("errorHttpConsent"), "plain HTTP must be refused without consent, got: " + alertText());
  check(saveCalls().length === 5, "the refused save must not reach IPC");
  await click(toggle(), "the allow-HTTP switch is missing");
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === 6, "consented plain HTTP must save");
  check(saveCalls()[5].input.allowHttp === true, "consent must be sent explicitly");
  await wait(() => text().includes(label("plainHttp")), "a plain-HTTP row must be marked");

  // --- Deleting asks first ----------------------------------------------
  const before = deleteCalls().length;
  await click(buttonByLabel(i18n.t("plugins.connections.deleteConnection", { label: "Lab server" })), "delete action missing");
  await wait(() => buttonByText(label("deleteCancel")), "the confirmation is missing");
  await wait(() => document.activeElement === buttonByText(label("deleteCancel")), "focus must start on the safe choice");
  await click(buttonByText(label("deleteCancel")), "the cancel action is missing");
  await wait(() => !buttonByText(label("deleteCancel")), "cancelling must close the confirmation");
  check(deleteCalls().length === before, "cancelling must not delete anything");
  check(text().includes("Lab server"), "cancelling must keep the connection");

  await click(buttonByLabel(i18n.t("plugins.connections.deleteConnection", { label: "Lab server" })), "delete action missing");
  await wait(() => buttonByText(label("deleteConfirm")), "the confirmation is missing");
  await click(buttonByText(label("deleteConfirm")), "the confirm action is missing");
  await wait(() => deleteCalls().length === before + 1, "confirming must delete");
  check(deleteCalls()[before].input.connectionId === "conn-2", "delete must name the connection");
  check(deleteCalls()[before].input.pluginId === PLUGIN_ID, "delete must stay inside this plugin");
  await wait(() => !text().includes("Lab server"), "the deleted row must disappear");
  unmount();

  // --- A failed read is recoverable --------------------------------------
  listMode = "fail";
  const beforeRetry = listCalls().length;
  mount(plugin());
  await wait(() => buttonByText(label("retry")), "a failed read must offer a retry");
  check(!text().includes("Work memory"), "a failed read must not pretend to have data");
  listMode = "ok";
  await click(buttonByText(label("retry")), "retry action missing");
  await wait(() => text().includes("Work memory"), "retry must load the list");
  check(listCalls().length === beforeRetry + 2, "retry must ask the host again");
  unmount();

  // --- An older host without the channel renders nothing -----------------
  listMode = "unsupported";
  const beforeUnsupported = listCalls().length;
  mount(plugin());
  await frame(); await frame(); await frame();
  check(listCalls().length === beforeUnsupported + 1, "the section must probe the host");
  check(!buttonByText(label("add")), "an unsupported host must not show the section");
  check(!text().includes(label("loadFailed")), "an unsupported host is not an error");
  unmount();

  return { passed: true };
};

/**
 * The installed-plugins row is the entry a user actually has, so this mounts
 * the real panel together with the real dialog host and shares one settings
 * selection between them, exactly as the plugins page wires them.
 */
function PluginsSurface({ summary, onOpen }) {
  const [settingsPlugin, setSettingsPlugin] = React.useState(null);
  const [rowMenu, setRowMenu] = React.useState(null);
  React.useEffect(() => { if (settingsPlugin) onOpen?.(settingsPlugin); }, [settingsPlugin, onOpen]);
  const model = {
    t, locale: "en",
    plugins: [summary],
    installedGroups: [{ id: "active", rows: [summary] }],
    setTab: () => {}, loadDev: async () => {}, setTemplatePick: () => {},
    setInstalledQuery: () => {},
    rowMenu, setRowMenu,
    isPluginBusy: () => false,
    queueInstall: () => {},
    projects: [], currentProjectPath: null,
    run: async (fn) => { await fn(); },
    refreshPlugins: async () => {},
    reloadPlugin: async () => {},
    settingsPlugin, setSettingsPlugin,
    servicesByPlugin: new Map(),
    reviewSummaries: {},
    pendingInstall: null, setPendingInstall: () => {},
    pendingReview: null, setPendingReview: () => {}, confirmReview: async () => {},
    autoUpdate: false, setAutoUpdate: () => {},
    confirmInstall: async () => {}, installJob: null,
    cancelInstallDownload: () => {}, retryInstall: async () => {}, closeInstallDialog: () => {},
    templatePick: null, creating: false, createFromTemplate: async () => {},
  };
  return React.createElement(React.Fragment, null,
    React.createElement(InstalledPluginsPanel, model),
    React.createElement(PluginDialogs, model));
}

const mountSurface = (summary) => {
  host = document.createElement("div");
  document.getElementById("root").append(host);
  view = createRoot(host);
  flushSync(() => view.render(React.createElement(PluginsSurface, { summary })));
};

window.pluginConnectionsEntryProbe = async () => {
  // --- The row's settings entry is the only native entry -------------------
  listMode = "ok";
  connections = [{
    id: "conn-entry", pluginId: PLUGIN_ID, label: "Work memory",
    baseUrl: "https://memory.example.com", revision: 1,
    hasCredential: true, caConfigured: false, allowHttp: false,
    routes: [{ path: "/mcp", methods: ["POST"] }],
  }];
  const listBefore = listCalls().length;
  mountSurface(plugin({ settings: undefined }));
  await wait(() => buttonByLabel(i18n.t("plugins.openSettings")), "a connection-only plugin must offer its settings entry");
  check(listCalls().length === listBefore, "the sheet must not read connections before it opens");

  await click(buttonByLabel(i18n.t("plugins.openSettings")), "settings entry is not clickable");
  await wait(() => document.querySelector('[role="dialog"]'), "the settings sheet did not open");
  await wait(() => buttonByText(label("add")), "the opened sheet did not render the connections section");
  check(listCalls().length === listBefore + 1, "opening the sheet reads this plugin's connections");
  check(document.querySelector('[role="dialog"]').getAttribute("aria-label") === i18n.t("plugins.settingsTitle", { name: "AI Memory" }),
    "the sheet must be the plugin settings dialog");
  check(!buttonByText(i18n.t("plugins.settingsSave")), "a connections-only plugin has nothing for the settings footer to save");
  unmount();

  // A plugin that has neither settings nor connections keeps no entry.
  mountSurface(plugin({ settings: undefined, permissions: ["fs.read"] }));
  await wait(() => text().includes("AI Memory"), "the plugin row did not render");
  check(!buttonByLabel(i18n.t("plugins.openSettings")), "a plugin with nothing to configure must not offer settings");
  unmount();

  // --- A compare-and-set refusal is visible and recoverable ----------------
  mountSurface(plugin({ settings: undefined }));
  await wait(() => buttonByLabel(i18n.t("plugins.openSettings")), "settings entry missing");
  await click(buttonByLabel(i18n.t("plugins.openSettings")), "settings entry is not clickable");
  await wait(() => buttonByText(label("add")), "connections section missing");
  await click(buttonByLabel(i18n.t("plugins.connections.editConnection", { label: "Work memory" })), "edit action missing");
  await wait(() => field("plugin-connection-label"), "the editor did not open");
  await fill(field("plugin-connection-label"), "Renamed here");

  // Another window saves first: the same connection moves to revision 2.
  connections = connections.map((entry) => entry.id === "conn-entry"
    ? { ...entry, label: "Renamed elsewhere", revision: 2 }
    : entry);
  const savesBefore = saveCalls().length;
  const listsBefore = listCalls().length;
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => alertText() === label("errorConflict"), "a stale save must report the conflict, got: " + alertText());
  check(saveCalls()[savesBefore].input.expectedRevision === 1, "the refused save carried the revision the user saw");
  await wait(() => listCalls().length === listsBefore + 1, "a conflict must re-read the connections");
  check(field("plugin-connection-label").value === "Renamed here", "a conflict must not discard what the user typed");
  await wait(() => text().includes("Renamed elsewhere"), "the refreshed row must show the host's current value");
  check(document.querySelector('[role="alert"]').checkVisibility(), "the conflict notice must be visible");

  // Saving again compares against what is now on screen.
  await click(buttonByText(label("save")), "save action missing");
  await wait(() => saveCalls().length === savesBefore + 2, "the retry must reach the host");
  check(saveCalls()[savesBefore + 1].input.expectedRevision === 2, "the retry must compare against the refreshed revision");
  await wait(() => stored("conn-entry").label === "Renamed here", "the retry must save the user's value");
  await wait(() => !field("plugin-connection-label"), "the editor must close after the retry saves");
  unmount();

  return { passed: true };
};
`;

test(
  "plugin settings sheet manages host connections without ever reading the token",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-connections-"));
    try {
      await build({
        stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        alias: {
          "@pi-desktop/i18n": join(root, "packages/i18n/src"),
          "@pi-desktop/shared": join(root, "packages/shared/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 900, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("PLUGIN_CONNECTIONS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.pluginConnectionsProbe()")));
    console.log("PLUGIN_CONNECTIONS_ENTRY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.pluginConnectionsEntryProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      if (!/PLUGIN_CONNECTIONS_PROBE|PLUGIN_CONNECTIONS_ENTRY_PROBE/.test(output)) {
        // A bundle or runtime failure surfaces here with the real stack.
        assert.fail(output.slice(-6000));
      }
      assert.equal(code, 0, output.slice(-6000));
      assert.match(output, /PLUGIN_CONNECTIONS_PROBE \{"passed":true\}/);
      assert.match(output, /PLUGIN_CONNECTIONS_ENTRY_PROBE \{"passed":true\}/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
