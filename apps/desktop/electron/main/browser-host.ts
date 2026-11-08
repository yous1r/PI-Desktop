import type { BrowserWindow } from "electron";
import type { BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "./browser-view";
import { BrowserCdp } from "./browser-cdp";
import { BrowserActivity, type BrowserOperationOwner } from "./browser-activity";
import { BrowserPageOperations, type BrowserPage } from "./browser-page-operations";
import { randomUUID } from "node:crypto";

export const BROWSER_PLUGIN_ID = "pi.browser";
export const BROWSER_VIEW_ID = "browser";
const BROWSER_REVEAL_TIMEOUT_MS = 5_000;
const DEFAULT_BROWSER_TAB_ID = "plugin:pi.browser/browser";

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigateInput = {
  url?: string;
  path?: string;
};

/**
 * Translate a plugin-page hole into window coordinates and clamp it so the
 * guest cannot cover chat/composer outside the calling plugin view.
 */
export function clampGuestBounds(
  view: BrowserRect,
  hole: BrowserRect,
): BrowserRect | null {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

/**
 * Convert a chrome page's hole from its own CSS pixels to DIP.
 *
 * A docked view follows the app's Appearance type scale as page zoom
 * (`PluginViewHost`), so a rect the page measured at 125% covers 1.25 DIP per
 * pixel in the window. Without this the guest page would sit in a hole smaller
 * than the one the chrome actually draws from 100% type upward.
 */
export function scaleGuestHole(hole: BrowserRect, scale: unknown): BrowserRect {
  const factor = Number(scale);
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return hole;
  return {
    x: hole.x * factor,
    y: hole.y * factor,
    width: hole.width * factor,
    height: hole.height * factor,
  };
}

function asRect(value: unknown): BrowserRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

export type BrowserHostDeps = {
  isAdmissionClosed: () => boolean;
  createPane: (onState: (state: BrowserState) => void, onOpenUrl: (url: string) => void, owner: BrowserOperationOwner) => BrowserPane;
  onOpenUrl?: (url: string, sessionId: string | undefined, owner: BrowserOperationOwner) => Promise<void>;
  isPluginLoaded: (pluginId: string) => boolean;
  getFileRoots: (sessionId: string | undefined, owner: BrowserOperationOwner) => Promise<readonly string[]>;
  getScratchDir?: (sessionId?: string) => string | null;
  onState: (state: BrowserState) => void;
  onPresentationState?: (state: BrowserState) => void;
  onRevealView?: (sessionId: string, tabId?: string, location?: BrowserNavigateInput) => void;
};

type ChromeSurface = {
  pluginId: string;
  viewId: string;
  visible: boolean;
  bounds: BrowserRect;
  /**
   * Page zoom the chrome page is painting at. The page measures its guest hole
   * in its own CSS pixels, so once the host scales that page with the app's
   * type scale one chrome CSS pixel covers `scale` DIP (see `scaleGuestHole`).
   */
  scale?: number;
};

type BrowserRevealWaiter = {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};


/** Host-owned pages, keyed by conversation and resource tab. */
export class BrowserHost {
  private readonly deps: BrowserHostDeps;
  private readonly activity: BrowserActivity;
  private readonly operations: BrowserPageOperations;
  private readonly pages = new Map<string, BrowserPage>();
  private readonly locations = new Map<string, string>();
  private readonly selectedTabs = new Map<string, string | null>();
  private readonly connectedTabs = new Map<string, string | null>();
  private readonly revealWaiters = new Set<BrowserRevealWaiter>();
  private active: BrowserPage | null = null;
  private window: BrowserWindow | null = null;
  private chrome: ChromeSurface | null = null;
  private hole: BrowserRect | null = null;
  private holePluginId: string | null = null;

  constructor(deps: BrowserHostDeps) {
    this.deps = deps;
    this.activity = new BrowserActivity(deps.isAdmissionClosed);
    this.operations = new BrowserPageOperations((sessionId, tabId, started = true) =>
      started ? this.currentPage(sessionId, tabId) : this.operationPage(sessionId, tabId), deps.getScratchDir);
  }

  getHandoffActivity(): { operations: number; pages: number; uncontainedResources: number } {
    return { ...this.activity.snapshot(), pages: this.pages.size };
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (!window) { this.disposeGuest(); return; }
    for (const page of this.pages.values()) page.pane.setWindow(window);
    this.applyGuest();
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.chrome = surface;
    this.applyGuest();
    this.resolveVisibleRevealWaiters();
  }

  async reveal(sessionId?: string): Promise<void> {
    return this.activity.scope().run(() => this.revealActive(sessionId));
  }

  private async revealActive(sessionId?: string): Promise<void> {
    const id = sessionId?.trim();
    if (!id) throw this.unavailableError("Browser reveal requires an active session.");
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) {
      throw this.unavailableError("The Browser plugin is unavailable.");
    }
    if (this.isBrowserVisibleForSession(id)) return;
    const revealView = this.deps.onRevealView;
    if (!revealView) throw this.unavailableError("Browser view cannot be opened by this host.");

    let waiter: BrowserRevealWaiter | undefined;
    const visible = new Promise<void>((resolve, reject) => {
      const entry: BrowserRevealWaiter = {
        sessionId: id,
        resolve,
        reject: (error) => reject(error),
        timeout: setTimeout(() => {
          this.rejectRevealWaiter(
            entry,
            this.unavailableError(
              "Browser view did not become visible for the calling session. Switch to that session and retry.",
            ),
          );
        }, BROWSER_REVEAL_TIMEOUT_MS),
      };
      waiter = entry;
      this.revealWaiters.add(entry);
    });

    try {
      const tabId = this.active?.sessionId === id
        ? this.active.tabId ?? undefined
        : this.selectedTabs.get(id) ?? undefined;
      revealView(id, tabId);
    } catch (error) {
      if (waiter) {
        this.rejectRevealWaiter(
          waiter,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return visible;
  }

  getContext(): { sessionId?: string; tabId?: string } {
    return this.active ? this.contextFor(this.active) : {};
  }

  private contextFor(page: BrowserPage): { sessionId?: string; tabId?: string } {
    return {
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      ...(page.tabId ? { tabId: page.tabId } : {}),
    };
  }

  private isBrowserVisibleForSession(sessionId: string): boolean {
    return this.chrome?.visible === true &&
      this.chrome.pluginId === BROWSER_PLUGIN_ID &&
      this.chrome.viewId === BROWSER_VIEW_ID &&
      this.active?.sessionId === sessionId;
  }

  private resolveVisibleRevealWaiters(): void {
    for (const waiter of [...this.revealWaiters]) {
      if (!this.isBrowserVisibleForSession(waiter.sessionId)) continue;
      this.revealWaiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectRevealWaiter(waiter: BrowserRevealWaiter, error: Error): void {
    if (!this.revealWaiters.delete(waiter)) return;
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  private unavailableError(message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code: "UNAVAILABLE" });
  }

  private assertBrowserViewVisible(): void {
    if (
      this.chrome?.visible === true &&
      this.chrome.pluginId === BROWSER_PLUGIN_ID &&
      this.chrome.viewId === BROWSER_VIEW_ID
    ) return;
    throw Object.assign(
      new Error("Browser view must be visible before browser operations can run"),
      { code: "UNAVAILABLE" },
    );
  }

  private key(sessionId: string, tabId: string | null): string {
    return JSON.stringify([sessionId, tabId]);
  }

  private pageFor(sessionId: string, tabId: string | null): BrowserPage {
    this.activity.assertAdmission();
    const key = this.key(sessionId, tabId);
    const existing = this.pages.get(key);
    if (existing) return existing;
    const owner = this.activity.scope(() => this.pages.get(key) === page);
    const page: BrowserPage = {
      key, sessionId, tabId, owner, cdp: new BrowserCdp(owner.assertCurrent), state: null,
      started: false, navigationVersion: 0, navigating: false,
      pane: this.deps.createPane(
        (state) => {
          if (!owner.isCurrent()) return;
          page.state = state;
          if (state.url && !page.navigating) this.locations.set(key, state.url);
          this.publishPage(page);
        },
        (url) => {
          if (!owner.isCurrent()) return;
          void owner.run(async () => this.deps.onOpenUrl?.(url, sessionId || undefined, owner))
            .catch((error) => console.warn("Browser link opening failed", error));
        },
        owner,
      ),
    };
    page.pane.setWindow(this.window);
    this.pages.set(key, page);
    return page;
  }

  private publishPage(page: BrowserPage): void {
    const state = this.stateFor(page);
    if (!state) return;
    this.deps.onState(state);
    if (this.active === page) this.deps.onPresentationState?.(state);
  }

  private publishCurrent(): void {
    const state = this.getState() ?? {
      url: "", title: "", isLoading: false, canGoBack: false, canGoForward: false,
      ...this.getContext(),
    };
    this.deps.onState(state);
    this.deps.onPresentationState?.(state);
  }

  setChromeSession(sessionId: string | undefined, tabId?: string, location?: string): boolean {
    this.activity.assertAdmission();
    const id = sessionId?.trim() || "";
    const tab = tabId ?? (this.active?.sessionId === id
      ? this.active.tabId : this.selectedTabs.get(id) ?? null);
    const page = this.pageFor(id, tab);
    if (this.active === page) return false;
    this.active?.pane.setVisible(false);
    this.active = page;
    this.selectedTabs.set(id, tab);
    const target = this.locations.get(page.key) ?? location?.trim();
    const navigate = !page.started && !page.navigating;
    if (target && navigate) {
      page.started = false;
      page.state = null;
      this.publishCurrent();
      this.applyGuest();
      void this.navigatePage(page, target).catch((error) => {
        console.warn("Browser tab restore failed", error);
      });
    } else {
      this.publishCurrent();
      this.applyGuest();
    }
    return true;
  }

  setGuestHole(pluginId: string, hole: unknown): BrowserRect | null {
    this.activity.assertAdmission();
    this.hole = asRect(hole);
    this.holePluginId = pluginId;
    this.applyGuest();
    return this.guestBounds();
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    if (visible) this.activity.assertAdmission();
    if (!visible && this.holePluginId === pluginId) {
      this.active?.pane.setVisible(false);
    } else if (visible) {
      this.applyGuest();
    }
  }

  /** A new preview has its own page even before the renderer mounts its tab. */
  async openTab(input: BrowserNavigateInput, sessionId: string): Promise<{ tabId: string; state: BrowserState | null }> {
    this.assertPluginAvailable();
    const id = sessionId.trim();
    if (!id) throw this.unavailableError("Browser navigation requires a session.");
    const tabId = `plugin:pi.browser/browser:${randomUUID()}`;
    const page = this.pageFor(id, tabId);
    this.selectedTabs.set(id, tabId);
    this.connectedTabs.set(id, tabId);
    const navigation = this.navigatePage(page, String(input.path ?? input.url ?? "").trim());
    this.revealNavigation(page, navigation, input);
    return { tabId, state: await navigation };
  }

  async navigate(input: BrowserNavigateInput, sessionId?: string, tabId?: string): Promise<BrowserState | null> {
    this.assertPluginAvailable();
    const target = String(input.path ?? input.url ?? "").trim();
    let page: BrowserPage;
    if (sessionId !== undefined) {
      const id = sessionId.trim();
      if (!id) throw this.unavailableError("Browser navigation requires a session.");
      const selected = tabId ?? this.connectedTabs.get(id) ?? this.selectedTabs.get(id) ?? DEFAULT_BROWSER_TAB_ID;
      const key = this.key(id, selected);
      const existing = this.pages.get(key);
      if (tabId !== undefined && !existing) throw this.unavailableError("The Browser tab is closed.");
      page = existing ?? this.pageFor(id, selected);
      if (tabId === undefined) this.connectedTabs.set(id, selected);
      if (!existing) this.selectedTabs.set(id, selected);
      const navigation = target ? this.navigatePage(page, target) : Promise.resolve(this.stateFor(page));
      if (!existing) this.revealNavigation(page, navigation);
      return navigation;
    }
    page = this.operationPage();
    return target ? this.navigatePage(page, target) : this.stateFor(page);
  }

  private revealNavigation(page: BrowserPage, navigation: Promise<BrowserState | null>, input?: BrowserNavigateInput): void {
    try { this.deps.onRevealView?.(page.sessionId, page.tabId ?? undefined, input); }
    catch (error) {
      void navigation.catch((failure) => console.warn("Browser navigation after reveal failure", failure));
      throw error;
    }
  }

  private navigatePage(page: BrowserPage, target: string): Promise<BrowserState | null> {
    return page.owner.run(async () => {
      const version = page.navigationVersion + 1;
      try { return await this.navigatePageActive(page, target); }
      finally { if (page.navigationVersion === version) page.navigating = false; }
    });
  }

  private async navigatePageActive(page: BrowserPage, target: string): Promise<BrowserState | null> {
    const version = ++page.navigationVersion;
    page.navigating = true;
    this.locations.set(page.key, target);
    const current = () => page.owner.isCurrent() && page.navigationVersion === version;
    let roots: readonly string[];
    try {
      roots = await this.deps.getFileRoots(page.sessionId || undefined, page.owner);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      this.publishPage(page);
      if (this.active === page) this.applyGuest();
      return null;
    }
    if (!current()) return null;
    let state: BrowserState | null;
    try {
      state = await page.pane.navigateAndWait(target, roots[0] ?? null);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      this.publishPage(page);
      if (this.active === page) this.applyGuest();
      return null;
    }
    if (!current()) return null;
    page.navigating = false;
    page.started = state !== null;
    page.state = state ?? page.pane.getState();
    this.locations.set(page.key, state?.url || target);
    if (!state && !page.state?.loadError) {
      page.state = { url: target, title: "", isLoading: false,
        canGoBack: false, canGoForward: false, loadError: "INVALID_URL" };
    }
    this.publishPage(page);
    if (this.active === page) this.applyGuest();
    return state ? { ...state, ...this.contextFor(page) } : null;
  }

  private assertPluginAvailable(): void {
    this.activity.assertAdmission();
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) {
      throw this.unavailableError("The Browser plugin is unavailable.");
    }
  }

  /** Trusted tool session identity never falls back to the visible page. */
  private operationPage(sessionId?: string, tabId?: string): BrowserPage {
    this.assertPluginAvailable();
    if (sessionId !== undefined) {
      const id = sessionId.trim();
      const tab = tabId ?? this.connectedTabs.get(id) ?? this.selectedTabs.get(id);
      const page = id && tab !== undefined ? this.pages.get(this.key(id, tab)) : undefined;
      if (!page) throw this.unavailableError("No Browser page is connected to this session. Navigate or open a preview first.");
      if (tabId === undefined) this.connectedTabs.set(id, page.tabId);
      return page;
    }
    // Unscoped plugin/UI calls retain their existing visible-page boundary.
    this.assertBrowserViewVisible();
    if (!this.active) throw this.unavailableError("browser guest is not available");
    return this.active;
  }

  private stateFor(page: BrowserPage): BrowserState | null {
    return page.state ? { ...page.state, ...this.contextFor(page) } : null;
  }

  action(action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string): void {
    const page = this.operationPage(sessionId, tabId);
    if (page.state) page.pane.action(action);
  }

  getState(): BrowserState | null {
    return this.active ? this.stateFor(this.active) : null;
  }

  getStateForPlugin(sessionId?: string, tabId?: string): BrowserState | null {
    return this.stateFor(this.operationPage(sessionId, tabId));
  }

  /** Rehydrate side-panel tabs after a renderer reload; DOM stays in Main. */
  getPages(sessionId: string): BrowserState[] {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) return [];
    return [...this.pages.values()].filter((page) => page.sessionId === sessionId && page.tabId !== null)
      .map((page) => this.stateFor(page) ?? {
        url: "", title: "", isLoading: page.navigating, canGoBack: false, canGoForward: false,
        ...this.contextFor(page),
      });
  }

  openExternal(sessionId?: string, tabId?: string): void {
    const page = this.operationPage(sessionId, tabId);
    if (page.started) page.pane.openExternal();
  }

  private currentPage(sessionId?: string, tabId?: string): BrowserPage {
    const page = this.operationPage(sessionId, tabId);
    if (!page.started) throw this.unavailableError("browser guest is not available");
    return page;
  }

  snapshot(sessionId?: string, tabId?: string) { return this.operations.snapshot(sessionId, tabId); }
  screenshot(input: { fullPage?: boolean } = {}, sessionId?: string, tabId?: string) {
    return this.operations.screenshot(input, sessionId, tabId);
  }
  click(uid: string, sessionId?: string, tabId?: string) { return this.operations.click(uid, sessionId, tabId); }
  fill(uid: string, text: string, sessionId?: string, tabId?: string) { return this.operations.fill(uid, text, sessionId, tabId); }
  evaluate(expression: string, sessionId?: string, tabId?: string) { return this.operations.evaluate(expression, sessionId, tabId); }
  console(limit?: number, sessionId?: string, tabId?: string) { return this.operations.console(limit, sessionId, tabId); }
  cdpCommand(method: string, params?: unknown, sessionId?: string, tabId?: string) {
    return this.operations.cdpCommand(method, params, sessionId, tabId);
  }

  /** Resolve containment roots from the owning session, not the visible UI. */
  getFileRoots(sessionId?: string): Promise<readonly string[]> {
    const owner = this.activity.scope();
    return owner.run(async () => {
      const roots = await this.deps.getFileRoots(sessionId, owner);
      owner.assertCurrent();
      return roots;
    });
  }

  async previewFile(): Promise<{ ok: true } | { ok: false; content: string }> {
    this.activity.assertAdmission();
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) return {
      ok: false, content: "BrowserPreview: the Browser plugin is disabled. Enable pi.browser in Plugins to preview HTML.",
    };
    return { ok: true };
  }

  closeTab(sessionId: string, tabId: string | null): void {
    const key = this.key(sessionId, tabId);
    const page = this.pages.get(key);
    if (page) {
      this.pages.delete(key);
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
      if (this.active === page) this.active = null;
    }
    this.locations.delete(key);
    if (this.selectedTabs.get(sessionId) === tabId) this.selectedTabs.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    for (const page of [...this.pages.values()]) {
      if (page.sessionId !== sessionId) continue;
      this.closeTab(sessionId, page.tabId);
    }
    this.selectedTabs.delete(sessionId);
    this.connectedTabs.delete(sessionId);
    for (const key of this.locations.keys()) {
      if (JSON.parse(key)[0] === sessionId) this.locations.delete(key);
    }
  }

  dispose(): void { this.activity.dispose(); this.disposeGuest(); }

  /** Presentation is renderer-owned; page lifetime is not. */
  detachPresentation(): void {
    for (const page of this.pages.values()) page.pane.setVisible(false);
    this.active = null;
    this.chrome = null;
    this.hole = null;
    this.holePluginId = null;
  }

  disposeGuest(): void {
    this.activity.invalidate();
    for (const waiter of [...this.revealWaiters]) {
      this.rejectRevealWaiter(
        waiter,
        this.unavailableError("Browser view was closed before it became visible."),
      );
    }
    for (const page of this.pages.values()) {
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
    }
    this.pages.clear();
    this.locations.clear();
    this.selectedTabs.clear();
    this.connectedTabs.clear();
    this.detachPresentation();
  }

  private guestBounds(): BrowserRect | null {
    if (!this.chrome?.visible || !this.hole || this.holePluginId !== this.chrome.pluginId) return null;
    return clampGuestBounds(
      this.chrome.bounds,
      scaleGuestHole(this.hole, this.chrome.scale),
    );
  }

  private applyGuest(): void {
    if (!this.active) return;
    const bounds = this.guestBounds();
    if (!bounds || !this.active.started) { this.active.pane.setVisible(false); return; }
    this.active.pane.setBounds(bounds);
    this.active.pane.setVisible(true);
  }
}
