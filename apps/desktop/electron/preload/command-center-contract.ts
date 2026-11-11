/**
 * Fixed IPC contract for the command-center renderer bridge.
 *
 * These channels are dedicated (not routed through the generic `invoke`
 * whitelist), carry no transport object, and are registered by Electron main
 * only when the app bootstrap provides the remote-host bridge. The renderer
 * never gets a RACP client or connection token.
 */
export const COMMAND_CENTER_IPC = Object.freeze({
  capability: "pi-desktop/command-center/capability",
  selection: "pi-desktop/command-center/selection",
  observationHost: "pi-desktop/command-center/observationHost",
  monitorPage: "pi-desktop/command-center/monitorPage",
  ping: "pi-desktop/command-center/ping",
  workspaceList: "pi-desktop/command-center/workspaceList",
  receiptList: "pi-desktop/command-center/receiptList",
});

export type CommandCenterHostDescriptor = Readonly<{
  hostKey: string;
  label: string;
  hostId: string;
  expectedHostEpoch: string;
  commandCenter: true;
}>;

export type CommandCenterMonitorPageRequest = Readonly<{
  version: 1;
  token?: string;
}>;

export type CommandCenterReceiptListRequest = Readonly<{
  afterSequence: number;
  limit: number;
}>;

export type CommandCenterPingReply = Readonly<{ ok: true; serverTime: string }>;

export type CommandCenterPreloadApi = {
  /** Connected Hosts that negotiated the optional commandCenter capability. */
  hosts(): Promise<readonly CommandCenterHostDescriptor[]>;
  /** Select the observed Host; `null` restores the first-capable-host default. */
  selectHost(hostKey: string | null): Promise<CommandCenterHostDescriptor | null>;
  /** Selected Host while it stays connected, else the first capable Host. */
  observationHost(): Promise<CommandCenterHostDescriptor | null>;
  /** Bounded monitor page; omit `token` for the current first page. */
  monitorPage(hostKey: string, request: CommandCenterMonitorPageRequest): Promise<unknown>;
  /** Existing authenticated connection ping, used only for observation freshness. */
  ping(hostKey: string): Promise<CommandCenterPingReply>;
  /** Existing read-only workspace list. */
  workspaceList(hostKey: string): Promise<unknown>;
  /** Existing bounded receipt list. */
  receiptList(hostKey: string, request: CommandCenterReceiptListRequest): Promise<unknown>;
};
