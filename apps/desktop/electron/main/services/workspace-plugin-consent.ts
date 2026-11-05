import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { IPC, type WorkspacePluginConsentRequest } from "@pi-desktop/shared";

type ConsentInput = { pluginId: string; pluginName: string; hostKey: string };
type Pending = {
  input: ConsentInput;
  request: WorkspacePluginConsentRequest;
  resolve(allowed: boolean): void;
  reject(error: unknown): void;
};
type Owner = {
  window: BrowserWindow;
  ready: boolean;
  pending: Pending[];
  active: Pending | null;
  detach(): void;
};

/** One visible approval at a time, owned by the main window and denied on teardown. */
export function createWorkspacePluginConsent(options: { getWindow(): BrowserWindow | null }) {
  let owner: Owner | null = null;
  let disposed = false;

  function dismiss(current: Owner, request: Pending) {
    if (!current.window.webContents.isDestroyed()) {
      try {
        current.window.webContents.send(IPC.event.pluginWorkspaceConsentDismiss, {
          requestId: request.request.requestId,
        });
      } catch (error) {
        console.error("Failed to dismiss workspace plugin consent", error);
      }
    }
  }

  function cancel(current: Owner) {
    current.ready = false;
    const requests = current.pending.splice(0);
    current.active = null;
    for (const request of requests) {
      try { dismiss(current, request); }
      finally { request.resolve(false); }
    }
  }

  function pump(current: Owner) {
    if (!current.ready || current.active || !current.pending.length) return;
    const next = current.pending[0];
    current.active = next;
    try {
      current.window.webContents.send(IPC.event.pluginWorkspaceConsentRequest, next.request);
    } catch (error) {
      current.pending.shift();
      current.active = null;
      next.reject(error);
      pump(current);
    }
  }

  function getOwner(): Owner | null {
    const window = options.getWindow();
    if (owner?.window !== window) {
      if (owner) { cancel(owner); owner.detach(); }
      owner = null;
    }
    if (disposed || !window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    if (owner) return owner;
    const contents = window.webContents;
    const current: Owner = { window, ready: false, pending: [], active: null, detach: () => {} };
    const unavailable = () => cancel(current);
    const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) unavailable();
    };
    const closed = () => { unavailable(); current.detach(); if (owner === current) owner = null; };
    contents.on("did-start-navigation", navigating);
    contents.on("render-process-gone", unavailable);
    contents.on("destroyed", closed);
    window.on("closed", closed);
    current.detach = () => {
      contents.removeListener("did-start-navigation", navigating);
      contents.removeListener("render-process-gone", unavailable);
      contents.removeListener("destroyed", closed);
      window.removeListener("closed", closed);
    };
    owner = current;
    return current;
  }

  return {
    request(input: ConsentInput): Promise<boolean> {
      const current = getOwner();
      if (!current || current.pending.length >= 32) return Promise.resolve(false);
      return new Promise((resolve, reject) => {
        current.pending.push({ input, resolve, reject, request: {
          requestId: randomUUID(), pluginName: input.pluginName, hostKey: input.hostKey,
        } });
        pump(current);
      });
    },
    markReady(senderId: number, ready: boolean): boolean {
      const current = getOwner();
      if (!current || current.window.webContents.id !== senderId) return false;
      if (!ready) cancel(current);
      else { current.ready = true; pump(current); }
      return true;
    },
    respond(senderId: number, requestId: string, allowed: boolean): boolean {
      const current = getOwner();
      const active = current?.active;
      if (!current || !active || current.window.webContents.id !== senderId || active.request.requestId !== requestId) return false;
      current.pending.shift();
      current.active = null;
      dismiss(current, active);
      active.resolve(allowed);
      pump(current);
      return true;
    },
    cancelPlugin(pluginId: string): void {
      if (!owner) return;
      const current = owner;
      for (const request of [...current.pending]) {
        if (request.input.pluginId !== pluginId) continue;
        current.pending.splice(current.pending.indexOf(request), 1);
        if (current.active === request) { current.active = null; dismiss(current, request); }
        request.resolve(false);
      }
      pump(current);
    },
    dispose(): void {
      disposed = true;
      if (owner) { cancel(owner); owner.detach(); owner = null; }
    },
  };
}
export type WorkspacePluginConsent = ReturnType<typeof createWorkspacePluginConsent>;
