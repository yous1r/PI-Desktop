import type { RacpEventEnvelope } from "@pi-desktop/shared";
import type { RemoteHostClient } from "../remote/remote-host-connection.js";

const reads = ["session/attach", "session/history", "events/subscribe", "events/unsubscribe", "events/ack"] as const;
type ObservationMethod = typeof reads[number];

/** H5 supplies this from the authenticated owner/transport binding. A Ready
 * payload, PID, selected workspace or permission-mode preference cannot supply it. */
export type AuthenticatedHandoffConnection = {
  client: RemoteHostClient;
  identity: Readonly<{ profileId: string; ownerEpoch: string; protocolVersion: number }>;
  /** Original connection + authorization generation, including across awaits. */
  assertCurrent(): void;
  /** Original transport has closed, so RACP has released its subscriptions. */
  isClosed(): boolean;
};

/** Read-only Desktop port for OwnerHandoffAttachment. The caller retains socket
 * ownership; RACP retains reconnect policy and the server retains authorization.
 * No capability is advertised and no backend/renderer route is changed here. */
export function createDesktopHandoffAttachmentTransport(connection: AuthenticatedHandoffConnection) {
  const { client } = connection;
  const check = connection.assertCurrent.bind(connection);
  const isClosed = connection.isClosed.bind(connection);
  const reconnect = client.subscribeReconnect?.bind(client);
  const state = client.subscribeState?.bind(client);
  const closed = client.subscribeSubscriptionClosed?.bind(client);
  if (!reconnect || !state || !closed) throw new Error("HANDOFF_ATTACHMENT_LIFECYCLE_UNAVAILABLE");
  check();
  const identity = Object.freeze({ ...connection.identity });
  return {
    identity,
    assertCurrent: check,
    isClosed,
    async request<T = unknown>(method: ObservationMethod, params: unknown): Promise<T> {
      check();
      if (!reads.includes(method)) throw new Error("HANDOFF_ATTACHMENT_READ_ONLY");
      // Even an authenticated owner attaches as viewer: the default owner role
      // in AgentHost.attach resumes its paused queue and can dispatch a turn.
      if (method === "session/attach" && (!params || typeof params !== "object" ||
          !("role" in params) || params.role !== "viewer")) throw new Error("HANDOFF_ATTACHMENT_READ_ONLY");
      const result = await client.request<T>(method, params);
      check();
      return result;
    },
    subscribe(listener: (event: RacpEventEnvelope) => void): () => void {
      return client.subscribe(listener);
    },
    subscribeClosed(listener: (subscriptionId: string) => void): () => void {
      return closed(notice => listener(notice.subscriptionId));
    },
    subscribeUnavailable(listener: () => void): () => void {
      return state(value => { if (value !== "connected") listener(); });
    },
    subscribeReconnect(listener: () => Promise<void>): () => void {
      return reconnect(listener);
    },
  };
}
