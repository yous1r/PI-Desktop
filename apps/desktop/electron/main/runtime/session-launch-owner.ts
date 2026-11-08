import { ErrorCodes } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { RuntimeState } from "./context";

export type SessionLaunchHost = Pick<HostProcess, "call" | "isAvailable">;

/** One launch may read only its original Host and publish only to its original
 * sidecar. Awaited resource initialization remains owned by the admitting caller. */
export function captureSessionLaunchOwner(state: RuntimeState) {
  const { host, sidecar, handoffAdmission } = state;
  if (!host) throw Object.assign(new Error("host unavailable"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
  const generation = host.generation;
  const assertCurrent = () => {
    if (handoffAdmission.isClosed()) throw Object.assign(new Error("HOST_BUSY"), { errorCode: "HOST_BUSY" });
    if (state.host !== host || state.sidecar !== sidecar || host.generation !== generation) {
      throw Object.assign(new Error("session launch owner changed"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
    }
  };
  async function wait<T>(operation: () => T | Promise<T>): Promise<T> {
    assertCurrent();
    try {
      const value = await operation();
      assertCurrent();
      return value;
    } catch (error) {
      assertCurrent();
      throw error;
    }
  }
  const boundHost: SessionLaunchHost = {
    isAvailable: () => { assertCurrent();return host.isAvailable(); },
    call: <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) =>
      wait(() => host.call<T>(method, params, timeoutMs)),
  };
  assertCurrent();
  return { host: boundHost, sidecar, assertCurrent, wait };
}
