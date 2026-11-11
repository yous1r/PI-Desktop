import { useSyncExternalStore } from "react";
import type { CommandCenterMonitorSession } from "@pi-desktop/command-center-client";
import {
  createCommandCenterSessionProvider,
  type CommandCenterDataProvider,
} from "./command-center-data";

/**
 * Desktop command-center live-provider bootstrap.
 *
 * The renderer owns no RACP transport. A trusted adapter that already holds an
 * authenticated observation scope registers a live provider here after the
 * Host handshake advertises the optional `commandCenter` capability; the
 * mounted route subscribes and uses it. Without such a connection the registry
 * stays empty and the route keeps its deterministic fixture preview, with the
 * Host status explicitly offline.
 *
 * This module adds no capability advertisement, IPC channel or RACP operation.
 */

/** RACP server capabilities subset the command-center bootstrap needs. */
export type CommandCenterBootstrapCapabilities = Readonly<{
  readonly commandCenter?: boolean;
}>;

export type CommandCenterLiveConnectionPorts = {
  /** Server capabilities from the authenticated RACP initialize result. */
  readonly capabilities?: CommandCenterBootstrapCapabilities;
  /** Client monitor session over the observation context, reader and health. */
  readonly session: CommandCenterMonitorSession;
  readonly loadWorkspaces: () => Promise<unknown>;
  readonly loadReceipts: () => Promise<unknown>;
};

/**
 * Build a live provider only when the peer advertises `commandCenter === true`.
 * An absent/false capability returns `undefined`, leaving the fixture default.
 */
export function createCommandCenterLiveProvider(
  connection: CommandCenterLiveConnectionPorts | null | undefined,
): CommandCenterDataProvider | undefined {
  if (connection === null || connection === undefined) return undefined;
  if (connection.capabilities?.commandCenter !== true) return undefined;
  return createCommandCenterSessionProvider({
    session: connection.session,
    loadWorkspaces: connection.loadWorkspaces,
    loadReceipts: connection.loadReceipts,
  });
}

let liveProvider: CommandCenterDataProvider | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not prevent the bootstrap from publishing.
    }
  }
}

/** Register the connection-owned provider; returns an idempotent cleanup. */
export function setCommandCenterLiveProvider(provider: CommandCenterDataProvider | undefined): () => void {
  liveProvider = provider;
  notify();
  return () => {
    if (liveProvider === provider) {
      liveProvider = undefined;
      notify();
    }
  };
}

export function getCommandCenterLiveProvider(): CommandCenterDataProvider | undefined {
  return liveProvider;
}

export function subscribeCommandCenterLiveProvider(listener: () => void): () => void {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * One-call app-bootstrap entry: build and register the live provider, or a
 * no-op cleanup when the connection does not advertise the capability. The
 * returned cleanup unregisters and disposes the connection-owned provider.
 */
export function bootstrapCommandCenterLiveProvider(
  connection: CommandCenterLiveConnectionPorts | null | undefined,
): () => void {
  const provider = createCommandCenterLiveProvider(connection);
  if (provider === undefined) return () => {};
  const unregister = setCommandCenterLiveProvider(provider);
  return () => {
    unregister();
    provider.dispose();
  };
}

/** App-shell selector: empty registry means "use the fixture default". */
export function useCommandCenterLiveProvider(): CommandCenterDataProvider | undefined {
  return useSyncExternalStore(
    subscribeCommandCenterLiveProvider,
    getCommandCenterLiveProvider,
    getCommandCenterLiveProvider,
  );
}
