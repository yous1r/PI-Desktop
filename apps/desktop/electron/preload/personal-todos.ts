import { contextBridge, ipcRenderer } from "electron";
// Keep this sandbox preload self-contained: shared runtime imports create CJS chunks.
// The channel whitelist is checked against Shared by the personal todo tests.

const invokes = new Set<string>([
  "pi-desktop/personalTodos/get", "pi-desktop/personalTodos/edit", "pi-desktop/personalTodos/flush",
  "pi-desktop/personalTodos/window", "pi-desktop/personalTodos/copy", "pi-desktop/personalTodos/quitReady",
]);
const events = new Set<string>(["pi-desktop/personalTodos/event/changed", "pi-desktop/personalTodos/event/prepareQuit"]);
contextBridge.exposeInMainWorld("piDesktop", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!invokes.has(channel)) throw new Error("Channel unavailable in personal todo window");
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!events.has(channel)) throw new Error("Channel unavailable in personal todo window");
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
  locale: process.argv.find((arg) => arg.startsWith("--pi-desktop-locale="))?.split("=")[1],
});
