import { IPC } from "@pi-desktop/shared";
import type { BrowserWindow } from "electron";
import type { IpcRegistrar } from "../ipc/types";
import { registerTerminalIpc } from "../ipc/terminal-ipc";
import type { WorkspaceTerminalRouter, TerminalRouterOptions } from "../terminal/workspace-terminal-router";
import { WorkspaceTerminalRegistry } from "../terminal/workspace-terminal-registry";
import type { DesktopHandoffAdmission } from "../runtime/handoff-admission";
import { getActiveRemoteHostsBoot } from "./remote-hosts";

const terminals = new WorkspaceTerminalRegistry();
export const getWorkspaceTerminalHandoffActivity = () => terminals.getHandoffActivity();
export const getWorkspaceTerminalHandoffOwner = () => terminals;
export const disposeWorkspaceTerminals = () => terminals.dispose();
export function registerWorkspaceTerminals(deps: {
  registrar: IpcRegistrar;
  getMainWindow(): BrowserWindow | null;
  getHost: TerminalRouterOptions["getHost"];
  currentWorkspacePath: TerminalRouterOptions["currentWorkspacePath"];
  handoffAdmission: Pick<DesktopHandoffAdmission, "isClosed">;
}) {
  let current: {id:number;router:WorkspaceTerminalRouter} | undefined;
  registerTerminalIpc({registrar:deps.registrar,router:()=>{
    const window=deps.getMainWindow();
    if (!window || window.isDestroyed()) throw Object.assign(new Error("Terminal window is unavailable"),{errorCode:"TERMINAL_HOST_OFFLINE"});
    if (current?.id === window.id) return current.router;
    const router=terminals.create({
      isAdmissionClosed:()=>deps.handoffAdmission.isClosed(),
      getHost:deps.getHost,currentWorkspacePath:deps.currentWorkspacePath,
      remoteClient:hostKey=>{
        const boot=getActiveRemoteHostsBoot();
        if (!boot) throw Object.assign(new Error("Remote Host is unavailable"),{errorCode:"TERMINAL_HOST_OFFLINE"});
        return boot.workspaceClient(hostKey);
      },
      emit:event=>{
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        window.webContents.send("data" in event ? IPC.event.terminalData : IPC.event.terminalExit,event);
      },
    });
    current={id:window.id,router};
    window.once("closed",()=>{
      if (current?.router === router) current=undefined;
      void terminals.retire(router);
    });
    return router;
  }});
}
