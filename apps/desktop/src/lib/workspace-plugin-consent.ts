import { IPC, type WorkspacePluginConsentRequest } from "@pi-desktop/shared";

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  if (!window.piDesktop) throw new Error("piDesktop preload bridge unavailable");
  const result = await window.piDesktop.invoke<T>(channel, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export const workspacePluginConsent = {
  ready: (ready: boolean) => invoke<{ ready: boolean }>(IPC.invoke.pluginWorkspaceConsentReady, { ready }),
  respond: (requestId: string, allowed: boolean) => invoke<{ accepted: boolean }>(
    IPC.invoke.pluginWorkspaceConsentRespond, { requestId, allowed },
  ),
  onRequest(listener: (request: WorkspacePluginConsentRequest) => void) {
    if (!window.piDesktop) return () => {};
    return window.piDesktop.on(IPC.event.pluginWorkspaceConsentRequest, (payload) => {
      if (!payload || typeof payload !== "object") return;
      const value = payload as Record<string, unknown>;
      if (typeof value.requestId !== "string" || !value.requestId || typeof value.pluginName !== "string" || typeof value.hostKey !== "string") return;
      listener({ requestId: value.requestId, pluginName: value.pluginName, hostKey: value.hostKey });
    });
  },
  onDismiss(listener: (requestId: string) => void) {
    if (!window.piDesktop) return () => {};
    return window.piDesktop.on(IPC.event.pluginWorkspaceConsentDismiss, (payload) => {
      if (!payload || typeof payload !== "object") return;
      const requestId = (payload as Record<string, unknown>).requestId;
      if (typeof requestId === "string") listener(requestId);
    });
  },
};
