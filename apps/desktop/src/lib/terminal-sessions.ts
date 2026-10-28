/**
 * Renderer-side bookkeeping for work-panel PTYs that outlive their view.
 *
 * The shell itself lives in Electron main. This module only remembers which
 * terminal id belongs to which work-panel tab, so a tab switch, project
 * switch, or session switch can detach the xterm view without ending the
 * process, and a later mount can replay the scrollback and re-attach.
 *
 * It is deliberately free of React and of the work-panel store: both the
 * terminal component and `closeWorkPanelTab` need it, and importing a
 * component from a store slice (or the reverse) would couple two layers that
 * have no other reason to know each other.
 */
import { api } from "./api";

export type TerminalHandle = {
  terminalId: string;
  /** Live size, so a re-attach can restore the PTY to the new viewport. */
  cols: number;
  rows: number;
};

const terminalHandles = new Map<string, TerminalHandle>();

/** The live PTY for a tab, or `undefined` when it has none or already exited. */
export function terminalHandleFor(tabId: string): TerminalHandle | undefined {
  return terminalHandles.get(tabId);
}

/** Remember that `terminalId` now backs `tabId`. */
export function setTerminalHandle(tabId: string, handle: TerminalHandle): void {
  terminalHandles.set(tabId, handle);
}

/** Forget a tab's PTY without touching the process. */
export function forgetTerminalHandle(tabId: string): void {
  terminalHandles.delete(tabId);
}

/**
 * End the shell behind a closed tab.
 *
 * This is the only path that kills a PTY on the renderer's initiative: a plain
 * unmount detaches instead, which is what keeps a background command alive
 * across a tab or project switch. Safe to call for a tab that never had a
 * terminal.
 */
export function closeTerminalForTab(tabId: string): void {
  const handle = terminalHandles.get(tabId);
  terminalHandles.delete(tabId);
  if (!handle) return;
  void api.terminalClose(handle.terminalId).catch(() => undefined);
}
