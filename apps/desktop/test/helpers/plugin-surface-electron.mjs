import { EventEmitter } from "node:events";
let next = 0;
export const pages = [];
export class WebContentsView {
  constructor() {
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      id: ++next, destroyed: false, sent: [],
      isDestroyed() { return this.destroyed; },
      setWindowOpenHandler() {}, setZoomFactor() {}, getZoomFactor() { return 1; },
      loadURL: async () => {},
      send(channel, value) { this.sent.push({channel, value}); },
      close() { this.destroyed = true; this.emit("destroyed"); },
    });
    pages.push(this.webContents);
  }
  setBounds(bounds) { this.bounds = bounds; }
}
export const ipcMain = { handle() {}, on() {} };
export class BrowserWindow {}
export const Menu = {};
export const systemPreferences = {};
export const shell = { openExternal: async () => {} };
export const session = { fromPartition: () => ({
  webRequest: { onBeforeRequest() {} },
  setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
}) };
