import type { WebContents } from "electron";
import type { BrowserState } from "@pi-desktop/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserPane } from "./browser-view";
import type { BrowserCdp } from "./browser-cdp";
import type { BrowserOperationOwner } from "./browser-activity";

export type BrowserPage = {
  key: string;
  sessionId: string;
  tabId: string | null;
  pane: BrowserPane;
  cdp: BrowserCdp;
  owner: BrowserOperationOwner;
  state: BrowserState | null;
  started: boolean;
  navigationVersion: number;
  navigating: boolean;
};

const BROWSER_CDP_TIMEOUT_MS = 30_000;

/** Bound the caller's wait while retaining the original operation until it settles. */
function withCdpDeadline<T>(page: BrowserPage, wc: WebContents, run: () => Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const original = page.owner.run(run);
  const detach = page.cdp.captureDetach(wc);
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error(`browser ${label} timed out after ${BROWSER_CDP_TIMEOUT_MS}ms`), { code: "TIMEOUT" }));
      detach();
    }, BROWSER_CDP_TIMEOUT_MS);
  });
  return Promise.race([original, timedOut])
    .finally(() => { if (timeout) clearTimeout(timeout); });
}

function webContents(page: BrowserPage): WebContents {
  page.owner.assertCurrent();
  const wc = page.pane.getWebContents();
  if (!wc || wc.isDestroyed()) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
  return wc;
}

function capture<T>(page: BrowserPage, run: (wc: WebContents) => Promise<T>): Promise<T> {
  return page.owner.run(() => page.pane.captureScreenshot((wc) =>
    withCdpDeadline(page, wc, () => run(wc), "screenshot"),
  ));
}

/** Browser execution stays independent of presentation, bound to its original page. */
export class BrowserPageOperations {
  private readonly page: (sessionId?: string, tabId?: string, started?: boolean) => BrowserPage;
  private readonly scratch?: (sessionId?: string) => string | null;

  constructor(page: BrowserPageOperations["page"], scratch?: BrowserPageOperations["scratch"]) {
    this.page = page;
    this.scratch = scratch;
  }

  async snapshot(sessionId?: string, tabId?: string): Promise<{ tree: string; url: string; title: string }> {
    const page = this.page(sessionId, tabId);
    const wc = webContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.snapshot(wc), "snapshot");
  }

  async screenshot(input: { fullPage?: boolean } = {}, sessionId?: string, tabId?: string): Promise<{ mimeType: string; data: string; path?: string }> {
    const page = this.page(sessionId, tabId);
    const shot = await capture(page, (wc) => page.cdp.screenshot(wc, input));
    // A completed native result can still answer its caller; retired pages cannot write new files.
    if (!page.owner.isCurrent()) return shot;
    const scratch = this.scratch?.(sessionId ?? page.sessionId);
    if (!scratch) return shot;
    try {
      mkdirSync(scratch, { recursive: true });
      const path = join(scratch, `browser-screenshot-${Date.now()}.jpg`);
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      return { ...shot, path };
    } catch { return shot; }
  }

  async click(uid: string, sessionId?: string, tabId?: string): Promise<void> {
    const page = this.page(sessionId, tabId);
    return page.owner.run(() => page.pane.withStableViewport((wc) =>
      withCdpDeadline(page, wc, () => page.cdp.click(wc, uid), "click"),
    ));
  }

  async fill(uid: string, text: string, sessionId?: string, tabId?: string): Promise<void> {
    const page = this.page(sessionId, tabId);
    const wc = webContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.fill(wc, uid, text), "fill");
  }

  async evaluate(expression: string, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.page(sessionId, tabId);
    const wc = webContents(page);
    return withCdpDeadline(page, wc, () => page.cdp.evaluate(wc, expression), "evaluate");
  }

  console(limit?: number, sessionId?: string, tabId?: string): { messages: ReturnType<BrowserCdp["console"]> } {
    const page = this.page(sessionId, tabId, false);
    if (!page.started) return { messages: [] };
    const wc = webContents(page);
    void page.owner.run(() => page.cdp.attach(wc)).catch((error) => console.warn("Browser console attachment failed", error));
    return { messages: page.cdp.console(limit) };
  }

  async cdpCommand(method: string, params?: unknown, sessionId?: string, tabId?: string): Promise<unknown> {
    const page = this.page(sessionId, tabId);
    const wc = webContents(page);
    if (method === "Page.captureScreenshot") return capture(page, (view) => page.cdp.send(view, method, params));
    return withCdpDeadline(page, wc, () => page.cdp.send(wc, method, params), `cdp ${method}`);
  }
}
