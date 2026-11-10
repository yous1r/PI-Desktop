import { app, BrowserWindow, screen, type IpcMainInvokeEvent } from "electron";
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { IPC, type PersonalTodoView } from "@pi-desktop/shared";
import { getModuleDirectory } from "../module-path";
import { suppressLinuxFramelessSystemMenu } from "../frameless-system-menu";
import type { TodoActivity } from "./activity";
import { clampTodoBounds, dockTodoBounds, parseTodoPreferences, TODO_DEFAULT_SIZE, type TodoBounds, type TodoPreferences } from "./geometry";
import { todoError } from "./validation";

export function createTodoWindow(input: {
  dataDir: string;
  getMainWindow(): BrowserWindow | null;
  getView(): PersonalTodoView;
  onWindow(value: Partial<Pick<PersonalTodoView, "visible" | "alwaysOnTop" | "collapsed">>): void;
  flush(): Promise<unknown>;
  activity: TodoActivity;
  log(message: string, error: unknown): void;
}) {
  let window: BrowserWindow | null = null;
  let creation: Promise<BrowserWindow> | null = null;
  let disposed = false;
  let ready = false;
  let positionTimer: ReturnType<typeof setTimeout> | null = null;
  let collapsed = true;
  let placement: { requested: TodoBounds; actual: TodoBounds } | null = null;
  let quitRequest: { id: string; resolve(): void; reject(error: Error): void } | null = null;
  let closeAllowed = false;
  const statePath = join(input.dataDir, "personal-todo-window.json");
  let preferences: TodoPreferences = { alwaysOnTop: true };
  try { preferences = parseTodoPreferences(readFileSync(statePath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") input.log("personal todo placement could not be read", error);
  }
  input.onWindow({ alwaysOnTop: preferences.alwaysOnTop });
  // Native surfaces, listeners and timers stay counted until they are actually
  // released. Native/compositor ownership is never certified by these counts.
  const activity = input.activity;
  const countedWindows = new WeakSet<BrowserWindow>();
  let countedListeners = 0;
  function countWindow(current: BrowserWindow) {
    if (countedWindows.has(current)) return;
    countedWindows.add(current); activity.retain();
  }
  function releaseWindow(current: BrowserWindow) {
    if (!countedWindows.has(current)) return;
    countedWindows.delete(current); activity.letGo();
  }
  function countDisplays() { countedListeners += 2; activity.retain(); activity.retain(); }
  function releaseDisplays() {
    while (countedListeners > 0) { countedListeners -= 1; activity.letGo(); }
  }

  function persist() {
    mkdirSync(input.dataDir, { recursive: true });
    const temp = `${statePath}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(preferences)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, statePath);
  }
  function saveBounds() {
    if (!window || window.isDestroyed() || collapsed) return;
    preferences.bounds = readBounds(window);
    try { persist(); } catch (error) { input.log("personal todo placement could not be saved", error); }
  }
  function clearBoundsTimer() {
    if (!positionTimer) return;
    clearTimeout(positionTimer); positionTimer = null; activity.letGo();
  }
  function scheduleBounds() {
    clearBoundsTimer();
    positionTimer = setTimeout(() => {
      positionTimer = null;
      activity.letGo();
      saveBounds();
    }, 400);
    activity.retain();
  }
  function readBounds(current: BrowserWindow): TodoBounds {
    const actual = current.getBounds();
    if (!placement) return actual;
    const logical = { ...actual };
    for (const key of ["x", "y", "width", "height"] as const) {
      if (actual[key] === placement.actual[key]) logical[key] = placement.requested[key];
    }
    return logical;
  }
  function applyBounds(current: BrowserWindow, next: TodoBounds) {
    const bounds = readBounds(current);
    // Windows may round native bounds by a DIP. Never feed unchanged bounds
    // back into setBounds on each open: the rounding otherwise accumulates.
    if (bounds.x !== next.x || bounds.y !== next.y || bounds.width !== next.width || bounds.height !== next.height) {
      current.setBounds(next);
      placement = { requested: { ...next }, actual: current.getBounds() };
    }
  }
  function rendererUrl(): URL {
    const url = process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL)
      : pathToFileURL(join(getModuleDirectory(import.meta.url), "../renderer/index.html"));
    url.searchParams.set("surface", "personal-todos");
    return url;
  }
  function owns(event: IpcMainInvokeEvent): boolean {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === rendererUrl().href);
  }
  function publish(view: PersonalTodoView) {
    if (window && !window.isDestroyed() && ready) window.webContents.send(IPC.event.personalTodosChanged, view);
  }
  async function ensureWindow(): Promise<BrowserWindow> {
    if (disposed) throw todoError("HOST_UNAVAILABLE", "Personal todo window is closed");
    // A fresh native surface is created only while admission is open.
    activity.assertOpen();
    if (creation) return creation;
    if (window && !window.isDestroyed()) return window;
    const operation = activity.track(async () => {
      const mainBounds = input.getMainWindow()?.getBounds();
      const work = screen.getDisplayMatching(preferences.bounds ?? mainBounds ?? screen.getPrimaryDisplay().workArea).workArea;
      const initial = clampTodoBounds(preferences.bounds ?? {
        x: (mainBounds ? mainBounds.x + mainBounds.width : work.x + work.width) - 380,
        y: (mainBounds?.y ?? work.y) + 60, ...TODO_DEFAULT_SIZE,
      }, work);
      preferences.bounds = initial;
      collapsed = true;
      const compact = dockTodoBounds(initial, work);
      const created = new BrowserWindow({
        ...compact, minWidth: 1, minHeight: 1,
        title: "PI-Desktop Todos", show: false, frame: false, resizable: false,
        transparent: true, hasShadow: false,
        maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true,
        alwaysOnTop: preferences.alwaysOnTop, backgroundColor: "#00000000", autoHideMenuBar: true,
        ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: join(getModuleDirectory(import.meta.url), "../preload/personal-todos.cjs"),
          contextIsolation: true, sandbox: true, nodeIntegration: false,
          additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
        },
      });
      window = created;
      countWindow(created);
      placement = { requested: compact, actual: created.getBounds() };
      created.setMenu(null);
      suppressLinuxFramelessSystemMenu(created);
      if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true, skipTransformProcessType: true,
      });
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", (event, url) => {
        if (url !== rendererUrl().href) event.preventDefault();
      });
      created.webContents.on("will-redirect", (event) => event.preventDefault());
      created.webContents.on("did-start-loading", () => { ready = false; });
      created.webContents.on("did-finish-load", () => { ready = true; publish(input.getView()); });
      created.webContents.on("render-process-gone", () => {
        ready = false;
        quitRequest?.reject(todoError("HOST_UNAVAILABLE", "Personal todo editor stopped"));
        quitRequest = null;
        input.log("personal todo editor stopped; draft retained by Main", "renderer-gone");
      });
      created.on("blur", () => { void input.flush().catch(() => undefined); });
      created.on("close", (event) => {
        if (disposed || closeAllowed) return;
        event.preventDefault();
        collapse();
      });
      created.on("move", scheduleBounds);
      created.on("resize", scheduleBounds);
      created.on("closed", () => {
        if (window === created) window = null;
        ready = false;
        releaseWindow(created);
      });
      try {
        await created.loadURL(rendererUrl().href);
        if (disposed) { created.destroy(); throw todoError("HOST_UNAVAILABLE", "Personal todo window is closed"); }
        // A gate that closed during the load never leaves a surface behind: the
        // native window is destroyed before the caller is refused.
        if (activity.isClosed()) { created.destroy(); activity.assertOpen(); }
        return created;
      } catch (error) {
        if (!created.isDestroyed()) created.destroy();
        releaseWindow(created);
        throw error;
      }
    });
    creation = operation;
    try { return await operation; } finally { if (creation === operation) creation = null; }
  }
  async function show(focus = true) {
    const current = await ensureWindow();
    if (current.webContents.isCrashed()) await current.loadURL(rendererUrl().href);
    if (disposed || current.isDestroyed()) throw todoError("HOST_UNAVAILABLE", "Personal todo window is closed");
    // A closed gate never displays a fresh surface.
    activity.assertOpen();
    if (focus && collapsed) {
      const bounds = preferences.bounds ?? current.getBounds();
      const work = screen.getDisplayMatching(bounds).workArea;
      current.setResizable(true);
      current.setMinimumSize(Math.min(300, work.width), Math.min(280, work.height));
      applyBounds(current, clampTodoBounds(bounds, work));
      collapsed = false;
    }
    if (focus) { current.show(); current.focus(); } else current.showInactive();
    input.onWindow({ visible: true, collapsed });
    publish(input.getView());
  }
  function collapse() {
    if (!window || window.isDestroyed() || collapsed) return;
    saveBounds();
    const bounds = readBounds(window);
    collapsed = true;
    window.setMinimumSize(1, 1);
    window.setResizable(false);
    applyBounds(window, dockTodoBounds(bounds, screen.getDisplayMatching(bounds).workArea));
    input.onWindow({ visible: true, collapsed: true });
    void input.flush().catch(() => undefined);
  }
  function displayChanged() {
    if (!window || window.isDestroyed()) return;
    const bounds = readBounds(window);
    const work = screen.getDisplayMatching(bounds).workArea;
    if (collapsed) {
      applyBounds(window, dockTodoBounds(bounds, work));
    } else {
      window.setMinimumSize(Math.min(300, work.width), Math.min(280, work.height));
      applyBounds(window, clampTodoBounds(bounds, work));
    }
  }
  // Installed after app ready, when the screen module is available.
  let observingDisplays = false;
  return {
    owns, publish, collapse,
    async show(focus = true) {
      // The entry itself is gated: a closed admission installs no listener either.
      activity.assertOpen();
      if (!observingDisplays) {
        observingDisplays = true;
        screen.on("display-removed", displayChanged);
        screen.on("display-metrics-changed", displayChanged);
        countDisplays();
      }
      await show(focus);
    },
    setPinned(value: boolean) {
      const previous = preferences.alwaysOnTop;
      preferences.alwaysOnTop = value;
      try { persist(); } catch (error) { preferences.alwaysOnTop = previous; throw error; }
      window?.setAlwaysOnTop(value, "floating");
      input.onWindow({ alwaysOnTop: value });
    },
    async drainEditor() {
      if (!window || window.isDestroyed() || !ready) return;
      const current = window;
      // Quit drains before admission is released, so this wait is never gated.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      activity.hold();
      try {
        await new Promise<void>((resolve, reject) => {
          quitRequest = { id: randomUUID(), resolve, reject };
          timeout = setTimeout(() => reject(todoError("TIMEOUT", "Personal todo editor did not settle")), 3000);
          current.webContents.send(IPC.event.personalTodosPrepareQuit, { requestId: quitRequest.id });
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        activity.release();
        quitRequest = null;
      }
    },
    resumeEditor() {
      closeAllowed = false;
      if (window && !window.isDestroyed() && ready) {
        window.webContents.send(IPC.event.personalTodosPrepareQuit, { requestId: null });
      }
    },
    allowClose() { closeAllowed = true; },
    editorReady(requestId: string) {
      if (quitRequest?.id !== requestId) throw todoError("CONFLICT", "Personal todo quit request expired");
      quitRequest.resolve();
    },
    dispose() {
      disposed = true;
      clearBoundsTimer();
      if (observingDisplays) {
        screen.removeListener("display-removed", displayChanged);
        screen.removeListener("display-metrics-changed", displayChanged);
        releaseDisplays();
      }
      saveBounds();
      quitRequest?.reject(todoError("HOST_UNAVAILABLE", "Personal todo window is closed"));
      quitRequest = null;
      const closing = window;
      window = null;
      ready = false;
      if (closing && !closing.isDestroyed()) closing.destroy();
      if (closing) {
        // Only an observed destruction releases the surface. When destroy() did
        // not take effect the native window may still exist, so its count stays
        // held and the unconfirmed surface is reported as uncertainty: this
        // owner never claims OS/compositor release it cannot observe.
        if (closing.isDestroyed()) releaseWindow(closing);
        else activity.unsettled();
      }
    },
  };
}
export type TodoWindow = ReturnType<typeof createTodoWindow>;
