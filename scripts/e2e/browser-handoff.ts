import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage, type WebContents } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";
import { BrowserBackingHost } from "../../apps/desktop/electron/main/browser-backing-host";
import { DesktopHandoffAdmission } from "../../apps/desktop/electron/main/runtime/handoff-admission";

const output = process.env.BROWSER_HANDOFF_ARTIFACT_DIR;
if (!output) throw new Error("BROWSER_HANDOFF_ARTIFACT_DIR is required");
app.setPath("userData", join(output, "profile"));
app.setPath("sessionData", join(output, "profile"));
app.on("window-all-closed", () => {});

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser fixture completion deadline exceeded")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function probe(output: string) {
  const workspace = join(output, "workspace");
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, "index.html");
  writeFileSync(path, `<!doctype html><meta charset="utf-8"><title>Handoff fixture</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <style>body{background:#2563eb;color:white;padding:32px;font:24px sans-serif}input,button{font:24px sans-serif}</style>
    <label for="note">Note</label><input id="note"><button onclick="window.count++">Increment</button>
    <script>window.count=0</script>`);
  const admission = new DesktopHandoffAdmission();
  const backing = new BrowserBackingHost();
  const panes: BrowserPane[] = [];
  const contents: WebContents[] = [];
  const host = new BrowserHost({
    isAdmissionClosed: () => admission.isClosed(),
    createPane: (state, open, owner) => {
      const pane = new BrowserPane(state, open, backing, owner);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true, getFileRoots: async () => [workspace],
    getScratchDir: () => join(output, "shots"), onState() {}, onRevealView() {},
  });
  const passed: string[] = [];
  let window: BrowserWindow | undefined;
  // All other resource families are absent in this isolated browser fixture.
  const inspect = async () => {
    const activity = host.getHandoffActivity();
    return { clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0,
      terminals: 0, plugins: 0, admissions: activity.operations, finalizations: 0, writes: 0,
      children: 0, workers: 0, schedules: 0, approvals: 0, inputs: 0,
      nativeSessions: activity.pages, mcp: 0, uncontainedResources: activity.uncontainedResources };
  };
  try {
    const empty = await admission.gate.acquireHandoff(randomUUID(), inspect);
    await assert.rejects(host.navigate({ path }, "A"), { code: "HOST_BUSY" });
    assert.deepEqual(host.getHandoffActivity(), { operations: 0, pages: 0, uncontainedResources: 0 });
    empty.cancel();
    passed.push("closed empty admission prevents native creation and cancellation restores normal entry");
    window = new BrowserWindow({ show: true, width: 900, height: 650,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL("data:text/html,<h1>Isolated browser handoff validation</h1>");
    host.setWindow(window);
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 20, y: 80, width: 700, height: 500 } });
    host.setGuestHole("pi.browser", { x: 0, y: 0, width: 700, height: 500 });
    host.setChromeSession("A", "page-a");

    await host.navigate({ path }, "A");
    const wc = panes.at(-1)?.getWebContents();
    assert(wc); contents.push(wc);
    const snapshot = await host.snapshot("A");
    const input = snapshot.tree.match(/- (e\d+) textbox "Note"/)?.[1];
    const button = snapshot.tree.match(/- (e\d+) button "Increment"/)?.[1];
    assert(input && button, snapshot.tree);
    await host.fill(input, "original page draft", "A");
    const screenshot = await host.screenshot({ fullPage: true }, "A");
    assert(screenshot.path?.startsWith(join(output, "shots")));
    assert(!nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64")).isEmpty());
    host.setChromeSession("B", "blank");
    await host.click(button, "A");
    assert.equal(await host.evaluate("window.count", "A"), 1);
    assert.equal(await host.evaluate("document.querySelector('#note').value", "A"), "original page draft");
    assert(BrowserWindow.getAllWindows().filter((entry) => entry !== window).every((entry) => !entry.isVisible()));
    passed.push("real visible Chromium capture and background session input retain their original page");

    const entered = Promise.withResolvers<void>();
    const onMessage = (_event: unknown, method: string, params: { args?: { value?: unknown }[] }) => {
      if (method === "Runtime.consoleAPICalled" && params.args?.[0]?.value === "HANDOFF_FIXTURE_ENTERED") entered.resolve();
    };
    wc.debugger.on("message", onMessage);
    const pending = host.evaluate("new Promise(resolve=>{window.finishHandoff=resolve;console.log('HANDOFF_FIXTURE_ENTERED')})", "A");
    void pending.catch(() => {}); // The awaited result below or fixture failure owns the rejection.
    try {
      await bounded(entered.promise);
      assert(host.getHandoffActivity().operations > 0);
      await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
      await host.evaluate("window.finishHandoff(19)", "A");
      assert.equal(await bounded(pending), 19);
    } finally { wc.debugger.off("message", onMessage); }
    passed.push("in-flight native evaluation blocks handoff until its original completion");

    const destroyed = once(wc, "destroyed");
    host.disposeGuest();
    await bounded(destroyed);
    assert.equal(host.getHandoffActivity().operations, 0);
    assert.equal(host.getHandoffActivity().pages, 0);
    assert(host.getHandoffActivity().uncontainedResources > 0);
    assert.deepEqual(BrowserWindow.getAllWindows(), [window]);
    await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
    await host.navigate({ path }, "A");
    const next = panes.at(-1)?.getWebContents();
    assert(next && next !== wc); contents.push(next);
    assert.equal(await host.evaluate("window.count", "A"), 0);
    admission.dispose();
    await assert.rejects(host.snapshot("A"), { code: "HOST_BUSY" });
    const nextDestroyed = once(next, "destroyed");
    host.dispose();
    await bounded(nextDestroyed);
    assert(contents.every((entry) => entry.isDestroyed()));
    window.destroy();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    passed.push("retired pages close their handles, retain refusal evidence, and cannot reopen after permanent disposal");
    return { status: "PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES", passed,
      activity: host.getHandoffActivity(), originalWebContentsDestroyed: contents.length,
      allFixtureWindowsClosed: true, qualifiedNativeFamilyClosure: false, electron: process.versions.electron };
  } finally { admission.dispose(); host.dispose(); if (window && !window.isDestroyed()) window.destroy(); }
}

app.whenReady().then(() => probe(output)).then((report) => {
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("BROWSER_HANDOFF " + JSON.stringify(report));
  app.exit(0);
}, (error) => { console.error(error); app.exit(1); });
