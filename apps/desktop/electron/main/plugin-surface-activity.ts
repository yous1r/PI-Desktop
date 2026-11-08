import type { WebContents } from "electron";
import { ExternalResourceActivity } from "./external-resource-activity";
import { pageGoneWithin } from "./plugin-panel-senders";

export type PluginSurfaceOptions = {
  isAdmissionClosed: () => boolean;
  /** Capture the original installation, never resolve a replacement after await. */
  captureOwner: (pluginId: string) => () => void;
  onError: (error: unknown) => void;
};

/** Page ownership survives cache removal; original work survives caller budgets. */
export class PluginSurfaceActivity extends ExternalResourceActivity {
  private readonly options: PluginSurfaceOptions;
  private readonly pages = new Map<number, { page: WebContents; assertCurrent: () => void }>();
  private readonly pending = new Set<{ pluginId: string; active: boolean }>();

  private readonly closing = new WeakMap<WebContents, Promise<void>>();
  constructor(options: PluginSurfaceOptions) { super(options.isAdmissionClosed); this.options = options; }
  capture(pluginId: string): () => void {
    this.assertOpen();
    const original = this.options.captureOwner(pluginId);
    return () => { this.assertOpen(); original(); };
  }
  async runOpen<T>(pluginId: string, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    return this.run(async () => {
      const original = this.capture(pluginId), pending = { pluginId, active: true };
      const assertCurrent = () => {
        original();
        if (!pending.active) throw Object.assign(new Error("Plugin surface open was retired"), { code: "PLUGIN_UNLOADED" });
      };
      this.pending.add(pending);
      try { return await operation(assertCurrent); } finally { this.pending.delete(pending); }
    });
  }
  retire(pluginId: string): void {
    for (const pending of this.pending) if (pending.pluginId === pluginId) pending.active = false;
  }
  own(page: WebContents, assertCurrent: () => void): void {
    const entry = { page, assertCurrent };
    this.pages.set(page.id, entry);
    const id = page.id;
    page.once("destroyed", () => { if (this.pages.get(id) === entry) this.pages.delete(id); });
  }
  assertSender(senderId: number): void {
    this.assertOpen();
    const entry = this.pages.get(senderId);
    if (!entry || entry.page.isDestroyed()) throw Object.assign(new Error("Plugin page is gone"), { code: "PLUGIN_GONE" });
    entry.assertCurrent();
  }
  isCurrent(senderId: number): boolean {
    try { this.assertSender(senderId); return true; } catch (error) {
      if (!["HOST_BUSY", "PLUGIN_UNLOADED", "PLUGIN_GONE"].includes(String((error as { code?: unknown })?.code))) this.options.onError(error);
      return false;
    }
  }
  closePage(page: WebContents, close: () => void): Promise<void> {
    const existing = this.closing.get(page);
    if (existing) return existing;
    const pending = Promise.withResolvers<void>();
    this.closing.set(page, pending.promise);
    void this.track(async () => { close(); await pageGoneWithin(page); }).then(pending.resolve, pending.reject);
    return pending.promise;
  }
  report(error: unknown): void { this.options.onError(error); }
  getHandoffActivity() { return this.snapshot(this.pages.size); }
}
