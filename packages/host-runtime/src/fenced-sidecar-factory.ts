import type { AgentSidecar, AgentSidecarOptions, SidecarHostLink, SidecarLaunch } from "./agent-sidecar.js";
import { ExecutionFence } from "./execution-fence.js";

type Cleanup = Pick<AgentSidecar, "dispose" | "confirmExit">;
const constructionCleanup = Symbol("sidecar construction cleanup");
type ConstructionLaunch = SidecarLaunch & { [constructionCleanup]?: (cleanup: Cleanup) => void };
export type FencedSidecarOptions = AgentSidecarOptions & { host: SidecarHostLink; binaryPath: string; assertLaunch?: () => void };

/** Capture the original transport even when a derived constructor throws after spawn. */
export function retainSidecarConstruction(launch: SidecarLaunch, cleanup: Cleanup): void {
  (launch as ConstructionLaunch)[constructionCleanup]?.(cleanup);
}

/** Shared creation/cleanup; the embedding host supplies its concrete Sidecar class. */
export async function createFencedSidecar<T extends AgentSidecar>(
  options: FencedSidecarOptions,
  construct: (options: AgentSidecarOptions) => T,
  attach: (sidecar: T, fence: ExecutionFence) => void,
): Promise<T> {
  const { host, binaryPath, launch, onStderr, assertLaunch } = options;
  assertLaunch?.();
  const prepared = await ExecutionFence.prepare(host, binaryPath, launch);
  let cleanup: Cleanup | undefined;
  try {
    prepared.fence.assertHost(host);
    assertLaunch?.();
    prepared.fence.assertHost(host);
    const ownedLaunch: ConstructionLaunch = { ...prepared.launch,
      [constructionCleanup]: owner => { cleanup = owner; } };
    const sidecar = construct({ launch: ownedLaunch, onStderr });
    cleanup = sidecar;
    attach(sidecar, prepared.fence);
    sidecar.setHost(host);
    prepared.fence.assertHost(host);
    assertLaunch?.();
    prepared.fence.assertHost(host);
    return sidecar;
  } catch (error) {
    // Start both paths before awaiting either. A lost native reply must not
    // prevent transport cleanup; a killed root is not native-family proof.
    const [stopped, disposed] = await Promise.allSettled([
      prepared.fence.stop(),
      (async () => { if (cleanup) { await cleanup.dispose(); return cleanup.confirmExit(2000); } return true; })(),
    ]);
    const errors: unknown[] = [error];
    if (stopped.status === "rejected") errors.push(stopped.reason);
    if (disposed.status === "rejected") errors.push(disposed.reason);
    try { prepared.fence.releaseHostObservation(); } catch (cleanupError) { errors.push(cleanupError); }
    if (stopped.status !== "fulfilled" || !stopped.value.confirmed ||
        disposed.status !== "fulfilled" || !disposed.value || errors.length > 1) {
      throw new AggregateError(errors, "EXECUTION_FENCE_CLEANUP_UNCONFIRMED");
    }
    throw error;
  }
}
