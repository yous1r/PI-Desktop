import { IPC } from "@pi-desktop/shared";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcRegistrar } from "./types";
import type { WorkspacePluginConsent } from "../services/workspace-plugin-consent";

export function registerWorkspacePluginConsentIpc(
  registrar: IpcRegistrar,
  consent: WorkspacePluginConsent,
): void {
  const assertSender = (event: IpcMainInvokeEvent) => {
    registrar.assertMainWindowSender(event);
    if (event.senderFrame !== event.sender.mainFrame) {
      throw Object.assign(new Error("Workspace consent requires the main frame"), { errorCode: "PERMISSION_DENIED" });
    }
  };
  const invalid = () => Object.assign(new Error("Invalid workspace consent response"), { errorCode: "INVALID_ARGUMENT" });
  registrar.handleWithEvent(IPC.invoke.pluginWorkspaceConsentReady, async (event, input: unknown) => {
    assertSender(event);
    const ready = input && typeof input === "object" ? (input as Record<string, unknown>).ready : undefined;
    if (typeof ready !== "boolean") throw invalid();
    return { ready: consent.markReady(event.sender.id, ready) && ready };
  });
  registrar.handleWithEvent(IPC.invoke.pluginWorkspaceConsentRespond, async (event, input: unknown) => {
    assertSender(event);
    const value = input && typeof input === "object" ? input as Record<string, unknown> : null;
    if (!value || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 64 || typeof value.allowed !== "boolean") throw invalid();
    return { accepted: consent.respond(event.sender.id, value.requestId, value.allowed) };
  });
}
