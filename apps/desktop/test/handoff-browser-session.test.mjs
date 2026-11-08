import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

const electron = new URL("./helpers/browser-electron-fixture.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { BrowserBackingHost } = await import("../electron/main/browser-backing-host.ts");
const { createBrowserSessionServices } = await import("../electron/main/services/browser-session-services.ts");
const { WebContentsView, deferred } = await import(electron);
const settled = () => new Promise(setImmediate);

function fixture(t) {
  let closed = false;
  const reads = [], opened = [], previews = [], pending = new Map();
  const original = {
    generation: "original", isAvailable: () => true,
    async call(method) {
      reads.push(method);
      if (pending.has(method)) return pending.get(method).promise;
      if (method === "settings.get") return { linkOpenTarget: "external" };
      if (method === "session.get") return { session: { projectPath: null } };
      throw new Error(`Unexpected method ${method}`);
    },
  };
  let source = original;
  const backing = new BrowserBackingHost();
  const host = new BrowserHost({
    isAdmissionClosed: () => closed,
    createPane: (state, open, owner) => new BrowserPane(state, open, backing, owner),
    isPluginLoaded: () => true, onState() {}, onRevealView() {},
    ...createBrowserSessionServices({
      dataDir: "/fixture", getHost: () => source, getWorkspacePath: () => "/visible-project",
      openExternal: async (url) => { opened.push(url); }, preview: (...args) => previews.push(args),
    }),
  });
  t.after(() => host.dispose());
  return { host, reads, opened, previews, pending,
    change(kind) {
      if (kind === "closure") closed = true;
      else if (kind === "replacement") source = { ...original };
      else if (kind === "generation") original.generation = "restarted";
      else host.disposeGuest();
    },
    async open() {
      await host.navigate({ url: "https://fixture.invalid/" }, "session");
      return WebContentsView.instances.at(-1).webContents;
    },
  };
}

for (const kind of ["closure", "replacement", "generation"]) {
  for (const method of ["session.get", "worktree.location"]) {
    test(`${kind} during ${method} cannot publish stale browser roots`, async (t) => {
      const h = fixture(t);
      const pending = deferred();
      h.pending.set(method, pending);
      if (method === "worktree.location") h.pending.set("session.get", { promise: Promise.resolve({ session: { worktree: {} } }) });
      const result = assert.rejects(h.host.getFileRoots("session"), { code: kind === "closure" ? "HOST_BUSY" : "HOST_UNAVAILABLE" });
      await settled();
      assert(h.reads.includes(method));
      h.change(kind);
      pending.resolve(method === "session.get" ? { session: { worktree: {} } } : { path: "/old-worktree" });
      await result;
      assert.equal(h.host.getHandoffActivity().operations, 0);
      if (method === "session.get") assert.deepEqual(h.reads, ["session.get"]);
    });
  }
}

for (const kind of ["closure", "replacement", "generation", "unload"]) {
  test(`${kind} during link preferences cannot open an external app or replacement page`, async (t) => {
    const h = fixture(t);
    const wc = await h.open();
    const warnings = [];
    t.mock.method(console, "warn", (...args) => warnings.push(args));
    const pending = deferred();
    h.pending.set("settings.get", pending);
    assert.deepEqual(wc.openWindow({ url: "https://fixture.invalid/link" }), { action: "deny" });
    assert(h.host.getHandoffActivity().operations > 0);
    h.change(kind);
    pending.resolve({ linkOpenTarget: "external" });
    await settled();
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.previews, []);
    assert.equal(h.host.getHandoffActivity().operations, 0);
    assert.match(String(warnings[0]), /Browser link opening failed/);
  });
}

test("ordinary session roots, link preferences and original page input remain usable", async (t) => {
  const h = fixture(t);
  const wc = await h.open();
  const snapshot = await h.host.snapshot("session");
  assert.match(snapshot.tree, /textbox/);
  await h.host.fill("e1", "retained draft", "session");
  h.host.setChromeSession("another-session", "another-tab");
  assert.equal(await h.host.evaluate("1+1", "session"), 2);
  wc.openWindow({ url: "https://fixture.invalid/external" });
  await settled();
  assert.deepEqual(h.opened, ["https://fixture.invalid/external"]);
  h.pending.set("settings.get", { promise: Promise.resolve({ linkOpenTarget: "browser" }) });
  wc.openWindow({ url: "https://fixture.invalid/internal" });
  await settled();
  assert.deepEqual(h.previews, [["session", "https://fixture.invalid/internal"]]);
  h.host.disposeGuest();
  assert.equal(h.host.getHandoffActivity().operations, 0);
  assert(h.host.getHandoffActivity().uncontainedResources > 0);
});
