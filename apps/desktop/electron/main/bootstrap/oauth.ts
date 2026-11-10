import type { HostProcess } from "../host-process";
import { VendorOAuth, type VendorOAuthDeps } from "../oauth";
import type { VendorOAuthOwner } from "../oauth-activity";

/** Bind every OAuth sequence to the Host and generation that admitted it. */
export function createDesktopVendorOAuth(input: Omit<VendorOAuthDeps, "call" | "captureOwner" | "isAdmissionClosed"> & {
  getHost: () => HostProcess | null;
  isAdmissionClosed: () => boolean;
}): VendorOAuth {
  const captureOwner = (): VendorOAuthOwner => {
    const original = input.getHost();
    const generation = original?.generation;
    const assertCurrent = () => {
      if (input.isAdmissionClosed()) {
        throw Object.assign(new Error("vendor OAuth admission is closed"), { code: "HOST_BUSY", errorCode: "HOST_BUSY" });
      }
      if (!original || input.getHost() !== original || original.generation !== generation || !original.isAvailable()) {
        throw Object.assign(new Error("vendor OAuth Host is unavailable"), { code: "HOST_UNAVAILABLE", errorCode: "HOST_UNAVAILABLE" });
      }
    };
    assertCurrent();
    return {
      assertCurrent,
      call: async <T,>(method: string, params?: unknown): Promise<T> => {
        assertCurrent();
        if (!original) throw new Error("vendor OAuth Host is unavailable");
        const result = await original.call<T>(method, params);
        assertCurrent();
        return result;
      },
    };
  };
  return new VendorOAuth({
    ...input,
    captureOwner,
    call: (method, params) => captureOwner().call(method, params),
  });
}
