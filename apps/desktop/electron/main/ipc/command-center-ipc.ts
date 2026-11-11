import { ErrorCodes } from "@pi-desktop/shared";
import {
  COMMAND_CENTER_IPC,
  type CommandCenterHostDescriptor,
  type CommandCenterMonitorPageRequest,
  type CommandCenterReceiptListRequest,
} from "../../preload/command-center-contract.js";
import type { IpcRegistrar } from "./types.js";

/**
 * Bridge from the renderer to already-connected remote Hosts.
 *
 * Main owns the RACP connection; the renderer only receives negotiated
 * capability descriptors and bounded read results. No channel accepts a
 * transport, token, principal or authorization scope from the renderer.
 */
export type CommandCenterIpcBootPort = {
  commandCenterHosts(): readonly CommandCenterHostDescriptor[];
  commandCenterMonitorPage(hostKey: string, request: CommandCenterMonitorPageRequest): Promise<unknown>;
  commandCenterPing(hostKey: string): Promise<unknown>;
  commandCenterWorkspaceList(hostKey: string): Promise<unknown>;
  commandCenterReceiptList(hostKey: string, request: CommandCenterReceiptListRequest): Promise<unknown>;
};

export type CommandCenterIpcDependencies = {
  registrar: IpcRegistrar;
  getBoot: () => CommandCenterIpcBootPort | null;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function hostKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    return invalid("invalid command-center host key");
  }
  return value;
}

/** `null` clears an explicit selection; anything else must be a valid key. */
function selectableHostKey(value: unknown): string | null {
  return value === null ? null : hostKey(value);
}

/**
 * Selected Host while it remains connected, else the first capable Host.
 * A closed Host therefore falls back without a second state store.
 */
function resolveObservationHost(
  boot: CommandCenterIpcBootPort,
  selectedHostKey: string | null,
): { host: CommandCenterHostDescriptor | null; selectedHostKey: string | null } {
  const hosts = boot.commandCenterHosts();
  if (selectedHostKey !== null) {
    const selected = hosts.find((host) => host.hostKey === selectedHostKey);
    if (selected !== undefined) return { host: selected, selectedHostKey };
    selectedHostKey = null;
  }
  return { host: hosts[0] ?? null, selectedHostKey };
}

function monitorPageRequest(value: unknown): CommandCenterMonitorPageRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("invalid monitor page request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "version" && key !== "token") || input.version !== 1) {
    return invalid("invalid monitor page request");
  }
  if (input.token === undefined) return { version: 1 };
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 512 || input.token.includes("\0")) {
    return invalid("invalid monitor page token");
  }
  return { version: 1, token: input.token };
}

function receiptListRequest(value: unknown): CommandCenterReceiptListRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("invalid receipt list request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "afterSequence" && key !== "limit")) {
    return invalid("invalid receipt list request");
  }
  if (!Number.isSafeInteger(input.afterSequence) || (input.afterSequence as number) < 0) {
    return invalid("invalid receipt cursor");
  }
  if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) {
    return invalid("invalid receipt limit");
  }
  return { afterSequence: input.afterSequence as number, limit: input.limit as number };
}

export function registerCommandCenterIpc({ registrar, getBoot }: CommandCenterIpcDependencies): void {
  // One explicit selection per registered bridge; absent means first capable.
  let selectedHostKey: string | null = null;
  const requireBoot = (): CommandCenterIpcBootPort => {
    const boot = getBoot();
    if (!boot) {
      throw Object.assign(new Error("remote host bridge is unavailable"), { errorCode: ErrorCodes.AGENT_UNAVAILABLE });
    }
    return boot;
  };

  registrar.handle(COMMAND_CENTER_IPC.capability, async (): Promise<readonly CommandCenterHostDescriptor[]> => {
    const boot = getBoot();
    if (!boot) return [];
    return boot.commandCenterHosts();
  });

  registrar.handle(COMMAND_CENTER_IPC.selection, async (rawHostKey: unknown): Promise<CommandCenterHostDescriptor | null> => {
    const requested = selectableHostKey(rawHostKey);
    const boot = requireBoot();
    if (requested !== null && !boot.commandCenterHosts().some((host) => host.hostKey === requested)) {
      throw Object.assign(new Error("unknown command-center Host"), { errorCode: ErrorCodes.NOT_FOUND });
    }
    selectedHostKey = requested;
    return resolveObservationHost(boot, selectedHostKey).host;
  });

  registrar.handle(COMMAND_CENTER_IPC.observationHost, async (): Promise<CommandCenterHostDescriptor | null> => {
    const boot = getBoot();
    if (!boot) return null;
    const resolved = resolveObservationHost(boot, selectedHostKey);
    selectedHostKey = resolved.selectedHostKey;
    return resolved.host;
  });

  registrar.handle(COMMAND_CENTER_IPC.monitorPage, async (rawHostKey: unknown, rawRequest: unknown): Promise<unknown> =>
    requireBoot().commandCenterMonitorPage(hostKey(rawHostKey), monitorPageRequest(rawRequest)));

  registrar.handle(COMMAND_CENTER_IPC.ping, async (rawHostKey: unknown): Promise<unknown> =>
    requireBoot().commandCenterPing(hostKey(rawHostKey)));

  registrar.handle(COMMAND_CENTER_IPC.workspaceList, async (rawHostKey: unknown): Promise<unknown> =>
    requireBoot().commandCenterWorkspaceList(hostKey(rawHostKey)));

  registrar.handle(COMMAND_CENTER_IPC.receiptList, async (rawHostKey: unknown, rawRequest: unknown): Promise<unknown> =>
    requireBoot().commandCenterReceiptList(hostKey(rawHostKey), receiptListRequest(rawRequest)));
}
