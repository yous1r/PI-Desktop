import { EventEmitter } from "node:events";
let next = 0;
export const pages = [];
export const windows = [];
export const controls = { holdLoads: false, holdClose: false };
export function deferred() { return Promise.withResolvers(); }
function page() {
  const wc = Object.assign(new EventEmitter(), {
    id: ++next, destroyed: false, sent: [], loads: [],
    isDestroyed() { return this.destroyed; },
    setWindowOpenHandler(handler) { this.openWindow = handler; },
    setZoomFactor() {}, getZoomFactor() { return 1; },
    loadURL(url) { const load = deferred(); this.loads.push({ ...load, url }); if (!controls.holdLoads) load.resolve(); return load.promise; },
    send(channel, value) { this.sent.push({ channel, value }); },
    close() { if (!controls.holdClose) this.die(); },
    die() { if (this.destroyed) return; this.destroyed = true; this.emit("destroyed"); },
    session: session.fromPartition(),
  });
  pages.push(wc);
  return wc;
}
export class WebContentsView {
  constructor() { this.webContents = page(); }
  setBounds(bounds) { this.bounds = bounds; }
}
export const ipcMain = { handlers: new Map(), listeners: new Map(),
  handle(name, handler) { this.handlers.set(name, handler); },
  on(name, handler) { this.listeners.set(name, handler); },
};
export class BrowserWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.webContents = page(); this.destroyed = false; this.shown = 0;
    this.webContents.once("destroyed", () => { this.destroyed = true; this.emit("closed"); });
    windows.push(this);
  }
  setMenu() {} isMinimized() { return false; } isMaximized() { return false; }
  isDestroyed() { return this.destroyed; } show() { this.shown++; } focus() {} restore() {}
  loadURL(url) { return this.webContents.loadURL(url); }
  close() { this.webContents.close(); } destroy() { this.webContents.die(); }
}
export const Menu = {};
export const systemPreferences = {};
export const shell = { calls: [], pending: null, openExternal(url) { this.calls.push(url); return this.pending?.promise ?? Promise.resolve(); } };
export const session = { fromPartition: () => ({
  webRequest: { onBeforeRequest() {} },
  setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
}) };
