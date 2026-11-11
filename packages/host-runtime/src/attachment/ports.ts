import type { OwnerHandoffReady, RacpCursor, RacpEventEnvelope, RacpSessionSnapshot } from "@pi-desktop/shared";

/** These are observation operations only. In particular attach always uses viewer. */
export type OwnerAttachmentReadMethod = "session/attach" | "session/history" | "events/subscribe" | "events/unsubscribe" | "events/ack";
export type OwnerAttachmentIdentity = Readonly<{ profileId: string; ownerEpoch: string; protocolVersion: number }>;
export type OwnerAttachmentTarget = Readonly<{ transferId: string; sourceEpoch: string; profileId: string }>;
export type OwnerAttachmentState = "detached" | "reconciling" | "waiting" | "attached" | "resync-required" | "error" | "disposed";
export type OwnerAttachmentTransport = {
  /** Supplied by authenticated transport binding, never copied from Ready. */
  readonly identity: OwnerAttachmentIdentity;
  /** Captures the original connection and authorization generation. */
  assertCurrent(): void;
  /** True only after the captured connection closed and RACP released its resources. */
  isClosed(): boolean;
  request<T = unknown>(method: OwnerAttachmentReadMethod, params: unknown): Promise<T>;
  subscribe(listener: (event: RacpEventEnvelope) => void): () => void;
  subscribeClosed(listener: (subscriptionId: string) => void): () => void;
  subscribeUnavailable(listener: () => void): () => void;
  /** Uses the existing RACP reconnect loop; this adapter never opens a socket. */
  subscribeReconnect(listener: () => Promise<void>): () => void;
};
export type OwnerAttachmentView = Readonly<{ generation: number; ready: Readonly<OwnerHandoffReady>; sessionId: string }>;
export type OwnerAttachmentProjection = {
  view: OwnerAttachmentView;
  snapshot: RacpSessionSnapshot;
  /** Ordered durable replay after snapshot.cursor, committed with the snapshot. */
  events: readonly RacpEventEnvelope[];
  /** Host-scope changes since subscription opened; not a host-list snapshot. */
  hostEvents: readonly RacpEventEnvelope[];
  cursor: RacpCursor;
};
export type OwnerAttachmentOptions = {
  target: OwnerAttachmentTarget;
  /** Release the retained original observation and await pending unsubscribe. No execution shutdown. */
  detachOriginal(): Promise<void>;
  /** Read the same durable transfer ID with a finite deadline and abort support.
   * Missing Ready is never synthesized. */
  readStatus(target: OwnerAttachmentTarget, signal: AbortSignal): Promise<{ response: unknown; ready?: unknown }>;
  /** Resolve an already authenticated connection. No launch, claim, pairing or role elevation. */
  resolveTransport(ready: Readonly<OwnerHandoffReady>, signal: AbortSignal): Promise<OwnerAttachmentTransport>;
  /** Presentation callbacks apply synchronously to the supplied view generation. */
  onSnapshot(projection: OwnerAttachmentProjection): void;
  onEvent(view: OwnerAttachmentView, event: RacpEventEnvelope): void;
  onState(state: OwnerAttachmentState): void;
  /** Includes stale cleanup failures; do not suppress them because a view was replaced. */
  onError(error: unknown): void;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
};
export const attachmentError = (code: string) => Object.assign(new Error(code), { code });
export function validCursor(value: unknown): value is RacpCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<RacpCursor>;
  return typeof cursor.epoch === "string" && cursor.epoch.length > 0 && cursor.epoch.length <= 256 &&
    Number.isSafeInteger(cursor.sequence) && cursor.sequence! >= 0;
}
