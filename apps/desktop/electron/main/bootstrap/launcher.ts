import { app, BrowserWindow, globalShortcut, screen } from "electron";
import { join } from "node:path";
import { getModuleDirectory } from "../module-path";
import {
  APP_NAME,
  IPC,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  type KeybindingOverrides,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { WindowLifecycleState } from "./window";
import { suppressLinuxFramelessSystemMenu } from "../frameless-system-menu";
import type { SurfaceActivityOwner, SurfaceRetention } from "../surface-activity";

export type LauncherState = {
  creationPromise: Promise<BrowserWindow> | null;
  pluginLauncherAccelerator: string | null;
  toggleWindowAccelerator: string | null;
};

export type LauncherDependencies = {
  state: WindowLifecycleState;
  launcherState: LauncherState;
  surfaces: SurfaceActivityOwner;
  appState: { applicationBooted: boolean };
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  toggleMainWindow: () => void;
};

/**
 * Bindings the app currently spends on a process-wide accelerator, keyed by the
 * shortcut id that owns them. The plugin shortcut registry reads this, so a
 * plugin is refused an accelerator the app already holds and gets it back once
 * the user rebinds the app shortcut away.
 */
const hostGlobalBindings = new Map<string, string>();

/** Live view of the app's own global accelerators, for the plugin runtime. */
export function hostGlobalShortcutBindings(): string[] {
  return [...hostGlobalBindings.values()];
}

function recordHostGlobalBinding(id: string, binding: string | null): void {
  if (binding) hostGlobalBindings.set(id, binding);
  else hostGlobalBindings.delete(id);
}

export function createLauncher({
  state,
  launcherState,
  surfaces,
  appState,
  getHost,
  logger,
  safeOpenExternal,
  toggleMainWindow,
}: LauncherDependencies) {

  const PLUGIN_LAUNCHER_WIDTH = 620;
  const PLUGIN_LAUNCHER_HEIGHT = 440;

  /** Live process-wide registrations this launcher still holds. */
  let pluginLauncherShortcutSurface: SurfaceRetention | null = null;
  let toggleWindowShortcutSurface: SurfaceRetention | null = null;

  /**
   * Release a process-wide registration only with evidence that it is gone.
   * `globalShortcut.unregister` is synchronous, but `isRegistered` is the only
   * native confirmation. Without that platform API the call contract is the
   * best available evidence, so a missing probe is not treated as a leak.
   */
  function unregisterAccelerator(
    accelerator: string,
    surface: SurfaceRetention | null,
  ): void {
    globalShortcut.unregister(accelerator);
    let stillRegistered = false;
    try {
      stillRegistered =
        typeof globalShortcut.isRegistered === "function" &&
        globalShortcut.isRegistered(accelerator);
    } catch {
      stillRegistered = true;
    }
    if (stillRegistered) surfaces.retainUnobservable();
    else surface?.release();
  }

  /** Retain a registration; its probe is the cleanup evidence when available. */
  function retainAccelerator(kind: string, accelerator: string): SurfaceRetention {
    return typeof globalShortcut.isRegistered === "function"
      ? surfaces.retain(kind, () => globalShortcut.isRegistered(accelerator))
      : surfaces.retain(kind);
  }

  function pluginLauncherBounds() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    return {
      x: Math.round(x + (width - PLUGIN_LAUNCHER_WIDTH) / 2),
      y: Math.round(y + (height - PLUGIN_LAUNCHER_HEIGHT) / 2),
      width: PLUGIN_LAUNCHER_WIDTH,
      height: PLUGIN_LAUNCHER_HEIGHT,
    };
  }

  function createPluginLauncherWindow(): Promise<BrowserWindow> {
    // Admission and Host identity are checked before a live window is handed
    // out, so a closed admission never returns a surface to its caller.
    surfaces.begin("plugin-launcher.create").assertFresh();
    if (launcherState.creationPromise) return launcherState.creationPromise;
    if (state.pluginLauncherWindow && !state.pluginLauncherWindow.isDestroyed()) {
      return Promise.resolve(state.pluginLauncherWindow);
    }

    // Only a fresh creation claims the launcher slot and its generation.
    // Reusing the prewarmed launcher is not a creation, so its own live
    // occupant must never refuse the hand-out above.
    const scope = surfaces.begin("plugin-launcher.create", {
      create: "launcher-window",
    });

    const creation = (async () => {
      // Revalidate before the native constructor: no await runs here today, and
      // this keeps the creation guarded if that ever changes.
      scope.assertFresh();
      const window = new BrowserWindow({
        ...pluginLauncherBounds(),
        title: `${APP_NAME} Plugin Launcher`,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        autoHideMenuBar: true,
        ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: join(getModuleDirectory(import.meta.url), "../preload/index.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
        },
      });
      let surface: SurfaceRetention;
      try {
        surface = surfaces.attach("launcher-window", "plugin-launcher.window", () =>
          !window.isDestroyed(),
        );
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
      state.pluginLauncherWindow = window;
      suppressLinuxFramelessSystemMenu(window);

      if (process.platform === "darwin") {
        // Join every Space and float above this app's own fullscreen window, but
        // never let Electron transform the process type. Without
        // `skipTransformProcessType`, `visibleOnFullScreen` runs
        // TransformProcessType(kProcessTransformToUIElementApplication) on the
        // whole process, which removes PI-Desktop from the Dock and Cmd+Tab for
        // as long as this window exists — and the launcher is prewarmed during
        // boot, so that would apply to every session (ADR 0086).
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      }
      window.webContents.setWindowOpenHandler(({ url }) => {
        void safeOpenExternal(url).catch(() => undefined);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        const devOrigin = process.env.ELECTRON_RENDERER_URL;
        if (devOrigin && url.startsWith(devOrigin)) return;
        event.preventDefault();
      });
      window.on("blur", () => {
        if (!window.isDestroyed() && !window.webContents.isDevToolsOpened()) {
          window.hide();
        }
      });
      window.on("closed", () => {
        surface.release();
        if (state.pluginLauncherWindow === window) state.pluginLauncherWindow = null;
      });

      try {
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "plugin-launcher");
          // The initial load is part of the admitted creation: counted until it
          // actually settles, not until a caller stops waiting.
          await scope.track(() => window.loadURL(url.toString()));
        } else {
          await scope.track(() =>
            window.loadFile(
              join(getModuleDirectory(import.meta.url), "../renderer/index.html"),
              { query: { surface: "plugin-launcher" } },
            ),
          );
        }
        return window;
      } catch (error) {
        if (!window.isDestroyed()) {
          try {
            window.destroy();
          } catch {
            // The failed surface could not be torn down: keep it counted and
            // record that its native closure is not observable.
            surfaces.retainUnobservable();
          }
        }
        throw error;
      }
    })();

    launcherState.creationPromise = creation;
    void creation.then(
      () => {
        if (launcherState.creationPromise === creation) {
          launcherState.creationPromise = null;
        }
      },
      () => {
        if (launcherState.creationPromise === creation) {
          launcherState.creationPromise = null;
        }
      },
    );
    return creation;
  }

  function prewarmPluginLauncher(): void {
    // A warm-up during handoff or shutdown would create a surface the app is
    // about to drop. It is skipped silently instead of logging a refusal as a
    // warm-up failure: no surface was requested by the user.
    if (surfaces.isClosed()) return;
    void createPluginLauncherWindow().catch((error) => {
      logger.app("diagnostics", "warn", "plugin launcher warm-up failed", {
        data: String(error),
      });
    });
  }

  async function showPluginLauncher(): Promise<void> {
    if (!appState.applicationBooted) return;
    const scope = surfaces.begin("plugin-launcher.show");
    scope.assertFresh();
    const window = await createPluginLauncherWindow();
    // The creation resumed after an await: a closed admission, or a launcher
    // that was replaced meanwhile, must not be shown by this stale callback.
    scope.assertFresh();
    if (window.isDestroyed() || state.pluginLauncherWindow !== window) return;
    window.setBounds(pluginLauncherBounds(), false);
    window.show();
    // `show()` already activates and focuses a macOS panel. Avoid a second
    // native focus/activation and window-stack move there; each adds visible
    // compositor work when another app owns the foreground window. Windows and
    // Linux retain the explicit focus and move for their frameless utility
    // window.
    if (process.platform !== "darwin") {
      window.focus();
      window.moveTop();
    }
    window.webContents.send(IPC.event.pluginLauncherShown);
  }

  async function togglePluginLauncher(): Promise<void> {
    const window = state.pluginLauncherWindow;
    if (window && !window.isDestroyed() && window.isVisible()) {
      window.hide();
      return;
    }
    await showPluginLauncher();
  }

  function applyPluginLauncherShortcut(keybindings?: KeybindingOverrides) {
    const shortcut = KEYBOARD_SHORTCUTS.find(
      (candidate) => candidate.id === "openPluginLauncher",
    );
    if (!shortcut || !app.isReady()) return;
    // A fresh process-wide registration is a native effect the app is about to
    // lose track of during handoff or shutdown. The existing accelerator is
    // left untouched instead of being re-registered or silently replaced.
    if (surfaces.isClosed()) return;
    const platform: ShortcutPlatform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : "linux";
    const binding = resolveKeybinding(shortcut, keybindings, platform);
    const accelerator = keybindingToElectronAccelerator(binding, platform);
    state.pluginLauncherBinding = binding;
    recordHostGlobalBinding("openPluginLauncher", binding);

    if (process.platform === "win32" && getHost()?.isAvailable()) {
      void getHost()!
        .call("keyboard.setGlobalShortcut", { binding })
        .catch((error) =>
          logger.app("diagnostics", "warn", "Windows global shortcut mode update failed", {
            data: String(error),
          }),
        );
    }

    if (launcherState.pluginLauncherAccelerator && launcherState.pluginLauncherAccelerator !== accelerator) {
      unregisterAccelerator(launcherState.pluginLauncherAccelerator, pluginLauncherShortcutSurface);
      pluginLauncherShortcutSurface = null;
      launcherState.pluginLauncherAccelerator = null;
    }

    // Windows reserves Alt+Space for the active window system menu. The
    // host-core low-level hook owns this exact binding so it still works while
    // another application is focused; do not ask Electron to register it too.
    if (process.platform === "win32" && binding === "Alt+Space") return;
    if (!accelerator || accelerator === launcherState.pluginLauncherAccelerator) return;
    const registered = globalShortcut.register(accelerator, () => {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "plugin launcher shortcut failed", {
          data: String(error),
        }),
      );
    });
    if (registered) {
      launcherState.pluginLauncherAccelerator = accelerator;
      pluginLauncherShortcutSurface = retainAccelerator(
        "global-shortcut.plugin-launcher",
        accelerator,
      );
    } else {
      logger.app("diagnostics", "error", "plugin launcher shortcut unavailable", {
        data: { accelerator, platform: process.platform },
      });
    }
  }

  /**
   * Register the merged window toggle (D438, rebound by D439). The default
   * `Alt+Shift+W` runs the same toggle the menu item and the renderer run: it
   * hides the window the user is looking at, or brings a hidden/minimized-to-tray
   * window back into focus. The key is process-wide, so it deliberately avoids
   * `Mod+W` — macOS spends that chord on its own close-window command. The
   * retired `Mod+Shift+W` summon binding is not registered either.
   */
  function applyToggleWindowShortcut(keybindings?: KeybindingOverrides) {
    const shortcut = KEYBOARD_SHORTCUTS.find(
      (candidate) => candidate.id === "toggleWindow",
    );
    if (!shortcut || !app.isReady()) return;
    // Same rule as the launcher: no fresh process-wide registration while the
    // app is being handed off or shut down.
    if (surfaces.isClosed()) return;
    const platform: ShortcutPlatform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : "linux";
    const binding = resolveKeybinding(shortcut, keybindings, platform);
    const accelerator = keybindingToElectronAccelerator(binding, platform);
    recordHostGlobalBinding("toggleWindow", binding);

    if (launcherState.toggleWindowAccelerator && launcherState.toggleWindowAccelerator !== accelerator) {
      unregisterAccelerator(launcherState.toggleWindowAccelerator, toggleWindowShortcutSurface);
      toggleWindowShortcutSurface = null;
      launcherState.toggleWindowAccelerator = null;
    }

    if (!accelerator || accelerator === launcherState.toggleWindowAccelerator) return;
    const registered = globalShortcut.register(accelerator, () => {
      toggleMainWindow();
    });
    if (registered) {
      launcherState.toggleWindowAccelerator = accelerator;
      toggleWindowShortcutSurface = retainAccelerator(
        "global-shortcut.toggle-window",
        accelerator,
      );
    } else {
      logger.app("diagnostics", "warn", "window toggle shortcut unavailable", {
        data: { accelerator, platform: process.platform },
      });
    }
  }


  return {
    pluginLauncherBounds,
    createPluginLauncherWindow,
    prewarmPluginLauncher,
    showPluginLauncher,
    togglePluginLauncher,
    applyPluginLauncherShortcut,
    applyToggleWindowShortcut,
  };
}
