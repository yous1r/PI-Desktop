import { IPC } from "@pi-desktop/shared";

/**
 * The work-panel terminal's IPC channels.
 *
 * `packages/shared/src/protocol.ts` owns these names (`IPC.invoke.terminal*` /
 * `IPC.event.terminal*`, all in `IPC_WHITELIST`); this module is only the one
 * place the renderer reads them, so no call site carries a channel literal of
 * its own and a renamed protocol entry cannot leave a stale copy behind.
 */
export const TERMINAL_IPC = {
  listShells: IPC.invoke.terminalListShells,
  create: IPC.invoke.terminalCreate,
  write: IPC.invoke.terminalWrite,
  resize: IPC.invoke.terminalResize,
  close: IPC.invoke.terminalClose,
  replay: IPC.invoke.terminalReplay,
  getBuffer: IPC.invoke.terminalGetBuffer,
  dataEvent: IPC.event.terminalData,
  exitEvent: IPC.event.terminalExit,
} as const;
