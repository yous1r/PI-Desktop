/**
 * Pure decisions behind the mirror status panel (spec 03-runtime/23 §6, §7).
 *
 * A component cannot be imported by `node --test` because it carries JSX, so
 * every rule worth asserting lives here and the component only renders what
 * these return. Nothing in this module touches React, the store, or the host.
 */
import type { MirrorInitStatus, MirrorSyncState } from "@pi-desktop/shared";

/** Badge tone per sync state: only `failed` is a problem, the rest are normal. */
export const MIRROR_STATE_TONE: Record<
  MirrorSyncState,
  "neutral" | "success" | "warning" | "error"
> = {
  idle: "neutral",
  watching: "success",
  syncing: "success",
  paused: "warning",
  failed: "error",
};

/** `helper-deploy` -> `helperDeploy`, so the catalog keys stay camelCase. */
export function stepCatalogKey(step: string): string {
  return step.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * A mirror that has not finished initializing cannot synchronize: the helper may
 * not exist yet, and starting would only produce a failure the user cannot act
 * on. `init-failed` deliberately opens the gate — the failure is visible, and
 * the user decides whether to retry initialization or press on.
 */
export function initBlocksSync(init: MirrorInitStatus | null): boolean {
  return init !== null && init.state !== "ready" && init.state !== "init-failed";
}

/**
 * Which of the two primary actions is available right now.
 *
 * `active` means the host reports a watcher or a transfer, so starting again
 * would be a no-op the user should not be offered; stopping a project that is
 * not running is equally pointless.
 */
export function mirrorActionAvailability(
  state: MirrorSyncState,
  options: { busy: boolean; init: MirrorInitStatus | null },
): { canStart: boolean; canStop: boolean } {
  const blocked = options.busy || initBlocksSync(options.init);
  const active = state === "watching" || state === "syncing";
  return { canStart: !blocked && !active, canStop: !blocked && active };
}
