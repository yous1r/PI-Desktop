import { parseCommandCenterObservationOwner } from "@pi-desktop/shared";

const contextBrand: unique symbol = Symbol("CommandCenterObservationContext");

/** Local lifetime identity, never a credential, role, or wire field. */
export interface CommandCenterObservationContext {
  readonly [contextBrand]: true;
}

interface ContextLifetime {
  active: boolean;
  owner?: Readonly<{ hostId: string; expectedHostEpoch: string }>;
  invalidations: Set<() => void>;
}

const lifetimes = new WeakMap<CommandCenterObservationContext, ContextLifetime>();

/**
 * A trusted adapter establishes one context per authenticated Host/owner scope.
 * Revoke it before changing principal, authorization scope, or Host generation.
 * Reconnecting within that same scope does not create a mutation or a new ID.
 */
export function createCommandCenterObservationContext(): CommandCenterObservationContext {
  const context: CommandCenterObservationContext = Object.freeze({ [contextBrand]: true as const });
  lifetimes.set(context, { active: true, invalidations: new Set() });
  return context;
}

/** Permanently revoke the context and clear all attempts it currently owns. */
export function invalidateCommandCenterObservationContext(context: CommandCenterObservationContext): void {
  const lifetime = lifetimes.get(context);
  if (!lifetime) throw new Error("COMMAND_CENTER_CLIENT_INVALID_CONTEXT");
  if (!lifetime.active) return;
  lifetime.active = false;
  for (const invalidate of lifetime.invalidations) invalidate();
  lifetime.invalidations.clear();
}

export function requireActiveContext(context: CommandCenterObservationContext): void {
  const lifetime = lifetimes.get(context);
  if (!lifetime) throw new Error("COMMAND_CENTER_CLIENT_INVALID_CONTEXT");
  if (!lifetime.active) throw new Error("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
}

/** A read-only adapter can bind a context without fabricating an intervention. */
export function bindCommandCenterObservationOwner(context: CommandCenterObservationContext, input: unknown): void {
  requireActiveContext(context);
  const owner = parseCommandCenterObservationOwner(input);
  bindContextOwner(context, owner);
}

/** Monitor reads require the owner established by the authenticated adapter. */
export function requireBoundContext(context: CommandCenterObservationContext): void {
  requireActiveContext(context);
  if (!lifetimes.get(context)?.owner) throw new Error("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_REQUIRED");
}

/** Pin the first validated request's owner synchronously, including failed hashing. */
export function bindContextOwner(
  context: CommandCenterObservationContext,
  owner: Readonly<{ hostId: string; expectedHostEpoch: string }>,
): void {
  requireActiveContext(context);
  const lifetime = lifetimes.get(context)!;
  if (lifetime.owner && (lifetime.owner.hostId !== owner.hostId ||
      lifetime.owner.expectedHostEpoch !== owner.expectedHostEpoch)) {
    throw new Error("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_MISMATCH");
  }
  lifetime.owner ??= Object.freeze({ hostId: owner.hostId, expectedHostEpoch: owner.expectedHostEpoch });
}

export function onContextInvalidated(context: CommandCenterObservationContext, invalidate: () => void): () => void {
  requireActiveContext(context);
  const lifetime = lifetimes.get(context)!;
  lifetime.invalidations.add(invalidate);
  return () => { lifetime.invalidations.delete(invalidate); };
}
