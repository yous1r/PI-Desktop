import { randomUUID } from "node:crypto";
import { type OwnerHandoffInspection, parseOwnerHandoffInspection, parseOwnerHandoffInspectionRequest } from "@pi-desktop/shared";
import type { HostProcess } from "./host-process.js";

export type OwnerInspectionBinding = {
  sourceEpoch: string;
  profileId: string;
  generation: string;
  host: Pick<HostProcess, "call" | "generation" | "isAvailable">;
};
function failure(code: string): Error { return Object.assign(new Error(code), { errorCode: code }); }

/** Read original Rust authority. The returned facts are not an admission hold
 * or complete inventory; callers still own Desktop and native qualification. */
export async function inspectOwnerHandoff(current: () => OwnerInspectionBinding | null): Promise<OwnerHandoffInspection> {
  const initial = current();
  if (!initial) throw failure("HANDOFF_OWNER_UNAVAILABLE");
  const binding = { ...initial };
  const hostGeneration = binding.host.generation;
  const request = Object.freeze(parseOwnerHandoffInspectionRequest({ version: 1, requestId: randomUUID(),
    sourceEpoch: binding.sourceEpoch, profileId: binding.profileId, generation: binding.generation }));
  const assertBinding = () => {
    const value = current();
    if (!value || value.host !== binding.host || value.sourceEpoch !== binding.sourceEpoch ||
        value.profileId !== binding.profileId || value.generation !== binding.generation ||
        value.host.generation !== hostGeneration || !binding.host.isAvailable()) throw failure("HANDOFF_OWNER_CHANGED");
  };
  assertBinding();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure("HANDOFF_INSPECTION_TIMEOUT")), 2500); });
    const value: unknown = await Promise.race([binding.host.call("ownerHandoff.inspect", request, 2000), deadline]);
    return parseOwnerHandoffInspection(value, request);
  } finally {
    clearTimeout(timer);
    assertBinding();
  }
}
