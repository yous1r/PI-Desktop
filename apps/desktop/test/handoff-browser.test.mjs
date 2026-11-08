import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const electron = new URL("./helpers/browser-electron-fixture.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { BrowserBackingHost } = await import("../electron/main/browser-backing-host.ts");
const { WebContentsView, deferred, shell } = await import(electron);
const settled = () => new Promise(setImmediate);

function harness(t, options = {}) {
  let closed = false;
  const backing = new BrowserBackingHost();
  const host = new BrowserHost({
    isAdmissionClosed: () => closed,
    createPane: (state, open, owner) => new BrowserPane(state, open, backing, owner),
    isPluginLoaded: () => true, getFileRoots: async () => [], onState() {}, onRevealView() {},
    ...options,
  });
  t.after(() => {
    host.dispose();
    WebContentsView.holdLoads = false;
    WebContentsView.failCreate = false;
    for (const view of WebContentsView.instances) {
      for (const pending of view.webContents.loads) pending.resolve();
      for (const pending of view.webContents.held.values()) pending.resolve({});
    }
  });
  return { host, closeAdmission: () => { closed = true; }, reopen: () => { closed = false; },
    async open() {
      await host.navigate({ url: "https://fixture.invalid/" }, "session");
      return WebContentsView.instances.at(-1).webContents;
    },
  };
}

function hold(wc, method) {
  const pending = deferred();
  const entered = deferred();
  wc.held.set(method, pending);
  const listener = (actual) => { if (actual === method) { wc.off("command", listener); entered.resolve(); } };
  wc.on("command", listener);
  return { ...pending, entered: entered.promise };
}

test("closed admission refuses browser navigation before roots or native creation", async (t) => {
  let reads = 0;
  const h = harness(t, { getFileRoots: async () => { reads++; return []; } });
  const before = WebContentsView.instances.length;
  h.closeAdmission();
  await assert.rejects(h.host.navigate({ url: "https://fixture.invalid/" }, "session"), { code: "HOST_BUSY" });
  assert.equal(reads, 0);
  assert.equal(WebContentsView.instances.length, before);
});

test("closure during file-root lookup prevents a late native navigation", async (t) => {
  const roots = deferred();
  const h = harness(t, { getFileRoots: () => roots.promise });
  const before = WebContentsView.instances.length;
  const navigation = h.host.navigate({ url: "https://fixture.invalid/" }, "session");
  h.closeAdmission();
  roots.resolve([]);
  await navigation.catch(() => {});
  assert.equal(WebContentsView.instances.length, before);
});

test("closing a page during a CDP setup cannot send later setup or evaluation commands", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  const setup = hold(wc, "Runtime.enable");
  const result = h.host.evaluate("1+1", "session");
  const rejected = assert.rejects(result, { code: "UNAVAILABLE" });
  await setup.entered;
  h.host.closeSession("session");
  setup.resolve({});
  await rejected;
  assert.deepEqual(wc.commands.map(({ method }) => method), ["Runtime.enable"]);
});

test("CDP timeout retains the original pending operation after page disposal", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  await h.host.evaluate("1+1", "session");
  const evaluation = hold(wc, "Runtime.evaluate");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = assert.rejects(h.host.evaluate("pending()", "session"), { code: "TIMEOUT" });
  await evaluation.entered;
  t.mock.timers.tick(30_000);
  await result;
  h.host.disposeGuest();
  assert(h.host.getHandoffActivity().operations > 0);
  assert(h.host.getHandoffActivity().uncontainedResources > 0);
  evaluation.resolve({ result: { value: 1 } });
  await settled();
  assert.equal(h.host.getHandoffActivity().operations, 0);
  assert(h.host.getHandoffActivity().uncontainedResources > 0);
});

test("a committed navigation retains its unfinished native load after window removal", async (t) => {
  WebContentsView.holdLoads = true;
  const h = harness(t);
  const wc = await h.open();
  h.host.setWindow(null);
  assert(h.host.getHandoffActivity().operations > 0);
  wc.loads[0].resolve();
  await settled();
  assert.deepEqual(h.host.getHandoffActivity(), { operations: 0, pages: 0, uncontainedResources: 2 });
});

test("temporary guest disposal allows new pages; permanent disposal seals admission", async (t) => {
  const h = harness(t);
  await h.open();
  h.host.disposeGuest();
  const retired = h.host.getHandoffActivity().uncontainedResources;
  await h.open();
  assert(h.host.getHandoffActivity().uncontainedResources > retired);
  h.host.dispose();
  await assert.rejects(h.host.navigate({ url: "https://fixture.invalid/new" }, "session"), { code: "UNAVAILABLE" });
});

test("an old deadline cannot detach a newer debugger binding on the same page", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  await h.host.evaluate("1+1", "session");
  const evaluation = hold(wc, "Runtime.evaluate");
  t.after(() => evaluation.resolve({ result: { value: 1 } }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = assert.rejects(h.host.evaluate("oldFirst()", "session"), { code: "TIMEOUT" });
  await evaluation.entered;
  t.mock.timers.tick(1_000);
  const second = assert.rejects(h.host.evaluate("oldSecond()", "session"), { code: "TIMEOUT" });
  await settled();
  t.mock.timers.tick(29_000);
  await first;
  wc.held.delete("Runtime.evaluate");
  assert.equal(await h.host.evaluate("1+1", "session"), 2);
  t.mock.timers.tick(1_000);
  await second;
  assert.equal(wc.debugger.isAttached(), true);
});

test("all browser execution entrypoints refuse a closed gate", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  h.closeAdmission();
  const before = wc.commands.length;
  for (const run of [
    () => h.host.reveal("session"), () => h.host.openTab({ url: "https://fixture.invalid/" }, "session"),
    () => h.host.snapshot("session"), () => h.host.screenshot({}, "session"),
    () => h.host.click("e1", "session"), () => h.host.fill("e1", "x", "session"),
    () => h.host.evaluate("1", "session"), () => h.host.cdpCommand("Page.enable", {}, "session"),
    () => h.host.getFileRoots("session"), () => h.host.previewFile(),
  ]) await assert.rejects(Promise.resolve().then(run), { code: "HOST_BUSY" });
  for (const run of [
    () => h.host.action("reload", "session"), () => h.host.console(1, "session"),
    () => h.host.openExternal("session"), () => h.host.setChromeSession("other"),
  ]) assert.throws(run, { code: "HOST_BUSY" });
  assert.equal(wc.commands.length, before);
});

test("removed roots remain counted and cannot navigate a recreated page", async (t) => {
  const first = deferred();
  let roots = first.promise;
  const h = harness(t, { getFileRoots: () => roots });
  const pending = h.host.navigate({ url: "https://fixture.invalid/old" }, "session");
  h.host.disposeGuest();
  assert(h.host.getHandoffActivity().operations > 0);
  roots = Promise.resolve([]);
  const replacement = await h.open();
  first.resolve([]);
  assert.equal(await pending, null);
  assert.equal(replacement.loads.length, 1);
  assert.equal(h.host.getHandoffActivity().operations, 0);
});

test("reveal waiters retain activity until visibility or disposal resolves them", async (t) => {
  const h = harness(t);
  const pending = assert.rejects(h.host.reveal("session"), { code: "UNAVAILABLE" });
  assert(h.host.getHandoffActivity().operations > 0);
  h.host.disposeGuest();
  await pending;
  assert.equal(h.host.getHandoffActivity().operations, 0);
});

test("concurrent CDP callers wait for the same initialization before sending user commands", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  const setup = hold(wc, "Runtime.enable");
  const first = h.host.evaluate("1+1", "session");
  await setup.entered;
  const second = h.host.cdpCommand("Page.reload", {}, "session");
  await settled();
  assert(!wc.commands.some(({ method }) => method === "Page.reload"));
  setup.resolve({});
  await Promise.all([first, second]);
  assert(wc.commands.findIndex(({ method }) => method === "Accessibility.enable") <
    wc.commands.findIndex(({ method }) => method === "Page.reload"));
});

test("closure between element lookup and fill prevents the delayed page mutation", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  await h.host.snapshot("session");
  const lookup = hold(wc, "DOM.resolveNode");
  const pending = assert.rejects(h.host.fill("e1", "secret draft", "session"), { code: "HOST_BUSY" });
  await lookup.entered;
  h.closeAdmission();
  lookup.resolve({ object: { objectId: "old-element" } });
  await pending;
  assert(!wc.commands.some(({ method }) => method === "Runtime.callFunctionOn"));
});

test("queued capture rechecks admission without discarding the running capture", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  const image = hold(wc, "Page.captureScreenshot");
  const first = h.host.screenshot({}, "session");
  await image.entered;
  const queued = assert.rejects(h.host.screenshot({}, "session"), { code: "HOST_BUSY" });
  h.closeAdmission();
  assert(h.host.getHandoffActivity().operations >= 2);
  image.resolve({ data: "aW1hZ2U=" });
  assert.equal((await first).data, "aW1hZ2U=");
  await queued;
  assert.equal(wc.commands.filter(({ method }) => method === "Page.captureScreenshot").length, 1);
  assert.equal(h.host.getHandoffActivity().operations, 0);
});

test("a late screenshot answers its caller without creating a file after admission closes", async (t) => {
  const scratch = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "browser-shot-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const h = harness(t, { getScratchDir: () => scratch });
  const wc = await h.open();
  const image = hold(wc, "Page.captureScreenshot");
  const pending = h.host.screenshot({}, "session");
  await image.entered;
  h.closeAdmission();
  image.resolve({ data: "aW1hZ2U=" });
  assert.equal((await pending).path, undefined);
  assert.deepEqual(readdirSync(scratch), []);
});

test("external opening remains owned after page disposal and never proves native closure", async (t) => {
  const h = harness(t);
  await h.open();
  const original = h.host.getHandoffActivity().uncontainedResources;
  const pending = deferred();
  shell.pending = pending;
  t.after(() => { shell.pending = null; pending.resolve(); });
  h.host.openExternal("session");
  h.host.disposeGuest();
  assert(h.host.getHandoffActivity().operations > 0);
  pending.resolve();
  await settled();
  assert.deepEqual(h.host.getHandoffActivity(), { operations: 0, pages: 0, uncontainedResources: original + 1 });
});

test("metadata and invalid URLs do not invent native resources; failed creation is retained", async (t) => {
  const h = harness(t);
  h.host.setChromeSession("session", "blank");
  await h.host.navigate({ url: "javascript:alert(1)" }, "session", "blank");
  h.host.closeSession("session");
  assert.deepEqual(h.host.getHandoffActivity(), { operations: 0, pages: 0, uncontainedResources: 0 });
  WebContentsView.failCreate = true;
  await h.host.navigate({ url: "https://fixture.invalid/" }, "session");
  h.host.disposeGuest();
  assert.equal(h.host.getHandoffActivity().uncontainedResources, 1);
});

test("background console initialization is observed and retained after unload", async (t) => {
  const h = harness(t);
  const wc = await h.open();
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const setup = hold(wc, "Runtime.enable");
  h.host.console(10, "session");
  await setup.entered;
  h.host.disposeGuest();
  assert(h.host.getHandoffActivity().operations > 0);
  setup.reject(new Error("fixture transport lost"));
  await settled();
  assert.equal(h.host.getHandoffActivity().operations, 0);
  assert.match(String(warnings[0]), /Browser console attachment failed/);
  assert.equal(wc.debugger.listenerCount("message"), 0);
});

test("a replacement native guest cannot receive an element uid from the old debugger", async (t) => {
  const h = harness(t);
  const original = await h.open();
  await h.host.snapshot("session");
  original.close();
  const replacement = await h.open();
  assert.notEqual(replacement, original);
  await assert.rejects(h.host.fill("e1", "old target", "session"), { code: "INVALID_ARGUMENT" });
  assert(!replacement.commands.some(({ method }) => method === "Runtime.callFunctionOn"));
});
