import type { HostProcess } from "./host-process.js";

export type OriginalOwnerHost = Pick<HostProcess, "call" | "generation" | "isAvailable">;
export function ownerQueryFailure(code: string): Error { return Object.assign(new Error(code), { errorCode: code }); }

/** Keep original transport and binding on both success and failure, including
 * overload retries. Observed late results never authorize another owner. */
export async function callOriginalOwner<T>(host: OriginalOwnerHost, method: string, request: object,
  assertIdentity: () => void, parse: (value: unknown) => T, timeoutCode: string): Promise<T> {
  const generation = host.generation;
  const assertCurrent = () => {
    assertIdentity();
    if (host.generation !== generation || !host.isAvailable()) throw ownerQueryFailure("HANDOFF_OWNER_CHANGED");
  };
  assertCurrent();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(ownerQueryFailure(timeoutCode)), 2500); });
    const value: unknown = await Promise.race([host.call(method, request, 2000), deadline]);
    return parse(value);
  } finally {
    clearTimeout(timer);
    assertCurrent();
  }
}
