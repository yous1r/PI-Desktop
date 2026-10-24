/**
 * Work-panel terminal channels. A thin pass-through to the main-process
 * TerminalService and ShellRegistry: node-pty processes must never be spawned
 * from the renderer, and shell discovery stays a filesystem probe in main.
 *
 * Every channel asserts the main window as sender: the launcher and widget
 * windows share this preload, and PTY output is only ever delivered to the main
 * window, so a terminal opened from another surface would be unreachable.
 */
import { ErrorCodes, IPC } from "@pi-desktop/shared";

import type { IpcRegistrar } from "./types";
import type { ShellRegistry } from "../terminal/shell-registry";
import type { TerminalService } from "../terminal/terminal-service";

export type TerminalIpcDependencies = {
  registrar: IpcRegistrar;
  registry: ShellRegistry;
  service: TerminalService;
  /** The workspace cwd a new terminal opens in, when a project is active. */
  defaultCwd: () => string | undefined;
  /**
   * Rejects a cwd outside the workspace. Without it a renderer could park a
   * shell in any directory on the machine.
   */
  isAllowedCwd?: (cwd: string) => boolean;
};

function requiredText(input: unknown, field: string): string {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw Object.assign(new Error(`${field} required`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  return text;
}

function optionalText(input: unknown, field: string): string | undefined {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function requiredSize(input: unknown): { cols: number; rows: number } {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const cols = typeof source.cols === "number" ? source.cols : 80;
  const rows = typeof source.rows === "number" ? source.rows : 24;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) {
    throw Object.assign(new Error("cols and rows must be numbers >= 2"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  return { cols, rows };
}

export function registerTerminalIpc({
  registrar,
  registry,
  service,
  defaultCwd,
  isAllowedCwd,
}: TerminalIpcDependencies): void {
  const handle = registrar.handleWithEvent.bind(registrar);
  const fromMain = (event: Parameters<IpcRegistrar["assertMainWindowSender"]>[0]): void =>
    registrar.assertMainWindowSender(event);

  handle(IPC.invoke.terminalListShells, async (event, input: unknown) => {
    fromMain(event);
    const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return { shells: registry.listShells(source.refresh === true) };
  });

  handle(IPC.invoke.terminalCreate, async (event, input: unknown) => {
    fromMain(event);
    const shellId = requiredText(input, "shellId");
    const profile = registry.find(shellId);
    if (!profile) {
      throw Object.assign(new Error(`shell '${shellId}' is not available`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const requestedCwd = optionalText(input, "cwd");
    const cwd = requestedCwd ?? defaultCwd();
    if (requestedCwd && isAllowedCwd && !isAllowedCwd(requestedCwd)) {
      throw Object.assign(new Error("cwd is outside the workspace"), {
        errorCode: ErrorCodes.PERMISSION_REQUIRED,
      });
    }
    return service.create(profile, cwd, requiredSize(input));
  });

  handle(IPC.invoke.terminalWrite, async (event, input: unknown) => {
    fromMain(event);
    // `data` is keystrokes, so an empty string is legitimate (a modifier-only
    // press); only a non-string payload is an error.
    const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (typeof source.data !== "string") {
      throw Object.assign(new Error("data required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    service.write(requiredText(input, "terminalId"), source.data);
    return { ok: true };
  });

  handle(IPC.invoke.terminalResize, async (event, input: unknown) => {
    fromMain(event);
    const size = requiredSize(input);
    service.resize(requiredText(input, "terminalId"), size.cols, size.rows);
    return { ok: true };
  });

  handle(IPC.invoke.terminalClose, async (event, input: unknown) => {
    fromMain(event);
    service.close(requiredText(input, "terminalId"));
    return { ok: true };
  });

  handle(IPC.invoke.terminalGetBuffer, async (event, input: unknown) => {
    fromMain(event);
    const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const maxBytes =
      typeof source.maxBytes === "number" && Number.isFinite(source.maxBytes) && source.maxBytes >= 1
        ? Math.min(Math.floor(source.maxBytes), 256 * 1024)
        : undefined;
    return { text: service.getBuffer(requiredText(input, "terminalId"), maxBytes) };
  });
}
