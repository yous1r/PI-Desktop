import { randomUUID } from "node:crypto";
import { parseOwnerHandoffIdentity, parseOwnerHandoffIdentityRequest, parseOwnerHandoffTransferQuery,
  parseOwnerHandoffTransferRequest, type OwnerHandoffIdentity, type OwnerHandoffRecord } from "@pi-desktop/shared";
import { callOriginalOwner, type OriginalOwnerHost, ownerQueryFailure } from "./owner-handoff-call.js";

export type OwnerSourceBinding = { host: OriginalOwnerHost; sourceEpoch: string; profileId: string };
/** Identity comes only from the retained original stdio owner, before or after
 * Sidecar startup. It is not discovery, inventory, or transfer permission. */
export async function queryOwnerHandoffIdentity(current: () => OriginalOwnerHost | null): Promise<OwnerHandoffIdentity> {
  const host = current();
  if (!host) throw ownerQueryFailure("HANDOFF_OWNER_UNAVAILABLE");
  const request = Object.freeze(parseOwnerHandoffIdentityRequest({ version: 1, requestId: randomUUID() }));
  return callOriginalOwner(host, "ownerHandoff.identity", request, () => {
    if (current() !== host) throw ownerQueryFailure("HANDOFF_OWNER_CHANGED");
  }, value => parseOwnerHandoffIdentity(value, request), "HANDOFF_QUERY_TIMEOUT");
}
/** The coordinator still verifies phase; this read never reopens admission. */
export async function readOwnerHandoffTransfer(current: () => OwnerSourceBinding | null, transferId: string): Promise<{ version: 1; record: OwnerHandoffRecord }> {
  const initial = current();
  if (!initial) throw ownerQueryFailure("HANDOFF_OWNER_UNAVAILABLE");
  const binding = { ...initial };
  const request = Object.freeze(parseOwnerHandoffTransferRequest({ version: 1, requestId: randomUUID(),
    sourceEpoch: binding.sourceEpoch, profileId: binding.profileId, transferId }));
  return callOriginalOwner(binding.host, "ownerHandoff.readTransfer", request, () => {
    const value = current();
    if (!value || value.host !== binding.host || value.sourceEpoch !== binding.sourceEpoch || value.profileId !== binding.profileId) {
      throw ownerQueryFailure("HANDOFF_OWNER_CHANGED");
    }
  }, value => ({ version: 1, record: parseOwnerHandoffTransferQuery(value, request).record }), "HANDOFF_QUERY_TIMEOUT");
}
