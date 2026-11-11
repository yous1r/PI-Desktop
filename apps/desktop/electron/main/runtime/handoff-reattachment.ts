/**
 * Opt-in Electron-main composition for {@link OwnerHandoffAttachment}.
 *
 * The attachment is an observation-only model: every cycle needs an already
 * authenticated connection, and its captured target-owner identity is supplied
 * by the authenticated binding, never by a Ready payload or a local preference.
 * This port owns that sequence across the RACP reconnect loop:
 *
 * - enable(): capture the authenticated authority, reconcile the snapshot, then
 *   let the attachment apply the ordered replay;
 * - on RACP reconnect or an explicit owner-epoch change: release the previous
 *   attachment (its subscriptions and pending acks), capture the replacement
 *   authority and start a new attachment from a fresh snapshot;
 * - on disconnect, disable, or dispose: release everything and publish an
 *   explicit unavailable/detached state instead of retrying in the background.
 *
 * Nothing constructs this port unless a command-center caller opts in, so the
 * existing paired-Host connection behaviour is unchanged. The port creates no
 * timers, opens no socket and starts no turn; `session/attach` stays `viewer`.
 */
import type { RacpEventEnvelope } from "@pi-desktop/shared";
import {
  OwnerHandoffAttachment,
  type OwnerAttachmentOptions,
  type OwnerAttachmentProjection,
  type OwnerAttachmentState,
  type OwnerAttachmentTarget,
  type OwnerAttachmentTransport,
  type OwnerAttachmentView,
} from "@pi-desktop/host-runtime";
import type { RemoteHostClient } from "../remote/remote-host-connection.js";
import { createDesktopHandoffAttachmentTransport } from "./handoff-attachment.js";

/** The authenticated binding for one RACP connection. H5 supplies the identity
 * from the authenticated owner handshake; `Ready`, a PID, a selected workspace
 * or a permission-mode preference cannot supply it. */
export type DesktopHandoffReattachmentAuthority = Readonly<{
  /** Durable transfer identity captured before Ready was published. */
  target: OwnerAttachmentTarget;
  /** Authenticated target-owner identity captured from the live connection. */
  identity: Readonly<{ profileId: string; ownerEpoch: string; protocolVersion: number }>;
  /** The paired-Host client whose connection carries this binding. */
  client: RemoteHostClient;
  /** Throws once the captured connection or authorization generation changed. */
  assertCurrent(): void;
  /** True only after the captured connection closed and RACP released its streams. */
  isClosed(): boolean;
}>;

export type DesktopHandoffReattachmentState = OwnerAttachmentState | "unavailable";
export type DesktopHandoffReattachmentDetail = Readonly<{ code?: string }>;

export type DesktopHandoffReattachmentOptions = {
  /** Opt-in authority resolver. Never called until the port is enabled. A
   * composition that must launch/join a successor may resolve asynchronously. */
  authority(): DesktopHandoffReattachmentAuthority | Promise<DesktopHandoffReattachmentAuthority>;
  /** Release the retained original observation. Invoked at most once per port. */
  detachOriginal: OwnerAttachmentOptions["detachOriginal"];
  /** Read the durable transfer record and its Ready payload for the original host. */
  readStatus: OwnerAttachmentOptions["readStatus"];
  /** Host session whose snapshot and replay are observed. Never mutated. */
  sessionId: string;
  onSnapshot(projection: OwnerAttachmentProjection): void;
  onEvent(view: OwnerAttachmentView, event: RacpEventEnvelope): void;
  onState(state: DesktopHandoffReattachmentState, detail?: DesktopHandoffReattachmentDetail): void;
  onError?(error: unknown): void;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  log?: (level: "warn", message: string, data?: Record<string, unknown>) => void;
};

export type DesktopHandoffReattachment = {
  readonly state: DesktopHandoffReattachmentState;
  /** Last explicit failure code, retained after a fail-closed transition. */
  readonly detail: DesktopHandoffReattachmentDetail | undefined;
  /** Capture the authenticated authority and reconcile one snapshot. */
  enable(): Promise<void>;
  /** The authenticated owner/authorization generation changed; reattach. */
  ownerChanged(): Promise<void>;
  /** Release observation resources; the port stays opted in for a later enable(). */
  disable(): Promise<void>;
  /** Permanently release observation resources. */
  dispose(): Promise<void>;
};

type AttachmentHandle = {
  readonly token: object;
  retiring: boolean;
  readonly attachment: OwnerHandoffAttachment;
};

const failure = (code: string) => Object.assign(new Error(code), { code });
const codeOf = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "HANDOFF_ATTACHMENT_FAILED";
};

export function createDesktopHandoffReattachment(
  options: DesktopHandoffReattachmentOptions,
): DesktopHandoffReattachment {
  const log = options.log ?? (() => undefined);
  let stateValue: DesktopHandoffReattachmentState = "detached";
  let lastCode: string | undefined;
  let enabled = false;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let authority: DesktopHandoffReattachmentAuthority | undefined;
  let current: AttachmentHandle | undefined;
  let watched: RemoteHostClient | undefined;
  let detachers: (() => void)[] = [];
  let queue: Promise<void> = Promise.resolve();
  let original: Promise<void> | undefined;

  const publish = (state: DesktopHandoffReattachmentState, code?: string): void => {
    if (stateValue === state && lastCode === code) return;
    stateValue = state;
    lastCode = code;
    try { options.onState(state, code === undefined ? undefined : { code }); }
    catch (error) { log("warn", "handoff reattachment state observer threw", { error: String(error) }); }
  };
  const report = (error: unknown): void => {
    try { options.onError?.(error); }
    catch (observer) { log("warn", "handoff reattachment error observer threw", { error: String(observer) }); }
  };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  // The retained original observation is released once, not once per cycle.
  const detachOriginal = (): Promise<void> => {
    if (!original) {
      const pending = Promise.resolve().then(() => options.detachOriginal());
      original = pending;
      void pending.catch(() => { if (original === pending) original = undefined; });
    }
    return original;
  };
  const unwatch = (): void => {
    watched = undefined;
    for (const detach of detachers.splice(0)) {
      try { detach(); }
      catch (error) { log("warn", "handoff reattachment listener threw on detach", { error: String(error) }); }
    }
  };

  function create(next: DesktopHandoffReattachmentAuthority): AttachmentHandle {
    const token = {};
    const active = () => {
      const handle = current;
      return handle !== undefined && handle.token === token && !handle.retiring && !disposed;
    };
    const transport = async (): Promise<OwnerAttachmentTransport> => {
      next.assertCurrent();
      if (next.isClosed()) throw failure("HANDOFF_ATTACHMENT_DISCONNECTED");
      const base = createDesktopHandoffAttachmentTransport({
        client: next.client,
        identity: next.identity,
        assertCurrent: next.assertCurrent,
        isClosed: next.isClosed,
      });
      // This port owns reconnection: it retires the whole attachment and builds a
      // replacement from the newly captured authority, so a transport captured
      // before the socket was replaced must not resync on its own.
      return { ...base, subscribeReconnect: () => () => undefined };
    };
    const attachment = new OwnerHandoffAttachment({
      target: next.target,
      detachOriginal,
      readStatus: options.readStatus,
      resolveTransport: async (_ready, signal) => { signal.throwIfAborted(); return transport(); },
      onSnapshot: projection => { if (active()) options.onSnapshot(projection); },
      onEvent: (view, event) => { if (active()) options.onEvent(view, event); },
      onState: state => { if (active() && state !== "disposed") publish(state); },
      onError: error => { if (active()) report(error); },
      ...(options.maxPendingEvents === undefined ? {} : { maxPendingEvents: options.maxPendingEvents }),
      ...(options.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
    });
    return { token, retiring: false, attachment };
  }

  function watch(client: RemoteHostClient): void {
    if (!client.subscribeReconnect || !client.subscribeState) {
      throw failure("HANDOFF_ATTACHMENT_LIFECYCLE_UNAVAILABLE");
    }
    watched = client;
    detachers.push(client.subscribeState(state => {
      if (state === "connected" || !enabled || disposed) return;
      // Suppress the retiring transport's own fault before the queued teardown
      // runs: a dropped socket is one unavailable transition, not an error.
      if (current) current.retiring = true;
      void enqueue(() => retire("HANDOFF_ATTACHMENT_DISCONNECTED")).catch(error => {
        report(error); publish("unavailable", codeOf(error));
      });
    }));
    detachers.push(client.subscribeReconnect(async () => {
      if (!enabled || disposed) return;
      // The RACP reconnect loop awaits this listener; an observation failure is
      // published, never propagated as a connection-recovery failure.
      try { await enqueue(() => reattach("HANDOFF_ATTACHMENT_DISCONNECTED")); }
      catch (error) { report(error); publish("unavailable", codeOf(error)); }
    }));
  }

  async function retire(code?: string, state: DesktopHandoffReattachmentState = "unavailable"): Promise<void> {
    const handle = current;
    current = undefined;
    if (handle) {
      handle.retiring = true;
      try { await handle.attachment.dispose(); }
      catch (error) { report(error); code ??= codeOf(error); }
    }
    if (enabled && !disposed && current === undefined) publish(state, code);
  }

  async function reattach(code: string): Promise<void> {
    if (!enabled || disposed) return;
    const previous = authority;
    await retire(code);
    if (!enabled || disposed) return;
    let next: DesktopHandoffReattachmentAuthority;
    try { next = await options.authority(); }
    catch (error) { report(error); publish("unavailable", codeOf(error)); return; }
    if (previous && (previous.target.transferId !== next.target.transferId ||
        previous.target.sourceEpoch !== next.target.sourceEpoch ||
        previous.target.profileId !== next.target.profileId)) {
      const error = failure("HANDOFF_REATTACHMENT_TARGET_CHANGED");
      report(error); publish("error", error.code); return;
    }
    if (watched !== next.client) { unwatch(); watch(next.client); }
    authority = next;
    const handle = create(next);
    current = handle;
    publish("reconciling");
    try { await handle.attachment.reconcile(options.sessionId); }
    catch (error) {
      if (current === handle) {
        // The attachment already reported its own cycle error; retain the code
        // so a fail-closed port exposes why it is unavailable.
        if (stateValue !== "error") report(error);
        publish("error", codeOf(error));
      }
    }
  }

  return {
    get state() { return stateValue; },
    get detail() { return lastCode === undefined ? undefined : { code: lastCode }; },
    async enable() {
      if (disposed) throw failure("HANDOFF_ATTACHMENT_DISPOSED");
      await enqueue(async () => {
        if (disposed) throw failure("HANDOFF_ATTACHMENT_DISPOSED");
        if (enabled) return;
        let next: DesktopHandoffReattachmentAuthority;
        try { next = await options.authority(); }
        catch (error) { report(error); publish("error", codeOf(error)); throw error; }
        if (next.isClosed()) {
          const error = failure("HANDOFF_ATTACHMENT_DISCONNECTED");
          report(error); publish("error", error.code); throw error;
        }
        if (next.client.state?.() !== undefined && next.client.state() !== "connected") {
          const error = failure("HANDOFF_REATTACHMENT_UNAVAILABLE");
          report(error); publish("error", error.code); throw error;
        }
        try { watch(next.client); }
        catch (error) { report(error); publish("error", codeOf(error)); throw error; }
        enabled = true;
        authority = next;
        const handle = create(next);
        current = handle;
        publish("reconciling");
        try { await handle.attachment.reconcile(options.sessionId); }
        catch (error) {
          if (current === handle) {
            if (stateValue !== "error") report(error);
            publish("error", codeOf(error));
          }
          throw error;
        }
      });
    },
    async ownerChanged() {
      if (disposed) throw failure("HANDOFF_ATTACHMENT_DISPOSED");
      if (!enabled) throw failure("HANDOFF_REATTACHMENT_DISABLED");
      await enqueue(() => reattach("HANDOFF_REATTACHMENT_OWNER_CHANGED"));
    },
    async disable() {
      if (disposed) return;
      enabled = false;
      unwatch();
      await enqueue(async () => {
        await retire();
        if (!disposed) publish("detached");
      });
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      enabled = false;
      unwatch();
      disposing = queue.then(async () => {
        await retire();
        publish("disposed");
      });
      return disposing;
    },
  };
}
