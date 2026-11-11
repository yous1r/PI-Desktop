import { useEffect, useSyncExternalStore } from "react";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterMonitorSession,
  createCommandCenterObservationContext,
  invalidateCommandCenterObservationContext,
  type CommandCenterMonitorSession,
} from "@pi-desktop/command-center-client";
import {
  createCommandCenterSessionProvider,
  type CommandCenterDataProvider,
} from "./command-center-data";
import {
  commandCenterTransportFromWindow,
  type CommandCenterTransport,
} from "./command-center-transport";

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

/**
 * Build the live provider from the fixed renderer bridge. Only a connected Host
 * that negotiated `commandCenter` contributes; every failure path returns a
 * no-op cleanup so the fixture preview stays the default.
 */
export async function bootstrapCommandCenterFromTransport(
  transport: CommandCenterTransport,
): Promise<() => void> {
  let hosts: readonly { hostKey: string; hostId: string; expectedHostEpoch: string; commandCenter: boolean }[];
  try {
    hosts = await transport.hosts();
  } catch (error) {
    console.warn("Command-center capability read failed", error);
    return () => {};
  }
  const host = hosts.find((candidate) =>
    candidate.commandCenter === true && candidate.hostId.length > 0 && candidate.expectedHostEpoch.length > 0);
  if (host === undefined) return () => {};

  const context = createCommandCenterObservationContext();
  let session: CommandCenterMonitorSession | undefined;
  try {
    bindCommandCenterObservationOwner(context, {
      hostId: host.hostId,
      expectedHostEpoch: host.expectedHostEpoch,
    });
    session = createCommandCenterMonitorSession(context, {
      clock: { now: () => Date.now() },
      scheduler: {
        schedule(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      ping: () => transport.ping(host.hostKey),
      loadPage: async (token) => transport.monitorPage(
        host.hostKey,
        token === undefined ? { version: 1 } : { version: 1, token },
      ),
    });
  } catch (error) {
    invalidateCommandCenterObservationContext(context);
    console.warn("Command-center observation context rejected", error);
    return () => {};
  }
  if (session === undefined) return () => {};

  const provider = createCommandCenterSessionProvider({
    session,
    loadWorkspaces: async () => {
      const page = await transport.workspaceList(host.hostKey) as { workspaces?: unknown } | null;
      return page?.workspaces;
    },
    loadReceipts: async () => {
      const receipts: unknown[] = [];
      let afterSequence = 0;
      for (let page = 0; page < 2; page += 1) {
        const result = await transport.receiptList(host.hostKey, { afterSequence, limit: 100 }) as
          { receipts?: unknown; nextAfterSequence?: unknown } | null;
        if (Array.isArray(result?.receipts)) receipts.push(...result.receipts);
        const next = result?.nextAfterSequence;
        if (typeof next !== "number" || next <= afterSequence) break;
        afterSequence = next;
      }
      return receipts;
    },
  });
  const unregister = setCommandCenterLiveProvider(provider);
  session.connect();
  return () => {
    unregister();
    provider.dispose();
    session.dispose();
    invalidateCommandCenterObservationContext(context);
  };
}

/**
 * Mount-time bootstrap for the mounted route. No bridge means no effect; the
 * fixture preview and explicit offline status stay in place.
 */
export function useCommandCenterTransportBootstrap(): void {
  useEffect(() => {
    const transport = commandCenterTransportFromWindow();
    if (transport === undefined) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void bootstrapCommandCenterFromTransport(transport).then((dispose) => {
      if (disposed) dispose();
      else cleanup = dispose;
    }).catch((error: unknown) => {
      console.warn("Command-center live bootstrap failed", error);
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
}
