import { type Static, Type } from "typebox";
import * as Value from "typebox/value";

/**
 * Negotiable command-center capability names for the C1 contract surface.
 * These are names only; no operation, IPC channel or RACP catalog entry is
 * registered from this module.
 */
export const COMMAND_CENTER_CAPABILITIES = [
  "workspaceList", "workspaceUpdate", "membershipBind", "monitor", "conversation", "interventions",
] as const;
export type CommandCenterCapability = (typeof COMMAND_CENTER_CAPABILITIES)[number];

export const CommandCenterCapabilitiesSchema = Type.Object({
  workspaceList: Type.Optional(Type.Boolean()),
  workspaceUpdate: Type.Optional(Type.Boolean()),
  membershipBind: Type.Optional(Type.Boolean()),
  monitor: Type.Optional(Type.Boolean()),
  conversation: Type.Optional(Type.Boolean()),
  interventions: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type CommandCenterCapabilities = Static<typeof CommandCenterCapabilitiesSchema>;

/**
 * Capabilities whose complete producer/consumer path exists today.
 *
 * C1 deliberately implements none: shipping schemas alone must not make a
 * client believe it can list workspaces, monitor tasks or submit controls.
 * C3/C4 update this list together with real adapters, role checks and
 * negotiation tests; until then every capability stays unavailable.
 */
export const COMMAND_CENTER_IMPLEMENTED_CAPABILITIES: readonly CommandCenterCapability[] = Object.freeze([]);

/**
 * Parse an advertised capability block and return the capabilities that are
 * both advertised and actually implemented.
 *
 * `undefined`/`null` (block absent) is the normal current wire state. An
 * unknown capability name is rejected so a typo cannot silently enable a path.
 * A `true` value for an unimplemented capability is rejected instead of being
 * ignored: a producer that advertises an incomplete path is a contract bug.
 */
export function parseCommandCenterCapabilities(value: unknown): CommandCenterCapability[] {
  if (value === undefined || value === null) return [];
  if (!Value.Check(CommandCenterCapabilitiesSchema, value)) throw new Error("COMMAND_CENTER_INVALID_CAPABILITIES");
  const advertised = value as CommandCenterCapabilities;
  const enabled = COMMAND_CENTER_CAPABILITIES.filter((name) => advertised[name] === true);
  if (enabled.length > 0) throw new Error("COMMAND_CENTER_CAPABILITY_UNAVAILABLE");
  return enabled;
}

/** True only when a capability is implemented and advertised by this peer. */
export function commandCenterCapabilityAvailable(
  advertised: CommandCenterCapabilities | undefined,
  name: CommandCenterCapability,
): boolean {
  return COMMAND_CENTER_IMPLEMENTED_CAPABILITIES.includes(name) && advertised?.[name] === true;
}
