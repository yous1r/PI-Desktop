import type { TerminalTargetContext } from "@pi-desktop/shared";

import { api } from "./api";

/**
 * Renderer-side bookkeeping for terminals that outlive their view.
 *
 * The shell itself lives in Electron main — locally in a PTY, remotely on the
 * paired `pi-host`. This module only remembers which `terminalId` belongs to
 * which work-panel tab, so a tab switch, a project switch, or a session switch
 * can detach the xterm view without ending the process, and a later mount
 * replays the scrollback and re-attaches.
 *
 * The creation-time target is kept with the handle: re-attaching must address
 * the workspace the terminal was created for, not whatever workspace happens to
 * be active when the user switches back.
 *
 * It is deliberately free of React and of the work-panel store: the terminal
 * component and `closeWorkPanelTab` both need it, and importing one from the
 * other would couple two layers that have no other reason to know each other.
 */
export type TerminalHandle = {
  terminalId: string;
  /** Context captured at creation; every later action addresses the terminal id. */
  target: TerminalTargetContext;
  /** Live size, so a re-attach can restore the viewport's column count. */
  cols: number;
  rows: number;
};

const terminalHandles = new Map<string, TerminalHandle>();

/** The live terminal for a tab, or `undefined` when it has none or exited. */
export function terminalHandleFor(tabId: string): TerminalHandle | undefined {
  return terminalHandles.get(tabId);
}

/** Remember that `terminalId` now backs `tabId`. */
export function setTerminalHandle(tabId: string, handle: TerminalHandle): void {
  terminalHandles.set(tabId, handle);
}

/** Forget a tab's terminal without touching the process. */
export function forgetTerminalHandle(tabId: string): void {
  terminalHandles.delete(tabId);
}

/** Tab ids that currently own a terminal, in insertion order. */
export function terminalTabIds(): string[] {
  return [...terminalHandles.keys()];
}

/**
 * End the shell behind a closed tab.
 *
 * This is the only path that kills a terminal on the renderer's initiative: a
 * plain unmount detaches instead, which is what keeps a background command
 * alive across a tab, project, or session switch. Safe to call for a tab that
 * never had a terminal.
 */
export function closeTerminalForTab(tabId: string): void {
  const handle = terminalHandles.get(tabId);
  terminalHandles.delete(tabId);
  if (!handle) return;
  void api.terminalClose(handle.terminalId).catch(() => undefined);
}

/**
 * End every shell bound to `sessionId`.
 *
 * Sweep by creation-time session ownership as well as by visible tab id, so
 * deleting a session also closes its detached/background terminals.
 */
export function closeTerminalForSession(sessionId: string): void {
  for (const [tabId, handle] of [...terminalHandles]) {
    if (handle.target.sessionId === sessionId) closeTerminalForTab(tabId);
  }
}

/** End every shell among `tabIds`, for close-others / close-all. */
export function closeTerminalForTabs(tabIds: Iterable<string>): void {
  for (const tabId of [...tabIds]) closeTerminalForTab(tabId);
}

/** Test/teardown seam: drop every handle without sending a close request. */
export function forgetAllTerminalHandles(): void {
  terminalHandles.clear();
}
