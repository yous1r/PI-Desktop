/**
 * Controlled Electron surface fixture for the H1-R07 surface/listener tests.
 *
 * It implements only the native surface API the real `bootstrap/window.ts`,
 * `bootstrap/launcher.ts` and `bootstrap/app-lifecycle.ts` modules call, plus
 * observable state a test can assert on. Nothing here touches a live Electron
 * process, a real display, a tray, a global accelerator or a network.
 */
import { EventEmitter } from "node:events";

export const electronState = {
  windows: [],
  trays: [],
  shortcuts: new Map(),
  menus: [],
  powerBlockers: new Map(),
  badgeCount: null,
  quitCalls: 0,
  setApplicationMenuCalls: 0,
};

export function resetElectronState() {
  electronState.windows.length = 0;
  electronState.trays.length = 0;
  electronState.shortcuts.clear();
  electronState.menus.length = 0;
  electronState.powerBlockers.clear();
  electronState.badgeCount = null;
  electronState.quitCalls = 0;
  electronState.setApplicationMenuCalls = 0;
  FakeBrowserWindow.loadGate = null;
}

function display(id = 1) {
  return {
    id,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
  };
}

export class FakeBrowserWindow extends EventEmitter {
  /** When set, every `loadURL`/`loadFile` waits for it before resolving. */
  static loadGate = null;

  static getAllWindows() {
    return electronState.windows.filter((window) => !window.dead);
  }

  constructor(options = {}) {
    super();
    this.options = options;
    this.dead = false;
    this.visible = false;
    this.minimized = false;
    this.maximized = false;
    this.fullScreen = false;
    this.focused = false;
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 1200,
      height: options.height ?? 800,
    };
    this.webContents = Object.assign(new EventEmitter(), {
      id: electronState.windows.length + 1,
      mainFrame: { url: "" },
      sent: [],
      isDestroyed: () => this.dead,
      send: (channel, payload) => this.webContents.sent.push({ channel, payload }),
      setWindowOpenHandler: (handler) => {
        this.openHandler = handler;
      },
      isDevToolsOpened: () => false,
      openDevTools: () => {},
      closeDevTools: () => {},
      capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }),
      executeJavaScript: async () => undefined,
    });
    this.contentView = {
      getBounds: () => ({ x: 0, y: 0, width: this.bounds.width, height: this.bounds.height }),
      setBorderRadius: (radius) => {
        this.borderRadius = radius;
      },
      setBackgroundColor: (color) => {
        this.contentBackgroundColor = color;
      },
    };
    electronState.windows.push(this);
  }

  async loadURL(url) {
    if (FakeBrowserWindow.loadGate) await FakeBrowserWindow.loadGate;
    this.loadedUrl = url;
    this.webContents.mainFrame.url = url;
    this.webContents.emit("did-finish-load");
  }

  async loadFile(file, options) {
    if (FakeBrowserWindow.loadGate) await FakeBrowserWindow.loadGate;
    this.loadedFile = { file, options };
    this.webContents.mainFrame.url = `file://${file}`;
    this.webContents.emit("did-finish-load");
    return undefined;
  }

  setMenu(menu) {
    this.menu = menu;
  }

  setBackgroundColor(color) {
    this.backgroundColor = color;
  }

  setVibrancy(material) {
    this.vibrancy = material;
  }

  setVisibleOnAllWorkspaces(value, options) {
    this.visibleOnAllWorkspaces = { value, options };
  }

  setMinimumSize(width, height) {
    this.minimumSize = { width, height };
  }

  setAlwaysOnTop(value) {
    this.alwaysOnTop = value;
  }

  setBounds(bounds) {
    this.setBoundsCalls = (this.setBoundsCalls ?? 0) + 1;
    this.bounds = { ...this.bounds, ...bounds };
  }

  getBounds() {
    return { ...this.bounds };
  }

  getNormalBounds() {
    return { ...this.bounds };
  }

  setSize(width, height) {
    this.bounds = { ...this.bounds, width, height };
  }

  setPosition(x, y) {
    this.bounds = { ...this.bounds, x, y };
  }

  setShape(rects) {
    this.shape = rects;
  }

  getNativeWindowHandle() {
    return Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
  }

  isDestroyed() {
    return this.dead;
  }

  isVisible() {
    return this.visible;
  }

  isMinimized() {
    return this.minimized;
  }

  isMaximized() {
    return this.maximized;
  }

  isFullScreen() {
    return this.fullScreen;
  }

  minimize() {
    this.minimized = true;
  }

  maximize() {
    this.maximized = true;
  }

  restore() {
    this.minimized = false;
  }

  setFullScreen(value) {
    this.fullScreen = value;
  }

  show() {
    this.visible = true;
    this.emit("show");
  }

  showInactive() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
    this.emit("hide");
  }

  focus() {
    this.focused = true;
  }

  moveTop() {}

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.emit("closed");
  }

  close() {
    let prevented = false;
    this.emit("close", {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) this.destroy();
  }
}

export const BrowserWindow = FakeBrowserWindow;

export const app = {
  getLocale: () => "en",
  getAppPath: () => process.env.PI_SURFACE_FIXTURE_APP_PATH ?? process.cwd(),
  getVersion: () => "0.0.0-fixture",
  getName: () => "PI Desktop",
  isPackaged: false,
  isReady: () => true,
  quit: () => {
    electronState.quitCalls += 1;
  },
  setBadgeCount: (count) => {
    electronState.badgeCount = count;
  },
  dock: { setIcon: () => {} },
  whenReady: async () => undefined,
};

export const screen = Object.assign(new EventEmitter(), {
  getDisplayMatching: () => display(1),
  getDisplayNearestPoint: () => display(1),
  getPrimaryDisplay: () => display(1),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
});

export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: "system",
};

export const Menu = {
  buildFromTemplate: (template) => ({ template }),
  setApplicationMenu: (menu) => {
    electronState.setApplicationMenuCalls += 1;
    electronState.applicationMenu = menu;
  },
};

export const nativeImage = {
  createFromPath: (path) => ({
    path,
    isEmpty: () => false,
    resize: () => ({ isEmpty: () => false, setTemplateImage: () => {} }),
    setTemplateImage: () => {},
  }),
  createFromBuffer: () => ({ isEmpty: () => false }),
  createFromDataURL: () => ({ isEmpty: () => false }),
  createEmpty: () => ({ isEmpty: () => true }),
};

export class Tray extends EventEmitter {
  constructor(icon) {
    super();
    this.icon = icon;
    this.dead = false;
    electronState.trays.push(this);
  }

  setToolTip() {}
  setContextMenu(menu) {
    this.contextMenu = menu;
  }
  isDestroyed() {
    return this.dead;
  }
  destroy() {
    this.dead = true;
  }
}

export const globalShortcut = {
  register: (accelerator) => {
    if (electronState.shortcuts.has(accelerator)) return false;
    electronState.shortcuts.set(accelerator, () => {});
    return true;
  },
  unregister: (accelerator) => {
    electronState.shortcuts.delete(accelerator);
  },
  isRegistered: (accelerator) => electronState.shortcuts.has(accelerator),
  unregisterAll: () => {
    electronState.shortcuts.clear();
  },
};

export const powerSaveBlocker = {
  start: (type) => {
    const id = electronState.powerBlockers.size + 1;
    electronState.powerBlockers.set(id, type);
    return id;
  },
  stop: (id) => {
    electronState.powerBlockers.delete(id);
  },
  isStarted: (id) => electronState.powerBlockers.has(id),
};

export const shell = {
  openExternal: async () => undefined,
};

export const clipboard = { writeText: () => {}, readText: () => "" };

export const dialog = {
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => {},
};

export const ipcMain = Object.assign(new EventEmitter(), {
  handle: () => {},
  removeHandler: () => {},
});

export const session = {
  defaultSession: { setPermissionRequestHandler: () => {} },
};

export const powerMonitor = new EventEmitter();
