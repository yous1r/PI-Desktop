import {
  OWNER_HANDOFF_EXCHANGE_METHOD, OWNER_HANDOFF_COMPLETE_METHOD, OWNER_HANDOFF_EXCHANGE_TIMEOUT_MS,
  parseOwnerHandoffExchange, parseOwnerHandoffCompletion, parseOwnerHandoffCompletionAck,
  type OwnerHandoffExchange, type OwnerHandoffCompletion, type OwnerHandoffQuiescenceReport,
} from "@pi-desktop/shared";
import type { HostProcess } from "./host-process.js";
import { callOriginalOwner, ownerQueryFailure } from "./owner-handoff-call.js";

type Host = Pick<HostProcess, "generation" | "isAvailable" | "call" | "onNotification" | "onExit">;
export type OwnerHandoffExchangeOptions = {
  host: Host;
  /** Must validate the notifying original before resolving any coordinator. */
  isCurrent(): boolean;
  exchange(request: OwnerHandoffExchange, assertCurrent: () => void): Promise<OwnerHandoffQuiescenceReport>;
  /** Fail closed if original admission is held. No producer payload escapes. */
  unavailable(): void;
};
function failureOutcome(error: unknown): OwnerHandoffCompletion["outcome"] {
  const code = error && typeof error === "object" ? "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined : undefined;
  return { error: { code: code === "HANDOFF_BUSY" || code === "HOST_BUSY" ? "HANDOFF_BUSY" :
    code === "HANDOFF_OWNER_CHANGED" ? code : "HANDOFF_UNAVAILABLE" } };
}

/** One original normal-stdio subscription. Optional identity queries happen
 * inside the coordinator only after a valid Rust notification arrives. */
export function bindOwnerHandoffExchange(options: OwnerHandoffExchangeOptions): { dispose(): void } {
  const host = options.host, generation = host.generation;
  let closed = false, pending = false, receiving = false;
  let acknowledging: OwnerHandoffExchange | undefined;
  let queued: { request: OwnerHandoffExchange; deadline: number } | undefined;
  let unnotify = () => {}, unexit = () => {};
  const unsubscribe = () => {
    for (const release of [unnotify, unexit]) {
      try { release(); } catch { console.warn("[owner-handoff] channel unsubscribe failed"); }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    queued = undefined;
    acknowledging = undefined;
    unsubscribe();
    try { options.unavailable(); }
    catch { console.warn("[owner-handoff] channel cleanup failed"); }
  };
  const assertCurrent = () => {
    if (closed || host.generation !== generation || !host.isAvailable() || !options.isCurrent() || closed) throw ownerQueryFailure("HANDOFF_OWNER_CHANGED");
  };
  const run = async (request: OwnerHandoffExchange, expiresAt: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertCurrent();
      const remaining = expiresAt - performance.now();
      if (remaining <= 0) throw ownerQueryFailure("HANDOFF_EXCHANGE_TIMEOUT");
      let outcome: OwnerHandoffCompletion["outcome"];
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        close(); reject(ownerQueryFailure("HANDOFF_EXCHANGE_TIMEOUT"));
      }, remaining); });
      try { outcome = { report: await Promise.race([options.exchange(request, assertCurrent), deadline]) }; }
      catch (error) { outcome = failureOutcome(error); }
      finally { clearTimeout(timer); }
      assertCurrent();
      const completion = parseOwnerHandoffCompletion({ ...request, outcome }, request);
      acknowledging = request;
      await callOriginalOwner(host, OWNER_HANDOFF_COMPLETE_METHOD, completion, assertCurrent,
        value => parseOwnerHandoffCompletionAck(value, request), "HANDOFF_EXCHANGE_TIMEOUT");
    } catch { close(); }
    finally {
      clearTimeout(timer); pending = false; acknowledging = undefined;
      const next = queued; queued = undefined;
      if (next && !closed) { pending = true; void run(next.request, next.deadline); }
    }
  };
  try {
    unexit = host.onExit(close);
    unnotify = host.onNotification((method, value) => {
      if (method !== OWNER_HANDOFF_EXCHANGE_METHOD || closed) return;
      // Rust can consume a completion and notify again before its RPC ACK is
      // delivered. Retain one successor during ACK only; never run concurrently.
      if (receiving || (pending && (!acknowledging || queued))) { close(); return; }
      receiving = true;
      const deadline = performance.now() + OWNER_HANDOFF_EXCHANGE_TIMEOUT_MS - 5000;
      try {
        const waiting = pending;
        pending = true;
        assertCurrent();
        const parsed = parseOwnerHandoffExchange(value);
        const request = Object.freeze({ ...parsed, request: Object.freeze({ ...parsed.request }) });
        if (waiting) {
          if (!acknowledging || request.request.exchangeId === acknowledging.request.exchangeId ||
              request.profileId !== acknowledging.profileId || request.request.sourceEpoch !== acknowledging.request.sourceEpoch) {
            close(); return;
          }
          queued = { request, deadline };
        } else { void run(request, deadline); }
      } catch { close(); }
      finally { receiving = false; }
    });
    assertCurrent();
  } catch { close(); }
  // A subscription callback may synchronously close during registration.
  if (closed) unsubscribe();
  return { dispose: close };
}
