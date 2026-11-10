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
  let closed = false, pending = false;
  let unnotify = () => {}, unexit = () => {};
  const unsubscribe = () => {
    for (const release of [unnotify, unexit]) {
      try { release(); } catch { console.warn("[owner-handoff] channel unsubscribe failed"); }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    try { options.unavailable(); }
    catch { console.warn("[owner-handoff] channel cleanup failed"); }
  };
  const assertCurrent = () => {
    if (closed || host.generation !== generation || !host.isAvailable() || !options.isCurrent()) throw ownerQueryFailure("HANDOFF_OWNER_CHANGED");
  };
  const run = async (request: OwnerHandoffExchange) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertCurrent();
      let outcome: OwnerHandoffCompletion["outcome"];
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        close(); reject(ownerQueryFailure("HANDOFF_EXCHANGE_TIMEOUT"));
      }, OWNER_HANDOFF_EXCHANGE_TIMEOUT_MS - 5000); });
      try { outcome = { report: await Promise.race([options.exchange(request, assertCurrent), deadline]) }; }
      catch (error) { outcome = failureOutcome(error); }
      finally { clearTimeout(timer); }
      assertCurrent();
      const completion = parseOwnerHandoffCompletion({ ...request, outcome }, request);
      await callOriginalOwner(host, OWNER_HANDOFF_COMPLETE_METHOD, completion, assertCurrent,
        value => parseOwnerHandoffCompletionAck(value, request), "HANDOFF_EXCHANGE_TIMEOUT");
    } catch { close(); }
    finally { clearTimeout(timer); pending = false; }
  };
  try {
    unexit = host.onExit(close);
    unnotify = host.onNotification((method, value) => {
      if (method !== OWNER_HANDOFF_EXCHANGE_METHOD || closed) return;
      try {
        if (pending) { close(); return; }
        pending = true;
        assertCurrent();
        const parsed = parseOwnerHandoffExchange(value);
        const request = Object.freeze({ ...parsed, request: Object.freeze({ ...parsed.request }) });
        void run(request);
      } catch { close(); }
    });
    assertCurrent();
  } catch { close(); }
  // A subscription callback may synchronously close during registration.
  if (closed) unsubscribe();
  return { dispose: close };
}
