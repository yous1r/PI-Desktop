/** Renderer-side contract for the fixed command-center preload bridge. */

export type CommandCenterHostDescriptor = Readonly<{
  hostKey: string;
  label: string;
  hostId: string;
  expectedHostEpoch: string;
  commandCenter: true;
}>;

export type CommandCenterMonitorPageRequest = Readonly<{ version: 1; token?: string }>;
export type CommandCenterReceiptListRequest = Readonly<{ afterSequence: number; limit: number }>;
export type CommandCenterPingReply = Readonly<{ ok: true; serverTime: string }>;

/** Everything the renderer may ask of one already-connected Host. */
export type CommandCenterTransport = {
  hosts(): Promise<readonly CommandCenterHostDescriptor[]>;
  monitorPage(hostKey: string, request: CommandCenterMonitorPageRequest): Promise<unknown>;
  ping(hostKey: string): Promise<CommandCenterPingReply>;
  workspaceList(hostKey: string): Promise<unknown>;
  receiptList(hostKey: string, request: CommandCenterReceiptListRequest): Promise<unknown>;
};

function isMethod(value: unknown): value is (...args: unknown[]) => Promise<unknown> {
  return typeof value === "function";
}

/**
 * Read the preload bridge without widening `Window` or reaching into Electron
 * internals. Absent or incomplete bridges keep the fixture default.
 */
export function commandCenterTransportFromWindow(): CommandCenterTransport | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as unknown as { piDesktop?: { commandCenter?: unknown } }).piDesktop?.commandCenter;
  if (bridge === null || typeof bridge !== "object") return undefined;
  const candidate = bridge as Record<string, unknown>;
  if (!isMethod(candidate.hosts) || !isMethod(candidate.monitorPage) || !isMethod(candidate.ping) ||
      !isMethod(candidate.workspaceList) || !isMethod(candidate.receiptList)) {
    return undefined;
  }
  return bridge as CommandCenterTransport;
}
