import { IPC } from "@pi-desktop/shared";
import type { BrowserWindow } from "electron";
import type { IpcRegistrar } from "../ipc/types";
import { registerTerminalIpc } from "../ipc/terminal-ipc";
import { WorkspaceTerminalRouter, type TerminalRouterOptions } from "../terminal/workspace-terminal-router";
import { getActiveRemoteHostsBoot } from "./remote-hosts";

const routers = new Set<WorkspaceTerminalRouter>();
export async function disposeWorkspaceTerminals(): Promise<void> {
  await Promise.allSettled([...routers].map(router=>router.dispose()));
  routers.clear();
}
export function registerWorkspaceTerminals(deps: {
  registrar: IpcRegistrar;
  getMainWindow(): BrowserWindow | null;
  getHost: TerminalRouterOptions["getHost"];
  currentWorkspacePath: TerminalRouterOptions["currentWorkspacePath"];
}) {
  let current: {id:number;router:WorkspaceTerminalRouter} | undefined;
  registerTerminalIpc({registrar:deps.registrar,router:()=>{
    const window=deps.getMainWindow();
    if (!window || window.isDestroyed()) throw Object.assign(new Error("Terminal window is unavailable"),{errorCode:"TERMINAL_HOST_OFFLINE"});
    if (current?.id === window.id) return current.router;
    const router=new WorkspaceTerminalRouter({
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
    current={id:window.id,router};routers.add(router);
    window.once("closed",()=>{void router.dispose().finally(()=>routers.delete(router));});
    return router;
  }});
}
