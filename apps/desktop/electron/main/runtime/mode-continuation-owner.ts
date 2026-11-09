import { AsyncLocalStorage } from "node:async_hooks";
import type { HostProcess } from "../host-process";
import type { AgentHostBridge } from "../agent-host-bridge";

export type ModeContinuationOwner = {
  assertCurrent(): void;
  host: Pick<HostProcess, "call">;
  bridge: AgentHostBridge;
};

// Internal startup may wait in AgentHost admission and IPC setup. Cleanup keeps
// the original owner after invalidation; new effects must check assertCurrent.
// This context is never serialized or accepted from renderer/plugin requests.
const owner = new AsyncLocalStorage<ModeContinuationOwner>();

export function withModeContinuationOwner<T>(binding: ModeContinuationOwner, operation: () => T): T {
  binding.assertCurrent();
  return owner.run(binding, operation);
}

export function assertModeContinuationOwner(): void {
  owner.getStore()?.assertCurrent();
}

export function modeContinuationSettlementOwner(): ModeContinuationOwner | undefined {
  return owner.getStore();
}
