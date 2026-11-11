import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Result } from "@pi-desktop/shared";
import { IPC, IPC_WHITELIST } from "@pi-desktop/shared/protocol";
import {
  COMMAND_CENTER_IPC,
  type CommandCenterHostDescriptor,
  type CommandCenterMonitorPageRequest,
  type CommandCenterPingReply,
  type CommandCenterReceiptListRequest,
} from "./command-center-contract.js";

const LOCALE_ARGUMENT_PREFIX = "--pi-desktop-locale=";

function readOsLocale(): string | undefined {
  return process.argv
    .find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX))
    ?.slice(LOCALE_ARGUMENT_PREFIX.length);
}

function assertChannel(channel: string) {
  if (!IPC_WHITELIST.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

/** Fixed command-center channels only; the renderer cannot name an arbitrary one. */
async function commandCenterInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as Result<T> | undefined;
  if (result === undefined || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error("command-center bridge returned an invalid reply");
  }
  if (!result.ok) {
    const error = new Error(result.error.message) as Error & { code?: string; details?: unknown };
    error.code = result.error.code;
    error.details = result.error.details;
    throw error;
  }
  return result.data;
}

const api = {
  invoke: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    assertChannel(channel);
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onLiveVoicePort: () => {
    const listener = (event: Electron.IpcRendererEvent, payload: unknown) => {
      const value = payload && typeof payload === "object" ? payload as { callId?: unknown; nonce?: unknown } : null;
      const port = event.ports[0];
      if (!port || typeof value?.callId !== "string" || typeof value.nonce !== "string") return;
      window.postMessage({ kind: "pi-desktop-live-voice-port", callId: value.callId, nonce: value.nonce }, "*", [port]);
    };
    ipcRenderer.on(IPC.event.liveVoicePort, listener);
    return () => ipcRenderer.removeListener(IPC.event.liveVoicePort, listener);
  },
  commandCenter: {
    hosts: () => commandCenterInvoke<readonly CommandCenterHostDescriptor[]>(COMMAND_CENTER_IPC.capability),
    monitorPage: (hostKey: string, request: CommandCenterMonitorPageRequest) =>
      commandCenterInvoke<unknown>(COMMAND_CENTER_IPC.monitorPage, hostKey, request),
    ping: (hostKey: string) => commandCenterInvoke<CommandCenterPingReply>(COMMAND_CENTER_IPC.ping, hostKey),
    workspaceList: (hostKey: string) => commandCenterInvoke<unknown>(COMMAND_CENTER_IPC.workspaceList, hostKey),
    receiptList: (hostKey: string, request: CommandCenterReceiptListRequest) =>
      commandCenterInvoke<unknown>(COMMAND_CENTER_IPC.receiptList, hostKey, request),
  },
  channels: IPC,
  // Synchronous platform info so the renderer can style window chrome
  // (traffic lights on macOS vs. controls overlay on Windows/Linux)
  // before first paint, without an IPC round-trip.
  platform: process.platform,
  // `app.getLocale()` is resolved in the main process and passed as a renderer
  // creation argument. This keeps the locale available before first paint
  // without importing Electron's main-only `app` module in the sandbox.
  locale: readOsLocale(),
  /** Resolve a real dropped File without exposing Node or Electron to the page. */
  getDroppedFilePath: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);

export type PiDesktopPreloadApi = typeof api;
