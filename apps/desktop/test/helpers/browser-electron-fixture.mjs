import { EventEmitter } from "node:events";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const shell = {
  calls: [], pending: null,
  openExternal(url) { this.calls.push(url); return this.pending?.promise ?? Promise.resolve(); },
  openPath(path) { this.calls.push(path); return this.pending?.promise ?? Promise.resolve(""); },
};

export class View {
  children = [];
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  addChildView(view) { this.children.push(view); }
  removeChildView(view) { this.children = this.children.filter((child) => child !== view); }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  getBounds() { return { ...this.bounds }; }
  setVisible(visible) { this.visible = visible; }
}

export class BrowserWindow {
  static instances = [];
  contentView = new View();
  destroyed = false;
  constructor(options) { this.size = [options.width, options.height]; BrowserWindow.instances.push(this); }
  getContentSize() { return this.size; }
  setContentSize(width, height) { this.size = [width, height]; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

export class WebContentsView extends View {
  static instances = [];
  static holdLoads = false;
  static failCreate = false;
  constructor() {
    super();
    if (WebContentsView.failCreate) throw new Error("fixture native allocation failed");
    const wc = Object.assign(new EventEmitter(), {
      id: WebContentsView.instances.length + 1, url: "", destroyed: false, throttled: true,
      commands: [], held: new Map(), loads: [],
      loadURL(url) {
        const load = deferred();
        this.loads.push(load);
        this.emit("did-start-navigation", {}, url, false, true);
        this.url = url;
        this.emit("did-navigate", {}, url);
        if (!WebContentsView.holdLoads) load.resolve();
        return load.promise;
      },
      getURL() { return this.url; }, getTitle: () => "fixture", isLoading: () => false,
      isDestroyed() { return this.destroyed; },
      close() { this.destroyed = true; this.emit("destroyed"); },
      getBackgroundThrottling() { return this.throttled; },
      setBackgroundThrottling(value) { this.throttled = value; },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler(handler) { this.openWindow = handler; },
      session: { setPermissionRequestHandler() {} },
      reload() {}, reloadIgnoringCache() {}, stop() {},
    });
    wc.debugger = Object.assign(new EventEmitter(), {
      attached: false,
      isAttached() { return this.attached; }, attach() { this.attached = true; }, detach() { this.attached = false; },
      async sendCommand(method, params) {
        wc.commands.push({ method, params });
        wc.emit("command", method);
        const held = wc.held.get(method);
        if (held) return held.promise;
        if (method === "Accessibility.getFullAXTree") return { nodes: [
          { nodeId: "1", role: { value: "textbox" }, backendDOMNodeId: wc.id },
        ] };
        if (method === "DOM.resolveNode") return { object: { objectId: "fixture-element" } };
        if (method === "Runtime.evaluate") return { result: { value: 2 } };
        if (method === "Page.captureScreenshot") return { data: Buffer.from("fixture-image").toString("base64") };
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 600 } };
        return {};
      },
    });
    this.webContents = wc;
    WebContentsView.instances.push(this);
  }
}
